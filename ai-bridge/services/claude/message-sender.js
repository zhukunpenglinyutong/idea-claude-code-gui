/**
 * Message sending functions for Claude Agent SDK.
 * Handles plain text messages and multimodal messages with attachments.
 */

import {
  isCustomBaseUrl,
  loadClaudeSettings,
  setupApiKey,
  buildCliEnv,
  buildWebviewControlledSettingsOverride,
} from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import { mapModelIdToSdkName, resolveModelFromSettings, setModelEnvironmentVariables } from '../../utils/model-utils.js';
import { AsyncStream } from '../../utils/async-stream.js';
import { canUseTool } from '../../permission-handler.js';
import { buildContentBlocks, loadAttachments } from './attachment-service.js';
import { buildIDEContextPrompt } from '../system-prompts.js';
import { buildQuickFixPrompt } from '../quickfix-prompts.js';
import { emitAccumulatedUsage, mergeUsage } from '../../utils/usage-utils.js';
import {
  ensureClaudeSdk,
  AUTO_RETRY_CONFIG,
  isRetryableError,
  isNoConversationFoundError,
  sleep,
  getRetryDelayMs,
  hasClaudeProjectSessionFile,
  waitForClaudeProjectSessionFile,
  truncateToolResultBlock,
  truncateString,
  truncateErrorContent,
  emitUsageTag,
  buildConfigErrorPayload
} from './message-utils.js';
import { createPreToolUseHook } from './permission-mode.js';
import { loadMcpServersConfigAsRecord } from './mcp-status/config-loader.js';
import { setActiveQueryResult } from './message-session-registry.js';
import { normalizeStreamDelta, resolveSnapshotDelta, resetTurnBlockState } from './stream-delta-normalizer.js';
import { generateSessionTitle } from '../session-title-service.js';
import { getClaudeCliPathOverride } from '../../utils/claude-cli-path.js';

// ========== Internal helpers for deduplication ==========

const SUPPORTED_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeReasoningEffort(reasoningEffort) {
  const effort = typeof reasoningEffort === 'string' ? reasoningEffort.trim() : '';
  return SUPPORTED_EFFORT_LEVELS.has(effort) ? effort : null;
}

/**
 * Resolve Extended Thinking configuration from settings.
 * @param {object|null} settings - Claude settings object
 * @returns {{ alwaysThinkingEnabled: boolean, maxThinkingTokens: number|undefined }}
 */
function resolveThinkingConfig(settings) {
  const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
  const configuredMaxThinkingTokens = settings?.maxThinkingTokens
    || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
    || 10000;
  return {
    alwaysThinkingEnabled,
    maxThinkingTokens: alwaysThinkingEnabled ? configuredMaxThinkingTokens : undefined
  };
}

/**
 * Build query options object shared by both send functions.
 */
function buildQueryOptions({ workingDirectory, permissionMode, sdkModelName, maxThinkingTokens, streamingEnabled, systemPromptAppend, preToolUseHook, sdkStderrLines, mcpServers, modelId }) {
  const claudeCliOverride = getClaudeCliPathOverride();
  return {
    cwd: workingDirectory,
    permissionMode,
    model: sdkModelName,
    maxTurns: 100,
    enableFileCheckpointing: true,
    env: buildCliEnv(),
    settings: buildWebviewControlledSettingsOverride(modelId),
    ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
    ...(streamingEnabled && { includePartialMessages: true }),
    additionalDirectories: Array.from(
      new Set([workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean))
    ),
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
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
    stderr: (data) => {
      try {
        const text = (data ?? '').toString().trim();
        if (text) {
          sdkStderrLines.push(text);
          if (sdkStderrLines.length > 50) sdkStderrLines.shift();
          console.error(`[SDK-STDERR] ${text}`);
        }
      } catch (_) { /* ignore */ }
    }
  };
}

/**
 * Prepare session resume on the options object if a resumeSessionId is provided.
 */
async function prepareSessionResume(options, resumeSessionId, workingDirectory) {
  if (resumeSessionId && resumeSessionId !== '') {
    options.resume = resumeSessionId;
    console.log('[RESUMING]', resumeSessionId);
    if (!hasClaudeProjectSessionFile(resumeSessionId, workingDirectory)) {
      console.log('[RESUME_WAIT] Waiting for session file to appear before resuming...');
      await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
    }
  }
}

/**
 * Load the Claude SDK and return the query function, throwing if unavailable.
 */
async function loadSdkQueryFunction(logPrefix) {
  const sdk = await ensureClaudeSdk();
  console.log(`[DIAG]${logPrefix} SDK loaded, exports:`, sdk ? Object.keys(sdk) : 'null');
  const queryFn = sdk?.query;
  if (typeof queryFn !== 'function') {
    throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
  }
  return queryFn;
}

/**
 * Build the systemPrompt.append content from opened files and agent prompt.
 */
function buildSystemPromptAppend(openedFiles, agentPrompt, message) {
  if (openedFiles && openedFiles.isQuickFix) {
    return buildQuickFixPrompt(openedFiles, message);
  }
  return buildIDEContextPrompt(openedFiles, agentPrompt);
}

/**
 * Process a single message from the SDK result stream.
 * Handles streaming deltas, assistant content, tool usage, session tracking, and error results.
 */
function processStreamMessage(msg, state, logPrefix) {
  if (state.streamingEnabled && !state.streamStarted) {
    process.stdout.write('[STREAM_START]\n');
    state.streamStarted = true;
  }

  // Handle stream_event type (streaming deltas from SDK)
  if (state.streamingEnabled && msg.type === 'stream_event') {
    state.hasStreamEvents = true;
    const event = msg.event;
    if (event) {
      // Usage tracking during streaming (following CLI's accumulation logic):
      // - message_start: ACCUMULATE usage across all turns (not reset!)
      // - message_delta: incremental output_tokens updates
      // - The accumulatedUsage represents the cumulative total across all turns in multi-turn tool use.
      if (event.type === 'message_start') {
        // Turn boundary: re-numbered content blocks. Clear the index-keyed block
        // maps so the prior turn's accumulator / locked stream-mode cannot corrupt
        // or duplicate this turn's index-0 block (see resetTurnBlockState). Mirrors
        // stream-event-processor.js — both streaming paths must reset identically.
        resetTurnBlockState(state);
        // Emit BLOCK_RESET — mirrors stream-event-processor.js, see there for rationale.
        if (state.streamingEnabled) {
          process.stdout.write('[BLOCK_RESET]\n');
        }
        if (event.message?.usage) {
          // IMPORTANT: Must use mergeUsage(state.accumulatedUsage, ...) to accumulate across turns.
          // Using mergeUsage(null, ...) would reset and only show the last turn's usage.
          state.accumulatedUsage = mergeUsage(state.accumulatedUsage, event.message.usage);
        }
      }
      if (event.type === 'message_delta' && event.usage) {
        state.accumulatedUsage = mergeUsage(state.accumulatedUsage, event.usage);
        emitAccumulatedUsage(state.accumulatedUsage);
      }
      if (event.type === 'content_block_delta' && event.delta) {
        if (event.delta.type === 'text_delta' && event.delta.text) {
          const delta = normalizeStreamDelta(state, 'text', event.index, event.delta.text);
          if (delta) {
            process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
            state.lastAssistantContent += delta;
          }
        } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          const delta = normalizeStreamDelta(state, 'thinking', event.index, event.delta.thinking);
          if (delta) {
            process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
            state.lastThinkingContent += delta;
          }
        }
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        console.log('[THINKING_START]');
      }
    }
    return;
  }

  // Determine whether to output the full [MESSAGE] tag
  let shouldOutput = true;
  if (state.streamingEnabled && msg.type === 'assistant') {
    const c = msg.message?.content;
    if (!Array.isArray(c) || !c.some(b => b.type === 'tool_use')) shouldOutput = false;
  }
  if (shouldOutput) console.log('[MESSAGE]', JSON.stringify(msg));

  // Process assistant content blocks
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i += 1) {
        const block = content[i];
        if (block.type === 'text') {
          emitTextDelta(block.text || '', state, i);
        } else if (block.type === 'thinking') {
          emitThinkingDelta(block.thinking || block.text || '', state, i);
        } else if (block.type === 'tool_use') {
          console.log('[TOOL_USE]', JSON.stringify({ id: block.id, name: block.name }));
        }
      }
    } else if (typeof content === 'string') {
      emitTextDelta(content, state);
    }
  }

  // Emit usage tag for assistant messages.
  // IMPORTANT: This is the authoritative source for token usage, NOT the accumulatedUsage.
  // The assistant message's usage field contains the correct cumulative total.
  // In streaming mode, this overwrites any intermediate [USAGE] values sent during streaming.
  // The Java backend (ClaudeMessageHandler.handleAssistantMessage) relies on this for correct totals.
  emitUsageTag(msg);

  // Output tool_result blocks from user messages
  if (msg.type === 'user') {
    const content = msg.message?.content ?? msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          console.log('[TOOL_RESULT]', JSON.stringify(truncateToolResultBlock(block)));
        }
      }
    }
  }

  // Capture session_id
  if (msg.type === 'system' && msg.session_id) {
    state.currentSessionId = msg.session_id;
    console.log('[SESSION_ID]', msg.session_id);
    setActiveQueryResult(msg.session_id, state.queryResult);
  }

  // Error result detection
  if (msg.type === 'result' && msg.is_error) {
    console.error(`[DEBUG]${logPrefix ? ` ${logPrefix}` : ''} Received error result:`, JSON.stringify(msg));
    throw new Error(msg.result || msg.message || 'API request failed');
  }
}

/** Emit text content delta with streaming fallback support. */
function emitTextDelta(currentText, state, blockIndex = 0) {
  if (!state.streamingEnabled) {
    console.log('[CONTENT]', truncateErrorContent(currentText));
    return;
  }
  // Single-source the delta through the normalizer (see resolveSnapshotDelta).
  // Emit gate (unchanged from the tail-fill fix):
  //   - !hasStreamEvents: pre-stream fallback, emit the whole computed delta
  //   - hasStreamEvents && hadPrevious: genuine tail-fill / snapshot correction
  //   - hasStreamEvents && !hadPrevious: stream will deliver this block, suppress
  const { delta, hadPrevious } = resolveSnapshotDelta(state, 'text', blockIndex, currentText);
  if (delta && (!state.hasStreamEvents || hadPrevious)) {
    process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(delta)}\n`);
  }
  state.lastAssistantContent = currentText;
}

/** Emit thinking content delta with streaming fallback support. */
function emitThinkingDelta(thinkingText, state, blockIndex = 0) {
  if (!state.streamingEnabled) {
    console.log('[THINKING]', thinkingText);
    return;
  }
  const { delta, hadPrevious } = resolveSnapshotDelta(state, 'thinking', blockIndex, thinkingText);
  if (delta && (!state.hasStreamEvents || hadPrevious)) {
    process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(delta)}\n`);
  }
  state.lastThinkingContent = thinkingText;
}

/**
 * Execute a query call with auto-retry logic for transient API errors.
 */
async function executeWithRetry({ createQueryResult, streamingEnabled, resumeSessionId, workingDirectory, logPrefix, outerStreamState, userMessage }) {
  let retryAttempt = 0;
  let lastRetryError = null;
  const lp = logPrefix ? ` ${logPrefix}` : '';

  while (retryAttempt <= AUTO_RETRY_CONFIG.maxRetries) {
    const state = {
      currentSessionId: resumeSessionId, messageCount: 0, hasStreamEvents: false,
      lastAssistantContent: '', lastThinkingContent: '', accumulatedUsage: null,
      streamingEnabled, streamStarted: outerStreamState.streamStarted,
      streamEnded: outerStreamState.streamEnded, queryResult: null
    };

    if (retryAttempt > 0) {
      console.log(`[RETRY]${lp} Attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries} after error: ${lastRetryError?.message || 'unknown'}`);
    }

    try {
      let result;
      try {
        result = createQueryResult();
      } catch (queryError) {
        if (shouldRetry(queryError, retryAttempt, state.messageCount)) {
          ({ retryAttempt, lastRetryError } = await performRetry(queryError, retryAttempt, state, resumeSessionId, workingDirectory, streamingEnabled, outerStreamState, lp));
          continue;
        }
        throw queryError;
      }

      state.queryResult = result;

      try {
        for await (const msg of result) {
          state.messageCount++;
          processStreamMessage(msg, state, logPrefix);
        }
      } catch (loopError) {
        logLoopError(loopError, lp);
        if (shouldRetry(loopError, retryAttempt, state.messageCount)) {
          ({ retryAttempt, lastRetryError } = await performRetry(loopError, retryAttempt, state, resumeSessionId, workingDirectory, streamingEnabled, outerStreamState, lp));
          continue;
        }
        throw loopError;
      }

      // Success
      if (retryAttempt > 0) console.log(`[RETRY]${lp} Success after ${retryAttempt} retry attempt(s)`);
      if (streamingEnabled && state.streamStarted) {
        // NOTE: Do NOT emit accumulatedUsage at stream end.
        // The assistant message's usage (sent via emitUsageTag) is the authoritative final value.
        // Emitting accumulatedUsage here would send a redundant or potentially stale value.
        process.stdout.write('[STREAM_END]\n');
        outerStreamState.streamEnded = true;
      }
      outerStreamState.streamStarted = state.streamStarted;
      console.log('[MESSAGE_END]');
      console.log(JSON.stringify({ success: true, sessionId: state.currentSessionId }));

      // Fire-and-forget: generate AI title for new sessions (not resumes)
      if (userMessage && state.currentSessionId && !resumeSessionId) {
        void generateSessionTitle(userMessage, state.currentSessionId, workingDirectory);
      }

      break;

    } catch (retryError) {
      outerStreamState.streamStarted = state.streamStarted;
      outerStreamState.accumulatedUsage = state.accumulatedUsage;
      throw retryError;
    }
  }
}

/** Check whether an error qualifies for automatic retry. */
function shouldRetry(error, retryAttempt, messageCount) {
  return isRetryableError(error) &&
    retryAttempt < AUTO_RETRY_CONFIG.maxRetries &&
    messageCount <= AUTO_RETRY_CONFIG.maxMessagesForRetry;
}

/** Execute the retry delay + state reset and return updated counters. */
async function performRetry(error, retryAttempt, state, resumeSessionId, workingDirectory, streamingEnabled, outerStreamState, lp) {
  retryAttempt++;
  const retryDelayMs = getRetryDelayMs(error);
  if (isNoConversationFoundError(error) && resumeSessionId && resumeSessionId !== '') {
    await waitForClaudeProjectSessionFile(resumeSessionId, workingDirectory, 2500, 100);
  }
  console.log(`[RETRY]${lp} Will retry (attempt ${retryAttempt}/${AUTO_RETRY_CONFIG.maxRetries}) after ${retryDelayMs}ms delay`);
  console.log(`[RETRY] Reason: ${error.message || String(error)}, messageCount: ${state.messageCount}`);
  if (streamingEnabled && state.streamStarted && !state.streamEnded) {
    state.streamStarted = false;
    outerStreamState.streamStarted = false;
  }
  await sleep(retryDelayMs);
  return { retryAttempt, lastRetryError: error };
}

/** Log detailed error information from the message loop. */
function logLoopError(error, lp) {
  console.error(`[DEBUG] Error in message loop${lp}:`, error.message);
  console.error('[DEBUG] Error stack:', error.stack);
  if (error.code) console.error('[DEBUG] Error code:', error.code);
  if (error.syscall) console.error('[DEBUG] Error syscall:', error.syscall);
  if (error.path) console.error('[DEBUG] Error path:', error.path);
  if (error.spawnargs) console.error('[DEBUG] Error spawnargs:', JSON.stringify(error.spawnargs));
}

/**
 * Handle top-level catch for both send functions: emit stream end on error and format error payload.
 */
function handleSendError(error, streamState, sdkStderrLines) {
  if (streamState.streamingEnabled && streamState.streamStarted && !streamState.streamEnded) {
    // NOTE: Do NOT emit accumulatedUsage at stream end, even on error.
    // If assistant messages were received, emitUsageTag already sent the correct usage.
    // If no assistant message was received, the usage would be incomplete anyway.
    process.stdout.write('[STREAM_END]\n');
  }
  const payload = buildConfigErrorPayload(error);
  if (sdkStderrLines.length > 0) {
    const sdkErrorText = sdkStderrLines.slice(-10).join('\n');
    payload.error = `SDK-STDERR:\n\`\`\`\n${sdkErrorText}\n\`\`\`\n\n${payload.error}`;
    payload.details.sdkError = sdkErrorText;
  }
  payload.error = truncateString(payload.error);
  console.error('[SEND_ERROR]', JSON.stringify(payload));
}

// ========== Exported send functions ==========

/**
 * Send a plain text message to Claude Agent SDK.
 * @param {string} message - The message text
 * @param {string} resumeSessionId - Session ID to resume (optional)
 * @param {string} cwd - Working directory (optional)
 * @param {string} permissionMode - Permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {object} openedFiles - List of opened files (optional)
 * @param {string} agentPrompt - Agent prompt (optional)
 * @param {boolean} streaming - Whether to enable streaming (optional, defaults to config value)
 */
export async function sendMessage(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, openedFiles = null, agentPrompt = null, streaming = null, disableThinking = false, reasoningEffort = null) {
  console.log('[DIAG] ========== sendMessage() START ==========');
  console.log('[DIAG] params:', { msgLen: message ? message.length : 0, resumeSessionId: resumeSessionId || '(new)', cwd, permissionMode, model });

  const sdkStderrLines = [];
  let streamingEnabled = false;
  const outerStreamState = { streamStarted: false, streamEnded: false, accumulatedUsage: null };
  try {
    const { baseUrl, apiKeySource, baseUrlSource } = setupApiKey();
    if (isCustomBaseUrl(baseUrl)) {
      console.log('[DEBUG] Custom Base URL detected:', baseUrl);
    }
    console.log('[DEBUG] API config:', { apiKeySource, baseUrl: baseUrl || 'https://api.anthropic.com', baseUrlSource });
    console.log('[MESSAGE_START]');

    const workingDirectory = selectWorkingDirectory(cwd);
    try { process.chdir(workingDirectory); } catch (e) { console.error('[WARNING] chdir failed:', e.message); }
    console.log('[DEBUG] Working directory:', workingDirectory);

    const sdkModelName = mapModelIdToSdkName(model);
    const settings = loadClaudeSettings();
    const resolvedModel = resolveModelFromSettings(model, settings?.env);
    console.log('[DEBUG] Model:', model, '->', sdkModelName, '(API:', resolvedModel + ')');
    setModelEnvironmentVariables(resolvedModel, model);

    const systemPromptAppend = buildSystemPromptAppend(openedFiles, agentPrompt, message);

    const effectivePermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
    const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
    const { alwaysThinkingEnabled, maxThinkingTokens: configuredMaxThinkingTokens } = resolveThinkingConfig(settings);
    // maxThinkingTokens and reasoningEffort are mutually exclusive
    const maxThinkingTokens = (alwaysThinkingEnabled && !normalizedReasoningEffort) ? configuredMaxThinkingTokens : undefined;
    streamingEnabled = streaming != null ? streaming : (settings?.streamingEnabled ?? false);
    console.log('[DEBUG] Config:', { effectivePermissionMode, alwaysThinkingEnabled, maxThinkingTokens, streamingEnabled, reasoningEffort: normalizedReasoningEffort });

    const preToolUseHook = createPreToolUseHook(effectivePermissionMode, workingDirectory);
    const mcpServers = await loadMcpServersConfigAsRecord(workingDirectory);
    const options = buildQueryOptions({ workingDirectory, permissionMode: effectivePermissionMode, sdkModelName, maxThinkingTokens, streamingEnabled, systemPromptAppend, preToolUseHook, sdkStderrLines, mcpServers, modelId: model });

    if (normalizedReasoningEffort) {
      options.effort = normalizedReasoningEffort;
      console.log('[DEBUG] Set SDK effort:', normalizedReasoningEffort);
    }

    await prepareSessionResume(options, resumeSessionId, workingDirectory);

    const queryFn = await loadSdkQueryFunction('');

    await executeWithRetry({
      createQueryResult: () => queryFn({ prompt: message, options }),
      streamingEnabled,
      resumeSessionId,
      workingDirectory,
      logPrefix: '',
      outerStreamState,
      userMessage: message
    });

  } catch (error) {
    handleSendError(error, { streamingEnabled, ...outerStreamState }, sdkStderrLines);
  }
}

/**
 * Send message with attachments using Claude Agent SDK (multimodal).
 * @param {string} message - The message text
 * @param {string} resumeSessionId - Session ID to resume (optional)
 * @param {string} cwd - Working directory (optional)
 * @param {string} permissionMode - Permission mode (optional)
 * @param {string} model - Model name (optional)
 * @param {object} stdinData - Stdin data containing attachments (optional)
 */
export async function sendMessageWithAttachments(message, resumeSessionId = null, cwd = null, permissionMode = null, model = null, stdinData = null) {
  const sdkStderrLines = [];
  let streamingEnabled = false;
  const outerStreamState = { streamStarted: false, streamEnded: false, accumulatedUsage: null };
  try {
    setupApiKey();
    console.log('[MESSAGE_START]');

    const workingDirectory = selectWorkingDirectory(cwd);
    try { process.chdir(workingDirectory); } catch (e) { console.error('[WARNING] chdir failed:', e.message); }

    const attachments = await loadAttachments(stdinData);
    const openedFiles = stdinData?.openedFiles || null;
    const agentPrompt = stdinData?.agentPrompt || null;

    const systemPromptAppend = buildSystemPromptAppend(openedFiles, agentPrompt, message);

    const sdkModelName = mapModelIdToSdkName(model);
    const settings = loadClaudeSettings();
    const resolvedAttachModel = resolveModelFromSettings(model, settings?.env);
    console.log('[DEBUG] (withAttachments) Model:', model, '->', resolvedAttachModel);
    setModelEnvironmentVariables(resolvedAttachModel, model);

    const contentBlocks = await buildContentBlocks(attachments, message, resolvedAttachModel);
    const userMessage = {
      type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: contentBlocks }
    };

    const normalizedPermissionMode = (!permissionMode || permissionMode === '') ? 'default' : permissionMode;
    const preToolUseHook = createPreToolUseHook(normalizedPermissionMode, workingDirectory);

    const { alwaysThinkingEnabled, maxThinkingTokens: configuredMaxThinkingTokens } = resolveThinkingConfig(settings);
    const reasoningEffort = normalizeReasoningEffort(stdinData?.reasoningEffort || null);
    // maxThinkingTokens and reasoningEffort are mutually exclusive
    const maxThinkingTokens = (alwaysThinkingEnabled && !reasoningEffort) ? configuredMaxThinkingTokens : undefined;
    const streamingParam = stdinData?.streaming;
    streamingEnabled = streamingParam != null ? streamingParam : (settings?.streamingEnabled ?? false);
    console.log('[DEBUG] (withAttachments) Config:', { normalizedPermissionMode, alwaysThinkingEnabled, maxThinkingTokens, streamingEnabled, reasoningEffort });

    const mcpServers = await loadMcpServersConfigAsRecord(workingDirectory);
    const options = buildQueryOptions({ workingDirectory, permissionMode: normalizedPermissionMode, sdkModelName, maxThinkingTokens, streamingEnabled, systemPromptAppend, preToolUseHook, sdkStderrLines, mcpServers, modelId: model });

    if (reasoningEffort) {
      options.effort = reasoningEffort;
      console.log('[DEBUG] (withAttachments) Set SDK effort:', reasoningEffort);
    }

    await prepareSessionResume(options, resumeSessionId, workingDirectory);

    const queryFn = await loadSdkQueryFunction(' (withAttachments)');

    await executeWithRetry({
      createQueryResult: () => {
        // Recreate inputStream for each retry (AsyncStream can only be consumed once)
        const inputStream = new AsyncStream();
        inputStream.enqueue(userMessage);
        inputStream.done();
        return queryFn({ prompt: inputStream, options });
      },
      streamingEnabled,
      resumeSessionId,
      workingDirectory,
      logPrefix: '(withAttachments)',
      outerStreamState,
      userMessage: message
    });

  } catch (error) {
    handleSendError(error, { streamingEnabled, ...outerStreamState }, sdkStderrLines);
  }
}
