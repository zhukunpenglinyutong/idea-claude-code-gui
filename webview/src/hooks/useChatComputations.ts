import { type RefObject, useCallback, useMemo, useRef } from 'react';
import type { TFunction } from 'i18next';
import type {
  ClaudeContentBlock,
  ClaudeMessage,
  ClaudeRawMessage,
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
  finalizeSubagentsForSettledTurn,
  finalizeTodosForSettledTurn,
  sliceLatestConversationTurn,
} from '../utils/turnScope';
import { FILE_MODIFY_TOOL_NAMES, isToolName } from '../utils/toolConstants';
import { useSubagents } from './useSubagents';
import { useFileChanges } from './useFileChanges';
import { useFileChangesManagement } from './useFileChangesManagement';
import type { useMessageProcessing } from './useMessageProcessing';

interface UseChatComputationsParams {
  t: TFunction;
  messages: ClaudeMessage[];
  mergedMessages: ClaudeMessage[];
  customSessionTitle: string | null;
  streamingActive: boolean;
  currentProvider: string;
  currentSessionId: string | null;
  currentSessionIdRef: RefObject<string | null>;
  getMessageText: ReturnType<typeof useMessageProcessing>['getMessageText'];
  getContentBlocks: ReturnType<typeof useMessageProcessing>['getContentBlocks'];
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

  const latestTurnSubagents = useSubagents({
    messages: latestTurnMessages,
    getContentBlocks,
    findToolResult,
    getToolResultRaw,
  });

  const subagents = useMemo(
    () => finalizeSubagentsForSettledTurn(latestTurnSubagents, streamingActive),
    [latestTurnSubagents, streamingActive],
  );

  const globalTodos = useMemo(() => {
    return deriveTodosForTurn(latestTurnMessages, getContentBlocks, streamingActive);
  }, [latestTurnMessages, getContentBlocks, streamingActive]);

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
  };
}
