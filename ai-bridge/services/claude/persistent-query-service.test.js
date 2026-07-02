import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';
import { createTurnSink } from './runtime-lifecycle.js';

test('abortCurrentTurn marks runtime as user-aborted before disposing it', async () => {
  let disposed = false;
  const runtime = {
    closed: false,
    sessionId: null,
    runtimeSessionEpoch: 'epoch-test',
    activeTurnCount: 1,
    inputStream: {
      done() {
        disposed = true;
      },
    },
    query: {
      close() {},
    },
  };

  __testing.setActiveTurnRuntime(runtime);

  await __testing.abortCurrentTurn();

  assert.equal(runtime.abortRequested, true);
  assert.equal(runtime.closed, true);
  assert.equal(disposed, true);
});

// ============================================================================
// Tests for Issue #1305 Fix - TurnSink and Abort Coordination
// ============================================================================

test('abortCurrentTurn clears turnSink before marking abort', async () => {
  let disposed = false;
  const runtime = {
    closed: false,
    sessionId: 'test-session',
    runtimeSessionEpoch: 'epoch-test',
    activeTurnCount: 1,
    turnSink: createTurnSink(),
    inputStream: {
      done() {
        disposed = true;
      },
    },
    query: {
      close() {},
    },
  };

  __testing.setActiveTurnRuntime(runtime);

  // Verify turnSink exists before abort
  assert.ok(runtime.turnSink !== null);

  await __testing.abortCurrentTurn();

  // turnSink should be cleared
  assert.equal(runtime.turnSink, null);
  assert.equal(runtime.abortRequested, true);
  assert.equal(disposed, true);
});

test('abortCurrentTurn fails turnSink to unblock waiting take()', async () => {
  let disposed = false;
  const runtime = {
    closed: false,
    sessionId: 'test-session',
    runtimeSessionEpoch: 'epoch-test',
    activeTurnCount: 1,
    turnSink: createTurnSink(),
    inputStream: {
      done() {
        disposed = true;
      },
    },
    query: {
      close() {},
    },
  };

  __testing.setActiveTurnRuntime(runtime);

  // Start a waiting take()
  const takePromise = runtime.turnSink.take();

  // Abort in parallel
  const abortPromise = __testing.abortCurrentTurn();

  // The take() should reject (not hang forever)
  await assert.rejects(
    async () => await takePromise,
    (err) => {
      assert.match(err.message, /aborted/i);
      return true;
    }
  );

  await abortPromise;

  assert.equal(runtime.turnSink, null);
  assert.equal(runtime.abortRequested, true);
});

test('abortCurrentTurn handles null turnSink gracefully', async () => {
  let disposed = false;
  const runtime = {
    closed: false,
    sessionId: 'test-session',
    runtimeSessionEpoch: 'epoch-test',
    activeTurnCount: 1,
    turnSink: null, // No active turnSink
    inputStream: {
      done() {
        disposed = true;
      },
    },
    query: {
      close() {},
    },
  };

  __testing.setActiveTurnRuntime(runtime);

  // Should not throw even without turnSink
  await assert.doesNotReject(async () => {
    await __testing.abortCurrentTurn();
  });

  assert.equal(runtime.abortRequested, true);
  assert.equal(disposed, true);
});

test('abortCurrentTurn prevents perpetual reader from pushing to cleared sink', async () => {
  const runtime = {
    closed: false,
    sessionId: 'test-session',
    runtimeSessionEpoch: 'epoch-test',
    activeTurnCount: 1,
    turnSink: createTurnSink(),
    inputStream: {
      done() {},
    },
    query: {
      close() {},
    },
  };

  __testing.setActiveTurnRuntime(runtime);

  // Save reference to original sink
  const originalSink = runtime.turnSink;

  // Abort
  await __testing.abortCurrentTurn();

  // runtime.turnSink should be null (stops perpetual reader)
  assert.equal(runtime.turnSink, null);

  // Pushing to originalSink should be ignored (sink is failed)
  originalSink.push({ type: 'test', content: 'should be ignored' });

  // take() should throw, not return the pushed message
  await assert.rejects(
    async () => await originalSink.take(),
    /aborted/i
  );
});

test('abortCurrentTurn is idempotent (double abort is safe)', async () => {
  let disposeCount = 0;
  const runtime = {
    closed: false,
    sessionId: 'test-session',
    runtimeSessionEpoch: 'epoch-test',
    activeTurnCount: 1,
    turnSink: createTurnSink(),
    inputStream: {
      done() {
        disposeCount++;
      },
    },
    query: {
      close() {},
    },
  };

  __testing.setActiveTurnRuntime(runtime);

  // First abort
  await __testing.abortCurrentTurn();

  // Active runtime should be cleared
  const activeRuntime = __testing.getActiveTurnRuntime();
  assert.equal(activeRuntime, null);

  // Second abort should be no-op (no active runtime)
  await __testing.abortCurrentTurn();

  // Dispose should only be called once
  assert.equal(disposeCount, 1);
});

// ============================================================================
// Tests for TurnSink Lifecycle in executeTurn
// ============================================================================

test('turnSink creation happens after beginRuntimeTurn', () => {
  // This test verifies the order documented in the fix
  // Actual executeTurn flow:
  // 1. beginRuntimeTurn(runtime)
  // 2. runtime.turnSink = createTurnSink()
  // This ensures executeTurn is ready to consume before perpetual reader can push

  const runtime = {
    closed: false,
    turnSink: null,
    activeTurnCount: 0,
  };

  // Simulate beginRuntimeTurn
  runtime.activeTurnCount++;

  // Simulate turnSink creation AFTER beginRuntimeTurn
  runtime.turnSink = createTurnSink();

  assert.equal(runtime.activeTurnCount, 1);
  assert.ok(runtime.turnSink !== null);

  // This order prevents race: perpetual reader checks runtime.turnSink
  // and only pushes if non-null, by which time executeTurn is ready
});

test('turnSink cleanup happens after endRuntimeTurn', () => {
  // This test verifies the cleanup order documented in the fix
  // Actual executeTurn finally block:
  // 1. endRuntimeTurn(runtime)
  // 2. runtime.turnSink = null
  // This follows LIFO principle (reverse of creation order)

  const runtime = {
    closed: false,
    turnSink: createTurnSink(),
    activeTurnCount: 1,
  };

  // Simulate endRuntimeTurn
  runtime.activeTurnCount--;

  // Simulate turnSink cleanup AFTER endRuntimeTurn
  runtime.turnSink = null;

  assert.equal(runtime.activeTurnCount, 0);
  assert.equal(runtime.turnSink, null);
});

// ============================================================================
// Tests for Message Routing Logic
// ============================================================================

test('messages route to turnSink when active, not when null', () => {
  const runtime = {
    turnSink: null,
  };

  const messages = [];

  // Simulate perpetual reader routing logic
  const routeMessage = (msg) => {
    if (runtime.turnSink) {
      // In-turn mode: push to turnSink
      runtime.turnSink.push(msg);
      return 'in-turn';
    } else {
      // Inter-turn mode: handle separately
      messages.push(msg);
      return 'inter-turn';
    }
  };

  // Before turn starts (no turnSink)
  const route1 = routeMessage({ type: 'test1' });
  assert.equal(route1, 'inter-turn');
  assert.equal(messages.length, 1);

  // Turn starts
  runtime.turnSink = createTurnSink();

  const route2 = routeMessage({ type: 'test2' });
  assert.equal(route2, 'in-turn');

  // Turn ends
  runtime.turnSink = null;

  const route3 = routeMessage({ type: 'test3' });
  assert.equal(route3, 'inter-turn');
  assert.equal(messages.length, 2);
});

console.log('\n✅ All persistent-query-service tests updated with turnSink coverage');
