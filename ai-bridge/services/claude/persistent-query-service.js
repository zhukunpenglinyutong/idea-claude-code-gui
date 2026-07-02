/**
 * Persistent query service for daemon mode.
 * Keeps Claude Query processes alive across turns to reduce per-request latency.
 */

import {
  isCustomBaseUrl,
  loadClaudeSettings,
  setupApiKey,
  buildCliEnv,
  buildWebviewControlledSettingsOverride,
} from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import {
  mapModelIdToSdkName,
  resolveModelFromSettings,
  setModelEnvironmentVariables
} from '../../utils/model-utils.js';
import { canUseTool } from '../../permission-handler.js';
import { buildContentBlocks, loadAttachments } from './attachment-service.js';
import { buildIDEContextPrompt } from '../system-prompts.js';
import { buildQuickFixPrompt } from '../quickfix-prompts.js';
import { registerActiveQueryResult, removeSession } from './message-service.js';
import { normalizePermissionMode } from './permission-mode.js';
import { redactSecrets, truncateString } from './message-output-filter.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes,
  cleanupStaleSessionRuntimes,
  disposeRuntime,
  registerRuntimeSession,
  acquireRuntime,
  applyDynamicControls,
  buildRuntimeSignature,
  endRuntimeTurn,
  resetCachedQueryFn,
  setCachedQueryFn,
  touchRuntime,
  createTurnSink,
} from './runtime-lifecycle.js';
import {
  SESSION_CLEANUP_INTERVAL_MS,
  clearActiveTurnRuntime,
  clearActiveTurnRuntimeIf,
  getActiveTurnRuntime,
  getAllRuntimes,
  getRuntimeForSession,
  getSnapshot,
  resetRegistryState,
  setActiveTurnRuntime,
} from './runtime-registry.js';
import { loadMcpServersConfigAsRecord } from './mcp-status/config-loader.js';
import {
  createTurnState,
  emitUsageTag,
  processMessageContent,
  processStreamEvent,
  processToolResultMessages,
  shouldOutputMessage,
} from './stream-event-processor.js';
import { generateSessionTitle } from '../session-title-service.js';
import { getClaudeCliPathOverride } from '../../utils/claude-cli-path.js';

const SUPPORTED_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function resolveReasoningEffort(params) {
  const effort = typeof params.reasoningEffort === 'string'
    ? params.reasoningEffort.trim()
    : '';
  return SUPPORTED_EFFORT_LEVELS.has(effort) ? effort : undefined;
}

function resolveThinkingTokens(params, settings) {
  if (resolveReasoningEffort(params)) return undefined;

  const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
  const configuredMax = settings?.maxThinkingTokens
    || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
    || 10000;

  if (params.disableThinking === true) return 0;
  if (alwaysThinkingEnabled) return configuredMax;
  return undefined;
}

function resolveStreamingEnabled(params, settings) {
  return params.streaming != null
    ? !!params.streaming
    : (settings?.streamingEnabled ?? false);
}

/**
 * Extract text content from a user message object.
 * @param {object} userMessage - User message object from buildUserMessage()
 * @returns {string|null} Extracted text or null
 */
function extractUserMessageText(userMessage) {
  if (!userMessage?.message?.content) return null;
  const content = userMessage.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find(b => b.type === 'text');
    return textBlock?.text || null;
  }
  return null;
}

function buildSystemPromptAppend(params) {
  const openedFiles = params.openedFiles || null;
  const agentPrompt = params.agentPrompt || null;
  if (openedFiles && openedFiles.isQuickFix) {
    return buildQuickFixPrompt(openedFiles, params.message || '');
  }
  return buildIDEContextPrompt(openedFiles, agentPrompt);
}

function resolveRequestModelState(modelId, settingsEnv) {
  return {
    sdkModelName: mapModelIdToSdkName(modelId),
    resolvedModelId: resolveModelFromSettings(modelId, settingsEnv),
  };
}

function buildQueryOptions(workingDirectory, sdkModelName, permissionMode, maxThinkingTokens, reasoningEffort, streamingEnabled, systemPromptAppend, requestedSessionId, mcpServers, modelId) {
  const claudeCliOverride = getClaudeCliPathOverride();
  return {
    cwd: workingDirectory,
    permissionMode,
    model: sdkModelName,
    maxTurns: 100,
    enableFileCheckpointing: true,
    env: buildCliEnv(),
    settings: buildWebviewControlledSettingsOverride(modelId),
    ...(reasoningEffort && { effort: reasoningEffort }),
    ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
    ...(streamingEnabled && { includePartialMessages: true }),
    additionalDirectories: Array.from(
      new Set(
        [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
      )
    ),
    canUseTool,
    settingSources: ['user', 'project', 'local'],
    // bypassPermissions requires this flag per SDK contract (sdk.d.ts: "Must be set to
    // true when using permissionMode: 'bypassPermissions'"). Without it a future SDK
    // version could silently drop bypass and change permission behavior.
    ...(permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
    ...(mcpServers && { mcpServers }),
    ...(claudeCliOverride && { pathToClaudeCodeExecutable: claudeCliOverride }),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(systemPromptAppend && { append: systemPromptAppend })
    },
    ...(requestedSessionId && { resume: requestedSessionId })
  };
}

async function buildUserMessage(params, withAttachments, requestedSessionId, resolvedModelId = null) {
  if (withAttachments) {
    const attachments = await loadAttachments({ attachments: params.attachments || [] });
    const contentBlocks = await buildContentBlocks(attachments, params.message || '', resolvedModelId);
    return {
      type: 'user',
      session_id: requestedSessionId || '',
      parent_tool_use_id: null,
      message: { role: 'user', content: contentBlocks }
    };
  }

  const userText = (params.message || '').trim() || '[Empty message]';
  return {
    type: 'user',
    session_id: requestedSessionId || '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: userText }] }
  };
}

async function buildRequestContext(params, withAttachments, overrides = {}) {
  setupApiKey();

  const baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_URL || '';
  if (isCustomBaseUrl(baseUrl)) {
    console.debug('[DEBUG] Custom Base URL detected');
  }

  const requestedSessionId = (typeof params.sessionId === 'string' && params.sessionId.trim() !== '')
    ? params.sessionId.trim()
    : null;
  const runtimeSessionEpoch = (typeof params.runtimeSessionEpoch === 'string' && params.runtimeSessionEpoch.trim() !== '')
    ? params.runtimeSessionEpoch.trim()
    : null;

  const workingDirectory = selectWorkingDirectory(params.cwd || null);
  try {
    process.chdir(workingDirectory);
  } catch (error) {
    console.error('[WARNING] Failed to change process.cwd():', error.message);
  }

  const settings = overrides.settings ?? loadClaudeSettings();
  const modelId = params.model || null;
  const { sdkModelName, resolvedModelId } = resolveRequestModelState(modelId, settings?.env);
  setModelEnvironmentVariables(resolvedModelId, modelId);

  const permissionMode = normalizePermissionMode(params.permissionMode);
  const streamingEnabled = resolveStreamingEnabled(params, settings);
  const reasoningEffort = resolveReasoningEffort(params);
  const maxThinkingTokens = resolveThinkingTokens(params, settings);
  const systemPromptAppend = buildSystemPromptAppend(params);

  const mcpServers = await loadMcpServersConfigAsRecord(workingDirectory);

  const options = buildQueryOptions(
    workingDirectory, sdkModelName, permissionMode,
    maxThinkingTokens, reasoningEffort, streamingEnabled, systemPromptAppend, requestedSessionId,
    mcpServers, modelId
  );

  const userMessage = await buildUserMessage(params, withAttachments, requestedSessionId, resolvedModelId);

  const runtimeSignature = buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch);
  console.log('[LIFECYCLE] buildRequestContext sessionId=' + (requestedSessionId || '(new)')
    + ' epoch=' + (runtimeSessionEpoch || '(none)')
    + ' signature=' + runtimeSignature);

  return {
    requestedSessionId,
    runtimeSessionEpoch,
    streamingEnabled,
    options,
    userMessage,
    sdkModelName,
    modelId, // Original model ID from params, may contain [1m] suffix
    resolvedModelId,
    permissionMode,
    maxThinkingTokens,
    reasoningEffort,
    runtimeSignature
  };
}

// Background cleanup of idle session runtimes, decoupled from the request hot path.
// Runs every 5 minutes instead of on every acquireRuntime call to avoid O(n) scans.
const _sessionCleanupTimer = setInterval(async () => {
  await cleanupStaleSessionRuntimes({ registerActiveQueryResult, removeSession });
}, SESSION_CLEANUP_INTERVAL_MS);
// unref() so the timer does not prevent natural process exit
_sessionCleanupTimer.unref();

async function executeTurn(runtime, requestContext, turnMeta) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  setActiveTurnRuntime(runtime);
  console.log('[LIFECYCLE] executeTurn sessionId=' + (requestContext.requestedSessionId || runtime.sessionId || '(new)')
    + ' epoch=' + (requestContext.runtimeSessionEpoch || runtime.runtimeSessionEpoch || '(none)'));

  const turnState = createTurnState(requestContext, runtime);
  if (turnMeta) {
    turnMeta.state = turnState;
  }

  try {
    beginRuntimeTurn(runtime);

    // Create and register turnSink after beginRuntimeTurn to avoid race
    // (ensures executeTurn is ready to consume before perpetual reader can push)
    runtime.turnSink = createTurnSink();

    console.log('[MESSAGE_START]');
    runtime.inputStream.enqueue(requestContext.userMessage);

    while (true) {
      let next;
      try {
        // Receive message from perpetual reader via turnSink
        // (perpetual reader owns runtime.query.next())
        next = await runtime.turnSink.take();
      } catch (error) {
        const wrapped = new Error(error?.message || String(error));
        wrapped.runtimeTerminated = true;
        throw wrapped;
      }

      if (next.done) {
        const err = new Error('Claude session stream ended unexpectedly');
        err.runtimeTerminated = true;
        throw err;
      }

      touchRuntime(runtime);
      const msg = next.value;

      if (turnState.streamingEnabled && !turnState.streamStarted) {
        process.stdout.write('[STREAM_START]\n');
        turnState.streamStarted = true;
      }

      if (msg?.type === 'stream_event' && turnState.streamingEnabled) {
        turnState.hasStreamEvents = true;
        processStreamEvent(msg, turnState);
        continue;
      }

      // Preserve all existing message processing logic
      if (shouldOutputMessage(msg, turnState)) {
        console.log('[MESSAGE]', JSON.stringify(msg));
      }

      processMessageContent(msg, turnState);
      // Emit usage tag for assistant messages.
      // IMPORTANT: This is the authoritative source for token usage, NOT the accumulatedUsage.
      // The assistant message's usage field contains the correct cumulative total.
      // In streaming mode, this overwrites any intermediate [USAGE] values sent during streaming.
      // The Java backend (ClaudeMessageHandler.handleAssistantMessage) relies on this for correct totals.
      emitUsageTag(msg);
      processToolResultMessages(msg);

      if (msg?.type === 'system' && msg.session_id) {
        turnState.finalSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);
        registerRuntimeSession(runtime, msg.session_id, { registerActiveQueryResult, removeSession });
      }

      if (msg?.type === 'result') {
        if (msg.is_error) {
          throw new Error(msg.result || msg.message || 'API request failed');
        }
        break;
      }
    }

    if (turnState.streamingEnabled && turnState.streamStarted && !turnState.streamEnded) {
      // NOTE: Do NOT emit accumulatedUsage at stream end.
      // The assistant message's usage (sent via emitUsageTag above) is the authoritative final value.
      // Emitting accumulatedUsage here would send a redundant or potentially stale value.
      process.stdout.write('[STREAM_END]\n');
      turnState.streamEnded = true;
    }

    const finalSessionId = turnState.finalSessionId || runtime.sessionId || requestContext.requestedSessionId || '';
    if (finalSessionId) {
      registerRuntimeSession(runtime, finalSessionId, { registerActiveQueryResult, removeSession });
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      sessionId: finalSessionId
    }));

    // Fire-and-forget: generate AI title for new sessions (not resumes).
    // titleGenerationAttempted prevents duplicate calls when a second message
    // arrives before the first Haiku API response completes.
    // The flag is reset if generateSessionTitle reports a transient failure
    // so a future turn may retry; permanent skips (e.g. CLI login mode) keep
    // the flag set to avoid endless retries.
    if (!requestContext.requestedSessionId && finalSessionId && !runtime.titleGenerationAttempted) {
      runtime.titleGenerationAttempted = true;
      const userMessageText = extractUserMessageText(requestContext.userMessage);
      if (userMessageText) {
        generateSessionTitle(userMessageText, finalSessionId, requestContext.options.cwd)
          .then((completed) => {
            if (!completed) {
              runtime.titleGenerationAttempted = false;
            }
          })
          .catch(() => {
            runtime.titleGenerationAttempted = false;
          });
      }
    }
  } finally {
    endRuntimeTurn(runtime);
    // Clear turnSink after endRuntimeTurn (reverse of creation order)
    runtime.turnSink = null;
    // Only clear if this runtime still owns the pointer (not cleared by abort)
    clearActiveTurnRuntimeIf(runtime);
  }
}

function emitSendError(runtime, error, requestContext) {
  const payload = {
    success: false,
    error: redactSecrets(error?.message || String(error)),
    details: {}
  };

  if (error?.code) payload.details.code = error.code;
  // Stack traces and SDK stderr can carry Authorization headers, Bearer
  // tokens, or sk-/ghp_ keys when the SDK throws on auth errors. Redact
  // these before they reach the UI / Java logs.
  if (error?.stack) payload.details.stack = redactSecrets(truncateString(error.stack, 2000));

  if (runtime?.stderrLines?.length) {
    const sdkErrorText = redactSecrets(runtime.stderrLines.slice(-10).join('\n'));
    payload.error = `SDK-STDERR:\n\`\`\`\n${sdkErrorText}\n\`\`\`\n\n${payload.error}`;
    payload.details.sdkError = sdkErrorText;
  }

  payload.error = truncateString(payload.error, 2500);

  // The error payload is emitted on three channels intentionally:
  //   1. stderr ([SEND_ERROR] tag) — captured by Java's stderrLines for diagnostics
  //   2. stdout ([SEND_ERROR] tag) — picked up by ClaudeStreamAdapter to surface
  //      the error in the chat UI without waiting for the [MESSAGE_END] envelope
  //   3. stdout (raw JSON) — the canonical request-result line consumed by the
  //      daemon's request demuxer to complete the active CompletableFuture
  // Removing any one of these breaks either logging, UX, or request completion.
  const serialized = JSON.stringify(payload);
  console.error('[SEND_ERROR]', serialized);
  console.log('[SEND_ERROR]', serialized);
  console.log(serialized);
}

function applyExactModelForContextUsage(requestContext) {
  const exactModelId = typeof requestContext?.resolvedModelId === 'string'
    ? requestContext.resolvedModelId.trim()
    : '';

  if (!exactModelId) {
    return requestContext;
  }

  return {
    ...requestContext,
    sdkModelName: exactModelId,
    options: {
      ...requestContext.options,
      model: exactModelId,
    },
  };
}

/**
 * Decide whether the existing runtime must be recreated to honor the requested model.
 *
 * The Claude SDK's `setModel()` can swap model names on an existing runtime, but it
 * CANNOT change the context-window limit. The `[1m]` suffix on a modelId selects the
 * 1M-token context window — toggling it requires building a new runtime from scratch.
 *
 * Two recreate conditions:
 *   - contextWindowChanged: the request's [1m] state differs from the runtime's
 *   - runtimeModelUnknown: caller specified a model but the runtime has no
 *     tracked modelId (e.g. a prewarmed runtime created without a model), so
 *     we cannot prove the existing window limit is correct.
 *
 * @param {object|null} runtime - The existing runtime (or null if none).
 * @param {string|null} modelId - The requested model ID, may carry the `[1m]` suffix.
 * @returns {boolean} True if the runtime must be disposed and recreated.
 */
function shouldRecreateRuntimeForModel(runtime, modelId) {
  if (!runtime) return false;
  const requestedHas1M = modelId?.includes('[1m]') ?? false;
  const runtimeModelId = runtime.modelId || null;
  const runtimeHas1M = runtimeModelId?.includes('[1m]') ?? false;
  const contextWindowChanged = requestedHas1M !== runtimeHas1M;
  const runtimeModelUnknown = !!modelId && !runtimeModelId;
  return contextWindowChanged || runtimeModelUnknown;
}

/**
 * Temporarily set `CLAUDE_CODE_DISABLE_1M_CONTEXT` for the duration of `operation`.
 *
 * NOT concurrency-safe: mutates a process-global env var. If two callers run in
 * parallel the second one captures the first one's mutation as its "original"
 * and will fail to restore the true baseline. Callers must serialize on the
 * daemon's request queue (which is already single-threaded per process) and
 * MUST NOT wrap parallel operations.
 */
async function withScopedContextWindowPreference(modelId, operation) {
  const envKey = 'CLAUDE_CODE_DISABLE_1M_CONTEXT';
  const hadOriginalValue = Object.prototype.hasOwnProperty.call(process.env, envKey);
  const originalValue = process.env[envKey];
  const disable1MContext = typeof modelId === 'string'
    && modelId.trim() !== ''
    && !modelId.includes('[1m]');

  if (disable1MContext) {
    process.env[envKey] = '1';
  } else {
    delete process.env[envKey];
  }

  try {
    return await operation();
  } finally {
    if (hadOriginalValue) {
      process.env[envKey] = originalValue;
    } else {
      delete process.env[envKey];
    }
  }
}

async function sendInternal(params, withAttachments) {
  const safeParams = params || {};
  const turnMeta = { state: null };
  let runtime = null;
  let requestContext = null;
  const sendStartTime = Date.now();
  try {
    requestContext = await buildRequestContext(safeParams, withAttachments);
    runtime = await acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
    await executeTurn(runtime, requestContext, turnMeta);
  } catch (error) {
    // Only clear if this runtime still owns the pointer (not cleared by abort)
    clearActiveTurnRuntimeIf(runtime);

    const elapsedMs = Date.now() - sendStartTime;

    const wasAborted = runtime?.abortRequested === true && error?.runtimeTerminated;

    if (turnMeta.state?.streamingEnabled && turnMeta.state?.streamStarted && !turnMeta.state?.streamEnded) {
      process.stdout.write('[STREAM_END]\n');
      turnMeta.state.streamEnded = true;
    }

    if (wasAborted) {
      // Graceful abort — output a clean result instead of SEND_ERROR so Java side
      // does not show an error toast. Also emit elapsed time like Codex does.
      console.log(JSON.stringify({
        success: false,
        error: 'User interrupted',
        elapsedMs
      }));
    } else {
      emitSendError(runtime, error, requestContext);
    }

    // Only dispose if not already disposed by abort
    if (runtime && !runtime.closed && error?.runtimeTerminated) {
      await disposeRuntime(runtime, { removeSession });
    }
  }
}

export async function sendMessagePersistent(params = {}) {
  await sendInternal(params, false);
}

export async function sendMessageWithAttachmentsPersistent(params = {}) {
  await sendInternal(params, true);
}

export async function preconnectPersistent(params = {}) {
  const safeParams = params || {};
  const requestContext = await buildRequestContext(safeParams, false);
  console.log('[LIFECYCLE] preconnectPersistent epoch=' + (requestContext.runtimeSessionEpoch || '(none)'));
  await acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
}

export async function resetRuntimePersistent(params = {}) {
  const runtimeSessionEpoch = typeof params === 'string'
    ? params
    : (params?.runtimeSessionEpoch || null);

  console.log('[LIFECYCLE] resetRuntimePersistent targetEpoch=' + (runtimeSessionEpoch || '(all-runtimes)'));

  const runtimes = getAllRuntimes();

  for (const runtime of runtimes) {
    if (!runtimeSessionEpoch || runtime.runtimeSessionEpoch === runtimeSessionEpoch) {
      await disposeRuntime(runtime, { removeSession });
    }
  }
}

/**
 * Hot-swap the permission mode of a live runtime mid-conversation.
 *
 * Finds the runtime backing the given session and calls the SDK's
 * setPermissionMode() plus updates the reactive permissionModeState that the
 * PreToolUse hook reads on every tool call. Subsequent tool invocations in the
 * current turn therefore honor the new mode immediately — no runtime restart
 * and no need to wait for the next user message.
 *
 * This is invoked via the daemon's command-queue bypass, so it may execute
 * while another turn's processRequest is active (activeRequestId set). Any
 * console.log/error here would be tagged with that turn's id and corrupt its
 * stdout stream, so logging goes to the original stderr writer and no result
 * JSON is emitted to stdout — the caller's done signal is the only response.
 *
 * When no live runtime exists yet (e.g. before the first message, or the daemon
 * is recycling the runtime), this is a no-op: the next send_message already
 * carries the requested mode via buildRequestContext.
 *
 * @param {object} params - { sessionId?: string, runtimeSessionEpoch?: string, permissionMode?: string }
 */
export async function setPermissionModePersistent(params = {}) {
  const safeParams = params || {};
  const sessionId = safeParams.sessionId || null;
  const epoch = safeParams.runtimeSessionEpoch || null;
  const targetPermissionMode = normalizePermissionMode(safeParams.permissionMode);

  const log = (msg) => {
    const w = process.stderr._originalStderrWrite;
    if (typeof w === 'function') {
      w(`[LIFECYCLE] ${msg}\n`, 'utf8');
    } else {
      process.stderr.write(`[LIFECYCLE] ${msg}\n`);
    }
  };

  let runtime = null;
  if (sessionId) {
    runtime = getRuntimeForSession(sessionId);
  }
  // Fall back to the active turn runtime when it belongs to the same session,
  // covering the brief window before the session id is promoted onto the runtime.
  if (!runtime || runtime.closed) {
    const active = getActiveTurnRuntime();
    if (active && !active.closed && (!sessionId || active.sessionId === sessionId)) {
      runtime = active;
    }
  }

  if (!runtime || runtime.closed) {
    log(`setPermissionModePersistent skipped: no live runtime sessionId=${sessionId || '(none)'}`
      + ` epoch=${epoch || '(none)'} mode=${targetPermissionMode}`);
    return;
  }

  if (runtime.currentPermissionMode === targetPermissionMode) {
    log(`setPermissionModePersistent no-op: already ${targetPermissionMode}`
      + ` sessionId=${sessionId || '(none)'} epoch=${epoch || '(none)'}`);
    return;
  }

  // Push to the SDK first. Only update local state on success — otherwise the
  // PreToolUse hook would read the new mode while the SDK still enforces the
  // old one, diverging until the next turn's applyDynamicControls resyncs.
  // Leaving local state untouched keeps hook and SDK in agreement, and the
  // Java side's settings write is harmless since the next send_message will
  // re-apply the requested mode via buildRequestContext.
  if (typeof runtime.query?.setPermissionMode === 'function') {
    try {
      await runtime.query.setPermissionMode(targetPermissionMode);
    } catch (error) {
      log(`setPermissionMode failed, local state left unchanged (will resync next turn): ${error.message}`
        + ` sessionId=${sessionId || '(none)'} epoch=${epoch || '(none)'}`
        + ` mode=${targetPermissionMode}`);
      return;
    }
  }
  // Note: a narrow race exists between the await above and these assignments.
  // If the in-progress turn ends mid-await and a new turn's applyDynamicControls
  // resets currentPermissionMode, our assignment would clobber that newer value.
  // The window is a single await tick and the next turn resyncs anyway, so we
  // accept it rather than add a compare-and-swap against the runtime's epoch.
  runtime.currentPermissionMode = targetPermissionMode;
  if (runtime.permissionModeState) {
    runtime.permissionModeState.value = targetPermissionMode;
  }

  log(`setPermissionModePersistent applied sessionId=${sessionId || '(none)'}`
    + ` epoch=${epoch || '(none)'} mode=${targetPermissionMode}`);
}

export async function abortCurrentTurn() {
  // Atomic swap: clear first to prevent double-disposal from rapid abort calls.
  // JS is single-threaded so assignment is atomic — only the first caller gets
  // a non-null runtime, subsequent callers see null and exit early.
  const runtime = getActiveTurnRuntime();
  if (!runtime) return;
  console.log('[LIFECYCLE] abortCurrentTurn epoch=' + (runtime.runtimeSessionEpoch || '(none)'));

  // Clear turnSink first to stop incoming messages, then fail it to unblock waiting take()
  const sinkToClose = runtime.turnSink;
  runtime.turnSink = null;

  if (sinkToClose) {
    sinkToClose.fail(new Error('Turn aborted'));
  }

  // Mark abort after sink is cleared
  runtime.abortRequested = true;

  clearActiveTurnRuntime();

  try {
    if (!runtime.closed) {
      await disposeRuntime(runtime, { removeSession });
    }
  } catch (error) {
    // Best-effort — log but don't throw so abort always "succeeds"
    console.error('[ABORT] Failed to dispose runtime:', error.message);
  }
}

/**
 * Get context usage breakdown from the active runtime.
 * Calls the SDK's getContextUsage() control request on the persistent runtime's query object.
 * If no runtime exists for the requested session, one is created via preconnect
 * so that /context works on historical sessions without sending a message first.
 * Outputs the result as JSON to stdout for the Java daemon bridge to collect.
 * @param {object} params - { sessionId?: string, cwd?: string, model?: string }
 */
export async function getContextUsagePersistent(params = {}) {
  const safeParams = params || {};
  const sessionId = safeParams.sessionId || null;
  const modelId = safeParams.model || null; // Original model ID, may contain [1m] suffix
  return withScopedContextWindowPreference(modelId, async () => {
    const settings = loadClaudeSettings();
    const { resolvedModelId } = resolveRequestModelState(modelId, settings?.env);
    const targetModel = resolvedModelId || modelId || null;
    let runtime = null;

    // Try to find the runtime for the specific session first
    if (sessionId) {
      runtime = getRuntimeForSession(sessionId);
    }
    // Only fall back to active turn runtime if it belongs to the same session
    if (!runtime || runtime.closed) {
      const active = getActiveTurnRuntime();
      if (active && !active.closed && (!sessionId || active.sessionId === sessionId)) {
        runtime = active;
      }
    }

    const mustRecreate = shouldRecreateRuntimeForModel(runtime, modelId);

    if (!runtime || runtime.closed || mustRecreate) {
      if (mustRecreate && runtime && !runtime.closed) {
        await disposeRuntime(runtime, { removeSession });
        runtime = null;
      }
      const requestContext = applyExactModelForContextUsage(
        await buildRequestContext(safeParams, false)
      );
      runtime = await acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
    } else {
      // Fast path: reuse existing runtime with minimal model sync.
      // Only map the model ID and call setModel if needed - skip full buildRequestContext
      // which would unnecessarily load MCP config, settings, etc.
      setModelEnvironmentVariables(targetModel, modelId);
    }

    if (typeof runtime.query?.setModel === 'function') {
      try {
        await runtime.query.setModel(targetModel || undefined);
        runtime.currentModel = targetModel;
        runtime.modelId = modelId || null;
      } catch (error) {
        console.error('[LIFECYCLE] setModel failed:', error.message);
      }
    }

    if (!runtime || runtime.closed) {
      throw new Error('Failed to establish a runtime for context usage query');
    }
    if (typeof runtime.query?.getContextUsage !== 'function') {
      throw new Error('getContextUsage is not available on the current runtime');
    }

    try {
      const data = await runtime.query.getContextUsage();
      console.log(JSON.stringify({ success: true, data }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'getContextUsage call failed');
      console.error('[LIFECYCLE] getContextUsage SDK error:', message);
      throw new Error(message);
    }
  });
}

export async function shutdownPersistentRuntimes() {
  const all = getAllRuntimes();
  for (const runtime of all) {
    await disposeRuntime(runtime, { removeSession });
  }
  resetRegistryState();
  resetCachedQueryFn();
}

export const __testing = {
  async resetState() {
    await shutdownPersistentRuntimes();
    clearActiveTurnRuntime();
  },
  setQueryFn(queryFn) {
    setCachedQueryFn(queryFn);
  },
  async buildRequestContext(params = {}, withAttachments = false, overrides = {}) {
    return buildRequestContext(params, withAttachments, overrides);
  },
  resolveRequestModelState(modelId, settingsEnv) {
    return resolveRequestModelState(modelId, settingsEnv);
  },
  applyExactModelForContextUsage(requestContext) {
    return applyExactModelForContextUsage(requestContext);
  },
  async acquireRuntime(requestContext) {
    return acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
  },
  async executeTurn(runtime, requestContext, turnMeta = null) {
    return executeTurn(runtime, requestContext, turnMeta);
  },
  async cleanupAnonymousRuntimes() {
    return cleanupStaleAnonymousRuntimes({ registerActiveQueryResult, removeSession });
  },
  async cleanupSessionRuntimes() {
    return cleanupStaleSessionRuntimes({ registerActiveQueryResult, removeSession });
  },
  async resetRuntimePersistent(params = {}) {
    return resetRuntimePersistent(params);
  },
  async abortCurrentTurn() {
    return abortCurrentTurn();
  },
  setActiveTurnRuntime(runtime) {
    setActiveTurnRuntime(runtime);
  },
  getActiveTurnRuntime() {
    return getActiveTurnRuntime();
  },
  getRuntimeForSession(sessionId) {
    return getRuntimeForSession(sessionId);
  },
  getSnapshot() {
    return getSnapshot();
  }
};
