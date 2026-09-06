// Isolate credentials before the runtime caches the user's home directory.
import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing, getContextUsagePersistent } from './persistent-query-service.js';

/**
 * Make a mock query.next() idle like a real SDK stream: block while idle,
 * settle only when close() runs. Returning {done:true} immediately makes the
 * perpetual reader treat the stream as ended out-of-band and evict the runtime
 * via disposeRuntime - which races acquireRuntime's ownership check (the
 * runtime can be closed between createRuntime and the assert). The reader
 * always awaits next(), so the close rejection is handled by its catch rather
 * than surfacing as an unhandled rejection.
 * @returns {{ next: () => Promise, onClose: () => void }}
 */
function createIdleNext() {
  let closeReject;
  const idle = new Promise((_, reject) => { closeReject = reject; });
  return {
    next: () => idle,
    onClose: () => closeReject(new Error('runtime closed')),
  };
}

/**
 * Create a query factory whose runtimes have getContextUsage() and setModel().
 * The runtime's currentModel is set from options.model at creation time.
 * Also stores modelId to track [1m] suffix state for context window changes.
 * @param {object} contextUsageResult - The object returned by getContextUsage()
 */
function createContextAwareQueryFactory(contextUsageResult = { totalTokens: 1000 }) {
  const runtimes = [];
  return {
    runtimes,
    queryFn({ prompt, options }) {
      // Set currentModel from options.model (matches SDK behavior)
      // Also store the original modelId for [1m] suffix tracking
      const idle = createIdleNext();
      const runtime = {
        prompt,
        options,
        closed: false,
        currentModel: options.model || null,
        modelId: options.modelId || options.model || null, // Track original modelId
        setPermissionMode: async () => {},
        setModel: async (model) => {
          runtime.currentModel = model || null;
        },
        setMaxThinkingTokens: async () => {},
        getContextUsage: async () => contextUsageResult,
        close() {
          this.closed = true;
          idle.onClose();
        },
        next: idle.next
      };
      runtimes.push(runtime);
      return runtime;
    }
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test('buildRequestContext preserves resolved model mapping for context usage runtimes', async () => {
  const previousAnthropicModel = process.env.ANTHROPIC_MODEL;
  const previousSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

  try {
    const requestContext = await __testing.buildRequestContext(
      {
        model: 'claude-sonnet-4-6',
        cwd: process.cwd(),
      },
      false,
      {
        settings: {
          env: {
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet-model',
          },
        },
      },
    );

    const exactContext = __testing.applyExactModelForContextUsage(requestContext);

    assert.deepEqual(
      __testing.resolveRequestModelState('claude-sonnet-4-6', {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet-model',
      }),
      {
        sdkModelName: 'sonnet',
        resolvedModelId: 'custom-sonnet-model',
      },
      'resolved model state should honor mapped sonnet model settings',
    );
    assert.equal(requestContext.resolvedModelId, 'custom-sonnet-model');
    assert.equal(requestContext.options.env.ANTHROPIC_MODEL, 'custom-sonnet-model');
    assert.equal(requestContext.options.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'custom-sonnet-model');
    assert.deepEqual(requestContext.options.settings, {
      env: {
        CLAUDE_CODE_EFFORT_LEVEL: '',
        MAX_THINKING_TOKENS: '',
        ANTHROPIC_MODEL: '',
        ANTHROPIC_DEFAULT_FABLE_MODEL: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
        ANTHROPIC_SMALL_FAST_MODEL: '',
        CLAUDE_CODE_SUBAGENT_MODEL: '',
        CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      },
    });
    assert.equal(process.env.ANTHROPIC_MODEL, 'custom-sonnet-model');
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'custom-sonnet-model');
    assert.equal(exactContext.options.model, 'custom-sonnet-model');
    assert.equal(exactContext.sdkModelName, 'custom-sonnet-model');
    assert.equal(exactContext.modelId, 'claude-sonnet-4-6');
  } finally {
    if (previousAnthropicModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = previousAnthropicModel;
    }

    if (previousSonnetModel === undefined) {
      delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    } else {
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = previousSonnetModel;
    }
  }
});

test('getContextUsagePersistent reuses existing runtime for same session', async () => {
  const factory = createContextAwareQueryFactory({ totalTokens: 5000 });
  __testing.setQueryFn(factory.queryFn);

  // Pre-acquire a runtime for session 'sess-1'
  const requestContext = await __testing.buildRequestContext({
    sessionId: 'sess-1',
    model: 'claude-sonnet-4-6',
    cwd: process.cwd(),
  });
  await __testing.acquireRuntime(requestContext);

  assert.equal(factory.runtimes.length, 1, 'should have created 1 runtime');

  // Call getContextUsagePersistent for the same session
  // It should reuse the existing runtime, not create a new one
  const origConsoleLog = console.log;
  console.log = (...args) => {
    origConsoleLog(...args);
  };

  try {
    await getContextUsagePersistent({
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-6',
      cwd: process.cwd(),
    });

    // Should still be only 1 runtime (reused, not recreated)
    assert.equal(factory.runtimes.length, 1, 'should reuse existing runtime');
  } finally {
    console.log = origConsoleLog;
  }
});

test('getContextUsagePersistent reuses runtime and calls setModel when model changes', async () => {
  const factory = createContextAwareQueryFactory({ totalTokens: 5000 });
  __testing.setQueryFn(factory.queryFn);

  // Pre-acquire a runtime for session 'sess-2' with model 'opus'
  const requestContext = await __testing.buildRequestContext({
    sessionId: 'sess-2',
    model: 'claude-opus-4-7',
    cwd: process.cwd(),
  });
  await __testing.acquireRuntime(requestContext);

  assert.equal(factory.runtimes.length, 1, 'should have 1 runtime initially');
  assert.equal(factory.runtimes[0].currentModel, 'opus', 'runtime should have opus model');

  // Request context usage with a DIFFERENT model (sonnet instead of opus)
  // The runtime should be reused and setModel called to update the model
  const origConsoleLog = console.log;
  console.log = (...args) => { /* suppress */ };

  try {
    await getContextUsagePersistent({
      sessionId: 'sess-2',
      model: 'claude-sonnet-4-6',
      cwd: process.cwd(),
    });

    // Should still be 1 runtime (reused), not recreated
    assert.equal(factory.runtimes.length, 1,
      `expected 1 runtime (reused), got ${factory.runtimes.length}`);

    // The runtime's model should be updated with the exact model ID.
    assert.equal(factory.runtimes[0].currentModel, 'claude-sonnet-4-6',
      'runtime model should have been updated via setModel');
  } finally {
    console.log = origConsoleLog;
  }
});

test('getContextUsagePersistent acquires new runtime when none exists', async () => {
  const factory = createContextAwareQueryFactory({ totalTokens: 9999 });
  __testing.setQueryFn(factory.queryFn);

  assert.equal(factory.runtimes.length, 0, 'should start with 0 runtimes');

  const origConsoleLog = console.log;
  console.log = (...args) => { /* suppress */ };

  try {
    await getContextUsagePersistent({
      model: 'claude-sonnet-4-6',
      cwd: process.cwd(),
    });

    // Should have created a runtime via acquireRuntime
    assert.equal(factory.runtimes.length, 1, 'should create 1 runtime via acquireRuntime');
    assert.equal(
      factory.runtimes[0].options.model,
      'claude-sonnet-4-6',
      'context runtime should be created with exact model ID',
    );
  } finally {
    console.log = origConsoleLog;
  }
});

test('getContextUsagePersistent throws when getContextUsage is not available', async () => {
  // Create a factory WITHOUT getContextUsage on the runtime
  const factory = {
    queryFn({ prompt, options }) {
      const idle = createIdleNext();
      return {
        prompt,
        options,
        closed: false,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        close() { this.closed = true; idle.onClose(); },
        next: idle.next
      };
    }
  };
  __testing.setQueryFn(factory.queryFn);

  const origConsoleLog = console.log;
  console.log = (...args) => { /* suppress */ };

  try {
    await assert.rejects(
      () => getContextUsagePersistent({
        model: 'claude-sonnet-4-6',
        cwd: process.cwd(),
      }),
      /getContextUsage is not available/,
    );
  } finally {
    console.log = origConsoleLog;
  }
});

test('getContextUsagePersistent recreates runtime when [1m] suffix state changes', async () => {
  const factory = createContextAwareQueryFactory({ totalTokens: 10000 });
  __testing.setQueryFn(factory.queryFn);

  // Pre-acquire a runtime with model that has [1m] suffix
  const requestContext = await __testing.buildRequestContext({
    sessionId: 'sess-1m',
    model: 'claude-sonnet-4-6[1m]',
    cwd: process.cwd(),
  });
  const runtime1 = await __testing.acquireRuntime(requestContext);

  // Check the actual runtime object (not the mock query) stored the original modelId
  assert.ok(runtime1.modelId?.includes('[1m]'),
    `runtime.modelId should contain [1m], got: ${runtime1.modelId}`);

  const origConsoleLog = console.log;
  console.log = (...args) => { /* suppress */ };

  try {
    // Request context usage WITHOUT [1m] suffix - should recreate runtime
    await getContextUsagePersistent({
      sessionId: 'sess-1m',
      model: 'claude-sonnet-4-6', // No [1m] suffix
      cwd: process.cwd(),
    });

    // Get the runtime after the call
    const runtime2 = __testing.getRuntimeForSession('sess-1m');

    // The runtime should be different (old one disposed, new one created)
    assert.ok(runtime2.modelId !== runtime1.modelId,
      `new runtime should have different modelId`);

    // New runtime should NOT have [1m] suffix in modelId
    assert.ok(!runtime2.modelId?.includes('[1m]'),
      `new runtime.modelId should NOT contain [1m], got: ${runtime2.modelId}`);
  } finally {
    console.log = origConsoleLog;
  }
});

test('getContextUsagePersistent recreates runtime when existing runtime model is unknown', async () => {
  const factory = createContextAwareQueryFactory({ totalTokens: 7777 });
  __testing.setQueryFn(factory.queryFn);

  const requestContext = await __testing.buildRequestContext({
    sessionId: 'sess-unknown-model',
    cwd: process.cwd(),
  });
  const runtime1 = await __testing.acquireRuntime(requestContext);

  assert.equal(runtime1.modelId, null, 'preconnected runtime should have unknown modelId');
  assert.equal(factory.runtimes.length, 1, 'should have 1 runtime initially');

  const origConsoleLog = console.log;
  console.log = (...args) => { /* suppress */ };

  try {
    const requestedModel = 'custom-context-model';

    await getContextUsagePersistent({
      sessionId: 'sess-unknown-model',
      model: requestedModel,
      cwd: process.cwd(),
    });

    assert.equal(factory.runtimes.length, 2, 'should recreate runtime when modelId is unknown');

    const runtime2 = __testing.getRuntimeForSession('sess-unknown-model');
    assert.notEqual(runtime2, runtime1, 'should replace the old runtime');
    assert.equal(runtime2.modelId, requestedModel, 'new runtime should track exact requested modelId');
    assert.equal(
      factory.runtimes[1].options.model,
      requestedModel,
      'recreated runtime should be created with exact model ID',
    );
  } finally {
    console.log = origConsoleLog;
  }
});

test('getContextUsagePersistent temporarily disables 1M context when model has no [1m] suffix', async () => {
  const observedValues = [];
  const factory = {
    queryFn({ prompt, options }) {
      const idle = createIdleNext();
      return {
        prompt,
        options,
        closed: false,
        currentModel: options.model || null,
        modelId: options.model || null,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        getContextUsage: async () => {
          observedValues.push(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT || null);
          return { totalTokens: 1234, rawMaxTokens: 200000, maxTokens: 200000 };
        },
        close() {
          this.closed = true;
          idle.onClose();
        },
        next: idle.next
      };
    }
  };
  __testing.setQueryFn(factory.queryFn);

  const previousValue = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;

  const origConsoleLog = console.log;
  console.log = (...args) => { /* suppress */ };

  try {
    await getContextUsagePersistent({
      sessionId: 'sess-disable-1m',
      model: 'claude-opus-4-7',
      cwd: process.cwd(),
    });

    assert.deepEqual(observedValues, ['1'], 'should disable 1M context during /context query');
    assert.equal(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, undefined,
      'should restore CLAUDE_CODE_DISABLE_1M_CONTEXT after /context query');
  } finally {
    console.log = origConsoleLog;
    if (previousValue === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    } else {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = previousValue;
    }
  }
});

test('getContextUsagePersistent temporarily clears 1M disable override for explicit [1m] model requests', async () => {
  const observedValues = [];
  const factory = {
    queryFn({ prompt, options }) {
      const idle = createIdleNext();
      return {
        prompt,
        options,
        closed: false,
        currentModel: options.model || null,
        modelId: options.model || null,
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        getContextUsage: async () => {
          observedValues.push(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT || null);
          return { totalTokens: 1234, rawMaxTokens: 1000000, maxTokens: 1000000 };
        },
        close() {
          this.closed = true;
          idle.onClose();
        },
        next: idle.next
      };
    }
  };
  __testing.setQueryFn(factory.queryFn);

  const previousValue = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';

  const origConsoleLog = console.log;
  console.log = (...args) => { /* suppress */ };

  try {
    await getContextUsagePersistent({
      sessionId: 'sess-keep-1m',
      model: 'claude-opus-4-7[1m]',
      cwd: process.cwd(),
    });

    assert.deepEqual(observedValues, [null],
      'explicit [1m] requests should temporarily clear the disable-1M override');
    assert.equal(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, '1',
      'should restore original CLAUDE_CODE_DISABLE_1M_CONTEXT after explicit [1m] query');
  } finally {
    console.log = origConsoleLog;
    if (previousValue === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    } else {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = previousValue;
    }
  }
});
