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

test('Integration: inter-turn background turn emits throttled progress nudges plus the result event', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-bg', turnSink: null, query: ctl.query };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    // No active turn (turnSink == null): a completed turn from the CLI.
    // The first content message emits a throttled progress nudge; the
    // assistant message lands inside the throttle window and is coalesced;
    // the result always emits.
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
  assert.equal(updates.length, 2);
  updates.forEach((u) => {
    assert.equal(u.type, 'daemon');
    assert.equal(u.sessionId, 'sess-bg');
  });
});

test('Integration: inter-turn background turn emits background_turn active then idle', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-bg2', turnSink: null, query: ctl.query };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    ctl.deliver({ type: 'user', content: '<task-notification>' });
    ctl.deliver({ type: 'assistant', content: 'chunk 1' });
    ctl.deliver({ type: 'assistant', content: 'chunk 2' });
    ctl.deliver({ type: 'result', is_error: false });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  const turnEvents = events.list.filter((e) => e.event === 'background_turn');
  // First message of the burst emits 'active' immediately; the result emits
  // 'idle'. The heartbeat is timer-driven (5s default) so none fire inside
  // this fast test.
  assert.deepEqual(turnEvents.map((e) => e.state), ['active', 'idle']);
  turnEvents.forEach((e) => {
    assert.equal(e.type, 'daemon');
    assert.equal(e.sessionId, 'sess-bg2');
  });
  // The idle event must arrive with (or before) the result's session_updated,
  // never linger past it.
  const lastIdleIdx = events.list.findIndex((e) => e.event === 'background_turn' && e.state === 'idle');
  const resultUpdateIdx = events.list.map((e) => e.event).lastIndexOf('session_updated');
  assert.ok(lastIdleIdx <= resultUpdateIdx, 'idle should not trail the final session_updated');
});

test('Integration: background_turn heartbeat keeps firing through silent gaps and stops on idle', async () => {
  const ctl = createControlledQuery();
  // Background turns routinely go silent for minutes (long tool call, deep
  // thinking); the heartbeat must be timer-driven so the webview TTL cannot
  // expire mid-turn. Shrunk interval so the test observes several ticks.
  const runtime = { closed: false, sessionId: 'sess-hb', turnSink: null, query: ctl.query, interTurnHeartbeatMs: 15 };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    ctl.deliver({ type: 'assistant', content: 'starting long silent work' });
    // Silence: no further messages while the heartbeat interval ticks.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const activeDuringSilence = events.list.filter(
      (e) => e.event === 'background_turn' && e.state === 'active',
    ).length;
    assert.ok(activeDuringSilence >= 3,
      `expected timer heartbeats during silence, got ${activeDuringSilence}`);

    ctl.deliver({ type: 'result', is_error: false });
    await settle();
    const afterIdleCount = events.list.filter((e) => e.event === 'background_turn').length;
    assert.equal(events.list[events.list.length - 1].event === 'background_turn'
      ? events.list[events.list.length - 1].state : 'idle', 'idle');
    // No further heartbeats after idle — the timer must be cleared.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.list.filter((e) => e.event === 'background_turn').length, afterIdleCount);
    const states = events.list.filter((e) => e.event === 'background_turn').map((e) => e.state);
    assert.equal(states[states.length - 1], 'idle');
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }
});

test('Integration: reader exit mid-background-turn emits background_turn idle', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-dead', turnSink: null, query: ctl.query, inputStream: { done() {} }, query_close: null };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    ctl.deliver({ type: 'assistant', content: 'chunk' });
    await settle();
    // Stream dies without a result message.
    ctl.deliverError(new Error('subprocess died'));
    await reader;
  } finally {
    events.restore();
  }

  const turnEvents = events.list.filter((e) => e.event === 'background_turn');
  assert.equal(turnEvents[turnEvents.length - 1].state, 'idle');
  assert.equal(turnEvents[turnEvents.length - 1].sessionId, 'sess-dead');
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

test('Integration: non-result inter-turn messages emit a single throttled nudge', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: 'sess-x', turnSink: null, query: ctl.query };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    // Both messages arrive within the 2s throttle window: exactly one nudge.
    ctl.deliver({ type: 'assistant', content: 'partial' });
    ctl.deliver({ type: 'user', content: 'noise' });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  const updates = events.list.filter((e) => e.event === 'session_updated');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sessionId, 'sess-x');
});

test('Integration: inter-turn result falls back to the session id carried on the message', async () => {
  const ctl = createControlledQuery();
  const runtime = { closed: false, sessionId: null, turnSink: null, query: ctl.query };
  const events = captureInterTurnEvents();

  const reader = startPerpetualReader(runtime);
  try {
    ctl.deliver({ type: 'result', is_error: false, session_id: 'sess-from-msg' });
    await settle();
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }

  const updates = events.list.filter((e) => e.event === 'session_updated');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sessionId, 'sess-from-msg');
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

test('Regression: disposeRuntime stops the background_turn heartbeat even when the reader is wedged', async () => {
  // A background workflow keeps the perpetual reader parked in query.next().
  // If the subprocess goes silent instead of emitting EOF, query.close() never
  // settles the pending next(), so the reader's finally (which clears the
  // heartbeat) never runs. disposeRuntime must therefore clear the interval
  // itself; otherwise the heartbeat leaks — the 5s cadence observed firing
  // past workflow completion.
  const { disposeRuntime } = await import('./runtime-lifecycle.js');
  const ctl = createControlledQuery();
  const runtime = {
    closed: false,
    sessionId: 'sess-dispose',
    turnSink: null, // inter-turn
    query: ctl.query,
    inputStream: { done() {} },
    interTurnHeartbeatMs: 15,
  };
  const events = captureInterTurnEvents();
  const reader = startPerpetualReader(runtime, {});
  try {
    ctl.deliver({ type: 'assistant', content: 'background work begins' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = events.list.filter((e) => e.event === 'background_turn' && e.state === 'active').length;
    assert.ok(started >= 1, `heartbeat should have started, got ${started}`);

    // close() sets ended=true but does NOT settle the parked next() — the
    // reader stays wedged, exactly the leak scenario.
    await disposeRuntime(runtime, {});
    assert.equal(runtime.interTurnHeartbeatTimer ?? null, null, 'disposeRuntime must clear the heartbeat timer');

    const afterDispose = events.list.length;
    await new Promise((resolve) => setTimeout(resolve, 60)); // > interval: no new ticks allowed
    const leaked = events.list.slice(afterDispose)
      .filter((e) => e.event === 'background_turn' && e.state === 'active');
    assert.equal(leaked.length, 0, `heartbeat leaked ${leaked.length} ticks after dispose`);
  } finally {
    runtime.closed = true;
    ctl.end();
    await reader;
    events.restore();
  }
});

console.log('\n✅ Perpetual reader integration tests exercise the real startPerpetualReader');
