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
import { extractResultError } from './message-utils.js';
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
  emitTaskEvent,
  waitForReaderQuiescent,
} from './runtime-lifecycle.js';
import { parseTaskNotificationXml, buildTaskNotificationEvent, extractTaskNotificationXml } from './task-notification-parser.js';
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

// Backstop for the foreign-result skip in executeTurn: that skip assumes a
// real run always emits output before its result. If a turn legitimately
// produces zero messages before its result, its own result is misclassified
// as foreign and skipped — without this idle backstop the take() loop would
// hang forever. When armed, any message arriving for the turn disarms it; on
// expiry the turn is settled empty (see the skip branch below).
const FOREIGN_RESULT_IDLE_BACKSTOP_MS = 60_000;
// Marker set on the synthetic result the backstop pushes so the foreign-result
// check lets it through and ends the turn.
const IDLE_BACKSTOP_RESULT = Symbol('idleBackstopResult');
// Test hook (see __testing): tests shrink the backstop instead of mocking
// timers globally, which would also intercept the reader/settle helpers.
let foreignResultIdleBackstopMs = FOREIGN_RESULT_IDLE_BACKSTOP_MS;

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
    maxTurns: 1000,
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
  // Fix: 同步 settings.json 中配置的所有模型层级映射到进程环境，
  // 否则 opus/haiku/fable 子代理请求时对应 env 为空，会 fallback 到错误的模型。
  for (const key of [
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) {
    const value = settings?.env?.[key];
    if (value) {
      process.env[key] = String(value).trim();
    }
  }


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

  const runtimeSignature = buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch, modelId);
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

  // Idle backstop timer armed when a foreign bare-success result is skipped
  // (see the result branch below). Must be cleared on any turn activity and
  // when the turn ends, or it would settle a later turn by mistake.
  let foreignResultIdleTimer = null;
  const disarmForeignResultIdleBackstop = () => {
    if (foreignResultIdleTimer !== null) {
      clearTimeout(foreignResultIdleTimer);
      foreignResultIdleTimer = null;
    }
  };

  try {
    beginRuntimeTurn(runtime);
    // Scope the abort flag to the turn that aborted: it is set by
    // abortCurrentTurn and must not carry into a fresh turn started right
    // after an interrupt, or sendInternal would misclassify the new turn's
    // failures (e.g. "Runtime is closed" on a disposed runtime) as a graceful
    // "User interrupted" and silently swallow the user's message.
    runtime.abortRequested = false;

    // Wait until the perpetual reader has drained the SDK pipe and parked with
    // no CLI run in flight BEFORE opening the sink or sending the user message.
    // Because the user message is not enqueued yet, nothing in the pipe can be a
    // response to it, so anything still buffered is prior-turn tail (a still-
    // in-flight background run_in_background, #1305) and routes inter-turn
    // instead of into this turn's sink — where its output, and worse its closing
    // result, would be misattributed and seed the one-behind shift (#1410). The
    // CLI would queue our send behind an in-flight run anyway, so this adds no
    // latency; it only aligns the daemon's accounting with the CLI's order.
    // Resolves on quiescence, on dispose (abort stays responsive), or a 120s
    // protocol-anomaly backstop.
    await waitForReaderQuiescent(runtime);

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

      // Any arriving message proves the pipe is alive, so disarm the idle
      // backstop armed by the foreign-result skip below. The skip re-arms it
      // when this message turns out to be another foreign bare result.
      disarmForeignResultIdleBackstop();

      if (turnState.streamingEnabled && !turnState.streamStarted) {
        process.stdout.write('[STREAM_START]\n');
        turnState.streamStarted = true;
      }

      // Subagent (sidechain) messages carry a non-null parent_tool_use_id pointing
      // at the main turn's Agent/Task tool_use. Their detailed thinking and tool
      // calls belong to the sidechain transcript, which the frontend loads
      // separately via onSubagentHistoryLoaded - so never emit them into the main
      // session stream, otherwise the subagent's internals pollute the main chat.
      // task_notification (type:'system') has no parent_tool_use_id and is preserved.
      if (msg?.parent_tool_use_id) {
        continue;
      }

      // In-turn task-notification: a background agent that finishes while the
      // main turn is still live delivers its report as a <task-notification>
      // XML, either in a plain user message's content or a queued_command
      // attachment's prompt — not as an SDK event. Synthesize the
      // task_notification the SDK no longer emits and continue, so the report
      // reaches the frontend subagent card and the raw XML never leaks into the
      // [MESSAGE] stream (which would only render as an opaque user message).
      // The frontend also recovers these from history on its own.
      const taskNotificationXml = extractTaskNotificationXml(msg);
      if (taskNotificationXml !== null) {
        const parsed = parseTaskNotificationXml(taskNotificationXml);
        const event = buildTaskNotificationEvent(parsed);
        if (event && runtime.sessionId) {
          console.log('[LIFECYCLE] In-turn task-notification message for sessionId=' + runtime.sessionId + ', toolUseId=' + parsed.toolUseId + ', status=' + event.status);
          emitTaskEvent(runtime.sessionId, event);
        } else if (!event) {
          console.log('[LIFECYCLE] In-turn task-notification message could not be parsed (no tool_use_id or non-terminal status), consuming silently');
        } else {
          console.log('[LIFECYCLE] In-turn task-notification message for anonymous runtime, consuming silently');
        }
        continue;
      }

      // Substantive output (assistant / user / stream_event) belongs to THIS
      // turn, so a later result is ours. A bare SUCCESS result arriving with
      // sawTurnMessage still false is provably foreign (a real run emits output
      // before its result) and is skipped below rather than ending the turn
      // empty and seeding the one-behind shift. system/control messages are NOT
      // counted: a turn almost always opens with a system session_id message,
      // so counting it would defang the foreign-result skip in production.
      if (msg?.type === 'assistant' || msg?.type === 'user' || msg?.type === 'stream_event') {
        turnState.sawTurnMessage = true;
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
          // The SDK puts the real error text in msg.errors (array), not in
          // result/message — extractResultError covers all three so the true
          // failure reaches the UI instead of a generic fallback.
          throw new Error(extractResultError(msg));
        }
        // Defense in depth for the boundary the quiescence gate cannot close: a
        // foreign run whose closing SUCCESS result is read only AFTER this sink
        // opened. With no prior turn output (sawTurnMessage still false) it is
        // provably not ours — a real run always emits output before its result —
        // so skip it instead of ending the turn empty and seeding the one-behind
        // shift. The background run still renders via the inter-turn
        // session_updated path (#1305).
        if (!turnState.sawTurnMessage && msg[IDLE_BACKSTOP_RESULT] !== true) {
          console.log('[LIFECYCLE] Skipping foreign bare-success result (no prior turn output this turn)');
          // The "real run emits output first" assumption fails for a turn that
          // legitimately produces zero messages: its own result would be
          // misclassified as foreign and skipped, leaving take() parked
          // forever. Arm an idle backstop that settles the turn empty if no
          // message belonging to this turn arrives in time.
          foreignResultIdleTimer = setTimeout(() => {
            foreignResultIdleTimer = null;
            console.warn('[LIFECYCLE] Foreign-result idle backstop fired: no turn output within '
              + foreignResultIdleBackstopMs + 'ms of skipping a foreign result; settling the turn empty'
              + ' sessionId=' + (turnState.finalSessionId || runtime.sessionId || requestContext.requestedSessionId || '(none)')
              + ' epoch=' + (requestContext.runtimeSessionEpoch || runtime.runtimeSessionEpoch || '(none)'));
            // Unblock the parked take() with a sentinel result that bypasses
            // the foreign check above and ends this turn with empty output.
            runtime.turnSink?.push({ type: 'result', is_error: false, [IDLE_BACKSTOP_RESULT]: true });
          }, foreignResultIdleBackstopMs);
          // Do not unref: this timer is the only handle keeping a silent turn
          // (and node:test) alive until the backstop settles it. Unref'ing it
          // lets the event loop drain while executeTurn is still parked on
          // take(), which cancels remaining tests with
          // "Promise resolution is still pending but the event loop has already resolved".
          continue;
        }
        // A task_notification for a background (run_in_background) Agent that
        // settles AFTER this result cannot ride the in-turn [MESSAGE] stream:
        // executeTurn breaks here and clears turnSink in the finally below
        // (synchronously, before the perpetual reader's next query.next()
        // resolves), so the perpetual reader routes that late event to the
        // inter-turn daemon path (emitTaskEvent -> DaemonBridge "task_event"
        // -> window.onTaskEvent). task_notification that settles BEFORE the
        // result is still processed above in the in-turn [MESSAGE] stream.
        // Both paths converge on window.onTaskEvent, which dedups by
        // tool_use_id + observable fields - see DaemonBridge.handleDaemonEvent.
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
    disarmForeignResultIdleBackstop();
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

  // Entering or leaving Auto (bypassPermissions) cannot be applied live:
  // allowDangerouslySkipPermissions is a process-launch argv flag frozen at
  // spawn, and setPermissionMode() (a control request) can neither add nor
  // remove it. Calling setPermissionMode here would log "applied" while the
  // subprocess keeps prompting (or keeps skipping, when leaving Auto). So for a
  // bypass-bit change, DON'T call setPermissionMode — invalidate the runtime
  // signature so the next send_message rebuilds the runtime with the correct
  // launch flag (mirrors buildRuntimeSignature's bypassPermissions bit). Update
  // local state so the intent is recorded; the rebuild spawns fresh regardless.
  const bypassBitChanged =
    (targetPermissionMode === 'bypassPermissions')
      !== (runtime.currentPermissionMode === 'bypassPermissions');
  if (bypassBitChanged) {
    runtime.runtimeSignature = '__rebuild-pending-bypass-change__';
    runtime.currentPermissionMode = targetPermissionMode;
    if (runtime.permissionModeState) {
      runtime.permissionModeState.value = targetPermissionMode;
    }
    log(`setPermissionModePersistent: bypass bit changed to ${targetPermissionMode};`
      + ` runtime marked for rebuild on next send sessionId=${sessionId || '(none)'}`
      + ` epoch=${epoch || '(none)'}`);
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
  setForeignResultIdleBackstopMs(ms) {
    foreignResultIdleBackstopMs = typeof ms === 'number' && ms > 0
      ? ms
      : FOREIGN_RESULT_IDLE_BACKSTOP_MS;
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
