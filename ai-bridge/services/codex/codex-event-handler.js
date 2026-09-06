/**
 * Codex event processing loop and helper functions.
 *
 * Extracted from the inner closures and for-await loop of sendMessage()
 * in message-service.js. Every former closure now receives its captured
 * variables through an explicit `state` (mutable) or `config` (immutable)
 * parameter.
 *
 * Exports:
 *   - createInitialEventState(emitMessage) — factory for the mutable state bag
 *   - prepareSessionReplayBoundary(state, threadId) — captures the pre-turn JSONL baseline
 *   - processCodexEventStream(events, state, config) — the main event loop
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { requestPermissionFromJava } from '../../permission-handler.js';
import { findSessionFileByThreadId } from './codex-agents-loader.js';
import { extractPatchFromResponseItemPayload, parseApplyPatchToOperations } from './codex-patch-parser.js';
import { extractUpdatePlanFromResponseItemPayload } from './codex-plan-parser.js';
import {
  truncateForDisplay, getStableItemId, extractCommand,
  smartToolName, smartDescription, mapCommandToolNameToPermissionToolName,
  resolveFilePath, stringifyRawEvent, isApprovalRelatedRawEvent
} from './codex-command-utils.js';
import {
  DEBUG_LEVEL, MAX_TOOL_RESULT_CHARS,
  SESSION_PATCH_SCAN_MAX_LINES, SESSION_CONTEXT_SCAN_MAX_LINES,
  logWarn, logInfo, logDebug,
  isAutoEditPermissionMode, isReconnectNotice, emitStatusMessage
} from './codex-utils.js';
import {
  normalizeMcpToolName, normalizeMcpToolInput,
  parseFunctionCallArguments, normalizeFunctionCallTool,
  rememberToolInvocation, findMatchingToolUseId,
} from './codex-tool-normalization.js';

const COMMAND_DENIED_ABORT_ERROR = '__CODEX_COMMAND_DENIED_ABORT__';
const CODEX_USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];

function normalizeCodexUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const normalized = {};
  let hasNumericField = false;
  for (const field of CODEX_USAGE_FIELDS) {
    const value = Number(usage[field]);
    if (Number.isFinite(value)) {
      normalized[field] = Math.max(0, value);
      hasNumericField = true;
    }
  }
  return hasNumericField ? normalized : null;
}

function subtractCodexUsage(total, baseline) {
  if (!total || !baseline) return null;
  const delta = {};
  for (const field of CODEX_USAGE_FIELDS) {
    delta[field] = Math.max(0, (total[field] || 0) - (baseline[field] || 0));
  }
  return delta;
}

function handleTokenCountEvent(event, state) {
  const info = event?.payload?.info;
  if (!info || typeof info !== 'object') return false;

  const totalUsage = normalizeCodexUsage(info.total_token_usage);
  const lastUsage = normalizeCodexUsage(info.last_token_usage);
  if (!totalUsage && !lastUsage) return false;

  if (!state.turnUsageBaseline && totalUsage && lastUsage) {
    state.turnUsageBaseline = subtractCodexUsage(totalUsage, lastUsage);
  }
  if (totalUsage) {
    state.latestTotalTokenUsage = totalUsage;
  }

  const forwardedInfo = {};
  if (totalUsage) forwardedInfo.total_token_usage = totalUsage;
  if (lastUsage) forwardedInfo.last_token_usage = lastUsage;
  const contextWindow = Number(info.model_context_window);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    forwardedInfo.model_context_window = contextWindow;
  }

  state.emitMessage({
    type: 'event_msg',
    payload: { type: 'token_count', info: forwardedInfo },
  });
  return true;
}

function resolveCompletedTurnUsage(state) {
  return subtractCodexUsage(state.latestTotalTokenUsage, state.turnUsageBaseline);
}

export function isWindowsTaskkillParseNoise(message) {
  if (typeof message !== 'string') return false;
  if (!message.startsWith('Failed to parse item:')) return false;

  const item = message.substring('Failed to parse item:'.length).trim();
  if (!item) return false;

  const hasPidPair = /\bPID\s+\d+\b[\s\S]*\bPID\s+\d+\b/i.test(item);
  if (!hasPidPair) return false;

  return /SUCCESS/i.test(item) ||
    /terminated/i.test(item) ||
    /process/i.test(item) ||
    /[\u6210\u529f\u7ec8\u6b62\u8fdb\u7a0b\u5b50]/.test(item) ||
    /[\uFFFD]{2,}/.test(item);
}

function toolUseMsg(id, name, input) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function toolResultMsg(toolUseId, isError, content) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] } };
}

function textMsg(text) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function handleFunctionCallPayload(payload, state) {
  if (!payload || payload.type !== 'function_call') return false;

  const rawToolName = typeof payload.name === 'string' ? payload.name : '';
  if (!rawToolName) return false;

  const parsedArguments = parseFunctionCallArguments(payload);
  const normalizedTool = normalizeFunctionCallTool(rawToolName, parsedArguments);
  const toolName = normalizedTool.name;
  const toolInput = normalizedTool.input;
  const matchedToolUseId = findMatchingToolUseId(state, toolName, toolInput);
  const toolUseId = matchedToolUseId || (typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : randomUUID());

  if (!state.emittedToolUseIds.has(toolUseId)) {
    state.emitMessage(toolUseMsg(toolUseId, toolName, toolInput));
    state.emittedToolUseIds.add(toolUseId);
  }
  rememberToolInvocation(state, toolUseId, toolName, toolInput);
  state.lastFunctionCallToolUseId = toolUseId;
  return true;
}

function handleFunctionCallOutputPayload(payload, state) {
  if (!payload || payload.type !== 'function_call_output') return false;
  let toolUseId = typeof payload.call_id === 'string' ? payload.call_id : '';
  if ((!toolUseId || !state.emittedToolUseIds.has(toolUseId)) && state.lastFunctionCallToolUseId) {
    toolUseId = state.lastFunctionCallToolUseId;
  }
  if (!toolUseId || state.emittedToolResultIds.has(toolUseId) || !state.emittedToolUseIds.has(toolUseId)) return false;

  const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '(no output)');
  const isError = payload.status === 'error' ||
    (typeof output === 'string' && /^error:|failed to parse|permission denied|command denied/i.test(output));
  const truncatedResult = truncateForDisplay(output, MAX_TOOL_RESULT_CHARS);
  state.emitMessage(toolResultMsg(toolUseId, isError, truncatedResult && truncatedResult.trim() ? truncatedResult : '(no output)'));
  state.emittedToolResultIds.add(toolUseId);
  return true;
}

function getResponseItemCallId(payload) {
  const id = payload?.call_id ?? payload?.id;
  return typeof id === 'string' && id.trim() ? id : '';
}

function createPatchBatchFromPayload(payload, config, fallbackCallId = '') {
  const patchText = extractPatchFromResponseItemPayload(payload);
  if (!patchText) return null;

  const callId = getResponseItemCallId(payload) || fallbackCallId;
  if (!callId) return null;

  const operations = parseApplyPatchToOperations(patchText)
    .map((op) => ({ ...op, filePath: resolveFilePath(op.filePath, config.cwd) }))
    .filter((op) => op.filePath && (op.oldString !== '' || op.newString !== ''));
  return operations.length > 0 ? { callId, operations } : null;
}

function emitSyntheticPatchToolUses(state, batch) {
  if (!batch || !Array.isArray(batch.operations)) return 0;
  let emittedCount = 0;
  batch.operations.forEach((op, index) => {
    const toolUseId = `codex_patch_${batch.callId}_${index}`;
    const toolName = op.toolName === 'write' ? 'write' : 'edit';
    if (state.emittedToolUseIds.has(toolUseId)) return;
    state.emitMessage(toolUseMsg(toolUseId, toolName, {
      file_path: op.filePath,
      old_string: op.oldString,
      new_string: op.newString,
      start_line: op.startLine,
      end_line: op.endLine,
      replace_all: false,
      source: 'codex_session_patch'
    }));
    state.emittedToolUseIds.add(toolUseId);
    emittedCount += 1;
  });
  return emittedCount;
}

function emitSyntheticPatchToolResults(state, batch, isError) {
  if (!batch || !Array.isArray(batch.operations)) return 0;
  let emittedCount = 0;
  batch.operations.forEach((_, index) => {
    const toolUseId = `codex_patch_${batch.callId}_${index}`;
    if (!state.emittedToolUseIds.has(toolUseId) || state.emittedToolResultIds.has(toolUseId)) return;
    state.emitMessage(toolResultMsg(toolUseId, isError, isError ? 'Patch apply failed' : 'Patch applied'));
    state.emittedToolResultIds.add(toolUseId);
    emittedCount += 1;
  });
  return emittedCount;
}

function handleCustomToolCallPayload(payload, state, config) {
  if (!payload || payload.type !== 'custom_tool_call') return false;

  let handled = false;
  const callId = getResponseItemCallId(payload);
  const planInput = extractUpdatePlanFromResponseItemPayload(payload);
  if (callId && planInput) {
    const toolUseId = `codex_plan_${callId}`;
    if (!state.processedCustomPlanCallIds.has(callId)) {
      state.processedCustomPlanCallIds.add(callId);
      if (!state.emittedToolUseIds.has(toolUseId)) {
        state.emitMessage(toolUseMsg(toolUseId, 'update_plan', planInput));
        state.emittedToolUseIds.add(toolUseId);
      }
      state.pendingCustomPlanToolUseIds.set(callId, toolUseId);
    }
    handled = true;
  }

  const batch = createPatchBatchFromPayload(payload, config);
  if (!batch) return handled;
  if (state.processedPatchCallIds.has(batch.callId)) return true;

  state.processedPatchCallIds.add(batch.callId);
  state.pendingCustomPatchBatches.set(batch.callId, batch);
  emitSyntheticPatchToolUses(state, batch);
  return true;
}

function extractCustomToolOutputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      return JSON.stringify(item ?? '');
    }).join('\n');
  }
  if (output && typeof output.text === 'string') return output.text;
  return JSON.stringify(output ?? '');
}

function handleCustomToolCallOutputPayload(payload, state) {
  if (!payload || payload.type !== 'custom_tool_call_output') return false;

  const callId = getResponseItemCallId(payload);
  const output = extractCustomToolOutputText(payload.output);
  // Plan outputs are short status texts, so an any-line match is safe here.
  const planErrorOutput = /(?:^|\n)\s*(?:error:|failed to parse|permission denied|command denied|script failed\b|script error:|exit code:\s*[1-9]\d*)/i;
  // apply_patch output can echo command output containing e.g. "exit code: 1"
  // even when the patch itself succeeded, so keep the original strict
  // start-of-output prefixes for the patch path.
  const patchErrorOutput = /^(?:error:|failed to parse|permission denied|command denied)/i;
  let handled = false;
  const planToolUseId = callId ? state.pendingCustomPlanToolUseIds.get(callId) : null;
  if (planToolUseId) {
    const isPlanError = payload.status === 'error' || payload.is_error === true || planErrorOutput.test(output);
    if (!state.emittedToolResultIds.has(planToolUseId)) {
      state.emitMessage(toolResultMsg(planToolUseId, isPlanError, isPlanError ? 'Plan update failed' : 'Plan updated'));
      state.emittedToolResultIds.add(planToolUseId);
    }
    state.pendingCustomPlanToolUseIds.delete(callId);
    handled = true;
  }

  const batch = callId ? state.pendingCustomPatchBatches.get(callId) : null;
  if (!batch) return handled;

  const isPatchError = payload.status === 'error' || payload.is_error === true || patchErrorOutput.test(output);
  emitSyntheticPatchToolResults(state, batch, isPatchError);
  state.pendingCustomPatchBatches.delete(callId);
  return true;
}

function flushPendingCustomPatchBatches(state, isError = false) {
  for (const batch of state.pendingCustomPatchBatches.values()) {
    emitSyntheticPatchToolResults(state, batch, isError);
  }
  state.pendingCustomPatchBatches.clear();
}

function flushPendingCustomPlanCalls(state, isError = false) {
  for (const toolUseId of state.pendingCustomPlanToolUseIds.values()) {
    if (state.emittedToolResultIds.has(toolUseId)) continue;
    state.emitMessage(toolResultMsg(toolUseId, isError, isError ? 'Plan update failed' : 'Plan updated'));
    state.emittedToolResultIds.add(toolUseId);
  }
  state.pendingCustomPlanToolUseIds.clear();
}


/** Creates the initial mutable state bag consumed by processCodexEventStream. */
export function createInitialEventState(emitMessage) {
  return {
    pendingToolUseIds: new Map(),
    emittedToolUseIds: new Set(),
    emittedToolResultIds: new Set(),
    toolCallSignatureById: new Map(),
    toolUseIdBySignature: new Map(),
    lastFunctionCallToolUseId: null,
    deniedCommandToolUseIds: new Set(),
    emittedDeniedCommandToolResultIds: new Set(),
    sessionFilePath: null,
    sessionLineCursor: 0,
    sessionReplayBaselineCursor: null,
    sessionReplayBaselinePrepared: false,
    sessionFunctionCursor: null,
    sessionTurnStartCursor: null,
    sessionTurnBoundaryReady: false,
    sessionTurnBoundaryWarningLogged: false,
    processedPatchCallIds: new Set(),
    pendingCustomPatchBatches: new Map(),
    processedCustomPlanCallIds: new Set(),
    pendingCustomPlanToolUseIds: new Map(),
    processedSessionFunctionCallIds: new Set(),
    processedSessionFunctionOutputIds: new Set(),
    processedSessionCustomToolCallIds: new Set(),
    processedSessionCustomToolOutputIds: new Set(),
    reasoningTextCache: new Map(),
    assistantTextCache: new Map(),
    reasoningObserved: false,
    commandApprovalAbortRequested: false,
    runtimePolicyLogged: false,
    suppressNoResponseFallback: false,
    turnStarted: false,
    turnCompleted: false,
    turnUsageBaseline: null,
    latestTotalTokenUsage: null,
    currentThreadId: null,
    finalResponse: '',
    assistantText: '',
    emitMessage
  };
}

function rememberPendingToolUseId(state, command, toolUseId) {
  if (!command) return;
  const list = state.pendingToolUseIds.get(command) ?? [];
  list.push(toolUseId);
  state.pendingToolUseIds.set(command, list);
}

function consumePendingToolUseId(state, command) {
  if (!command) return null;
  const list = state.pendingToolUseIds.get(command);
  if (!Array.isArray(list) || list.length === 0) return null;
  const id = list.shift() ?? null;
  if (list.length === 0) state.pendingToolUseIds.delete(command);
  return id;
}

function ensureToolUseId(state, phase, item) {
  const stableId = getStableItemId(item);
  if (stableId) return stableId;
  const command = extractCommand(item);
  if (phase === 'completed') {
    return consumePendingToolUseId(state, command) ?? randomUUID();
  }
  const id = randomUUID();
  rememberPendingToolUseId(state, command, id);
  return id;
}

function ensureSessionFilePath(state, threadId) {
  if (state.sessionFilePath && existsSync(state.sessionFilePath)) return state.sessionFilePath;
  if (!threadId) return null;
  state.sessionFilePath = findSessionFileByThreadId(threadId);
  return state.sessionFilePath;
}

function splitSessionJsonlEntries(content) {
  if (typeof content !== 'string' || !content.length) return [];
  return content.split('\n').filter((line) => line.trim());
}

function countSessionJsonlLines(content) {
  return splitSessionJsonlEntries(content).length;
}

/**
 * Captures the end of the existing session before the current Codex turn starts.
 * A later replay boundary is only accepted when a new turn_context appears at or
 * after this cursor, so historical function calls can never become replay candidates.
 */
export async function prepareSessionReplayBoundary(state, threadId) {
  state.sessionReplayBaselinePrepared = true;
  state.sessionReplayBaselineCursor = threadId ? null : 0;
  state.sessionFunctionCursor = null;
  state.sessionTurnStartCursor = null;
  state.sessionTurnBoundaryReady = false;
  state.sessionTurnBoundaryWarningLogged = false;

  if (!threadId) {
    state.sessionLineCursor = 0;
    return;
  }

  const sessionPath = ensureSessionFilePath(state, threadId);
  if (!sessionPath) {
    logWarn('SESSION_REPLAY', `Unable to locate resumed session ${threadId}; JSONL function replay is disabled for this turn.`);
    return;
  }

  try {
    const content = await readFile(sessionPath, 'utf8');
    const baseline = countSessionJsonlLines(content);
    state.sessionReplayBaselineCursor = baseline;
    state.sessionLineCursor = baseline;
  } catch (error) {
    logWarn('SESSION_REPLAY', 'Unable to capture the pre-turn session boundary; JSONL function replay is disabled for this turn:', error?.message || error);
  }
}

function getSessionThreadId(state, config) {
  return config.threadId || state.currentThreadId || null;
}

async function ensureSessionTurnBoundary(state, config) {
  if (state.sessionTurnBoundaryReady) return true;
  if (!state.sessionReplayBaselinePrepared || !Number.isInteger(state.sessionReplayBaselineCursor)) {
    return false;
  }

  const sessionPath = ensureSessionFilePath(state, getSessionThreadId(state, config));
  if (!sessionPath) return false;

  let content = '';
  try {
    content = await readFile(sessionPath, 'utf8');
  } catch (error) {
    logDebug('SESSION_REPLAY', 'Failed to read session file while locating the current turn boundary:', error?.message || error);
    return false;
  }

  const lines = splitSessionJsonlEntries(content);
  const baseline = state.sessionReplayBaselineCursor;
  for (let i = baseline; i < lines.length; i++) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch { continue; }
    if (parsed?.type !== 'turn_context') continue;

    const boundaryCursor = i + 1;
    state.sessionTurnStartCursor = boundaryCursor;
    state.sessionFunctionCursor = boundaryCursor;
    state.sessionTurnBoundaryReady = true;
    logDebug('SESSION_REPLAY', `Established current turn boundary at session line ${boundaryCursor}.`);
    return true;
  }

  return false;
}

function warnSessionTurnBoundaryNotReady(state) {
  if (state.sessionTurnBoundaryWarningLogged) return;
  state.sessionTurnBoundaryWarningLogged = true;
  logWarn('SESSION_REPLAY', 'Skipping JSONL function replay until a verified current-turn turn_context is available.');
}

async function readLatestTurnContextFromSession(state, threadId) {
  const sessionPath = ensureSessionFilePath(state, threadId);
  if (!sessionPath) return null;
  let content = '';
  try { content = await readFile(sessionPath, 'utf8'); } catch (error) {
    logDebug('PERM_DEBUG', 'Failed to read session for turn_context:', error?.message || error);
    return null;
  }
  if (!content.trim()) return null;
  const lines = splitSessionJsonlEntries(content);
  const startIndex = Math.max(0, lines.length - SESSION_CONTEXT_SCAN_MAX_LINES);
  for (let i = lines.length - 1; i >= startIndex; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type === 'turn_context' && parsed?.payload && typeof parsed.payload === 'object') {
      return parsed.payload;
    }
  }
  return null;
}

/**
 * Recover raw token_count events that the public Codex SDK stream omits. Only
 * entries after the verified current-turn boundary are accepted, preventing a
 * resumed thread from reusing the previous turn's context snapshot.
 */
async function replayCurrentTurnTokenCountsFromSession(state, config) {
  if (state.latestTotalTokenUsage) return 0;
  if (!await ensureSessionTurnBoundary(state, config)) return 0;

  const sessionPath = ensureSessionFilePath(state, getSessionThreadId(state, config));
  if (!sessionPath) return 0;

  let content = '';
  try {
    content = await readFile(sessionPath, 'utf8');
  } catch (error) {
    logDebug('CONTEXT_USAGE', 'Failed to read current-turn token usage:', error?.message || error);
    return 0;
  }

  const lines = splitSessionJsonlEntries(content);
  const startIndex = Number.isInteger(state.sessionTurnStartCursor)
    ? state.sessionTurnStartCursor
    : lines.length;
  let replayed = 0;
  for (let i = startIndex; i < lines.length; i++) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch { continue; }
    if (parsed?.type !== 'event_msg' || parsed?.payload?.type !== 'token_count') continue;
    if (handleTokenCountEvent(parsed, state)) replayed += 1;
  }
  return replayed;
}

async function collectPatchOperationsFromSession(state, config) {
  const sessionPath = ensureSessionFilePath(state, getSessionThreadId(state, config));
  if (!sessionPath) return [];
  let content = '';
  try { content = await readFile(sessionPath, 'utf8'); } catch (error) {
    console.warn('[DEBUG] Failed to read session file:', sessionPath, error?.message || error);
    return [];
  }
  if (!content.trim()) return [];

  const lines = splitSessionJsonlEntries(content);
  const startIndex = state.sessionLineCursor > 0
    ? state.sessionLineCursor
    : Math.max(0, lines.length - SESSION_PATCH_SCAN_MAX_LINES);
  const batches = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type !== 'response_item' || !parsed.payload) continue;

    const payload = parsed.payload;
    const callId = String(payload.call_id ?? payload.id ?? `line_${i}`);
    if (state.processedPatchCallIds.has(callId)) continue;

    const batch = createPatchBatchFromPayload(payload, config, callId);
    if (!batch) continue;
    state.processedPatchCallIds.add(callId);
    batches.push(batch);
  }
  state.sessionLineCursor = lines.length;
  return batches;
}

async function replayMissingFunctionCallsFromSession(state, config) {
  if (!state.sessionTurnBoundaryReady || !Number.isInteger(state.sessionTurnStartCursor)) {
    return { toolUses: 0, toolResults: 0 };
  }

  const sessionPath = ensureSessionFilePath(state, getSessionThreadId(state, config));
  if (!sessionPath) return { toolUses: 0, toolResults: 0 };

  let content = '';
  try { content = await readFile(sessionPath, 'utf8'); } catch (error) {
    logDebug('SESSION_REPLAY', 'Failed to read session file for function replay:', error?.message || error);
    return { toolUses: 0, toolResults: 0 };
  }
  if (!content.trim()) return { toolUses: 0, toolResults: 0 };

  const lines = splitSessionJsonlEntries(content);
  const startIndex = Math.max(
    state.sessionTurnStartCursor,
    Number.isInteger(state.sessionFunctionCursor) ? state.sessionFunctionCursor : state.sessionTurnStartCursor,
  );

  let toolUses = 0;
  let toolResults = 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type !== 'response_item' || !parsed.payload || typeof parsed.payload !== 'object') continue;

    const payload = parsed.payload;
    const payloadType = payload.type;
    if (payloadType === 'function_call') {
      const callId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : `line_${i}`;
      if (state.processedSessionFunctionCallIds.has(callId)) continue;
      state.processedSessionFunctionCallIds.add(callId);
      if (handleFunctionCallPayload(payload, state)) {
        toolUses += 1;
      }
      continue;
    }

    if (payloadType === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : `line_${i}`;
      if (state.processedSessionFunctionOutputIds.has(callId)) continue;
      state.processedSessionFunctionOutputIds.add(callId);
      if (handleFunctionCallOutputPayload(payload, state)) {
        toolResults += 1;
      }
      continue;
    }

    if (payloadType === 'custom_tool_call') {
      const callId = getResponseItemCallId(payload) || `line_${i}`;
      if (state.processedSessionCustomToolCallIds.has(callId)) continue;
      state.processedSessionCustomToolCallIds.add(callId);
      if (handleCustomToolCallPayload(payload, state, config)) {
        toolUses += 1;
      }
      continue;
    }

    if (payloadType === 'custom_tool_call_output') {
      const callId = getResponseItemCallId(payload) || `line_${i}`;
      if (state.processedSessionCustomToolOutputIds.has(callId)) continue;
      state.processedSessionCustomToolOutputIds.add(callId);
      if (handleCustomToolCallOutputPayload(payload, state)) {
        toolResults += 1;
      }
    }
  }

  state.sessionFunctionCursor = lines.length;
  return { toolUses, toolResults };
}

async function replayMissingFunctionCallsDuringStream(state, config) {
  if (!await ensureSessionTurnBoundary(state, config)) {
    warnSessionTurnBoundaryNotReady(state);
    return { toolUses: 0, toolResults: 0 };
  }
  return replayMissingFunctionCallsFromSession(state, config);
}

function buildPermissionInputForPatchOperation(operation) {
  if (!operation || typeof operation !== 'object') return null;
  const isWrite = operation.toolName === 'write' || operation.kind === 'add';
  if (isWrite) {
    return { toolName: 'Write', input: { file_path: operation.filePath, content: operation.newString ?? '' } };
  }
  return {
    toolName: 'Edit',
    input: { file_path: operation.filePath, old_string: operation.oldString ?? '', new_string: operation.newString ?? '', replace_all: false }
  };
}

async function requestPatchApprovalsViaBridge(patchBatches) {
  const deniedCallIds = new Set();
  if (!Array.isArray(patchBatches) || patchBatches.length === 0) return deniedCallIds;
  for (const batch of patchBatches) {
    if (!batch || !Array.isArray(batch.operations) || batch.operations.length === 0) continue;
    const previewOp = batch.operations[0];
    const requestPayload = buildPermissionInputForPatchOperation(previewOp);
    if (!requestPayload) continue;
    try {
      logInfo('PERM_DEBUG', `Patch approval request: callId=${batch.callId}, tool=${requestPayload.toolName}, file=${previewOp?.filePath || ''}`);
      const allowed = await requestPermissionFromJava(requestPayload.toolName, requestPayload.input);
      logInfo('PERM_DEBUG', `Patch approval decision: callId=${batch.callId}, allowed=${allowed ? 'true' : 'false'}`);
      if (!allowed) deniedCallIds.add(batch.callId);
    } catch (error) {
      logWarn('PERM_DEBUG', `Patch approval bridge failed (callId=${batch.callId}): ${error?.message || error}`);
      deniedCallIds.add(batch.callId);
    }
  }
  return deniedCallIds;
}

async function rollbackSinglePatchOperation(operation) {
  if (!operation || typeof operation !== 'object' || !operation.filePath) {
    return { ok: false, reason: 'invalid-operation' };
  }
  const { filePath } = operation;
  const oldString = typeof operation.oldString === 'string' ? operation.oldString : '';
  const newString = typeof operation.newString === 'string' ? operation.newString : '';
  const isAddedFile = operation.kind === 'add' || (operation.toolName === 'write' && oldString === '');

  if (isAddedFile) {
    if (!existsSync(filePath)) return { ok: true, reason: 'file-already-missing' };
    try { await unlink(filePath); return { ok: true, reason: 'file-deleted' }; }
    catch (error) { return { ok: false, reason: error?.message || String(error) }; }
  }
  if (!existsSync(filePath)) return { ok: false, reason: 'file-missing' };
  let currentContent = '';
  try { currentContent = await readFile(filePath, 'utf8'); }
  catch (error) { return { ok: false, reason: error?.message || String(error) }; }
  if (newString === oldString) return { ok: true, reason: 'noop' };
  if (!newString) return { ok: false, reason: 'unsupported-empty-new-string' };
  const index = currentContent.indexOf(newString);
  if (index < 0) return { ok: false, reason: 'new-string-not-found' };
  const revertedContent = currentContent.slice(0, index) + oldString + currentContent.slice(index + newString.length);
  try { await writeFile(filePath, revertedContent, 'utf8'); return { ok: true, reason: 'replaced' }; }
  catch (error) { return { ok: false, reason: error?.message || String(error) }; }
}

async function rollbackDeniedPatchBatches(patchBatches, deniedCallIds) {
  const resultByCallId = new Map();
  if (!Array.isArray(patchBatches) || patchBatches.length === 0) return resultByCallId;
  if (!(deniedCallIds instanceof Set) || deniedCallIds.size === 0) return resultByCallId;
  for (const batch of patchBatches) {
    if (!batch || !deniedCallIds.has(batch.callId)) continue;
    const operations = Array.isArray(batch.operations) ? [...batch.operations].reverse() : [];
    const failures = [];
    for (const op of operations) {
      const result = await rollbackSinglePatchOperation(op);
      if (!result.ok) failures.push({ filePath: op?.filePath || '', reason: result.reason });
    }
    resultByCallId.set(batch.callId, { success: failures.length === 0, failures });
  }
  return resultByCallId;
}

function emitSyntheticPatchOperations(state, patchBatches, isError, deniedCallIds = new Set(), rollbackByCallId = new Map()) {
  if (!Array.isArray(patchBatches) || patchBatches.length === 0) return 0;
  let emittedCount = 0;
  for (const batch of patchBatches) {
    if (!batch || !Array.isArray(batch.operations)) continue;
    emitSyntheticPatchToolUses(state, batch);
    batch.operations.forEach((op, index) => {
      const toolUseId = `codex_patch_${batch.callId}_${index}`;
      const deniedByUser = deniedCallIds instanceof Set && deniedCallIds.has(batch.callId);
      const rollbackResult = rollbackByCallId instanceof Map ? rollbackByCallId.get(batch.callId) : null;
      const rollbackSucceeded = !deniedByUser || rollbackResult?.success !== false;
      const opIsError = !!isError || deniedByUser;
      let resultText = 'Patch applied';
      if (isError) resultText = 'Patch apply failed';
      else if (deniedByUser) {
        resultText = rollbackSucceeded ? 'Patch denied by user and rolled back' : 'Patch denied by user but rollback failed';
      }
      if (!state.emittedToolResultIds.has(toolUseId)) {
        state.emitMessage(toolResultMsg(toolUseId, opIsError, resultText));
        state.emittedToolResultIds.add(toolUseId);
        emittedCount += 1;
      }
    });
  }
  return emittedCount;
}

function emitDeniedCommandToolResultOnce(state, toolUseId, messageText = 'Command denied by user') {
  if (!toolUseId || state.emittedDeniedCommandToolResultIds.has(toolUseId)) return;
  state.emitMessage(toolResultMsg(toolUseId, true, messageText));
  state.emittedToolResultIds.add(toolUseId);
  state.emittedDeniedCommandToolResultIds.add(toolUseId);
}

/**
 * Whether the event stream still needs the plugin's Java approval bridge.
 * Codex native review resolves approval before item.started is emitted.
 * @param {object} config
 * @returns {boolean}
 */
export function shouldBridgeCodexApproval(config) {
  const approvalPolicy = config?.threadOptions?.approvalPolicy;
  return config?.normalizedPermissionMode !== 'auto'
    && typeof approvalPolicy === 'string'
    && approvalPolicy !== 'never';
}

async function maybeRequestCommandApprovalViaBridge(state, config, { toolUseId, command, smartTool, description }) {
  // `item.started` is emitted after Codex has resolved the command approval and
  // started the process. Native auto review must therefore not ask Java again.
  const shouldBridgeApproval = shouldBridgeCodexApproval(config);
  if (!shouldBridgeApproval) return true;
  const permissionToolName = mapCommandToolNameToPermissionToolName(smartTool);
  const requestInput = { command, description, source: 'codex_command_execution' };
  try {
    logInfo('PERM_DEBUG', `Command approval request: toolUseId=${toolUseId}, tool=${permissionToolName}, command=${command}`);
    const allowed = await requestPermissionFromJava(permissionToolName, requestInput);
    logInfo('PERM_DEBUG', `Command approval decision: toolUseId=${toolUseId}, allowed=${allowed ? 'true' : 'false'}`);
    if (allowed) return true;
  } catch (error) {
    logWarn('PERM_DEBUG', `Command approval bridge failed, deny by default: toolUseId=${toolUseId}, error=${error?.message || error}`);
  }
  state.deniedCommandToolUseIds.add(toolUseId);
  state.suppressNoResponseFallback = true;
  emitDeniedCommandToolResultOnce(state, toolUseId, 'Command denied by user and turn aborted');
  state.emitMessage({ type: 'status', message: 'Approval denied: abort requested (command may have already started)' });
  state.commandApprovalAbortRequested = true;
  try { config.turnAbortController.abort(); }
  catch (error) { logDebug('PERM_DEBUG', `Abort turn failed after command denial: ${error?.message || error}`); }
  return false;
}

function emitThinkingDelta(text) {
  process.stdout.write(`[THINKING_DELTA] ${JSON.stringify(text)}\n`);
}

function emitContentDelta(text) {
  process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
}

function extractAppendedDelta(previousText, nextText) {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next.trim()) return '';
  if (!previous) return next;
  if (next === previous) return '';
  if (!next.startsWith(previous)) return '';
  return next.slice(previous.length);
}

function emitThinkingBlock(state, text) {
  console.log('[THINKING]', text);
  state.emitMessage({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text, text }] }
  });
}

function maybeEmitReasoning(state, item) {
  if (!item || item.type !== 'reasoning') return;
  const raw = typeof item.text === 'string' ? item.text : '';
  const text = raw.trim();
  if (!text) return;
  const stableId = getStableItemId(item) ?? randomUUID();
  const previousText = state.reasoningTextCache.get(stableId) ?? '';
  const delta = extractAppendedDelta(previousText, text);
  if (!delta && previousText === text) return;
  state.reasoningTextCache.set(stableId, text);
  state.reasoningObserved = true;
  if (delta) {
    emitThinkingDelta(delta);
  }
  emitThinkingBlock(state, text);
}

async function maybeLogRuntimePolicy(state, config) {
  if (state.runtimePolicyLogged) return;
  const turnContext = await readLatestTurnContextFromSession(state, config.threadId);
  if (!turnContext) return;
  const actualApproval = typeof turnContext.approval_policy === 'string' ? turnContext.approval_policy : '';
  const actualSandbox = turnContext?.sandbox_policy?.type || '';
  const writableRoots = Array.isArray(turnContext?.sandbox_policy?.writable_roots) ? turnContext.sandbox_policy.writable_roots : [];
  state.runtimePolicyLogged = true;
  logDebug('PERM_DEBUG', 'Runtime turn_context policy:', JSON.stringify({
    expectedApprovalPolicy: config.threadOptions.approvalPolicy || '',
    expectedSandboxMode: config.threadOptions.sandboxMode || '',
    actualApprovalPolicy: actualApproval, actualSandboxMode: actualSandbox, writableRoots
  }));
  const expectedApproval = config.threadOptions.approvalPolicy || '';
  if (expectedApproval && actualApproval && expectedApproval !== actualApproval) {
    logWarn('PERM_DEBUG', `approvalPolicy mismatch: expected=${expectedApproval}, runtime=${actualApproval}`);
  }
}

/**
 * Handle a completed item from the Codex event stream.
 * Dispatches to type-specific handlers for agent_message, command_execution,
 * file_change, and mcp_tool_call.
 */
async function handleItemCompleted(item, state, config) {
  console.log('[DEBUG] item.completed - type:', item.type);
  console.log('[DEBUG] item.completed - has text:', !!item.text);
  console.log('[DEBUG] item.completed - has agent_message:', !!item.agent_message);
  maybeEmitReasoning(state, item);

  if (item.type === 'agent_message') {
    handleAgentMessage(item, state);
  } else if (item.type === 'command_execution') {
    handleCommandExecution(item, state);
  } else if (item.type === 'file_change') {
    await handleFileChange(item, state, config);
  } else if (item.type === 'mcp_tool_call') {
    handleMcpToolCall(item, state);
  } else {
    console.log('[DEBUG] Unhandled item.completed item type:', item.type);
  }
}

function handleAgentMessage(item, state, { emitSnapshot = true } = {}) {
  const text = item.text || '';
  console.log('[DEBUG] agent_message text length:', text.length);
  console.log('[DEBUG] agent_message text (first 100 chars):', text.substring(0, 100));
  const stableId = getStableItemId(item) ?? 'agent_message';
  const previousText = state.assistantTextCache.get(stableId) ?? '';
  const delta = extractAppendedDelta(previousText, text);
  state.finalResponse = text;
  state.assistantTextCache.set(stableId, text);
  if (delta) {
    state.assistantText += delta;
    emitContentDelta(delta);
  }
  if (emitSnapshot && text && text.trim()) {
    state.emitMessage(textMsg(text));
  }
}

function handleCommandExecution(item, state) {
  const toolUseId = ensureToolUseId(state, 'completed', item);
  const command = extractCommand(item);
  if (state.deniedCommandToolUseIds.has(toolUseId)) {
    emitDeniedCommandToolResultOnce(state, toolUseId);
    console.log('[DEBUG] Skip command output because approval denied:', command);
    return;
  }
  const output = item.aggregated_output ?? item.output ?? item.stdout ?? item.result ?? '';
  const outputStrRaw = typeof output === 'string' ? output : JSON.stringify(output);
  const outputStr = truncateForDisplay(outputStrRaw, MAX_TOOL_RESULT_CHARS);
  const isError = (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.is_error === true;
  const toolName = smartToolName(command);
  const description = smartDescription(command);
  if (!state.emittedToolUseIds.has(toolUseId)) {
    state.emitMessage(toolUseMsg(toolUseId, toolName, { command, description }));
    state.emittedToolUseIds.add(toolUseId);
  }
  state.emitMessage(toolResultMsg(toolUseId, isError, outputStr && outputStr.trim() ? outputStr : '(no output)'));
  state.emittedToolResultIds.add(toolUseId);
}

async function handleFileChange(item, state, config) {
  const status = item.status || 'completed';
  const isError = status !== 'completed';
  try { console.log('[DEBUG] file_change raw item:', JSON.stringify(item)); }
  catch (error) { console.log('[DEBUG] file_change raw item stringify failed:', error?.message || error); }

  const patchBatches = await collectPatchOperationsFromSession(state, config);
  let deniedCallIds = new Set();
  let rollbackByCallId = new Map();

  const shouldBridgeApproval = !isError &&
    !isAutoEditPermissionMode(config.normalizedPermissionMode) &&
    shouldBridgeCodexApproval(config);
  if (shouldBridgeApproval && patchBatches.length > 0) {
    deniedCallIds = await requestPatchApprovalsViaBridge(patchBatches);
    if (deniedCallIds.size > 0) {
      rollbackByCallId = await rollbackDeniedPatchBatches(patchBatches, deniedCallIds);
      const failedRollbackCount = Array.from(rollbackByCallId.values())
        .filter((entry) => entry && entry.success === false).length;
      state.emitMessage({
        type: 'status',
        message: failedRollbackCount > 0
          ? `Approval denied: attempted to rollback ${deniedCallIds.size} change(s), ${failedRollbackCount} rollback(s) failed`
          : `Approval denied: rolled back ${deniedCallIds.size} change(s)`
      });
    }
  }
  const emitted = emitSyntheticPatchOperations(state, patchBatches, isError, deniedCallIds, rollbackByCallId);
  if (emitted > 0) console.log('[DEBUG] file_change synthesized operations:', emitted);
  else console.log('[DEBUG] file_change: no patch operations found in session log');
}

function handleMcpToolCall(item, state) {
  const toolName = normalizeMcpToolName(item.server, item.tool);
  const toolInput = normalizeMcpToolInput(item.server, item.tool, item.arguments || {});
  const matchedToolUseId = findMatchingToolUseId(state, toolName, toolInput);
  const toolUseId = matchedToolUseId || item.id || randomUUID();
  const isError = item.status === 'failed' || !!item.error;
  console.log('[DEBUG] MCP tool call completed:', toolName, 'id:', toolUseId, 'error:', isError);
  if (!state.emittedToolUseIds.has(toolUseId)) {
    state.emitMessage(toolUseMsg(toolUseId, toolName, toolInput));
    state.emittedToolUseIds.add(toolUseId);
  }
  rememberToolInvocation(state, toolUseId, toolName, toolInput);
  let resultContent = '(no output)';
  if (item.error) {
    resultContent = item.error.message || 'MCP tool call failed';
  } else if (item.result) {
    if (item.result.content && Array.isArray(item.result.content)) {
      const textParts = item.result.content.filter(block => block.type === 'text').map(block => block.text);
      resultContent = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(item.result);
    } else if (item.result.structured_content) {
      resultContent = JSON.stringify(item.result.structured_content);
    } else {
      resultContent = JSON.stringify(item.result);
    }
  }
  const truncatedResult = truncateForDisplay(resultContent, MAX_TOOL_RESULT_CHARS);
  state.emitMessage(toolResultMsg(toolUseId, isError, truncatedResult && truncatedResult.trim() ? truncatedResult : '(no output)'));
  state.emittedToolResultIds.add(toolUseId);
}

/**
 * Process Codex SDK event stream.
 * @param {AsyncIterable} events - The SDK event stream
 * @param {EventProcessingState} state - Mutable state (created via createInitialEventState)
 * @param {Object} config - { cwd, threadId, threadOptions, normalizedPermissionMode, turnAbortController }
 */
export async function processCodexEventStream(events, state, config) {
  let rawEventIndex = 0;
  try {
    for await (const event of events) {
      rawEventIndex += 1;
      const rawEventJson = stringifyRawEvent(event);
      if (rawEventJson && DEBUG_LEVEL >= 5) console.log(`[RAW_EVENT][${rawEventIndex}]`, rawEventJson);
      if (rawEventJson && DEBUG_LEVEL >= 4 && isApprovalRelatedRawEvent(rawEventJson)) {
        console.log(`[RAW_EVENT_APPROVAL_HINT][${rawEventIndex}]`, rawEventJson);
      }
      await maybeLogRuntimePolicy(state, config);
      console.log('[DEBUG] Codex event:', event.type);

      switch (event.type) {
      case 'thread.started': {
        state.currentThreadId = event.thread_id;
        console.log('[THREAD_ID]', state.currentThreadId);
        break;
      }

      case 'turn.started': {
        state.turnStarted = true;
        state.turnCompleted = false;
        state.turnUsageBaseline = null;
        state.latestTotalTokenUsage = null;
        await ensureSessionTurnBoundary(state, config);
        console.log('[DEBUG] Turn started');
        break;
      }

      case 'event_msg': {
        if (state.turnStarted && event?.payload?.type === 'token_count') {
          handleTokenCountEvent(event, state);
        }
        await replayMissingFunctionCallsDuringStream(state, config);
        break;
      }

      case 'item.started': {
        maybeEmitReasoning(state, event.item);
        if (event.item && event.item.type === 'command_execution') {
          const toolUseId = ensureToolUseId(state, 'started', event.item);
          const command = extractCommand(event.item);
          const toolName = smartToolName(command);
          const description = smartDescription(command);
          state.emitMessage(toolUseMsg(toolUseId, toolName, { command, description }));
          state.emittedToolUseIds.add(toolUseId);
          rememberToolInvocation(state, toolUseId, toolName, { command, description });
          const allowed = await maybeRequestCommandApprovalViaBridge(
            state, config, { toolUseId, command, smartTool: toolName, description }
          );
          if (!allowed) {
            logWarn('PERM_DEBUG', `Command denied by approval bridge: ${command}`);
            throw new Error(COMMAND_DENIED_ABORT_ERROR);
          }
        } else if (event.item && event.item.type === 'mcp_tool_call') {
          const toolName = normalizeMcpToolName(event.item.server, event.item.tool);
          const toolInput = normalizeMcpToolInput(event.item.server, event.item.tool, event.item.arguments || {});
          const matchedToolUseId = findMatchingToolUseId(state, toolName, toolInput);
          const toolUseId = matchedToolUseId || event.item.id || randomUUID();
          console.log('[DEBUG] MCP tool call started:', toolName, 'id:', toolUseId);
          if (!state.emittedToolUseIds.has(toolUseId)) {
            state.emitMessage(toolUseMsg(toolUseId, toolName, toolInput));
            state.emittedToolUseIds.add(toolUseId);
          }
          rememberToolInvocation(state, toolUseId, toolName, toolInput);
        }
        await replayMissingFunctionCallsDuringStream(state, config);
        break;
      }

      case 'item.updated':
        maybeEmitReasoning(state, event.item);
        if (event.item && event.item.type === 'agent_message') {
          handleAgentMessage(event.item, state, { emitSnapshot: false });
        }
        await replayMissingFunctionCallsDuringStream(state, config);
        break;

      case 'item.completed': {
        if (!event.item) break;
        await handleItemCompleted(event.item, state, config);
        await replayMissingFunctionCallsDuringStream(state, config);
        break;
      }

      case 'turn.completed': {
        state.turnCompleted = true;
        console.log('[DEBUG] Turn completed');
        const replayed = await replayMissingFunctionCallsDuringStream(state, config);
        if (replayed.toolUses > 0 || replayed.toolResults > 0) {
          console.log('[DEBUG] Replayed session function calls:', JSON.stringify(replayed));
        }
        const replayedTokenCounts = await replayCurrentTurnTokenCountsFromSession(state, config);
        if (replayedTokenCounts > 0) {
          logDebug('CONTEXT_USAGE', `Replayed current-turn token_count events: ${replayedTokenCounts}`);
        }
        flushPendingCustomPatchBatches(state);
        flushPendingCustomPlanCalls(state);
        const completedTurnUsage = resolveCompletedTurnUsage(state);
        if (completedTurnUsage) {
          console.log('[DEBUG] Token usage:', completedTurnUsage);
          const claudeUsage = {
            input_tokens: completedTurnUsage.input_tokens || 0,
            output_tokens: completedTurnUsage.output_tokens || 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: completedTurnUsage.cached_input_tokens || 0
          };
          state.emitMessage({
            type: 'result', subtype: 'usage', is_error: false,
            usage: claudeUsage, session_id: state.currentThreadId, uuid: randomUUID()
          });
          console.log('[DEBUG] Emitted usage statistics (Claude-compatible format):', claudeUsage);
        }
        if (typeof config.onTurnCompleted === 'function') {
          config.onTurnCompleted(event, state);
        }
        state.turnStarted = false;
        break;
      }

      case 'turn.failed': {
        const errorMsg = event.error?.message || 'Turn failed';
        if (isReconnectNotice(errorMsg)) {
          console.warn('[DEBUG] Codex reconnect notice:', errorMsg);
          emitStatusMessage(state.emitMessage, errorMsg);
          break;
        }
        if (state.commandApprovalAbortRequested && /aborted|abort|cancel|interrupt/i.test(errorMsg)) {
          logInfo('PERM_DEBUG', `Ignore turn.failed after command denial abort: ${errorMsg}`);
          break;
        }
        if (typeof config.onTurnFailed === 'function') {
          config.onTurnFailed(event, state);
        }
        console.error('[DEBUG] Turn failed:', errorMsg);
        throw new Error(errorMsg);
      }

      case 'error': {
        const generalError = event.message || 'Unknown error';
        if (isReconnectNotice(generalError)) {
          console.warn('[DEBUG] Codex reconnect notice:', generalError);
          emitStatusMessage(state.emitMessage, generalError);
          break;
        }
        if (state.commandApprovalAbortRequested && /aborted|abort|cancel|interrupt/i.test(generalError)) {
          logInfo('PERM_DEBUG', `Ignore error event after command denial abort: ${generalError}`);
          break;
        }
        if (typeof config.onTurnFailed === 'function') {
          config.onTurnFailed(event, state);
        }
        console.error('[DEBUG] Codex error:', generalError);
        throw new Error(generalError);
      }

      default: {
        const payloadType = event.payload?.type;
        console.log('[DEBUG] Unknown event type:', event.type, 'payload.type:', payloadType);

        if (event.type === 'response_item') {
          const payload = event.payload;
          const payloadCallId = typeof payload?.call_id === 'string' && payload.call_id
            ? payload.call_id
            : null;
          if (handleFunctionCallPayload(payload, state)) {
            if (payloadCallId) {
              state.processedSessionFunctionCallIds.add(payloadCallId);
            }
            break;
          }
          if (handleFunctionCallOutputPayload(payload, state)) {
            if (payloadCallId) {
              state.processedSessionFunctionOutputIds.add(payloadCallId);
            }
            break;
          }
          if (handleCustomToolCallPayload(payload, state, config)) {
            if (payloadCallId) {
              state.processedSessionCustomToolCallIds.add(payloadCallId);
            }
            break;
          }
          if (handleCustomToolCallOutputPayload(payload, state)) {
            if (payloadCallId) {
              state.processedSessionCustomToolOutputIds.add(payloadCallId);
            }
            break;
          }
        }

        if (event.type === 'event_msg' || payloadType === 'function_call' || payloadType === 'function_call_output') {
          console.log('[DEBUG] Full event:', JSON.stringify(event).substring(0, 500));
        }
      }
      }
    }
  } catch (streamError) {
    const streamErrorMessage = streamError?.message || String(streamError);
    if (state.commandApprovalAbortRequested && (
      streamErrorMessage === COMMAND_DENIED_ABORT_ERROR ||
      /aborted|abort|cancel|interrupt/i.test(streamErrorMessage)
    )) {
      logInfo('PERM_DEBUG', `Suppress streamed turn abort after command denial: ${streamErrorMessage}`);
    } else if (state.turnCompleted && isWindowsTaskkillParseNoise(streamErrorMessage)) {
      console.warn('[DEBUG] Suppressed post-completion Codex taskkill parse noise:', streamErrorMessage);
    } else {
      throw streamError;
    }
  }
}
