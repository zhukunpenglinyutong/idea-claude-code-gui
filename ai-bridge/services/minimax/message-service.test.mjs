import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMiniMaxStreamLine } from './message-service.js';

test('delta content maps to text event', () => {
  const line = JSON.stringify({
    type: 'delta', messageId: 'm1', role: 'assistant',
    content: 'hello', chunkIndex: 1,
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'text', data: 'hello', messageId: 'm1',
  });
});

test('delta thinking maps to thinking event', () => {
  const line = JSON.stringify({
    type: 'delta', messageId: 'm2', role: 'assistant',
    thinking: 'pondering', chunkIndex: 2,
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'thinking', data: 'pondering', messageId: 'm2',
  });
});

test('delta with toolCalls status 1 maps to tool_start', () => {
  const line = JSON.stringify({
    type: 'delta', role: 'assistant', chunkIndex: 3,
    toolCalls: [{ id: 'call-1', name: 'bash', status: 1, input: { command: 'ls' } }],
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'tool_start');
  assert.equal(event.call.id, 'call-1');
  assert.equal(event.call.name, 'bash');
  assert.deepEqual(event.call.input, { command: 'ls' });
});

test('delta with toolCalls status 2 maps to tool_done with output text', () => {
  const line = JSON.stringify({
    type: 'delta', role: 'assistant', chunkIndex: 4,
    toolCalls: [{
      id: 'call-2', name: 'bash', status: 2, input: { command: 'pwd' },
      output: { content: [{ type: 'text', text: '/repo' }] },
    }],
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'tool_done');
  assert.equal(event.call.id, 'call-2');
  assert.equal(event.output, '/repo');
});

test('assistant message with usage maps to usage event', () => {
  const line = JSON.stringify({
    type: 'message',
    message: {
      id: 'm3', role: 'assistant', content: 'ok',
      usage: { totalTokens: 10, inputTokens: 4, outputTokens: 6 },
    },
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.kind, 'usage');
  assert.deepEqual(event.usage, { totalTokens: 10, inputTokens: 4, outputTokens: 6 });
});

test('exec.result maps to result event with sessionId', () => {
  const line = JSON.stringify({
    schemaVersion: 1, type: 'exec.result',
    sessionId: 'mvs_abc123', status: 'succeeded', answer: 'done',
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'result', sessionId: 'mvs_abc123', status: 'succeeded',
    failed: false, errorMessage: '',
  });
});

test('exec.result with failed status is flagged and carries the error text', () => {
  const line = JSON.stringify({
    type: 'exec.result', status: 'failed', error: 'permission denied',
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), {
    kind: 'result', sessionId: '', status: 'failed',
    failed: true, errorMessage: 'permission denied',
  });
});

test('exec.result failure falls back to the message field', () => {
  const line = JSON.stringify({
    type: 'exec.result', status: 'cancelled', message: 'aborted by user',
  });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.failed, true);
  assert.equal(event.errorMessage, 'aborted by user');
});

test('exec.result without a status is not treated as failure', () => {
  const line = JSON.stringify({ type: 'exec.result', sessionId: 'mvs_x' });
  const event = parseMiniMaxStreamLine(line);
  assert.equal(event.failed, false);
  assert.equal(event.errorMessage, '');
});

test('noise events (heartbeat/generic/session-status/done/user message) are ignored', () => {
  assert.deepEqual(parseMiniMaxStreamLine('{"type":"heartbeat","turnId":"t1"}'), { kind: 'other' });
  assert.deepEqual(
    parseMiniMaxStreamLine('{"type":"generic","eventType":"query_collapse_view"}'),
    { kind: 'other' },
  );
  assert.deepEqual(parseMiniMaxStreamLine('{"type":"done","turnId":"t1"}'), { kind: 'other' });
  assert.deepEqual(
    parseMiniMaxStreamLine('{"type":"message","message":{"role":"user","content":"hi"}}'),
    { kind: 'other' },
  );
  assert.deepEqual(parseMiniMaxStreamLine('not json'), { kind: 'other' });
  assert.deepEqual(parseMiniMaxStreamLine(''), { kind: 'other' });
});

test('empty delta with finish flag is ignored', () => {
  const line = JSON.stringify({
    type: 'delta', messageId: 'm4', role: 'assistant', chunkIndex: 9, finish: true,
  });
  assert.deepEqual(parseMiniMaxStreamLine(line), { kind: 'other' });
});
