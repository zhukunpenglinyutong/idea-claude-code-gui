import { describe, expect, it } from 'vitest';
import { GatewayError } from '../src/gateway/errors.js';
import { SseClient, SseLineParser, type SseEnvelope } from '../src/gateway/sse.js';
import { FAKE_PROJECT_ID, FAKE_TAB_ID, FakeGateway, type FakeHandler } from './helpers/fakeGateway.js';

const TOKEN = 'token-sse';

describe('SseLineParser', () => {
  it('parses a single event frame', () => {
    const events: Array<{ name: string; data: string }> = [];
    const comments: string[] = [];
    const parser = new SseLineParser();
    parser.feed('event: task.accepted\ndata: {"state":"ACCEPTED"}\n\n', {
      onEvent: (name, data) => events.push({ name, data }),
      onComment: (line) => comments.push(line),
    });
    expect(events).toEqual([{ name: 'task.accepted', data: '{"state":"ACCEPTED"}' }]);
    expect(comments).toEqual([]);
  });

  it('joins multi-line data with newlines', () => {
    const events: Array<{ name: string; data: string }> = [];
    const parser = new SseLineParser();
    parser.feed('event: assistant.content\ndata: {"text":"a"\ndata: ,"more":1}\n\n', {
      onEvent: (name, data) => events.push({ name, data }),
    });
    expect(events).toEqual([{ name: 'assistant.content', data: '{"text":"a"\n,"more":1}' }]);
  });

  it('handles keepalive comments and ignores id/retry fields', () => {
    const events: Array<{ name: string; data: string }> = [];
    const comments: string[] = [];
    const parser = new SseLineParser();
    parser.feed(': keepalive\nid: 7\nretry: 1000\nevent: tool.started\ndata: {}\n\n', {
      onEvent: (name, data) => events.push({ name, data }),
      onComment: (line) => comments.push(line),
    });
    expect(events).toEqual([{ name: 'tool.started', data: '{}' }]);
    expect(comments).toEqual(['keepalive']);
  });

  it('handles CRLF line endings', () => {
    const events: Array<{ name: string; data: string }> = [];
    const parser = new SseLineParser();
    parser.feed('event: task.completed\r\ndata: {"state":"COMPLETED"}\r\n\r\n', {
      onEvent: (name, data) => events.push({ name, data }),
    });
    expect(events).toEqual([{ name: 'task.completed', data: '{"state":"COMPLETED"}' }]);
  });

  it('buffers partial lines across arbitrary chunk boundaries', () => {
    const events: Array<{ name: string; data: string }> = [];
    const parser = new SseLineParser();
    const handlers = { onEvent: (name: string, data: string) => events.push({ name, data }) };
    const frame = 'event: usage.updated\ndata: {"usedTokens":1}\n\n';
    for (const char of frame) {
      parser.feed(char, handlers);
    }
    expect(events).toEqual([{ name: 'usage.updated', data: '{"usedTokens":1}' }]);
  });

  it('flushes a trailing event without a blank line', () => {
    const events: Array<{ name: string; data: string }> = [];
    const parser = new SseLineParser();
    parser.feed('event: task.failed\ndata: {"state":"FAILED"}', {
      onEvent: (name, data) => events.push({ name, data }),
    });
    parser.flush();
    expect(events).toEqual([{ name: 'task.failed', data: '{"state":"FAILED"}' }]);
  });
});

describe('SseClient', () => {
  it('streams envelopes, comments and overflow from a live server', async () => {
    const ssePayload = (name: string): string =>
      `event: ${name}\ndata: ${JSON.stringify({
        eventId: 1,
        event: name,
        timestamp: 1_700_000_000_000,
        projectId: FAKE_PROJECT_ID,
        tabId: FAKE_TAB_ID,
        taskId: 'task-1',
        sessionId: 's-1',
        payload: { state: 'COMPLETED' },
      })}\n\n`;
    const handler: FakeHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': keepalive\n\n');
      res.write(ssePayload('task.started'));
      res.write(ssePayload('task.completed'));
      res.write('event: stream.overflow\ndata: {"reason":"client too slow"}\n\n');
      res.end();
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    try {
      const client = new SseClient({
        url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
        token: TOKEN,
      });
      const events: SseEnvelope[] = [];
      const comments: string[] = [];
      const overflow: string[] = [];
      let closed = false;
      await client.open({
        onEvent: (envelope) => events.push(envelope),
        onComment: (line) => comments.push(line),
        onOverflow: (reason) => overflow.push(reason),
        onClose: () => {
          closed = true;
        },
      });
      expect(closed).toBe(true);
      expect(comments).toEqual(['keepalive']);
      expect(overflow).toEqual(['{"reason":"client too slow"}']);
      expect(events.map((e) => e.event)).toEqual(['task.started', 'task.completed']);
      expect(events[1]?.taskId).toBe('task-1');
      expect(events[1]?.payload).toEqual({ state: 'COMPLETED' });
    } finally {
      await gateway.stop();
    }
  });

  it('rejects an unauthorized open as auth', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    try {
      const client = new SseClient({
        url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
        token: 'wrong',
      });
      await expect(client.open({})).rejects.toMatchObject({ kind: 'auth', status: 401 });
    } finally {
      await gateway.stop();
    }
  });

  it('reports a mid-stream failure as an error and does not throw', async () => {
    const handler: FakeHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      res.write('event: task.started\ndata: {}\n\n');
      // Let the client finish the fetch handshake before severing the socket;
      // destroying synchronously can fail before the response is established.
      setTimeout(() => res.destroy(), 100);
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    try {
      const client = new SseClient({
        url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
        token: TOKEN,
      });
      const errors: unknown[] = [];
      await client.open({
        onError: (error) => errors.push(error),
      });
      expect(errors.length).toBe(1);
      expect(errors[0]).toBeInstanceOf(GatewayError);
    } finally {
      await gateway.stop();
    }
  });
});
