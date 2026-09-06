import test from 'node:test';
import assert from 'node:assert/strict';

import { setPermissionModePersistent, __testing } from './persistent-query-service.js';

/**
 * Tests for the live permission-mode switch's handling of the Full Auto
 * (bypassPermissions) transition.
 *
 * Entering or leaving Full Auto cannot be applied to a running subprocess:
 * allowDangerouslySkipPermissions is a spawn-time launch flag, and
 * setPermissionMode() (a control request) can neither add nor remove it. So a
 * bypass-bit change must NOT call setPermissionMode (which would falsely report
 * "applied" while the subprocess keeps prompting / keeps skipping) — it must
 * invalidate the runtime signature so the next send_message rebuilds the
 * runtime with the correct launch flag. Non-bypass transitions keep applying
 * live via setPermissionMode.
 *
 * This suite does not touch buildRequestContext/setupApiKey, so it is CI-safe
 * without credentials.
 */

function createFakeRuntime(overrides = {}) {
  const setPermissionModeCalls = [];
  const mode = overrides.currentPermissionMode ?? 'default';
  return {
    closed: false,
    sessionId: overrides.sessionId ?? 'sess-1',
    runtimeSessionEpoch: 'epoch-1',
    runtimeSignature: overrides.runtimeSignature ?? 'sig-original',
    currentPermissionMode: mode,
    permissionModeState: { value: mode },
    inputStream: { done() {} },
    query: {
      setPermissionMode: async (m) => { setPermissionModeCalls.push(m); },
    },
    __setPermissionModeCalls: setPermissionModeCalls,
    ...overrides.extra,
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('entering Full Auto marks the runtime for rebuild and does NOT call setPermissionMode', async () => {
  const runtime = createFakeRuntime({ currentPermissionMode: 'default' });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({ sessionId: 'sess-1', permissionMode: 'bypassPermissions' });

  assert.deepEqual(runtime.__setPermissionModeCalls, [],
    'setPermissionMode must not be called for a bypass-bit change (the launch flag is frozen at spawn)');
  assert.notEqual(runtime.runtimeSignature, 'sig-original',
    'the runtime signature must be invalidated so the next send rebuilds with allowDangerouslySkipPermissions');
  assert.equal(runtime.currentPermissionMode, 'bypassPermissions');
  assert.equal(runtime.permissionModeState.value, 'bypassPermissions');
});

test('leaving Full Auto also marks the runtime for rebuild (flag cannot be removed live)', async () => {
  const runtime = createFakeRuntime({ currentPermissionMode: 'bypassPermissions' });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({ sessionId: 'sess-1', permissionMode: 'default' });

  assert.deepEqual(runtime.__setPermissionModeCalls, [],
    'leaving Full Auto must not call setPermissionMode — the subprocess was spawned WITH the skip flag');
  assert.notEqual(runtime.runtimeSignature, 'sig-original');
  assert.equal(runtime.currentPermissionMode, 'default');
});

test('non-bypass transition (default -> acceptEdits) applies live via setPermissionMode, signature untouched', async () => {
  const runtime = createFakeRuntime({ currentPermissionMode: 'default' });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({ sessionId: 'sess-1', permissionMode: 'acceptEdits' });

  assert.deepEqual(runtime.__setPermissionModeCalls, ['acceptEdits'],
    'modes that need no launch flag still switch live');
  assert.equal(runtime.runtimeSignature, 'sig-original',
    'a non-bypass switch must not force a runtime rebuild');
  assert.equal(runtime.currentPermissionMode, 'acceptEdits');
});

test('non-bypass transition (plan -> acceptEdits) also stays live', async () => {
  const runtime = createFakeRuntime({ currentPermissionMode: 'plan' });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({ sessionId: 'sess-1', permissionMode: 'acceptEdits' });

  assert.deepEqual(runtime.__setPermissionModeCalls, ['acceptEdits']);
  assert.equal(runtime.runtimeSignature, 'sig-original');
});

test('switching to the mode already active is a no-op (no call, no rebuild)', async () => {
  const runtime = createFakeRuntime({ currentPermissionMode: 'bypassPermissions' });
  __testing.setActiveTurnRuntime(runtime);

  await setPermissionModePersistent({ sessionId: 'sess-1', permissionMode: 'bypassPermissions' });

  assert.deepEqual(runtime.__setPermissionModeCalls, []);
  assert.equal(runtime.runtimeSignature, 'sig-original', 'no rebuild when the mode did not change');
});
