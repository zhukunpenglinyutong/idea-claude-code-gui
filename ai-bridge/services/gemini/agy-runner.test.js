import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgyTurn } from './agy-runner.js';

function makeFakeAgy(scriptBody) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fake-'));
  const bin = join(dir, 'agy-fake');
  writeFileSync(bin, scriptBody, { encoding: 'utf8' });
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test('runAgyTurn parses NDJSON stream and returns SUCCESS', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
const events = [
  { event: 'init', conversation_id: 'conv-1' },
  { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'hi', state: 'DONE' } },
  { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'hi', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];
for (const e of events) console.log(JSON.stringify(e));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const events = [];
    const turn = await runAgyTurn({
      message: 'hello',
      onEvent: (e) => events.push(e),
    });
    assert.equal(turn.conversationId, 'conv-1');
    assert.equal(turn.status, 'SUCCESS');
    assert.equal(turn.response, 'hi');
    assert.equal(turn.exitCode, 0);
    assert.ok(events.some((e) => e.event === 'init'));
    assert.ok(events.some((e) => e.event === 'result'));
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn rejects when binary missing', async () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  const prevPath = process.env.PATH;
  process.env.AGY_PATH = '/nonexistent/agy-binary-xyz';
  process.env.GEMINI_CLI_PATH = '';
  process.env.AGY_CLI_PATH = '';
  process.env.PATH = '';
  try {
    await assert.rejects(
      () => runAgyTurn({ message: 'x' }),
      /not found/i,
    );
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
    process.env.PATH = prevPath;
  }
});

test('runAgyTurn not-found hint names both AGY_PATH and AGY_CLI_PATH', async () => {
  // The Java detector (CliStatusDetector) honors AGY_PATH and AGY_CLI_PATH —
  // the hint must list both, or users following it stay broken.
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  const prevPath = process.env.PATH;
  process.env.AGY_PATH = '/nonexistent/agy-binary-xyz';
  process.env.GEMINI_CLI_PATH = '/nonexistent/gemini';
  process.env.AGY_CLI_PATH = '';
  process.env.PATH = '';
  try {
    await assert.rejects(
      () => runAgyTurn({ message: 'x' }),
      (err) => {
        assert.match(err.message, /not found/i);
        assert.match(err.message, /AGY_PATH/);
        assert.match(err.message, /AGY_CLI_PATH/);
        // Setups that followed the old spec must be pointed at the cause.
        assert.match(err.message, /GEMINI_CLI_PATH is deliberately ignored/);
        return true;
      },
    );
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
    process.env.PATH = prevPath;
  }
});

test('runAgyTurn rejects hard failure with no partial output', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
console.error('authentication required');
process.exit(2);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    await assert.rejects(
      () => runAgyTurn({ message: 'x' }),
      /authentication required|exited with code/i,
    );
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn never passes --effort (effort is in model slug only)', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'ok' } }));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  const logPath = join(dir, 'argv.json');
  process.env.AGY_PATH = bin;
  process.env.AGY_ARGV_LOG = logPath;
  try {
    await runAgyTurn({
      message: 'hi',
      model: 'claude-sonnet-4-6',
      reasoningEffort: '',
    });
    const { readFileSync } = await import('node:fs');
    const argv = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.ok(argv.includes('--model'));
    assert.ok(argv.includes('claude-sonnet-4-6'));
    assert.ok(!argv.includes('--effort'), 'must not pass --effort, got: ' + argv.join(' '));
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    delete process.env.AGY_ARGV_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn upgrades bare gemini family to full effort slug', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.AGY_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'ok' } }));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  const logPath = join(dir, 'argv-flash.json');
  process.env.AGY_PATH = bin;
  process.env.AGY_ARGV_LOG = logPath;
  try {
    await runAgyTurn({
      message: 'hi',
      model: 'gemini-3.6-flash',
      reasoningEffort: '',
    });
    const { readFileSync } = await import('node:fs');
    const argv = JSON.parse(readFileSync(logPath, 'utf8'));
    assert.ok(argv.includes('--model'));
    // No cached catalog in tests → bare family falls back to -high.
    assert.ok(argv.includes('gemini-3.6-flash-high'), 'got: ' + argv.join(' '));
    assert.ok(!argv.includes('--effort'), 'must not pass --effort, got: ' + argv.join(' '));
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    delete process.env.AGY_ARGV_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn surfaces ERROR status payload despite exit code 0', async () => {
  // agy ≥ 1.1.11: interactive-only slash commands (e.g. /clear) exit 0 but
  // carry status:"ERROR" + actionable error text in the result payload.
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: '',
    status: 'ERROR',
    response: '',
    error: '/clear is not available in print mode (every print-mode run already starts a new conversation unless --continue or --conversation is passed); pass --disable-slash-commands to send /clear to the model as literal text',
  },
}));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const turn = await runAgyTurn({ message: '/clear' });
    assert.equal(turn.exitCode, 0);
    assert.equal(turn.status, 'ERROR');
    assert.match(turn.error, /not available in print mode/);
    // callers (message-service) throw on non-SUCCESS without response text
    assert.equal(turn.response, '');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

function signalListenerCount() {
  // Per-turn shutdown hooks: exit/SIGTERM/SIGINT. Stacked leftovers from
  // earlier turns all run on the next signal (each calling process.exit(0)).
  return process.listenerCount('exit')
    + process.listenerCount('SIGTERM')
    + process.listenerCount('SIGINT');
}

test('runAgyTurn removes signal listeners when the turn closes (AC4)', async () => {
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'ok' } }));
process.exit(0);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const before = signalListenerCount();
    await runAgyTurn({ message: 'x' });
    assert.equal(signalListenerCount(), before, 'close path must remove exit/SIGTERM/SIGINT hooks');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn removes signal listeners when the spawn errors (AC4)', async () => {
  // Non-executable file → EACCES spawn error (never reaches close handling).
  const dir = mkdtempSync(join(tmpdir(), 'agy-err-'));
  const bin = join(dir, 'agy-noexec');
  writeFileSync(bin, '#!/usr/bin/env node\n', { encoding: 'utf8' });
  chmodSync(bin, 0o644);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const before = signalListenerCount();
    await assert.rejects(() => runAgyTurn({ message: 'x' }));
    assert.equal(signalListenerCount(), before, 'error path must remove exit/SIGTERM/SIGINT hooks');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn watchdog removes signal listeners on timeout (AC4)', async () => {
  // The watchdog path removes the hooks itself before rejecting; a stacked
  // leftover here would exit(0) the daemon on the next signal.
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
setInterval(() => {}, 60_000); // hang forever — watchdog must reap us
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const before = signalListenerCount();
    await assert.rejects(
      () => runAgyTurn({ message: 'x', turnTimeoutMs: 250 }),
      /timed out/,
    );
    assert.equal(signalListenerCount(), before, 'timeout path must remove exit/SIGTERM/SIGINT hooks');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn idle watchdog stays armed by streaming output', async () => {
  // Emits a line every 80ms for 600ms total — 2.4x the 250ms idle window —
  // then finishes. A hard TOTAL cap would have killed this turn at 250ms;
  // only idle semantics (re-arm on each line) let active long turns live.
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
let i = 0;
const iv = setInterval(() => {
  console.log(JSON.stringify({ event: 'step_update', seq: i++ }));
}, 80);
setTimeout(() => {
  clearInterval(iv);
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'ok' } }));
  process.exit(0);
}, 600);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const turn = await runAgyTurn({ message: 'x', turnTimeoutMs: 250 });
    assert.equal(turn.status, 'SUCCESS');
    assert.equal(turn.response, 'ok');
    assert.equal(turn.exitCode, 0);
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgyTurn watchdog reaps a turn that goes silent after output', async () => {
  // One line, then silence: guards the IDLE semantics against a naive
  // "first output disables the watchdog" misimplementation — the timer
  // restarts on the line and still fires after the quiet window.
  const { dir, bin } = makeFakeAgy(`#!/usr/bin/env node
console.log(JSON.stringify({ event: 'step_update', n: 1 }));
setInterval(() => {}, 60_000);
`);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    await assert.rejects(
      () => runAgyTurn({ message: 'x', turnTimeoutMs: 250 }),
      /no output for/,
    );
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

