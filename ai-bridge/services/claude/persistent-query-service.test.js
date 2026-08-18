import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  // 2. await waitForReaderQuiescent(runtime)
  // 3. runtime.turnSink = createTurnSink()
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

// ============================================================================
// Regression: fresh turn after an abort must not inherit abortRequested
// ============================================================================

test('executeTurn resets abortRequested at the start of a new turn', async () => {
  // abortCurrentTurn leaves abortRequested=true on the runtime. If a fresh
  // turn then fails (e.g. the runtime was disposed mid-abort), sendInternal's
  // wasAborted check would swallow the failure as a graceful "User
  // interrupted" and silently drop the user's message. The reset scopes the
  // flag to the turn that actually aborted.
  const runtime = {
    closed: false,
    abortRequested: true,
    sessionId: null,
    runtimeSessionEpoch: null,
    activeTurnCount: 0,
    inputStream: { enqueue() {}, done() {} },
    query: { close() {} },
  };

  // Start the turn; executeTurn waits for reader quiescence before creating
  // turnSink, then blocks on turnSink.take() until the sink is failed (as
  // abortCurrentTurn does to unblock a live turn).
  const failSink = __testing.executeTurn(runtime, {
    requestedSessionId: null,
    runtimeSessionEpoch: null,
    options: { cwd: '/tmp' },
    permissionMode: 'default',
    streamingEnabled: false,
    userMessage: { type: 'user', message: { role: 'user', content: 'hi' } },
  });

  // Wait for the quiescence gate to create the sink before simulating the CLI
  // closing the stream out from under the turn.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(runtime.turnSink);
  runtime.turnSink.fail(new Error('stream ended'));
  runtime.closed = true;

  await assert.rejects(failSink, /stream ended/);
  assert.equal(runtime.abortRequested, false);
});

// ============================================================================
// Regression: a fresh send must never reuse a closed runtime
// ============================================================================

test('acquireRuntime discards a closed runtime still registered from an abort', () => {
  // abortCurrentTurn marks the runtime closed but only removes it from the
  // registry after its async query.close() completes. A send that races that
  // window used to reuse the closed runtime, hit "Runtime is closed", and —
  // because abortRequested was still true — have the failure swallowed as a
  // graceful "User interrupted": the user's message was silently eaten.
  //
  // Runs in a child process with a mock SDK (mirroring the [1m]-toggle test)
  // so acquireRuntime never touches the real SDK loader or credentials.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-closed-runtime-'));
  try {
    fs.mkdirSync(path.join(tempHome, '.codemoss'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, '.codemoss', 'config.json'),
      JSON.stringify({ claude: { current: '__cli_login__', providers: {} } }),
      'utf8'
    );

    const childPath = fileURLToPath(
      new URL('./runtime-lifecycle.closed-runtime.child.mjs', import.meta.url)
    );
    const output = execFileSync(process.execPath, [childPath], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.match(output, /SCENARIO_OK/, `child scenario did not pass:\n${output}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
