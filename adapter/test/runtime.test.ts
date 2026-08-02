import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdapterApp } from '../src/app.js';
import type { GatewayDiscovery } from '../src/discovery.js';
import { GatewayClient } from '../src/gateway/client.js';
import { SseClient } from '../src/gateway/sse.js';
import { InboxJournal } from '../src/ilink/journal.js';
import type { InboundMessage, MessageTransport } from '../src/transport.js';
import { AdapterRuntime } from '../src/runtime.js';
import { OutboundRouter } from '../src/weixin/outbound.js';
import {
  FAKE_PROJECT_ID,
  FAKE_TAB_ID,
  FakeGateway,
  type FakeHandler,
} from './helpers/fakeGateway.js';
import { waitUntil } from './helpers/wait.js';

const TOKEN = 'runtime-token';

function discoveryFor(port: number): GatewayDiscovery {
  return { version: 1, host: '127.0.0.1', port, tokenFile: 'token.txt', pid: 1 };
}

class FakeTransport implements MessageTransport {
  readonly name = 'fake';
  readonly sent: string[] = [];
  readonly #handlers = new Set<(message: InboundMessage) => void>();

  async sendText(text: string): Promise<void> {
    this.sent.push(text);
  }

  onInbound(handler: (message: InboundMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  emit(message: InboundMessage): void {
    for (const handler of [...this.#handlers]) {
      handler(message);
    }
  }

  async close(): Promise<void> {}
}

function writeJson(res: Parameters<FakeHandler>[1], status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sseFrame(event: string, payload: Record<string, unknown>, taskId: string): string {
  return `event: ${event}\ndata: ${JSON.stringify({
    eventId: 1,
    event,
    timestamp: Date.now(),
    projectId: FAKE_PROJECT_ID,
    tabId: FAKE_TAB_ID,
    taskId,
    sessionId: 's-1',
    payload,
  })}\n\n`;
}

describe('AdapterRuntime', () => {
  it('opens SSE on bind, dispatches inbound to /chat and relays terminal text', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/chat') && _req.method === 'POST') {
        writeJson(res, 202, {
          taskId: 'task-rt',
          projectId: FAKE_PROJECT_ID,
          tabId: FAKE_TAB_ID,
          status: 'accepted',
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-rt'));
        res.write(sseFrame('assistant.content', { text: 'A' }, 'task-rt'));
        res.write(sseFrame('assistant.content', { text: 'B' }, 'task-rt'));
        res.write(sseFrame('task.completed', { state: 'COMPLETED' }, 'task-rt'));
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const outbound = new OutboundRouter({ sendText: (text) => transport.sendText(text) });
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound,
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
      reconnectDelayMs: 50,
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.includes('已收到，正在处理…'));
      transport.emit({ messageId: 'bot-1:m1', text: 'do it', receivedAt: Date.now() });
      await waitUntil(() => gateway.requests.some((r) => r.url.endsWith('/chat')));
      await waitUntil(() => transport.sent.includes('AB'));
      const chat = gateway.requests.find((r) => r.url.endsWith('/chat'));
      expect(chat?.body).toEqual({ message: 'do it' });
      expect(gateway.requests.some((r) => r.url.endsWith('/events'))).toBe(true);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('surfaces TAB_BUSY as a status text without queueing', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/chat') && _req.method === 'POST') {
        writeJson(res, 409, { error: { code: 'TAB_BUSY', message: 'Tab is busy' } });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      transport.emit({ messageId: 'bot-1:m1', text: 'do it', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('当前会话忙')));
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('surfaces target not_found as 目标已失效 and marks the binding INVALID', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/chat') && _req.method === 'POST') {
        writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Tab not found' } });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({
      loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }),
    });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      transport.emit({ messageId: 'bot-1:m1', text: 'do it', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('目标已失效')));
      expect(app.state.state).toBe('INVALID');
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('rejects inbound while INVALID and never sends to another tab', async () => {
    let closed = false;
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        if (closed) {
          writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Tab not found' } });
          return;
        }
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      closed = true;
      await app.checkNow();
      expect(app.state.state).toBe('INVALID');
      transport.emit({ messageId: 'bot-1:m1', text: 'do it', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('未绑定或目标不可用')));
      expect(gateway.requests.some((r) => r.url.endsWith('/chat'))).toBe(false);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('resolves a permission from WeChat via the decision endpoint', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-p'));
        res.write(
          sseFrame(
            'permission.requested',
            { interactionId: 'i1', requestId: 'r1', toolName: 'Write', inputs: {} },
            'task-p',
          ),
        );
        return;
      }
      if (url.includes('/permissions/i1/decision') && _req.method === 'POST') {
        writeJson(res, 200, { interactionId: 'i1', resolved: true });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.some((text) => text.includes('ALLOW / ALLOW_ALWAYS / DENY')));
      transport.emit({ messageId: 'bot-1:m1', text: 'ALLOW', receivedAt: Date.now() });
      await waitUntil(() => gateway.requests.some((r) => r.url.includes('/permissions/i1/decision')));
      const decision = gateway.requests.find((r) => r.url.includes('/permissions/i1/decision'));
      expect(decision?.body).toEqual({ taskId: 'task-p', decision: 'ALLOW' });
      expect(transport.sent).toContain('已发送授权决定。');
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('approves a plan and answers a question from WeChat', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-i'));
        res.write(sseFrame('plan.requested', { interactionId: 'i2', requestId: 'r2', plan: {} }, 'task-i'));
        res.write(
          sseFrame(
            'question.requested',
            { interactionId: 'i3', requestId: 'r3', allowCustomInput: true, questions: { 问题A: {} } },
            'task-i',
          ),
        );
        return;
      }
      if (url.includes('/plans/i2/decision') && _req.method === 'POST') {
        writeJson(res, 200, { interactionId: 'i2', resolved: true });
        return;
      }
      if (url.includes('/questions/i3/answer') && _req.method === 'POST') {
        writeJson(res, 200, { interactionId: 'i3', resolved: true });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.some((text) => text.includes('i2')));
      transport.emit({ messageId: 'bot-1:m1', text: '同意', receivedAt: Date.now() });
      await waitUntil(() => gateway.requests.some((r) => r.url.includes('/plans/i2/decision')));
      const plan = gateway.requests.find((r) => r.url.includes('/plans/i2/decision'));
      expect(plan?.body).toEqual({ taskId: 'task-i', approved: true });

      await waitUntil(() => transport.sent.some((text) => text.includes('i3')));
      transport.emit({ messageId: 'bot-1:m2', text: '我的答案是 B', receivedAt: Date.now() });
      await waitUntil(() => gateway.requests.some((r) => r.url.includes('/questions/i3/answer')));
      const question = gateway.requests.find((r) => r.url.includes('/questions/i3/answer'));
      expect(question?.body).toEqual({ taskId: 'task-i', answers: { 问题A: '我的答案是 B' } });
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('stops the active task with the stop command', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-stop'));
        return;
      }
      if (url.includes('/tasks/task-stop/abort') && _req.method === 'POST') {
        writeJson(res, 202, { taskId: 'task-stop', status: 'aborting' });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.includes('已收到，正在处理…'));
      transport.emit({ messageId: 'bot-1:m1', text: '停止', receivedAt: Date.now() });
      await waitUntil(() => gateway.requests.some((r) => r.url.includes('/tasks/task-stop/abort')));
      expect(transport.sent).toContain('正在停止任务…');
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('reports no active task when stop is requested idle', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      transport.emit({ messageId: 'bot-1:m1', text: '停止', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('当前没有运行中的任务')));
      expect(gateway.requests.some((r) => r.url.includes('/abort'))).toBe(false);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('survives outbound send failures without crashing', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-x'));
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    transport.sendText = async () => {
      throw new Error('wechat down');
    };
    const logs: string[] = [];
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
      log: (message) => logs.push(message),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => logs.some((line) => line.includes('outbound event failed')));
      expect(logs.some((line) => line.includes('wechat down'))).toBe(true);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('hints instead of dispatching unrecognized replies while permission is pending', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-p'));
        res.write(
          sseFrame(
            'permission.requested',
            { interactionId: 'i1', requestId: 'r1', toolName: 'Write', inputs: {} },
            'task-p',
          ),
        );
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.some((text) => text.includes('需要授权')));
      transport.emit({ messageId: 'bot-1:m1', text: '随便写吧', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('未识别授权指令')));
      expect(gateway.requests.some((r) => r.url.endsWith('/chat'))).toBe(false);
      expect(transport.sent.some((text) => text.includes('允许 / 始终允许 / 拒绝'))).toBe(true);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('surfaces the real gateway reason when a control request fails', async () => {
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-e'));
        res.write(
          sseFrame(
            'permission.requested',
            { interactionId: 'i1', requestId: 'r1', toolName: 'Write', inputs: {} },
            'task-e',
          ),
        );
        return;
      }
      if (url.includes('/permissions/i1/decision') && _req.method === 'POST') {
        writeJson(res, 409, { error: { code: 'INTERACTION_ALREADY_RESOLVED', message: 'Already resolved' } });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.some((text) => text.includes('需要授权')));
      transport.emit({ messageId: 'bot-1:m1', text: 'ALLOW', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('已被处理')));
      expect(transport.sent.some((text) => text.includes('无需重复操作'))).toBe(true);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('reports accurate pending-recovery counts on startup', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
      pendingRecovery: async () => ({ dispatching: 2, pending: 3 }),
    });
    runtime.start();
    try {
      await waitUntil(() => transport.sent.some((text) => text.includes('2 条未确认')));
      expect(transport.sent.some((text) => text.includes('3 条已收到但未发送'))).toBe(true);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('marks command replies SKIPPED and chat messages DISPATCHED in the journal', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-runtime-journal-'));
    const journal = new InboxJournal(dir);
    await journal.appendInbox('bot-j', {
      message_id: 'm-perm',
      seq: 1,
      from_user_id: 'user-1',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'ALLOW' } }],
    });
    await journal.appendInbox('bot-j', {
      message_id: 'm-chat',
      seq: 2,
      from_user_id: 'user-1',
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    });
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      if (url.endsWith('/events') && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-j'));
        res.write(
          sseFrame(
            'permission.requested',
            { interactionId: 'i1', requestId: 'r1', toolName: 'Write', inputs: {} },
            'task-j',
          ),
        );
        return;
      }
      if (url.endsWith('/chat') && _req.method === 'POST') {
        writeJson(res, 202, {
          taskId: 'task-j2',
          projectId: FAKE_PROJECT_ID,
          tabId: FAKE_TAB_ID,
          status: 'accepted',
        });
        return;
      }
      if (url.includes('/permissions/i1/decision') && _req.method === 'POST') {
        writeJson(res, 200, { interactionId: 'i1', resolved: true });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: () =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${FAKE_TAB_ID}/events`,
          token: TOKEN,
        }),
      journal,
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.some((text) => text.includes('需要授权')));
      transport.emit({ messageId: 'bot-j:m-perm', text: 'ALLOW', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('已发送授权决定')));
      transport.emit({ messageId: 'bot-j:m-chat', text: 'hello', receivedAt: Date.now() });
      await waitUntil(() => gateway.requests.some((r) => r.url.endsWith('/chat')));
      await waitUntil(async () => (await journal.loadPending('bot-j')).length === 0);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('reopens SSE for the new target on rebind and routes messages there', async () => {
    const TAB_B = '11111111-2222-3333-4444-777777777777';
    const events: string[] = [];
    const chats: string[] = [];
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [
            { tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false },
            { tabId: TAB_B, index: 1, selected: false, busy: false },
          ],
        });
        return;
      }
      const eventsMatch = url.match(/\/tabs\/([0-9a-f-]{36})\/events$/);
      if (eventsMatch !== null && _req.method === 'GET') {
        events.push(eventsMatch[1] ?? '');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(': keepalive\n\n');
        return;
      }
      const chatMatch = url.match(/\/tabs\/([0-9a-f-]{36})\/chat$/);
      if (chatMatch !== null && _req.method === 'POST') {
        chats.push(chatMatch[1] ?? '');
        writeJson(res, 202, {
          taskId: `task-${chatMatch[1]}`,
          projectId: FAKE_PROJECT_ID,
          tabId: chatMatch[1],
          status: 'accepted',
        });
        return;
      }
      if (url.includes('/abort') && _req.method === 'POST') {
        writeJson(res, 202, { taskId: 'x', status: 'aborting' });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: (target) =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${target.tabId}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => events.includes(FAKE_TAB_ID));
      await app.bind(FAKE_PROJECT_ID, TAB_B);
      await waitUntil(() => events.includes(TAB_B));
      transport.emit({ messageId: 'bot-1:m1', text: 'hello', receivedAt: Date.now() });
      await waitUntil(() => chats.includes(TAB_B));
      expect(chats).toEqual([TAB_B]);
      expect(gateway.requests.some((r) => r.url.includes('/abort'))).toBe(false);
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('invalidates old interactions on rebind and rejects stale replies', async () => {
    const TAB_B = '11111111-2222-3333-4444-777777777777';
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [
            { tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false },
            { tabId: TAB_B, index: 1, selected: false, busy: false },
          ],
        });
        return;
      }
      const eventsMatch = url.match(/\/tabs\/([0-9a-f-]{36})\/events$/);
      if (eventsMatch !== null && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        if (eventsMatch[1] === FAKE_TAB_ID) {
          res.write(sseFrame('task.accepted', { state: 'ACCEPTED' }, 'task-old'));
          res.write(
            sseFrame(
              'permission.requested',
              { interactionId: 'i1', requestId: 'r1', toolName: 'Write', inputs: {} },
              'task-old',
            ),
          );
        }
        res.write(': keepalive\n\n');
        return;
      }
      if (url.endsWith('/chat') && _req.method === 'POST') {
        writeJson(res, 202, { taskId: 'task-new', projectId: FAKE_PROJECT_ID, tabId: TAB_B, status: 'accepted' });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: (target) =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${target.tabId}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await waitUntil(() => transport.sent.some((text) => text.includes('需要授权')));
      await app.bind(FAKE_PROJECT_ID, TAB_B);
      transport.emit({ messageId: 'bot-1:m-stale', text: 'ALLOW', receivedAt: Date.now() });
      await waitUntil(() => transport.sent.some((text) => text.includes('交互已失效')));
      expect(gateway.requests.some((r) => r.url.includes('/permissions/i1/decision'))).toBe(false);
      expect(gateway.requests.some((r) => r.url.endsWith('/chat'))).toBe(false);
      transport.emit({ messageId: 'bot-1:m2', text: 'hello', receivedAt: Date.now() });
      await waitUntil(() => gateway.requests.some((r) => r.url.endsWith('/chat')));
    } finally {
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });

  it('admission before rebind uses the captured old target; after rebind uses the new target', async () => {
    const TAB_B = '11111111-2222-3333-4444-777777777777';
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const chatOrder: string[] = [];
    const handler: FakeHandler = async (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [
            { tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false },
            { tabId: TAB_B, index: 1, selected: false, busy: false },
          ],
        });
        return;
      }
      const eventsMatch = url.match(/\/tabs\/([0-9a-f-]{36})\/events$/);
      if (eventsMatch !== null && _req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        res.write(': keepalive\n\n');
        return;
      }
      const chatMatch = url.match(/\/tabs\/([0-9a-f-]{36})\/chat$/);
      if (chatMatch !== null && _req.method === 'POST') {
        const tabId = chatMatch[1] ?? '';
        chatOrder.push(tabId);
        if (tabId === FAKE_TAB_ID) {
          await oldGate;
        }
        writeJson(res, 202, { taskId: `task-${tabId}`, projectId: FAKE_PROJECT_ID, tabId, status: 'accepted' });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN }) });
    const transport = new FakeTransport();
    const runtime = new AdapterRuntime({
      app,
      transport,
      outbound: new OutboundRouter({ sendText: (text) => transport.sendText(text) }),
      sseFactory: (target) =>
        new SseClient({
          url: `http://127.0.0.1:${gateway.port}/api/v1/projects/${FAKE_PROJECT_ID}/tabs/${target.tabId}/events`,
          token: TOKEN,
        }),
    });
    runtime.start();
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      transport.emit({ messageId: 'bot-1:m-before', text: 'before', receivedAt: Date.now() });
      await waitUntil(() => chatOrder.includes(FAKE_TAB_ID));
      await app.bind(FAKE_PROJECT_ID, TAB_B);
      transport.emit({ messageId: 'bot-1:m-after', text: 'after', receivedAt: Date.now() });
      await waitUntil(() => chatOrder.includes(TAB_B));
      releaseOld?.();
      await waitUntil(() => chatOrder.length >= 2);
      expect(chatOrder).toEqual([FAKE_TAB_ID, TAB_B]);
    } finally {
      releaseOld?.();
      await runtime.stop();
      app.stop();
      await gateway.stop();
    }
  });
});
