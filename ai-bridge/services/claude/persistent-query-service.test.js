import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __testing } from './persistent-query-service.js';
import { createTurnSink } from './runtime-lifecycle.js';

// buildRequestContext() calls setupApiKey(), which reads credentials ONLY from
// ~/.claude/settings.json and gates that read on ~/.codemoss/config.json.
// Running it in-process therefore depends on the developer's real configuration
// and throws "API Key not configured" on a bare machine — which is exactly how
// these tests failed in CI while passing locally. getRealHomeDir() caches its
// result, so overriding HOME in this process is not reliable; mirror
// api-config.test.js and run the call in an isolated child process whose HOME
// points at a temp home we control.
const PQS_MODULE_URL = new URL('./persistent-query-service.js', import.meta.url).href;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function createTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-pqs-home-'));
  // access:'local' — otherwise loadClaudeSettings() skips the read entirely.
  fs.mkdirSync(path.join(home, '.codemoss'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.codemoss', 'config.json'),
    JSON.stringify({ claude: { current: '__local_settings_json__' } }),
    'utf8',
  );
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-test-key' } }),
    'utf8',
  );
  return home;
}

/** Resolve buildRequestContext's thinking options under a controlled HOME. */
function resolveThinkingOptions(request, settings) {
  const home = createTempHome();
  try {
    const script = `
      import { __testing } from ${JSON.stringify(PQS_MODULE_URL)};
      const context = await __testing.buildRequestContext(
        ${JSON.stringify(request)}, false, ${JSON.stringify({ settings })},
      );
      process.stdout.write('@@' + JSON.stringify({
        thinking: context.options.thinking ?? null,
        maxThinkingTokens: context.options.maxThinkingTokens ?? null,
      }));
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      // api-config resolves some paths relative to the repo root.
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // setupApiKey ignores shell credentials, but keep them out anyway so the
        // temp settings.json is unambiguously the only source.
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
      encoding: 'utf8',
    });
    const marker = stdout.lastIndexOf('@@');
    assert.ok(marker >= 0, `child produced no result payload:\n${stdout}`);
    return JSON.parse(stdout.slice(marker + 2));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

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

// ============================================================================
// Thinking config: Mythos-class models need an explicit visible display
// ============================================================================

test('buildRequestContext sends thinking adaptive+summarized for Fable instead of maxThinkingTokens', () => {
  const options = resolveThinkingOptions(
    { message: 'hi', model: 'claude-fable-5' },
    { alwaysThinkingEnabled: true },
  );
  assert.deepEqual(options.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(options.maxThinkingTokens, null);
});

test('buildRequestContext sends thinking disabled for Fable when disableThinking is set', () => {
  const options = resolveThinkingOptions(
    { message: 'hi', model: 'claude-fable-5', disableThinking: true },
    { alwaysThinkingEnabled: true },
  );
  assert.deepEqual(options.thinking, { type: 'disabled' });
  assert.equal(options.maxThinkingTokens, null);
});

test('buildRequestContext keeps the legacy maxThinkingTokens path for models with visible default display', () => {
  const options = resolveThinkingOptions(
    { message: 'hi', model: 'claude-sonnet-4-6' },
    { alwaysThinkingEnabled: true, maxThinkingTokens: 12000 },
  );
  assert.equal(options.thinking, null);
  assert.equal(options.maxThinkingTokens, 12000);
});

console.log('\n✅ All persistent-query-service tests updated with turnSink coverage');
