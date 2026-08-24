import test from 'node:test';
import assert from 'node:assert/strict';
import { AgyEventNormalizer } from './agy-event-normalizer.js';

function collect() {
  const lines = [];
  const n = new AgyEventNormalizer({
    log: (line) => lines.push(String(line)),
    error: () => {},
  });
  return { n, lines };
}

test('normalizer emits session id, deltas, tools, usage, success envelope', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'init',
    conversation_id: 'conv-abc',
    init: { cwd: '/tmp', tools: ['run_command'], permission_mode: 'request-review' },
  });
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-abc',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Hello ',
    },
  });
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-abc',
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'world',
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 },
    },
  });
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 4,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'echo hi' },
        output: 'hi\n',
      },
    },
  });
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: 'conv-abc',
      status: 'SUCCESS',
      response: 'Hello world',
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 },
    },
  });
  n.finishSuccess('conv-abc', 'Hello world');

  assert.ok(lines.some((l) => l.startsWith('[MESSAGE_START]')));
  assert.ok(lines.some((l) => l.startsWith('[STREAM_START]')));
  assert.ok(lines.some((l) => l === '[SESSION_ID] conv-abc'));
  assert.ok(lines.some((l) => l.startsWith('[CONTENT_DELTA]') && l.includes('Hello')));
  assert.ok(lines.some((l) => l.startsWith('[CONTENT_DELTA]') && l.includes('world')));
  assert.ok(lines.some((l) => l.startsWith('[TOOL_RESULT]') && l.includes('run_command')));
  assert.ok(lines.some((l) => l.startsWith('[USAGE]')));
  assert.ok(lines.some((l) => l.startsWith('[MESSAGE]')));
  assert.ok(lines.some((l) => l.startsWith('[STREAM_END]')));
  assert.ok(lines.some((l) => l.startsWith('[MESSAGE_END]')));
  const ok = lines.find((l) => l.startsWith('{') && l.includes('"success"'));
  assert.ok(ok);
  const env = JSON.parse(ok);
  assert.equal(env.success, true);
  assert.equal(env.sessionId, 'conv-abc');
  assert.equal(env.result, 'Hello world');
});

test('finishError emits SEND_ERROR', () => {
  const { n, lines } = collect();
  n.begin();
  n.finishError(new Error('authentication required'));
  assert.ok(lines.some((l) => l.startsWith('[SEND_ERROR]') && l.includes('authentication required')));
  const env = JSON.parse(lines.find((l) => l.startsWith('{') && l.includes('"success"')));
  assert.equal(env.success, false);
});

test('normalizer emits thinking deltas', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'thinking',
      thinking_delta: 'pondering',
    },
  });
  assert.ok(lines.some((l) => l.startsWith('[THINKING_DELTA]') && l.includes('pondering')));
});

test('result without streamed text emits content delta from response', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: 'final only',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  });
  n.finishSuccess('c1', 'final only');
  assert.ok(lines.some((l) => l.startsWith('[CONTENT_DELTA]') && l.includes('final only')));
  assert.equal(n.assistantText, 'final only');
  assert.equal(n.conversationId, 'c1');
});

test('result ERROR status records terminal error', () => {
  const { n } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: 'c-err',
      status: 'ERROR',
      error: 'auth failed',
      response: '',
    },
  });
  assert.equal(n._terminalError, 'auth failed');
});

test('falsy-but-present tool errors mark the result failed (0 / "" / false)', () => {
  // The adjacent contract says every present error value — "another JSON
  // value (number)" included — must mark the result failed; !!err marked
  // 0/""/false as success.
  for (const errValue of [0, '', false]) {
    const { n, lines } = collect();
    n.begin();
    n.handleStreamEvent({
      event: 'step_update',
      step_update: {
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: {}, error: errValue },
      },
    });
    const line = lines.find((l) => l.startsWith('[TOOL_RESULT]'));
    assert.ok(line, `no TOOL_RESULT emitted for error=${JSON.stringify(errValue)}`);
    assert.equal(
      JSON.parse(line.slice('[TOOL_RESULT] '.length)).is_error,
      true,
      `error=${JSON.stringify(errValue)} must be is_error`,
    );
  }
});

test('empty-string tool error renders the tool error label, not a bare Error line', () => {
  // errToText('') must fall back to the pre-diff 'tool error' label —
  // a trailing "Error: " with no diagnostic carries nothing.
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 3,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: {}, error: '' },
    },
  });
  const line = lines.find((l) => l.startsWith('[TOOL_RESULT]'));
  assert.ok(line, 'no TOOL_RESULT emitted');
  const parsed = JSON.parse(line.slice('[TOOL_RESULT] '.length));
  assert.equal(parsed.is_error, true);
  assert.match(parsed.content, /\nError: tool error$/);
});

test('absent or null tool error stays success', () => {
  for (const toolInfo of [
    { name: 'run_command', parameters: {}, output: 'done' },
    { name: 'run_command', parameters: {}, output: 'done', error: null },
  ]) {
    const { n, lines } = collect();
    n.begin();
    n.handleStreamEvent({
      event: 'step_update',
      step_update: {
        step_index: 5,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: toolInfo,
      },
    });
    const line = lines.find((l) => l.startsWith('[TOOL_RESULT]'));
    assert.ok(line);
    assert.equal(JSON.parse(line.slice('[TOOL_RESULT] '.length)).is_error, false);
  }
});

test('object-valued error message renders as JSON, not [object Object]', () => {
  // {message: {code: 1}} previously hit String(err.message) → "[object Object]"
  // before the stringify fallback could run.
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 7,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: {}, error: { message: { code: 1 } } },
    },
  });
  const line = lines.find((l) => l.startsWith('[TOOL_RESULT]'));
  assert.ok(line);
  const payload = JSON.parse(line.slice('[TOOL_RESULT] '.length));
  assert.ok(!payload.content.includes('[object Object]'), `body degenerated: ${payload.content}`);
  assert.ok(payload.content.includes('"code"'), `expected the stringified object, got: ${payload.content}`);

  // String messages keep passing through unchanged.
  const n2lines = [];
  const n2 = new AgyEventNormalizer({ log: (l) => n2lines.push(String(l)), error: () => {} });
  n2.begin();
  n2.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 8,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: {}, error: { message: 'boom', type: 'EIO' } },
    },
  });
  const line2 = n2lines.find((l) => l.startsWith('[TOOL_RESULT]'));
  assert.ok(line2);
  assert.ok(line2.includes('boom'));
});

test('checkpoint usage smaller than peak is not emitted', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: '2',
      usage: { input_tokens: 27793, output_tokens: 18, total_tokens: 27811 },
    },
  });
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_type: 'checkpoint',
      state: 'DONE',
      usage: { input_tokens: 96, output_tokens: 3, total_tokens: 99 },
    },
  });
  const usageLines = lines.filter((l) => l.startsWith('[USAGE]'));
  assert.equal(usageLines.length, 1);
  assert.ok(usageLines[0].includes('"input_tokens":27793'));
  assert.ok(usageLines[0].includes('"cache_read_input_tokens"'));
});

test('result usage is always emitted even if smaller', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      state: 'DONE',
      usage: { input_tokens: 5000, output_tokens: 1, total_tokens: 5001 },
    },
  });
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: 'c',
      status: 'SUCCESS',
      response: 'ok',
      usage: { input_tokens: 4000, output_tokens: 2, total_tokens: 4002 },
    },
  });
  const usageLines = lines.filter((l) => l.startsWith('[USAGE]'));
  assert.ok(usageLines.length >= 2);
  assert.ok(usageLines[usageLines.length - 1].includes('"input_tokens":4000'));
});

test('finishSuccess is idempotent for stream/message end tags', () => {
  const { n, lines } = collect();
  n.begin();
  n.finishSuccess('id', 'text');
  n.finishSuccess('id', 'text');
  assert.equal(lines.filter((l) => l === '[STREAM_END]').length, 1);
  assert.equal(lines.filter((l) => l === '[MESSAGE_END]').length, 1);
});

test('ignores null/unknown events', () => {
  const { n, lines } = collect();
  n.begin();
  const before = lines.length;
  n.handleStreamEvent(null);
  n.handleStreamEvent({ event: 'unknown_thing' });
  assert.equal(lines.length, before);
});

test('command_result stores command payload without emitting tags', () => {
  // agy ≥ 1.1.11 read-only slash commands: command_result + result pair,
  // no agent turn. Normalizer must not emit anything for command_result
  // itself (the text arrives via result) but keep the structured payload.
  const { n, lines } = collect();
  n.begin();
  const before = lines.length;
  n.handleStreamEvent({
    event: 'command_result',
    command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [] }] } },
  });
  assert.equal(lines.length, before);
  assert.equal(n.commandResult?.name, 'usage');

  // terminal result carries the human-readable table text
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: '',
      status: 'SUCCESS',
      response: 'Gemini Models\tWeekly Limit Remaining\t94%\t2026-08-18T23:37:11Z',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
  assert.ok(lines.some((l) => l.startsWith('[CONTENT_DELTA]')));
  assert.equal(n._terminalError, null);

  // begin() resets command state for the next turn
  n.begin();
  assert.equal(n.commandResult, null);
});

test('emits tool_use message and BLOCK_RESET when tool step update arrives', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: {
        name: 'view_file',
        parameters: { AbsolutePath: '/foo/bar.txt' },
      },
    },
  });

  const toolUseLine = lines.find((l) => l.startsWith('[MESSAGE]') && l.includes('"tool_use"'));
  assert.ok(toolUseLine, 'tool_use message should be emitted on ACTIVE tool step');
  assert.ok(toolUseLine.includes('view_file'));
  assert.ok(toolUseLine.includes('/foo/bar.txt'));
  assert.ok(lines.includes('[BLOCK_RESET]'), 'BLOCK_RESET should be emitted for tool step');
});

function toolResultPayload(lines) {
  const line = lines.find((l) => l.startsWith('[TOOL_RESULT]'));
  assert.ok(line, 'expected a [TOOL_RESULT] line');
  return JSON.parse(line.slice('[TOOL_RESULT] '.length));
}

test('string tool errors mark the result failed (AC18)', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 5,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'boom' },
        error: 'command exited with code 1',
      },
    },
  });
  const payload = toolResultPayload(lines);
  assert.equal(payload.is_error, true);
  assert.ok(payload.content.includes('Error: command exited with code 1'));
});

test('non-object tool error values (number) mark the result failed', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 6,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'boom' },
        error: 42,
      },
    },
  });
  const payload = toolResultPayload(lines);
  assert.equal(payload.is_error, true);
  assert.ok(payload.content.includes('42'));
});

test('huge tool error text is capped like normal output', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 7,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'flood' },
        error: 'E'.repeat(50_000),
      },
    },
  });
  const payload = toolResultPayload(lines);
  assert.equal(payload.is_error, true);
  assert.ok(payload.content.length <= 8_100, `expected capped body, got ${payload.content.length}`);
});

test('array tool error values mark the result failed and render readably', () => {
  // agy has no schema contract for tool_info.error — an array must not
  // silently render as "success" or crash String coercion.
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 8,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'boom' },
        error: ['exit 1'],
      },
    },
  });
  const payload = toolResultPayload(lines);
  assert.equal(payload.is_error, true);
  assert.ok(payload.content.includes('exit 1'), `expected array contents in body, got: ${payload.content}`);
});

test('object tool errors without message/type render via JSON (e.g. {code})', () => {
  // {code:'ENOENT'} has neither .message nor .type — JSON.stringify keeps
  // the diagnostic instead of collapsing to "[object Object]".
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 9,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: {
        name: 'view_file',
        parameters: { AbsolutePath: '/gone' },
        error: { code: 'ENOENT' },
      },
    },
  });
  const payload = toolResultPayload(lines);
  assert.equal(payload.is_error, true);
  assert.ok(payload.content.includes('ENOENT'), `expected code in body, got: ${payload.content}`);
  assert.ok(!payload.content.includes('[object Object]'));
});

test('error line survives the cap when the summary alone would fill it', () => {
  // The error is the diagnostic; a front-truncated combined string would
  // cut exactly the Error: line away and leave a wall of command text.
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 10,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'S'.repeat(50_000) },
        error: 'spawn failed',
      },
    },
  });
  const payload = toolResultPayload(lines);
  assert.equal(payload.is_error, true);
  assert.ok(payload.content.length <= 8_100, `expected capped body, got ${payload.content.length}`);
  assert.ok(payload.content.endsWith('\nError: spawn failed'), 'Error line must be preserved at the end');
});

