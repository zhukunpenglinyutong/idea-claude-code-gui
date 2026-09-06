import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRuntimeSignature, applyDynamicControls, applyPermissionModeToRuntime, createTurnSink } from './runtime-lifecycle.js';
import { findRuntimeForRequest, rememberRuntime, resetRegistryState } from './runtime-registry.js';
import { createPreToolUseHook } from './permission-mode.js';

// ============================================================================
// TurnSink Tests - Core Message Queue Functionality
// ============================================================================

test('TurnSink: push and take single message', async () => {
  const sink = createTurnSink();
  const testMsg = { type: 'test', content: 'hello' };

  sink.push(testMsg);
  const result = await sink.take();

  assert.deepEqual(result, { value: testMsg, done: false });
});

test('TurnSink: take waits for push when queue is empty', async () => {
  const sink = createTurnSink();
  const testMsg = { type: 'test', content: 'async' };

  // Start take before push
  const takePromise = sink.take();

  // Push after a delay
  setTimeout(() => sink.push(testMsg), 10);

  const result = await takePromise;
  assert.deepEqual(result, { value: testMsg, done: false });
});

test('TurnSink: multiple pushes queue correctly', async () => {
  const sink = createTurnSink();
  const msg1 = { type: 'msg1' };
  const msg2 = { type: 'msg2' };
  const msg3 = { type: 'msg3' };

  sink.push(msg1);
  sink.push(msg2);
  sink.push(msg3);

  const result1 = await sink.take();
  const result2 = await sink.take();
  const result3 = await sink.take();

  assert.deepEqual(result1.value, msg1);
  assert.deepEqual(result2.value, msg2);
  assert.deepEqual(result3.value, msg3);
});

test('TurnSink: push resolves waiting take immediately', async () => {
  const sink = createTurnSink();
  const testMsg = { type: 'immediate' };

  // Start waiting
  const takePromise = sink.take();

  // Push immediately (should resolve takePromise synchronously)
  sink.push(testMsg);

  const result = await takePromise;
  assert.deepEqual(result, { value: testMsg, done: false });
});

// ============================================================================
// TurnSink Tests - Failure Handling
// ============================================================================

test('TurnSink: fail prevents further pushes', async () => {
  const sink = createTurnSink();
  const error = new Error('Stream failed');

  sink.fail(error);

  // Pushes after failure should be ignored
  sink.push({ type: 'ignored' });

  // Take should throw the error
  await assert.rejects(
    async () => await sink.take(),
    (err) => {
      assert.equal(err.message, 'Stream failed');
      return true;
    }
  );
});

test('TurnSink: fail unblocks waiting take', async () => {
  const sink = createTurnSink();
  const error = new Error('Aborted');

  // Start waiting
  const takePromise = sink.take();

  // Fail the sink
  setTimeout(() => sink.fail(error), 10);

  // Take should reject with the error
  await assert.rejects(
    async () => await takePromise,
    (err) => {
      assert.equal(err.message, 'Aborted');
      return true;
    }
  );
});

test('TurnSink: multiple takes after failure all throw', async () => {
  const sink = createTurnSink();
  const error = new Error('Failed');

  sink.fail(error);

  // All subsequent takes should throw
  await assert.rejects(async () => await sink.take());
  await assert.rejects(async () => await sink.take());
  await assert.rejects(async () => await sink.take());
});

test('TurnSink: fail with waiting take does not process subsequent pushes', async () => {
  const sink = createTurnSink();

  // Start waiting
  const takePromise = sink.take();

  // Fail immediately
  sink.fail(new Error('Failed'));

  // Try to push (should be ignored)
  sink.push({ type: 'should_be_ignored' });

  // Take should reject, not resolve with the pushed message
  await assert.rejects(async () => await takePromise);
});

// ============================================================================
// TurnSink Tests - Edge Cases
// ============================================================================

test('TurnSink: empty queue behavior', async () => {
  const sink = createTurnSink();

  // Take from empty queue should wait
  const takePromise = sink.take();

  // Verify it's still pending after a short delay
  await new Promise(resolve => setTimeout(resolve, 10));

  // Resolve it
  sink.push({ type: 'test' });
  const result = await takePromise;

  assert.equal(result.done, false);
});

test('TurnSink: interleaved push/take operations', async () => {
  const sink = createTurnSink();

  sink.push({ id: 1 });
  const r1 = await sink.take();

  sink.push({ id: 2 });
  sink.push({ id: 3 });
  const r2 = await sink.take();

  sink.push({ id: 4 });
  const r3 = await sink.take();
  const r4 = await sink.take();

  assert.equal(r1.value.id, 1);
  assert.equal(r2.value.id, 2);
  assert.equal(r3.value.id, 3);
  assert.equal(r4.value.id, 4);
});

test('TurnSink: large queue does not lose messages', async () => {
  const sink = createTurnSink();
  const messageCount = 1000;

  // Push many messages
  for (let i = 0; i < messageCount; i++) {
    sink.push({ id: i });
  }

  // Take all messages and verify order
  for (let i = 0; i < messageCount; i++) {
    const result = await sink.take();
    assert.equal(result.value.id, i, `Message ${i} out of order`);
  }
});

// ============================================================================
// TurnSink Tests - Concurrent Operations
// ============================================================================

test('TurnSink: concurrent takes are resolved in order', async () => {
  const sink = createTurnSink();

  // Start multiple concurrent takes
  const take1 = sink.take();
  const take2 = sink.take();
  const take3 = sink.take();

  // Push messages
  sink.push({ id: 1 });
  sink.push({ id: 2 });
  sink.push({ id: 3 });

  // All takes should resolve correctly
  const [r1, r2, r3] = await Promise.all([take1, take2, take3]);

  assert.equal(r1.value.id, 1);
  assert.equal(r2.value.id, 2);
  assert.equal(r3.value.id, 3);
});

test('TurnSink: rapid push/take cycles maintain consistency', async () => {
  const sink = createTurnSink();
  const iterations = 100;

  for (let i = 0; i < iterations; i++) {
    sink.push({ id: i });
    const result = await sink.take();
    assert.equal(result.value.id, i);
  }
});

// ============================================================================
// Integration Tests - Simulating executeTurn and Perpetual Reader
// ============================================================================

test('Integration: simulate in-turn message flow', async () => {
  const sink = createTurnSink();

  // Simulate perpetual reader pushing messages
  const messages = [
    { type: 'system', session_id: 'test-123' },
    { type: 'assistant', content: 'Hello' },
    { type: 'assistant', tool_use: { name: 'read' } },
    { type: 'tool_result', content: 'file content' },
    { type: 'assistant', content: 'Done' },
    { type: 'result', is_error: false }
  ];

  // Simulate perpetual reader (async producer)
  const producer = (async () => {
    for (const msg of messages) {
      sink.push(msg);
      await new Promise(resolve => setTimeout(resolve, 5)); // Simulate delay
    }
  })();

  // Simulate executeTurn (consumer)
  const received = [];
  while (true) {
    const next = await sink.take();
    received.push(next.value);

    if (next.value.type === 'result') {
      break;
    }
  }

  await producer;

  assert.equal(received.length, messages.length);
  assert.deepEqual(received, messages);
});

test('Integration: simulate abort during active turn', async () => {
  const sink = createTurnSink();

  // Simulate perpetual reader pushing messages
  sink.push({ type: 'assistant', content: 'Starting...' });

  // Simulate executeTurn consuming
  const r1 = await sink.take();
  assert.equal(r1.value.type, 'assistant');

  // Simulate abort
  sink.fail(new Error('Turn aborted'));

  // Next take should throw
  await assert.rejects(
    async () => await sink.take(),
    /Turn aborted/
  );
});

test('Integration: simulate rapid turn transitions', async () => {
  // Simulate multiple turns with different sinks
  const turn1Sink = createTurnSink();
  const turn2Sink = createTurnSink();

  // Turn 1
  turn1Sink.push({ type: 'assistant', content: 'Turn 1' });
  turn1Sink.push({ type: 'result' });

  const t1m1 = await turn1Sink.take();
  const t1m2 = await turn1Sink.take();

  assert.equal(t1m1.value.content, 'Turn 1');
  assert.equal(t1m2.value.type, 'result');

  // Turn 2 (new sink)
  turn2Sink.push({ type: 'assistant', content: 'Turn 2' });
  turn2Sink.push({ type: 'result' });

  const t2m1 = await turn2Sink.take();
  const t2m2 = await turn2Sink.take();

  assert.equal(t2m1.value.content, 'Turn 2');
  assert.equal(t2m2.value.type, 'result');
});

// ============================================================================
// Stress Tests - Boundary Conditions
// ============================================================================

test('Stress: high-frequency push/take cycles', async () => {
  const sink = createTurnSink();
  const iterations = 1000;

  const producer = (async () => {
    for (let i = 0; i < iterations; i++) {
      sink.push({ id: i });
    }
  })();

  const consumer = (async () => {
    for (let i = 0; i < iterations; i++) {
      const result = await sink.take();
      assert.equal(result.value.id, i);
    }
  })();

  await Promise.all([producer, consumer]);
});

test('Stress: many concurrent waiting takes resolved by single fail', async () => {
  const sink = createTurnSink();
  const waitCount = 100;

  // Start many concurrent takes
  const takes = Array.from({ length: waitCount }, () => sink.take());

  // Fail the sink
  setTimeout(() => sink.fail(new Error('Mass abort')), 10);

  // All takes should reject
  const results = await Promise.allSettled(takes);

  results.forEach(result => {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Mass abort/);
  });
});

test('Stress: alternating push-wait-take pattern', async () => {
  const sink = createTurnSink();
  const rounds = 50;

  for (let i = 0; i < rounds; i++) {
    // Push
    sink.push({ round: i, phase: 'push' });

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1));

    // Take
    const result = await sink.take();
    assert.equal(result.value.round, i);
    assert.equal(result.value.phase, 'push');
  }
});

// ============================================================================
// Error Handling Tests
// ============================================================================

test('Error: take after fail with custom error', async () => {
  const sink = createTurnSink();
  const customError = new Error('Custom failure');
  customError.code = 'CUSTOM_ERR';

  sink.fail(customError);

  await assert.rejects(
    async () => await sink.take(),
    (err) => {
      assert.equal(err.message, 'Custom failure');
      assert.equal(err.code, 'CUSTOM_ERR');
      return true;
    }
  );
});

test('Error: push after fail does not throw', () => {
  const sink = createTurnSink();

  sink.fail(new Error('Failed'));

  // Push should silently be ignored (no throw)
  assert.doesNotThrow(() => {
    sink.push({ type: 'test' });
    sink.push({ type: 'test2' });
  });
});

test('Error: multiple fails keep first error', async () => {
  const sink = createTurnSink();

  const error1 = new Error('First error');
  const error2 = new Error('Second error');

  sink.fail(error1);
  sink.fail(error2); // Should be ignored

  await assert.rejects(
    async () => await sink.take(),
    (err) => {
      assert.equal(err.message, 'First error');
      return true;
    }
  );
});

// ============================================================================
// Memory Tests
// ============================================================================

test('Memory: sink does not leak on rapid creation/disposal', async () => {
  const iterations = 1000;

  for (let i = 0; i < iterations; i++) {
    const sink = createTurnSink();
    sink.push({ id: i });
    const result = await sink.take();
    assert.equal(result.value.id, i);
    // Sink should be garbage collected after this iteration
  }

  // If this test completes without OOM, memory management is OK
  assert.ok(true, 'No memory leak detected');
});

test('Memory: failed sink releases waiting promises', async () => {
  const sink = createTurnSink();

  // Create many waiting takes
  const takes = Array.from({ length: 100 }, () => sink.take());

  // Fail immediately
  sink.fail(new Error('Release all'));

  // All promises should settle (not hang)
  const results = await Promise.allSettled(takes);

  assert.equal(results.length, 100);
  results.forEach(r => assert.equal(r.status, 'rejected'));
});

// ============================================================================
// Runtime Signature & Dynamic Controls - 1M Context Toggle
// ============================================================================

test('buildRuntimeSignature differs when the [1m] context suffix toggles', () => {
  const options = { cwd: '/tmp/project', model: 'sonnet' };
  const sigOff = buildRuntimeSignature(options, '', true, 'epoch-x', 'claude-sonnet-4-6');
  const sigOn = buildRuntimeSignature(options, '', true, 'epoch-x', 'claude-sonnet-4-6[1m]');

  assert.notEqual(sigOff, sigOn);
  assert.match(sigOff, /"contextWindow1M":false/);
  assert.match(sigOn, /"contextWindow1M":true/);
});

test('buildRuntimeSignature is stable for the same [1m] state', () => {
  const options = { cwd: '/tmp/project', model: 'sonnet' };
  const a = buildRuntimeSignature(options, '', true, 'epoch-x', 'claude-sonnet-4-6[1m]');
  const b = buildRuntimeSignature(options, '', true, 'epoch-x', 'claude-sonnet-4-6[1m]');
  assert.equal(a, b);
});

test('applyPermissionModeToRuntime keeps state unchanged when the SDK rejects a live mode change', async () => {
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    runtimeSignature: 'sig-original',
    query: {
      setPermissionMode: async () => { throw new Error('rejected'); },
    },
  };

  const applied = await applyPermissionModeToRuntime(runtime, 'auto');

  assert.equal(applied, false);
  assert.equal(runtime.currentPermissionMode, 'default');
  assert.equal(runtime.permissionModeState.value, 'default');
  assert.equal(runtime.runtimeSignature, 'sig-original');
});

test('applyPermissionModeToRuntime marks Full Auto transitions for rebuild', async () => {
  const setPermissionModeCalls = [];
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    runtimeSignature: 'sig-original',
    query: {
      setPermissionMode: async (mode) => { setPermissionModeCalls.push(mode); },
    },
  };

  const applied = await applyPermissionModeToRuntime(runtime, 'bypassPermissions');

  assert.equal(applied, true);
  assert.deepEqual(setPermissionModeCalls, []);
  assert.equal(runtime.currentPermissionMode, 'bypassPermissions');
  assert.equal(runtime.permissionModeState.value, 'bypassPermissions');
  assert.equal(runtime.runtimeSignature, '__rebuild-pending-bypass-change__');
});

test('pending anonymous bypass runtime stays isolated by session epoch', () => {
  resetRegistryState();
  const pending = {
    runtimeSignature: '__rebuild-pending-bypass-change__',
    runtimeSessionEpoch: 'epoch-a',
  };
  rememberRuntime(pending, {
    requestedSessionId: null,
    runtimeSignature: 'sig-a',
  });

  assert.equal(findRuntimeForRequest({
    requestedSessionId: null,
    runtimeSignature: 'sig-b',
    runtimeSessionEpoch: 'epoch-b',
  }), null);
  assert.equal(findRuntimeForRequest({
    requestedSessionId: null,
    runtimeSignature: 'sig-a-new',
    runtimeSessionEpoch: 'epoch-a',
  }), pending);
  resetRegistryState();
});
test('applyDynamicControls passes the resolved model id to setModel, not the short name', async () => {
  // The CLI subprocess resolves short names ("sonnet") against its own env,
  // which was frozen at spawn — a daemon-side env update never reaches it.
  // The resolved id must therefore be sent verbatim.
  const setModelCalls = [];
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    currentModel: 'sonnet',
    currentResolvedModel: 'claude-sonnet-4-6',
    currentMaxThinkingTokens: null,
    query: {
      setModel: async (model) => { setModelCalls.push(model); },
    },
  };

  await applyDynamicControls(runtime, {
    permissionMode: 'default',
    sdkModelName: 'sonnet',
    resolvedModelId: 'MiniMax-M2.5',
    maxThinkingTokens: null,
  });

  assert.deepEqual(setModelCalls, ['MiniMax-M2.5']);
  assert.equal(runtime.currentModel, 'sonnet');
  assert.equal(runtime.currentResolvedModel, 'MiniMax-M2.5');
});

test('applyDynamicControls skips setModel when short name and resolved id are unchanged', async () => {
  const setModelCalls = [];
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    currentModel: 'sonnet',
    currentResolvedModel: 'claude-sonnet-4-6',
    currentMaxThinkingTokens: null,
    query: {
      setModel: async (model) => { setModelCalls.push(model); },
    },
  };

  await applyDynamicControls(runtime, {
    permissionMode: 'default',
    sdkModelName: 'sonnet',
    resolvedModelId: 'claude-sonnet-4-6',
    maxThinkingTokens: null,
  });

  assert.deepEqual(setModelCalls, []);
});

test('applyDynamicControls reapplies a mode skipped while another transition is pending', async () => {
  const pending = [];
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    currentModel: null,
    currentResolvedModel: null,
    currentMaxThinkingTokens: null,
    query: {
      setPermissionMode: (mode) => new Promise((resolve) => pending.push({ mode, resolve })),
    },
  };

  const first = applyDynamicControls(runtime, {
    permissionMode: 'acceptEdits',
    sdkModelName: null,
    resolvedModelId: null,
    maxThinkingTokens: null,
  });
  const second = applyDynamicControls(runtime, {
    permissionMode: 'default',
    sdkModelName: null,
    resolvedModelId: null,
    maxThinkingTokens: null,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((item) => item.mode), ['acceptEdits']);
  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((item) => item.mode), ['acceptEdits', 'default']);

  pending[1].resolve();
  await Promise.all([first, second]);
  assert.equal(runtime.currentPermissionMode, 'default');
  assert.equal(runtime.permissionModeState.value, 'default');
});

test('acquireRuntime rebuilds the runtime when the [1m] context toggle changes', () => {
  // This scenario drives buildRequestContext(), which calls setupApiKey().
  // setupApiKey resolves credentials ONLY from ~/.codemoss + ~/.claude under the
  // real home dir, ignoring env vars, and getRealHomeDir() caches that path on
  // first use — so a clean CI runner (no credentials) makes it throw "API Key
  // not configured". Run the scenario in a fresh child process whose HOME points
  // at a temp dir carrying a CLI-login config, mirroring api-config.test.js which
  // runs setupApiKey in a child for the same reason. The actual assertions live
  // in runtime-lifecycle.1m-toggle.child.mjs.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-1m-toggle-'));
  try {
    fs.mkdirSync(path.join(tempHome, '.codemoss'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, '.codemoss', 'config.json'),
      JSON.stringify({ claude: { current: '__cli_login__', providers: {} } }),
      'utf8'
    );

    const childPath = fileURLToPath(
      new URL('./runtime-lifecycle.1m-toggle.child.mjs', import.meta.url)
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

// ============================================================================
// buildRuntimeSignature — bypassPermissions (Full Auto) rebuild
// ============================================================================

test('buildRuntimeSignature differs when entering/leaving bypassPermissions (Full Auto)', () => {
  const base = { cwd: '/w', model: 'sonnet' };
  const sigDefault = buildRuntimeSignature({ ...base, permissionMode: 'default' }, '', true, 'ep');
  const sigAuto = buildRuntimeSignature({ ...base, permissionMode: 'bypassPermissions' }, '', true, 'ep');

  // Entering Full Auto must change the signature so acquireRuntime rebuilds the
  // runtime with allowDangerouslySkipPermissions at spawn.
  assert.notEqual(sigDefault, sigAuto);
  assert.match(sigDefault, /"bypassPermissions":false/);
  assert.match(sigAuto, /"bypassPermissions":true/);
});

test('buildRuntimeSignature is stable across native modes (default/plan/acceptEdits/auto apply live)', () => {
  const base = { cwd: '/w', model: 'sonnet' };
  const sigDefault = buildRuntimeSignature({ ...base, permissionMode: 'default' }, '', true, 'ep');
  const sigPlan = buildRuntimeSignature({ ...base, permissionMode: 'plan' }, '', true, 'ep');
  const sigAccept = buildRuntimeSignature({ ...base, permissionMode: 'acceptEdits' }, '', true, 'ep');
  const sigAuto = buildRuntimeSignature({ ...base, permissionMode: 'auto' }, '', true, 'ep');

  // These modes need no launch flag and are applied live via setPermissionMode,
  // so they must NOT force a runtime rebuild.
  assert.equal(sigDefault, sigPlan);
  assert.equal(sigDefault, sigAccept);
  assert.equal(sigDefault, sigAuto);
});

test('buildRuntimeSignature treats a missing permissionMode as non-bypass', () => {
  const sig = buildRuntimeSignature({ cwd: '/w', model: 'sonnet' }, '', true, 'ep');
  assert.match(sig, /"bypassPermissions":false/);
});

test('applyPermissionModeToRuntime serializes transitions and preserves request order', async () => {
  const pending = [];
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    query: {
      setPermissionMode: (mode) => new Promise((resolve) => pending.push({ mode, resolve }))
    }
  };

  const first = applyPermissionModeToRuntime(runtime, 'acceptEdits');
  const second = applyPermissionModeToRuntime(runtime, 'plan');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((item) => item.mode), ['acceptEdits']);

  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((item) => item.mode), ['acceptEdits', 'plan']);
  pending[1].resolve();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(runtime.currentPermissionMode, 'plan');
  assert.equal(runtime.permissionModeState.value, 'plan');
});

test('applyPermissionModeToRuntime reapplies the original mode after a superseded transition', async () => {
  const pending = [];
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    query: {
      setPermissionMode: (mode) => new Promise((resolve) => pending.push({ mode, resolve }))
    }
  };

  const first = applyPermissionModeToRuntime(runtime, 'acceptEdits');
  const second = applyPermissionModeToRuntime(runtime, 'default');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((item) => item.mode), ['acceptEdits']);

  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending.map((item) => item.mode), ['acceptEdits', 'default']);

  pending[1].resolve();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(runtime.currentPermissionMode, 'default');
  assert.equal(runtime.permissionModeState.value, 'default');
});

test('applyPermissionModeToRuntime ignores absent or closed runtimes', async () => {
  assert.equal(await applyPermissionModeToRuntime(null, 'plan'), false);
  assert.equal(await applyPermissionModeToRuntime({ closed: true, permissionModeState: {} }, 'plan'), false);
});

test('a superseded plan hook preserves the acknowledged SDK mode while the next change waits', async () => {
  const pending = [];
  const runtime = {
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    query: {
      setPermissionMode: (mode) => new Promise((resolve) => pending.push({ mode, resolve })),
    },
  };
  const hook = createPreToolUseHook(runtime.permissionModeState, process.cwd(),
    (mode) => applyPermissionModeToRuntime(runtime, mode));
  const enterPlan = hook({ tool_name: 'EnterPlanMode' });
  await new Promise((resolve) => setImmediate(resolve));
  const acceptEdits = applyPermissionModeToRuntime(runtime, 'acceptEdits');
  pending[0].resolve();
  await enterPlan;
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.equal(runtime.currentPermissionMode, 'plan');
    assert.equal(runtime.permissionModeState.value, 'plan');
  } finally {
    pending[1].resolve();
    await acceptEdits;
  }
});

test('superseded no-op and bypass transitions do not report themselves as the latest mode', async () => {
  for (const target of ['default', 'bypassPermissions']) {
    const runtime = {
      currentPermissionMode: 'default',
      permissionModeState: { value: 'default' },
      query: { setPermissionMode: async () => {} },
    };
    const first = applyPermissionModeToRuntime(runtime, target);
    const second = applyPermissionModeToRuntime(runtime, 'plan');
    assert.deepEqual(await Promise.all([first, second]), [false, true]);
    assert.equal(runtime.permissionModeState.value, 'plan');
  }
});

test('applyPermissionModeToRuntime ignores a transition completed after disposal', async () => {
  let resolveSdk;
  const runtime = {
    closed: false,
    currentPermissionMode: 'default',
    permissionModeState: { value: 'default' },
    query: { setPermissionMode: () => new Promise((resolve) => { resolveSdk = resolve; }) }
  };

  const result = applyPermissionModeToRuntime(runtime, 'plan');
  await new Promise((resolve) => setImmediate(resolve));
  runtime.closed = true;
  resolveSdk();
  assert.equal(await result, false);
  assert.equal(runtime.currentPermissionMode, 'default');
  assert.equal(runtime.permissionModeState.value, 'default');
});

console.log('\n✅ All TurnSink tests defined. Run with: node runtime-lifecycle.test.js');
