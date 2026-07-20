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

export function buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch, modelId) {
  const material = {
    cwd: options.cwd || '',
    additionalDirectories: options.additionalDirectories || [],
    systemPromptAppend: systemPromptAppend || '',
    streamingEnabled: !!streamingEnabled,
    runtimeSessionEpoch: runtimeSessionEpoch || '',
    model: options.model || '',
    effort: options.effort || '',
    // The [1m] suffix selects the 1M context window. The CLI subprocess locks
    // the window in at spawn from its environment, and setModel() cannot change
    // it afterwards (see shouldRecreateRuntimeForModel) — so toggling [1m] must
    // change the signature and rebuild the runtime instead of reusing it.
    contextWindow1M: (modelId || '').includes('[1m]'),
    // bypassPermissions (Auto mode) requires allowDangerouslySkipPermissions,
    // which the SDK passes as a process-launch argv flag — it is frozen at spawn
    // and setPermissionMode() (a runtime control request) cannot add it to a
    // live subprocess. So a runtime spawned in another mode keeps prompting via
    // canUseTool even after switching to Auto. Put the bypass state in the
    // signature so entering/leaving Auto rebuilds the runtime with the correct
    // launch flag. The other modes (default/plan/acceptEdits) need no launch
    // flag and keep applying live via setPermissionMode, so they intentionally
    // do NOT change the signature.
    bypassPermissions: options.permissionMode === 'bypassPermissions'
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
    currentResolvedModel: requestContext.resolvedModelId || null,
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
  const emitDaemonEvent = (event, sessionId, extra) => {
    try {
      // Access the global writeRawLine from daemon.js
      // daemon.js stores the original stdout.write as _originalStdoutWrite
      // We must use _originalStdoutWrite to bypass activeRequestId wrapping
      const originalWrite = process.stdout._originalStdoutWrite;
      if (!originalWrite) {
        console.error('[PERPETUAL_READER] _originalStdoutWrite not available (daemon.js not initialized?), cannot emit ' + event + ' event');
        return;
      }
      const eventPayload = {
        type: 'daemon',
        event,
        sessionId,
        ...(extra || {})
      };
      originalWrite.call(process.stdout, JSON.stringify(eventPayload) + '\n', 'utf8');
    } catch (err) {
      console.error('[PERPETUAL_READER] Failed to emit ' + event + ' event:', err);
    }
  };
  const emitInterTurnEvent = (sessionId) => emitDaemonEvent('session_updated', sessionId);

  // background_turn events tell the GUI when the CLI itself is generating a
  // response between GUI turns (e.g. answering a task-notification) — there is
  // no GUI-owned streaming state for those turns, so without this signal the
  // chat shows no waiting indicator while the answer is being produced.
  // 'active' doubles as a heartbeat so the webview can expire the state (20s
  // TTL) if the daemon dies without sending 'idle'. The heartbeat MUST be
  // timer-driven, not message-driven: background turns routinely go silent for
  // minutes at a time (a long tool call, deep thinking) and a heartbeat tied
  // to message arrival lets the TTL expire mid-turn — exactly when the user
  // most needs to see that work is still in progress.
  const emitBackgroundTurnState = (sessionId, state) => {
    if (!sessionId) return;
    emitDaemonEvent('background_turn', sessionId, { state });
  };

  const beginBackgroundTurn = (sessionId) => {
    if (runtime.interTurnActive) return;
    runtime.interTurnActive = true;
    emitBackgroundTurnState(sessionId, 'active');
    const intervalMs = runtime.interTurnHeartbeatMs ?? 5000;
    runtime.interTurnHeartbeatTimer = setInterval(() => {
      emitBackgroundTurnState(runtime.sessionId || sessionId, 'active');
    }, intervalMs);
    // Never keep the daemon process alive just for the heartbeat.
    runtime.interTurnHeartbeatTimer.unref?.();
  };

  const endBackgroundTurn = (sessionId) => {
    if (runtime.interTurnHeartbeatTimer) {
      clearInterval(runtime.interTurnHeartbeatTimer);
      runtime.interTurnHeartbeatTimer = null;
    }
    if (!runtime.interTurnActive) return;
    runtime.interTurnActive = false;
    emitBackgroundTurnState(sessionId, 'idle');
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
          // A GUI-owned turn has its own streaming state; clear any leftover
          // background-turn indicator from a preceding inter-turn burst.
          endBackgroundTurn(runtime.sessionId || msg?.session_id || null);
          runtime.turnSink.push(msg);
        } else {
          // INTER-TURN MODE: Handle message outside of active turn.
          // These turns come from the CLI itself — e.g. a background Task
          // finishing re-invokes the main loop with a task-notification and the
          // model answers without any user request in flight. The messages are
          // already persisted to JSONL by the CLI, so the UI only needs a
          // session_updated nudge to reload and render them. Without the
          // throttled nudges below, the whole background turn stayed invisible
          // until the user sent another message.
          //
          // runtime.sessionId can be unset (anonymous runtime); fall back to
          // the session id carried on the SDK message itself.
          const interTurnSessionId = runtime.sessionId || msg?.session_id || null;
          if (msg?.type === 'result') {
            endBackgroundTurn(interTurnSessionId);
            if (interTurnSessionId) {
              console.log('[PERPETUAL_READER] Inter-turn result detected, emitting session_updated for sessionId=' + interTurnSessionId);
              runtime.lastInterTurnEmitMs = Date.now();
              emitInterTurnEvent(interTurnSessionId);
            } else {
              // Anonymous runtime without a session id on the message - silently consume
              console.log('[PERPETUAL_READER] Inter-turn result for anonymous runtime, consuming silently');
            }
          } else if (
            interTurnSessionId
            && (msg?.type === 'assistant' || msg?.type === 'user' || msg?.type === 'system')
          ) {
            // The CLI is generating a background turn — signal it immediately
            // on the first message of the burst so the waiting indicator shows
            // without waiting for a heartbeat tick.
            beginBackgroundTurn(interTurnSessionId);
            // Throttled progress nudge so the background turn renders live
            // instead of appearing all at once on its final result. Each nudge
            // makes the plugin reload the whole session JSONL, so keep the
            // cadence low — 5s reads as "live" without visible reload churn.
            const now = Date.now();
            if (!runtime.lastInterTurnEmitMs || now - runtime.lastInterTurnEmitMs >= 5000) {
              runtime.lastInterTurnEmitMs = now;
              console.log('[PERPETUAL_READER] Inter-turn activity, emitting throttled session_updated for sessionId=' + interTurnSessionId);
              emitInterTurnEvent(interTurnSessionId);
            }
          }
        }
      }
    } catch (error) {
      console.error('[PERPETUAL_READER] Unexpected error in reader loop:', error);
      if (runtime.turnSink) {
        runtime.turnSink.fail(error);
      }
    } finally {
      console.log('[PERPETUAL_READER] Exiting for sessionId=' + (runtime.sessionId || '(new)'));
      // A reader exiting mid-background-turn (stream error, subprocess death)
      // never reaches the result message — stop the heartbeat and clear the
      // indicator explicitly so it does not linger until the webview TTL.
      endBackgroundTurn(runtime.sessionId || null);
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
  const targetResolvedModel = requestContext.resolvedModelId || null;
  // Compare both the SDK short name AND the resolved model ID: a settings-side
  // remap (e.g. sonnet -> "MiniMax-M2.5") changes only the resolved ID.
  // Pass the resolved ID to setModel, not the short name: the CLI subprocess
  // resolves short names against its OWN environment, which was frozen at spawn
  // time — the daemon-side env update in setModelEnvironmentVariables never
  // reaches a live subprocess. The resolved ID needs no env lookup. ([1m]
  // toggles never get here: they change the runtime signature, so acquireRuntime
  // rebuilds the runtime instead of reusing it.)
  if ((runtime.currentModel !== targetModel || runtime.currentResolvedModel !== targetResolvedModel)
      && typeof runtime.query?.setModel === 'function') {
    try {
      await runtime.query.setModel(targetResolvedModel || targetModel || undefined);
      runtime.currentModel = targetModel;
      runtime.currentResolvedModel = targetResolvedModel;
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
