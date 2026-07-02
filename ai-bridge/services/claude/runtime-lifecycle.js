import { AsyncStream } from '../../utils/async-stream.js';
import { loadClaudeSdk } from '../../utils/sdk-loader.js';
import { createPreToolUseHook, normalizePermissionMode } from './permission-mode.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes as cleanupAnonymousFromRegistry,
  cleanupStaleSessionRuntimes as cleanupSessionsFromRegistry,
  clearActiveTurnRuntimeIf,
  endRuntimeTurn,
  findRuntimeForRequest,
  rememberRuntime,
  promoteRuntimeToSession,
  removeRuntime,
  touchRuntime
} from './runtime-registry.js';

let cachedQueryFn = null;

/**
 * TurnSink: A simple queue/channel for passing messages from the perpetual reader to executeTurn.
 * Used to coordinate message flow during active turns.
 *
 * The turnSink acts as a bridge between the perpetual reader (which owns runtime.query.next())
 * and executeTurn (which processes messages). This design ensures:
 * 1. Only one consumer (perpetual reader) calls query.next(), preventing buffering issues
 * 2. executeTurn receives messages via a simple queue without blocking the reader
 * 3. Clean separation between in-turn and inter-turn message routing
 */
export function createTurnSink() {
  const queue = [];
  const waiters = []; // FIFO queue of pending take() resolvers
  let failed = false;
  let failureError = null;

  return {
    /**
     * Push a message into the sink (called by perpetual reader during active turn).
     * Hands the message to the oldest pending take() if any, otherwise queues it.
     */
    push(msg) {
      if (failed) return; // Ignore pushes after failure
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },

    /**
     * Take the next message from the sink (called by executeTurn).
     * Returns a promise that resolves to { value, done }.
     * If no messages are queued, waits for the next push. Concurrent takers are
     * served in FIFO order so none are ever orphaned.
     */
    async take() {
      if (failed) {
        throw failureError;
      }
      if (queue.length > 0) {
        return { value: queue.shift(), done: false };
      }
      // Wait for next push
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },

    /**
     * Signal that the stream has failed or completed.
     * Idempotent: the first error wins, and every pending take() is rejected
     * once so none hang. After failure, take() throws synchronously, so no new
     * waiter can be enqueued.
     */
    fail(error) {
      if (failed) return; // Keep the first failure reason
      failed = true;
      failureError = error;
      while (waiters.length > 0) {
        waiters.shift().reject(error);
      }
    }
  };
}

export function buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch) {
  const material = {
    cwd: options.cwd || '',
    additionalDirectories: options.additionalDirectories || [],
    systemPromptAppend: systemPromptAppend || '',
    streamingEnabled: !!streamingEnabled,
    runtimeSessionEpoch: runtimeSessionEpoch || '',
    model: options.model || '',
    effort: options.effort || ''
  };
  return JSON.stringify(material);
}

async function ensureQueryFn() {
  if (cachedQueryFn) return cachedQueryFn;
  const sdk = await loadClaudeSdk();
  const queryFn = sdk?.query;
  if (typeof queryFn !== 'function') {
    throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
  }
  cachedQueryFn = queryFn;
  return cachedQueryFn;
}

export function setCachedQueryFn(queryFn) {
  cachedQueryFn = queryFn;
}

export function resetCachedQueryFn() {
  cachedQueryFn = null;
}

export function registerRuntimeSession(runtime, sessionId, callbacks) {
  promoteRuntimeToSession(runtime, sessionId, callbacks);
}

export async function disposeRuntime(runtime, callbacks) {
  if (!runtime || runtime.closed) return;
  console.log('[LIFECYCLE] disposeRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + (runtime.runtimeSignature || '(none)'));
  runtime.closed = true;
  runtime.activeTurnCount = 0;

  try {
    runtime.inputStream.done();
  } catch (err) {
    console.error('[LIFECYCLE] inputStream.done() failed:', err?.message || err);
  }

  try {
    runtime.query?.close?.();
  } catch (err) {
    console.error('[LIFECYCLE] query.close() failed:', err?.message || err);
  }

  removeRuntime(runtime, callbacks?.removeSession);
  clearActiveTurnRuntimeIf(runtime);
}

async function createRuntime(requestContext, callbacks) {
  const queryFn = await ensureQueryFn();
  const initialPermissionMode = normalizePermissionMode(requestContext.permissionMode);

  const runtime = {
    closed: false,
    sessionId: requestContext.requestedSessionId || null,
    runtimeSessionEpoch: requestContext.runtimeSessionEpoch || null,
    runtimeSignature: requestContext.runtimeSignature,
    currentModel: requestContext.sdkModelName || null,
    modelId: requestContext.modelId || null, // Original model ID, may contain [1m] suffix
    currentPermissionMode: initialPermissionMode,
    permissionModeState: { value: initialPermissionMode },
    currentMaxThinkingTokens: requestContext.maxThinkingTokens ?? null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    activeTurnCount: 0,
    stderrLines: [],
    query: null,
    inputStream: new AsyncStream(),
    titleGenerationAttempted: false
  };

  const options = {
    ...requestContext.options,
    stderr: (data) => {
      try {
        const text = (data ?? '').toString().trim();
        if (!text) return;
        runtime.stderrLines.push(text);
        if (runtime.stderrLines.length > 200) {
          runtime.stderrLines.shift();
        }
        console.error(`[SDK-STDERR] ${text}`);
      } catch (_) {
      }
    }
  };

  options.hooks = {
    ...(options.hooks || {}),
    PreToolUse: [{
      hooks: [createPreToolUseHook(runtime.permissionModeState, options.cwd, async (mode) => {
        if (runtime.currentPermissionMode === mode) {
          runtime.permissionModeState.value = mode;
          return;
        }
        if (typeof runtime.query?.setPermissionMode === 'function') {
          try {
            await runtime.query.setPermissionMode(mode);
          } catch (error) {
            console.warn('[LIFECYCLE] hook setPermissionMode failed, updating local state only:', error.message);
          }
        }
        // Always update local state to keep hook and runtime in sync
        runtime.currentPermissionMode = mode;
        runtime.permissionModeState.value = mode;
      })]
    }]
  };

  runtime.query = queryFn({
    prompt: runtime.inputStream,
    options
  });

  rememberRuntime(runtime, requestContext, callbacks?.registerActiveQueryResult);

  console.log('[LIFECYCLE] createRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + runtime.runtimeSignature);

  // Start the perpetual reader for this runtime
  // The reader will continuously consume runtime.query.next() for the runtime's lifetime
  startPerpetualReader(runtime, callbacks);

  return runtime;
}

/**
 * Start the perpetual reader for a runtime.
 * The reader continuously consumes runtime.query.next() for the runtime's lifetime,
 * routing messages to either the active turn (via turnSink) or inter-turn handling.
 *
 * This is the single source of truth for consuming the SDK query iterator.
 * executeTurn() no longer calls query.next() directly - it receives messages via turnSink.
 *
 * Exported for testing; returns the reader loop promise.
 */
export function startPerpetualReader(runtime, callbacks) {
  /**
   * Emit an inter-turn event using daemon.js's writeRawLine mechanism.
   *
   * IMPORTANT: Must bypass activeRequestId interception to avoid misrouting.
   *
   * Why writeRawLine is required:
   * - daemon.js intercepts process.stdout.write and wraps output with activeRequestId
   * - If we used console.log() here, the event would be tagged with whatever request
   *   is currently active (possibly from a different session)
   * - This would cause the session_updated event to be delivered to the wrong session
   * - writeRawLine (_originalStdoutWrite) bypasses the interception layer and outputs
   *   directly to stdout, ensuring the event is process-level and not request-scoped
   *
   * The event format {type: 'daemon', event: 'session_updated', sessionId} is recognized
   * by Java's DaemonBridge.handleDaemonEvent() which routes it to registered listeners.
   */
  const emitInterTurnEvent = (sessionId) => {
    try {
      // Access the global writeRawLine from daemon.js
      // daemon.js stores the original stdout.write as _originalStdoutWrite
      // We must use _originalStdoutWrite to bypass activeRequestId wrapping
      const originalWrite = process.stdout._originalStdoutWrite;
      if (!originalWrite) {
        console.error('[PERPETUAL_READER] _originalStdoutWrite not available (daemon.js not initialized?), cannot emit session_updated event');
        return;
      }
      const eventPayload = {
        type: 'daemon',
        event: 'session_updated',
        sessionId: sessionId
      };
      originalWrite.call(process.stdout, JSON.stringify(eventPayload) + '\n', 'utf8');
    } catch (err) {
      console.error('[PERPETUAL_READER] Failed to emit session_updated event:', err);
    }
  };

  // Start the perpetual reader loop; return the promise so callers (and tests)
  // can await its completion.
  return (async () => {
    console.log('[PERPETUAL_READER] Starting for sessionId=' + (runtime.sessionId || '(new)'));

    try {
      while (!runtime.closed) {
        let next;

        try {
          next = await runtime.query.next();
        } catch (error) {
          console.error('[PERPETUAL_READER] query.next() error:', error?.message || error);
          // Forward error to turnSink if active turn exists
          if (runtime.turnSink) {
            runtime.turnSink.fail(error);
          }
          break; // Exit loop on error
        }

        // Check for iterator completion
        if (next.done) {
          console.log('[PERPETUAL_READER] Iterator completed (done: true)');
          if (runtime.turnSink) {
            runtime.turnSink.fail(new Error('stream ended'));
          }
          break; // Exit loop
        }

        const msg = next.value;

        // Keep the runtime's idle timer fresh while it actively produces output.
        // cleanupStaleSessionRuntimes reaps runtimes idle past SESSION_RUNTIME_MAX_IDLE_MS
        // and only spares those with activeTurnCount > 0 — which is 0 between turns.
        // Without this, a long-running background task (inter-turn) would be reaped
        // mid-flight, killing the SDK subprocess and losing its completion. In-turn
        // messages are also touched by executeTurn; touching here is idempotent and
        // additionally covers the inter-turn path executeTurn cannot see.
        touchRuntime(runtime);

        // Dual-mode routing: check if we're in an active turn or inter-turn period
        if (runtime.turnSink) {
          // IN-TURN MODE: Forward message to executeTurn via turnSink
          runtime.turnSink.push(msg);
        } else {
          // INTER-TURN MODE: Handle message outside of active turn
          // For phase 1: only emit event when we see a 'result' message
          // This indicates a complete turn has been generated by CLI
          if (msg?.type === 'result') {
            // Validate sessionId: only emit events for registered runtimes
            if (runtime.sessionId) {
              console.log('[PERPETUAL_READER] Inter-turn result detected, emitting session_updated for sessionId=' + runtime.sessionId);
              emitInterTurnEvent(runtime.sessionId);
            } else {
              // Anonymous runtime - silently consume
              console.log('[PERPETUAL_READER] Inter-turn result for anonymous runtime, consuming silently');
            }
          }
          // For other message types during inter-turn, we silently consume
          // (they've already been persisted to JSONL by the CLI)
        }
      }
    } catch (error) {
      console.error('[PERPETUAL_READER] Unexpected error in reader loop:', error);
      if (runtime.turnSink) {
        runtime.turnSink.fail(error);
      }
    } finally {
      console.log('[PERPETUAL_READER] Exiting for sessionId=' + (runtime.sessionId || '(new)'));
      // The reader only exits on a terminal condition (query error, stream end,
      // or runtime closed) — never after a normal turn, where it blocks on the
      // next query.next() instead. If the runtime is still live here, the SDK
      // stream ended out-of-band (e.g. the subprocess died while idle between
      // turns). Evict it so the next request builds a fresh runtime rather than
      // reusing this one, whose dead reader would hang executeTurn's
      // turnSink.take() forever. disposeRuntime() is idempotent, so this is safe
      // even when the active-turn error path disposes the runtime too.
      if (!runtime.closed) {
        try {
          await disposeRuntime(runtime, callbacks);
        } catch (err) {
          console.error('[PERPETUAL_READER] dispose on exit failed:', err?.message || err);
        }
      }
    }
  })();
}

async function applyDynamicControls(runtime, requestContext) {
  if (!runtime || runtime.closed) return;

  const targetPermissionMode = normalizePermissionMode(requestContext.permissionMode);
  if (runtime.currentPermissionMode !== targetPermissionMode) {
    if (typeof runtime.query?.setPermissionMode === 'function') {
      try {
        await runtime.query.setPermissionMode(targetPermissionMode);
      } catch (error) {
        console.error('[DAEMON] setPermissionMode failed:', error.message);
      }
    }
    runtime.currentPermissionMode = targetPermissionMode;
    if (runtime.permissionModeState) {
      runtime.permissionModeState.value = targetPermissionMode;
    }
  }

  const targetModel = requestContext.sdkModelName || null;
  if (runtime.currentModel !== targetModel && typeof runtime.query?.setModel === 'function') {
    try {
      await runtime.query.setModel(targetModel || undefined);
      runtime.currentModel = targetModel;
    } catch (error) {
      console.error('[DAEMON] setModel failed:', error.message);
    }
  }

  const targetThinking = requestContext.maxThinkingTokens ?? null;
  if (runtime.currentMaxThinkingTokens !== targetThinking && typeof runtime.query?.setMaxThinkingTokens === 'function') {
    try {
      await runtime.query.setMaxThinkingTokens(targetThinking);
      runtime.currentMaxThinkingTokens = targetThinking;
    } catch (error) {
      console.error('[DAEMON] setMaxThinkingTokens failed:', error.message);
    }
  }
}

function assertRuntimeOwnership(runtime, requestContext) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    const err = new Error(
      `Runtime ownership mismatch: expected epoch ${requestContext.runtimeSessionEpoch}, got ${runtime.runtimeSessionEpoch || '(none)'}`
    );
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.requestedSessionId && runtime.sessionId && runtime.sessionId !== requestContext.requestedSessionId) {
    const err = new Error(
      `Runtime ownership mismatch: expected session ${requestContext.requestedSessionId}, got ${runtime.sessionId}`
    );
    err.runtimeTerminated = true;
    throw err;
  }
}

export async function acquireRuntime(requestContext, callbacks) {
  await cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));

  let runtime = findRuntimeForRequest(requestContext);

  if (runtime && runtime.runtimeSignature !== requestContext.runtimeSignature) {
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (runtime && requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    console.log('[LIFECYCLE] disposeRuntimeForEpochMismatch existing=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' requested=' + requestContext.runtimeSessionEpoch);
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (!runtime) {
    runtime = await createRuntime(requestContext, callbacks);
  } else {
    console.log('[LIFECYCLE] reuseRuntime sessionId=' + (runtime.sessionId || '(new)')
      + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' signature=' + runtime.runtimeSignature);
  }

  assertRuntimeOwnership(runtime, requestContext);
  await applyDynamicControls(runtime, requestContext);
  touchRuntime(runtime);
  return runtime;
}

export async function cleanupStaleAnonymousRuntimes(callbacks) {
  return cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export async function cleanupStaleSessionRuntimes(callbacks) {
  return cleanupSessionsFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export { beginRuntimeTurn, endRuntimeTurn, touchRuntime, applyDynamicControls };
