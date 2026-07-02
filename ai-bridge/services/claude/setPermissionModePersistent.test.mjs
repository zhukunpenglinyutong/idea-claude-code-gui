import test from 'node:test';
import assert from 'node:assert/strict';

import { setPermissionModePersistent, __testing } from './persistent-query-service.js';

/**
 * Build a fake runtime with the shape setPermissionModePersistent reads.
 * @param {object} overrides
 * @returns {object}
 */
function createFakeRuntime(overrides = {}) {
  const setPermissionMode = overrides.setPermissionMode || (async () => {});
  return {
    closed: overrides.closed ?? false,
    sessionId: overrides.sessionId ?? 'sess-1',
    runtimeSessionEpoch: overrides.runtimeSessionEpoch ?? 'epoch-1',
    currentPermissionMode: overrides.currentPermissionMode ?? 'default',
    permissionModeState: { value: overrides.currentPermissionMode ?? 'default' },
    // disposeRuntime() tears down the perpetual reader via inputStream.done();
    // supply a no-op so disposing a sentinel fake doesn't throw mid-test.
    inputStream: { done() { } },
    query: { setPermissionMode },
    ...overrides.extra
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('setPermissionModePersistent skips when no live runtime exists', async () => {
  // No active turn runtime and no session runtime registered for 'sess-none'.
  let calls = 0;
  const unreachable = createFakeRuntime({
    sessionId: 'sess-other',
    currentPermissionMode: 'default',
    setPermissionMode: async () => { calls += 1; }
  });
  __testing.setActiveTurnRuntime(unreachable);

  await setPermissionModePersistent({
    sessionId: 'sess-none',
    runtimeSessionEpoch: 'epoch-none',
    permissionMode: 'acceptEdits'
  });

  // The unrelated active runtime must not be touched: no SDK call and no state change.
  assert.equal(calls, 0);
  assert.equal(unreachable.currentPermissionMode, 'default');
  assert.equal(unreachable.permissionModeState.value, 'default');
});

test('setPermissionModePersistent applies the new mode to SDK and reactive state', async () => {
  let appliedMode = null;
  const runtime = createFakeRuntime({
    currentPermissionMode: 'default',
    setPermissionMode: async (mode) => { appliedMode = mode; }
  });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({
    sessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    permissionMode: 'acceptEdits'
  });

  assert.equal(appliedMode, 'acceptEdits');
  assert.equal(runtime.currentPermissionMode, 'acceptEdits');
  assert.equal(runtime.permissionModeState.value, 'acceptEdits');
});

test('setPermissionModePersistent is a no-op when the mode is unchanged', async () => {
  let calls = 0;
  const runtime = createFakeRuntime({
    currentPermissionMode: 'plan',
    setPermissionMode: async () => { calls += 1; }
  });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({
    sessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    permissionMode: 'plan'
  });

  assert.equal(calls, 0);
  assert.equal(runtime.currentPermissionMode, 'plan');
  assert.equal(runtime.permissionModeState.value, 'plan');
});

test('setPermissionModePersistent leaves local state unchanged when the SDK call fails', async () => {
  const runtime = createFakeRuntime({
    currentPermissionMode: 'default',
    setPermissionMode: async () => { throw new Error('SDK rejected'); }
  });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({
    sessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    permissionMode: 'acceptEdits'
  });

  // On failure the hook and SDK must stay in agreement, so local state keeps
  // the old mode until the next turn's applyDynamicControls resyncs.
  assert.equal(runtime.currentPermissionMode, 'default');
  assert.equal(runtime.permissionModeState.value, 'default');
});

test('setPermissionModePersistent normalizes an unknown mode to default', async () => {
  let appliedMode = null;
  const runtime = createFakeRuntime({
    currentPermissionMode: 'plan',
    setPermissionMode: async (mode) => { appliedMode = mode; }
  });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({
    sessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    permissionMode: 'bogus-mode'
  });

  assert.equal(appliedMode, 'default');
  assert.equal(runtime.currentPermissionMode, 'default');
  assert.equal(runtime.permissionModeState.value, 'default');
});

test('setPermissionModePersistent skips a closed active runtime', async () => {
  let calls = 0;
  const runtime = createFakeRuntime({
    closed: true,
    currentPermissionMode: 'default',
    setPermissionMode: async () => { calls += 1; }
  });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({
    sessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    permissionMode: 'acceptEdits'
  });

  assert.equal(calls, 0);
});

test('setPermissionModePersistent still updates state when query has no setPermissionMode', async () => {
  // A runtime whose query object lacks setPermissionMode (older SDK shape).
  const runtime = createFakeRuntime({
    currentPermissionMode: 'default',
    setPermissionMode: undefined
  });
  runtime.query = {};
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({
    sessionId: 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    permissionMode: 'acceptEdits'
  });

  assert.equal(runtime.currentPermissionMode, 'acceptEdits');
  assert.equal(runtime.permissionModeState.value, 'acceptEdits');
});

test('setPermissionModePersistent prefers a registered session runtime over the active-turn fallback', async () => {
  // Register a real runtime in the session map via acquireRuntime so that
  // getRuntimeForSession('sess-registered') resolves to it directly.
  const factory = createTrackingQueryFactory();
  __testing.setQueryFn(factory.queryFn);

  const context = await __testing.buildRequestContext({
    sessionId: 'sess-registered',
    runtimeSessionEpoch: 'epoch-registered',
    cwd: process.cwd(),
    message: 'seed turn'
  }, false);
  const registered = await __testing.acquireRuntime(context);

  // Place a *different* runtime as the active turn one — it must NOT be picked
  // because the session-map lookup already resolved the registered runtime.
  let sentinelCalls = 0;
  const sentinel = createFakeRuntime({
    sessionId: 'sess-active',
    currentPermissionMode: 'default',
    setPermissionMode: async () => { sentinelCalls += 1; }
  });
  __testing.setActiveTurnRuntime(sentinel);

  await setPermissionModePersistent({
    sessionId: 'sess-registered',
    runtimeSessionEpoch: 'epoch-registered',
    permissionMode: 'plan'
  });

  assert.equal(registered.currentPermissionMode, 'plan');
  assert.equal(registered.permissionModeState.value, 'plan');
  assert.equal(sentinelCalls, 0, 'active-turn fallback must not be used when session runtime exists');
  assert.equal(sentinel.currentPermissionMode, 'default');
});

/**
 * Query factory whose returned runtime records every setPermissionMode call.
 * next() never resolves so the perpetual reader keeps the runtime alive
 * (returning done immediately would let the reader dispose it pre-emptively,
 * which is an unrelated, pre-existing test-infra quirk).
 * @returns {{ queryFn: Function, setPermissionModeCalls: number[] }}
 */
function createTrackingQueryFactory() {
  const setPermissionModeCalls = [];
  const queryFn = ({ prompt, options }) => {
    return {
      prompt,
      options,
      closed: false,
      async setPermissionMode(mode) { setPermissionModeCalls.push(mode); },
      async setModel() { },
      async setMaxThinkingTokens() { },
      close() { this.closed = true; },
      next() { return new Promise(() => { }); }
    };
  };
  return { queryFn, setPermissionModeCalls };
}
