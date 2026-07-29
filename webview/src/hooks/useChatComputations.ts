import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
  SubagentHistoryResponse,
  TodoItem,
  ToolResultBlock,
} from '../types';
import type { GetToolResultRawFn } from '../contexts/SubagentContext';
import type { RewindableMessage } from '../components/RewindSelectDialog';
import { formatTime } from '../utils/helpers';
import {
  containsAnyTag,
  hasTaskNotificationTag,
  INTERNAL_METADATA_TAGS,
} from '../utils/messageUtils';
import { extractTodosFromToolUse, extractAccumulatedTasks } from '../utils/todoToolNormalization';
import {
  type BackgroundTurnActivity,
  finalizeSubagentsForSettledTurn,
  finalizeTodosForSettledTurn,
  getBackgroundTurnActivity,
  sliceLatestConversationTurn,
} from '../utils/turnScope';
import { FILE_MODIFY_TOOL_NAMES, isToolName } from '../utils/toolConstants';
import { collectBackgroundTaskRecords, setBackgroundTaskUsage, setFinishedBackgroundTasks } from '../utils/backgroundTasks';
import { useBackgroundTurnSignal } from '../utils/backgroundTurnSignal';
import { useSubagents } from './useSubagents';
import { useFileChanges } from './useFileChanges';
import { useFileChangesManagement } from './useFileChangesManagement';
import type { useMessageProcessing } from './useMessageProcessing';

interface UseChatComputationsParams {
  t: TFunction;
  messages: ClaudeMessage[];
  mergedMessages: ClaudeMessage[];
  subagentHistories: Record<string, SubagentHistoryResponse>;
  customSessionTitle: string | null;
  streamingActive: boolean;
  currentProvider: string;
  currentSessionId: string | null;
  currentSessionIdRef: RefObject<string | null>;
  getMessageText: ReturnType<typeof useMessageProcessing>['getMessageText'];
  getContentBlocks: ReturnType<typeof useMessageProcessing>['getContentBlocks'];
}

/**
 * Whether a message slice contains any assistant tool_use block. Used to decide
 * whether the latest-turn scope is carrying active tool work worth focusing on,
 * or is empty of tools (a reload snapshot / text-only turn) and should widen to
 * the full conversation so StatusPanel lists do not disappear.
 */
function sliceHasToolUse(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
): boolean {
  for (const message of messages) {
    if (message.type !== 'assistant') continue;
    const blocks = getContentBlocks(message);
    for (const block of blocks) {
      if (block.type === 'tool_use') return true;
    }
  }
  return false;
}

export function deriveTodosForTurn(
  turnMessages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  streamingActive: boolean,
): TodoItem[] {
  let latestTodos: ReturnType<typeof extractTodosFromToolUse> = null;
  for (let i = turnMessages.length - 1; i >= 0; i--) {
    const msg = turnMessages[i];
    if (msg.type !== 'assistant') continue;
    const blocks = getContentBlocks(msg);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const todos = extractTodosFromToolUse(blocks[j]);
      if (todos && todos.length > 0) {
        latestTodos = todos;
        break;
      }
    }
    if (latestTodos) break;
  }

  if (latestTodos) {
    return finalizeTodosForSettledTurn(latestTodos, streamingActive);
  }

  return extractAccumulatedTasks(turnMessages, getContentBlocks);
}

/**
 * Bundles all chat-view derived computations: tool result lookup table,
 * subagent extraction, todos, rewindable messages, file change filtering,
 * and session title.
 *
 * Stage 5 of TASK-P1-01 — moves ~120 lines of computation out of App.tsx.
 */
export function useChatComputations({
  t,
  messages,
  mergedMessages,
  subagentHistories,
  customSessionTitle,
  streamingActive,
  currentProvider,
  currentSessionId,
  currentSessionIdRef,
  getMessageText,
  getContentBlocks,
}: UseChatComputationsParams) {
  // Ref-backed scan over messages for tool_result blocks, with a per-id cache.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const toolResultRawMapRef = useRef<Map<string, ClaudeRawMessage>>(new Map());

  const findToolResult = useCallback((toolUseId?: string, messageIndex?: number): ToolResultBlock | null => {
    if (!toolUseId || typeof messageIndex !== 'number') return null;
    const currentMessages = messagesRef.current;
    const cachedRaw = toolResultRawMapRef.current.get(toolUseId);
    if (cachedRaw != null) {
      const content = cachedRaw.content ?? cachedRaw.message?.content;
      if (Array.isArray(content)) {
        const hit = content.find(
          (block): block is ToolResultBlock =>
            Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
        );
        if (hit) return hit;
      }
    }
    for (let i = 0; i < currentMessages.length; i += 1) {
      const candidate = currentMessages[i];
      const raw = candidate.raw;
      if (!raw || typeof raw === 'string') continue;
      const content = raw.content ?? raw.message?.content;
      if (!Array.isArray(content)) continue;
      const resultBlock = content.find(
        (block): block is ToolResultBlock =>
          Boolean(block) && block.type === 'tool_result' && block.tool_use_id === toolUseId,
      );
      if (resultBlock) {
        toolResultRawMapRef.current.set(toolUseId, raw);
        return resultBlock;
      }
    }
    return null;
  }, []);

  const getToolResultRaw = useCallback<GetToolResultRawFn>(
    (toolUseId: string) => toolResultRawMapRef.current.get(toolUseId) ?? null,
    [],
  );

  // File changes (depend on findToolResult which is now stable above).
  const fileChangeMgmt = useFileChangesManagement({
    currentSessionId, currentSessionIdRef, messages,
    getContentBlocks, findToolResult,
  });
  const fileChanges = useFileChanges({
    messages, getContentBlocks, findToolResult,
    startFromIndex: fileChangeMgmt.baseMessageIndex,
  });

  const filteredFileChanges = useMemo(() => {
    if (fileChangeMgmt.processedFiles.length === 0) return fileChanges;
    return fileChanges.filter((fc) => !fileChangeMgmt.processedFiles.includes(fc.filePath));
  }, [fileChanges, fileChangeMgmt.processedFiles]);

  const latestTurnMessages = useMemo(() => sliceLatestConversationTurn(messages), [messages]);

  // Track which background tasks (agents/workflows launched with
  // run_in_background) have finished — their completion arrives as a
  // task-notification message carrying the launch's ids. Tool cards read
  // this store to keep background agents in "running" state after their
  // immediate launch-confirmation tool_result.
  useEffect(() => {
    const records = collectBackgroundTaskRecords(messages);
    setFinishedBackgroundTasks(records.finished);
    setBackgroundTaskUsage(records.usage);
  }, [messages]);

  // The CLI generating an inter-turn background response has no GUI-owned
  // streaming state — surface it as a waiting indicator. Two sources, ORed:
  // the live daemon signal (background_turn events relayed by Java; primary,
  // TTL-expired in its store) and the transcript-tail heuristic (a trailing
  // task-notification; covers reloads of sessions the daemon isn't signalling
  // about). The heuristic is re-evaluated on a timer so its freshness window
  // can expire without a new message arriving.
  const backgroundTurnSignal = useBackgroundTurnSignal();
  const [backgroundTurnActivity, setBackgroundTurnActivity] = useState<BackgroundTurnActivity>({ active: false });
  // The evaluator reads its inputs through a ref so the 30s timer below is
  // created ONCE. Depending on `messages` directly tore the interval down and
  // rebuilt it on every streamed message, which both churned timers and kept
  // pushing the freshness deadline further out.
  const backgroundTurnInputsRef = useRef({ messages, backgroundTurnSignal, currentSessionId });
  backgroundTurnInputsRef.current = { messages, backgroundTurnSignal, currentSessionId };
  const evaluateBackgroundTurn = useCallback(() => {
    const { messages: msgs, backgroundTurnSignal: signal, currentSessionId: sessionId } = backgroundTurnInputsRef.current;
    const heuristic = getBackgroundTurnActivity(msgs, Date.now());
    const signalActive = signal !== null && signal.sessionId === sessionId;
    const next: BackgroundTurnActivity = heuristic.active
      ? heuristic
      : signalActive
        ? { active: true, startTimeMs: signal.startedAtMs }
        : { active: false };
    setBackgroundTurnActivity((prev) => (
      prev.active === next.active && prev.startTimeMs === next.startTimeMs ? prev : next
    ));
  }, []);
  // Re-evaluate when the inputs change (cheap; no timer involved).
  useEffect(() => {
    evaluateBackgroundTurn();
  }, [messages, backgroundTurnSignal, currentSessionId, evaluateBackgroundTurn]);
  // One long-lived timer so the heuristic's freshness window can expire even
  // when no new message arrives.
  useEffect(() => {
    const timer = window.setInterval(evaluateBackgroundTurn, 30_000);
    return () => window.clearInterval(timer);
  }, [evaluateBackgroundTurn]);

  // While streaming, focus on the current turn's task progress; once settled
  // (history replay or idle), widen the scope to the whole conversation -
  // otherwise a multi-turn history session whose last turn has no task tool
  // would lose its task and subagent lists entirely.
  //
  // Exception: if the latest-turn slice carries no tool_use at all (e.g. a
  // same-session reload snapshot whose latest turn predates the active work, or
  // a text-only turn), widen to the full conversation. Without this, the
  // StatusPanel subagent/todo lists can briefly disappear when a deferred
  // reload's message refresh lands at the frontend a moment before the
  // stream-end signal flips streamingActive back to false. Widening only adds
  // content (earlier turns' settled items) - it never drops the current turn's.
  const statusScopeMessages = useMemo(() => {
    if (!streamingActive) return messages;
    return latestTurnMessages.length > 0 && sliceHasToolUse(latestTurnMessages, getContentBlocks)
      ? latestTurnMessages
      : messages;
  }, [streamingActive, latestTurnMessages, messages, getContentBlocks]);

  const latestTurnSubagents = useSubagents({
    messages: statusScopeMessages,
    getContentBlocks,
    findToolResult,
    getToolResultRaw,
    subagentHistories,
  });

  // Background subagents (agents/workflows) launched in earlier turns keep
  // running while the conversation moves on — scan the full history so they
  // stay visible in the status panel until their task-notification arrives.
  const allSubagents = useSubagents({
    messages,
    getContentBlocks,
    findToolResult,
    getToolResultRaw,
  });

  const subagents = useMemo(() => {
    const latest = finalizeSubagentsForSettledTurn(latestTurnSubagents, streamingActive);
    const inLatestTurn = new Set(latest.map((subagent) => subagent.id));
    const runningBackground = allSubagents.filter(
      (subagent) => subagent.isBackground && subagent.status === 'running' && !inLatestTurn.has(subagent.id),
    );
    return [...runningBackground, ...latest];
  }, [allSubagents, latestTurnSubagents, streamingActive]);

  const globalTodos = useMemo(() => {
    return deriveTodosForTurn(statusScopeMessages, getContentBlocks, streamingActive);
  }, [statusScopeMessages, getContentBlocks, streamingActive]);

  const canRewindFromMessageIndex = useCallback(
    (userMessageIndex: number) => {
      if (userMessageIndex < 0 || userMessageIndex >= mergedMessages.length) return false;
      const current = mergedMessages[userMessageIndex];
      if (current.type !== 'user') return false;
      if ((current.content || '').trim() === '[tool_result]') return false;
      const raw = current.raw;
      if (raw && typeof raw !== 'string') {
        const content = raw.content ?? raw.message?.content;
        if (Array.isArray(content) && content.some((block) => block && block.type === 'tool_result')) {
          return false;
        }
      }
      for (let i = userMessageIndex + 1; i < mergedMessages.length; i += 1) {
        const msg = mergedMessages[i];
        if (msg.type === 'user') break;
        const blocks = getContentBlocks(msg);
        for (const block of blocks) {
          if (block.type !== 'tool_use') continue;
          if (isToolName(block.name, FILE_MODIFY_TOOL_NAMES)) return true;
        }
      }
      return false;
    },
    [mergedMessages, getContentBlocks],
  );

  const rewindableMessages = useMemo((): RewindableMessage[] => {
    if (currentProvider !== 'claude') return [];
    const result: RewindableMessage[] = [];
    for (let i = 0; i < mergedMessages.length - 1; i++) {
      if (!canRewindFromMessageIndex(i)) continue;
      const message = mergedMessages[i];
      const content = message.content || getMessageText(message);
      const timestamp = message.timestamp ? formatTime(message.timestamp) : undefined;
      const messagesAfterCount = mergedMessages.length - i - 1;
      result.push({ messageIndex: i, message, displayContent: content, timestamp, messagesAfterCount });
    }
    return result;
  }, [mergedMessages, currentProvider, canRewindFromMessageIndex, getMessageText]);

  const sessionTitle = useMemo(() => {
    if (customSessionTitle) return customSessionTitle;
    if (messages.length === 0) return t('common.newSession');
    // Pick the first REAL prompt: skip meta/caveat messages and anything whose
    // text is raw internal XML (e.g. <local-command-caveat>) so the tag is
    // never leaked as the session title.
    let text = '';
    for (const message of messages) {
      if (message.type !== 'user') continue;
      const raw = message.raw;
      if (raw && typeof raw === 'object' && raw.isMeta === true) continue;
      const candidate = getMessageText(message).trim();
      if (!candidate) continue;
      if (candidate.startsWith('<')) continue;
      if (containsAnyTag(candidate, INTERNAL_METADATA_TAGS) || hasTaskNotificationTag(candidate)) continue;
      text = candidate;
      break;
    }
    if (!text) return t('common.newSession');
    return text.length > 15 ? `${text.substring(0, 15)}...` : text;
  }, [customSessionTitle, messages, t, getMessageText]);

  return {
    findToolResult,
    getToolResultRaw,
    fileChangeMgmt,
    filteredFileChanges,
    subagents,
    globalTodos,
    rewindableMessages,
    sessionTitle,
    backgroundTurnActivity,
  };
}
