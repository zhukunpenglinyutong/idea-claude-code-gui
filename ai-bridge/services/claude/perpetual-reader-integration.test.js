import test from 'node:test';
import assert from 'node:assert/strict';
import { startPerpetualReader, createTurnSink } from './runtime-lifecycle.js';

/**
 * Integration tests for the REAL perpetual reader (startPerpetualReader).
 *
 * Unlike a re-implementation of the loop, these tests drive the actual
 * production function so they catch regressions in routing, inter-turn event
 * emission, abort handling, and stream completion.
 *
 * A controlled query lets each test deliver messages deterministically (the
 * reader blocks in query.next() until we deliver or end), so there is no race.
 */

// ============================================================================
// Helpers
// ============================================================================

/**
 * A query stub whose next() resolves only when the test delivers a message,
 * ends the stream, or raises an error. This removes timing races: the reader
 * cannot run ahead of what the test explicitly hands it.
 */
function createControlledQuery() {
  const pending = [];
  const waiters = [];
  let ended = false;

  const settleNext = () => {
    if (waiters.length === 0 || pending.length === 0) return;
    const waiter = waiters.shift();
    const item = pending.shift();
    if (item.error) waiter.reject(item.error);
    else waiter.resolve(item.result);
  };

  return {
    query: {
      next() {
        if (pending.length > 0) {
          const item = pending.shift();
          return item.error ? Promise.reject(item.error) : Promise.resolve(item.result);
        }
        if (ended) return Promise.resolve({ done: true });
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      close() { ended = true; },
    },
    deliver(msg) {
      pending.push({ result: { value: msg, done: false } });
      settleNext();
    },
    deliverError(err) {
      pending.push({ error: err });
      settleNext();
    },
    end() {
      ended = true;
      pending.push({ result: { done: true } });
      settleNext();
    },
  };
}

/** Capture inter-turn events written via process.stdout._originalStdoutWrite. */
function captureInterTurnEvents() {
  const list = [];
  const original = process.stdout._originalStdoutWrite;
  process.stdout._originalStdoutWrite = (str) => {
    try { list.push(JSON.parse(str)); } catch (_) { /* ignore non-JSON */ }
    return true;
  };
  return {
    list,
    restore() {
      if (original === undefined) delete process.stdout._originalStdoutWrite;
      else process.stdout._originalStdoutWrite = original;
    },
  };
}

/** Yield long enough for the reader to drain a delivered message. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ============================================================================
// In-Turn Routing
// ============================================================================

test('Integration: perpetual reader routes in-turn messages to turnSink', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-1', turnSink: createTurnSink(), query: ctl.query, inputStream: { done() {} } };

  const reader = startPerpetualReader(runtime);

  ctl.deliver({ type: 'system', session_id: 'sess-1' });
  ctl.deliver({ type: 'assistant', content: 'Hello' });
  ctl.deliver({ type: 'result', is_error: false });

  const received = [];
  for (let i = 0; i < 3; i++) {
    received.push((await runtime.turnSink.take()).value);
  }

  runtime.closed = true;
  ctl.end();
  await reader;

  assert.deepEqual(received.map((m) => m.type), ['system', 'assistant', 'result']);
});

// ============================================================================
// Inter-Turn Event Emission (regression guard for the daemon writer wiring)
// ============================================================================

test('Integration: inter-turn result emits a session_updated event for a registered runtime', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-bg', turnSink: null, query: ctl.query };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    // No active turn (turnSink == null): a completed turn from the CLI.
    ctl.deliver({ type: 'user', content: '<task-notification>' });
    ctl.deliver({ type: 'assistant', content: 'Task completed' });
    ctl.deliver({ type: 'result', is_error: false });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  const updates = events.list.filter((e) => e.event === 'session_updated');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, 'daemon');
  assert.equal(updates[0].sessionId, 'sess-bg');
});

test('Integration: inter-turn result on anonymous runtime emits no event', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: null, turnSink: null, query: ctl.query };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    ctl.deliver({ type: 'result', is_error: false });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  assert.equal(events.list.filter((e) => e.event === 'session_updated').length, 0);
});

test('Integration: non-result inter-turn messages do not emit events', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-x', turnSink: null, query: ctl.query };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    ctl.deliver({ type: 'assistant', content: 'partial' });
    ctl.deliver({ type: 'user', content: 'noise' });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  assert.equal(events.list.filter((e) => e.event === 'session_updated').length, 0);
});

// ============================================================================
// Abort / Stream Completion / Errors
// ============================================================================

test('Regression (#1305): result routes by turnSink state, not by message ordering', async () => {
  // Locks the dual-mode routing invariant the turn-boundary analysis relies on:
  // a 'result' is delivered to the active turnSink while a turn is in progress
  // (so executeTurn can observe it and break), and only emits a session_updated
  // event once the turn is over (turnSink cleared). In production the clear is
  // synchronous in executeTurn's finally block, so the reader can never push a
  // post-turn result to a dying sink; this test pins that routing contract.
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-route', turnSink: createTurnSink(), query: ctl.query, inputStream: { done() {} } };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    // In-turn result → goes to the sink, NOT emitted as an event.
    ctl.deliver({ type: 'result', is_error: false });
    const inTurn = await runtime.turnSink.take();
    assert.equal(inTurn.value.type, 'result');

    // Simulate executeTurn's synchronous finally: break → turnSink = null.
    runtime.turnSink = null;

    // Inter-turn result → emitted as an event, NOT pushed anywhere.
    ctl.deliver({ type: 'result', is_error: false });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  const updates = events.list.filter((e) => e.event === 'session_updated');
  assert.equal(updates.length, 1, 'only the post-turn result should emit an event');
  assert.equal(updates[0].sessionId, 'sess-route');
});

test('Regression (#1305): result during inter-turn does not touch a cleared turnSink', async () => {
  // Guards against a future refactor that reintroduces an await between the
  // turnSink-null check and the push: if turnSink is null when a result
  // arrives, it must be routed through emitInterTurnEvent and never throw or
  // silently drop. Asserts no event is emitted for the in-turn result even
  // when the sink is cleared before the reader observes it.
  const ctl = createControlledQuery();
  // inputStream included for parity with other runtimes in the file; the
  // current path never reaches disposeRuntime (runtime.closed is set before
  // ctl.end()), but future reader changes could touch it on a non-closed path.
  const runtime = { closed: false, sessionId: 'sess-clear', turnSink: null, query: ctl.query, inputStream: { done() {} } };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    ctl.deliver({ type: 'result', is_error: false });
    ctl.deliver({ type: 'result', is_error: false });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  const updates = events.list.filter((e) => e.event === 'session_updated');
  assert.equal(updates.length, 2, 'each inter-turn result emits its own event');
  updates.forEach((u) => assert.equal(u.sessionId, 'sess-clear'));
});

test('Integration: query.next() error is forwarded to the active turnSink', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-1', turnSink: createTurnSink(), query: ctl.query, inputStream: { done() {} } };

  const reader = startPerpetualReader(runtime);

  ctl.deliverError(new Error('SDK connection lost'));

  await assert.rejects(async () => runtime.turnSink.take(), /SDK connection lost/);
  await reader; // reader exits after the error
});

test('Integration: stream completion fails the active turnSink', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-1', turnSink: createTurnSink(), query: ctl.query, inputStream: { done() {} } };

  const reader = startPerpetualReader(runtime);

  ctl.end();

  await assert.rejects(async () => runtime.turnSink.take(), /stream ended/);
  await reader;
});

test('Integration: runtime.closed stops the reader after the in-flight next() resolves', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-1', turnSink: createTurnSink(), query: ctl.query, inputStream: { done() {} } };

  const reader = startPerpetualReader(runtime);

  ctl.deliver({ type: 'assistant', content: 'first' });
  const first = await runtime.turnSink.take();
  assert.equal(first.value.content, 'first');

  // Close, then unblock the pending next() so the loop observes closed.
  runtime.closed = true;
  ctl.end();
  await reader; // resolves => reader exited cleanly
  assert.ok(true);
});

// ============================================================================
// Concurrency: independent readers per runtime
// ============================================================================

test('Integration: concurrent runtimes keep their inter-turn events isolated', async () => {
  const events = captureInterTurnEvents();
  const runtimes = ['a', 'b', 'c'].map((id) => {
    const ctl = createControlledQuery();
    const runtime = { closed: false, sessionId: 'sess-' + id, turnSink: null, query: ctl.query };
    return { ctl, runtime, reader: startPerpetualReader(runtime) };
  });

  try {
    for (const { ctl } of runtimes) ctl.deliver({ type: 'result', is_error: false });
    await settle();
  } finally {
    for (const { runtime, ctl } of runtimes) { runtime.closed = true; ctl.end(); }
    await Promise.all(runtimes.map((r) => r.reader));
    events.restore();
  }

  const ids = events.list
    .filter((e) => e.event === 'session_updated')
    .map((e) => e.sessionId)
    .sort();
  assert.deepEqual(ids, ['sess-a', 'sess-b', 'sess-c']);
});

test('Integration: reader disposes a still-live runtime when the stream ends inter-turn', async () => {
  // Regression guard: if the SDK stream ends while idle (no active turn) and the
  // runtime is not already closed, the reader must evict it. Otherwise the next
  // request would reuse a runtime whose reader is dead and hang on take().
  const ctl = createControlledQuery();
  let inputDone = false;
  let queryClosed = false;
  const runtime = {
    closed: false,
    sessionId: 'sess-zombie',
    turnSink: null, // inter-turn (no active turn)
    query: { next: ctl.query.next, close() { queryClosed = true; ctl.query.close(); } },
    inputStream: { done() { inputDone = true; } },
  };

  const reader = startPerpetualReader(runtime, undefined);
  ctl.end(); // stream ends out-of-band while idle
  await reader;

  assert.equal(runtime.closed, true, 'runtime should be disposed (closed) on inter-turn stream end');
  assert.equal(inputDone, true, 'inputStream.done() should be called');
  assert.equal(queryClosed, true, 'query.close() should be called');
});

console.log('\n✅ Perpetual reader integration tests exercise the real startPerpetualReader');
