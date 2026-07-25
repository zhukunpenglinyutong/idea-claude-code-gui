import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { sendToJava } from '../utils/bridge';
import { collectFileChangesAfterIndex, type UndoFileEntry } from '../utils/collectFileChangesAfterIndex';
import { formatTime } from '../utils/helpers';

export interface RollbackRequest {
  messageIndex: number;
  messageContent: string;
  messageTimestamp?: string;
  messagesAfterCount: number;
  hasFileChanges: boolean;
  fileChangesCount: number;
}

export interface UseRollbackHandlersOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  messages: ClaudeMessage[];
  setMessages: (messages: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => void;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getMessageText: (message: ClaudeMessage) => string;
  setDraftInput: (value: string) => void;
  resetProcessedFiles: () => void;
  /** Current streaming state — rollback button hidden when true */
  streamingActive: boolean;
}

export interface UseRollbackHandlersReturn {
  rollbackDialogOpen: boolean;
  currentRollbackRequest: RollbackRequest | null;
  isRollingBack: boolean;
  showRollbackDialog: (messageIndex: number, message: ClaudeMessage) => void;
  handleRollbackConfirm: () => void;
  handleRollbackCancel: () => void;
}

/**
 * Check if a user message is a tool_result-only proxy (no real user text).
 * Same logic as the Rewind feature — we skip these messages.
 */
function isToolResultOnlyUserMessage(msg: ClaudeMessage): boolean {
  if (msg.type !== 'user') return false;
  if ((msg.content ?? '').trim() === '[tool_result]') return true;

  const raw = msg.raw;
  if (!raw || typeof raw === 'string') return false;

  const rawObj = raw as { content?: unknown[]; message?: { content?: unknown[] } };
  const content = rawObj.content ?? rawObj.message?.content;
  if (!Array.isArray(content)) return false;

  return content.some(
    (block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result',
  );
}

export function useRollbackHandlers(
  options: UseRollbackHandlersOptions,
): UseRollbackHandlersReturn {
  const {
    t,
    addToast,
    messages,
    setMessages,
    getContentBlocks,
    findToolResult,
    getMessageText,
    setDraftInput,
    resetProcessedFiles,
    streamingActive,
  } = options;

  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false);
  const [currentRollbackRequest, setCurrentRollbackRequest] = useState<RollbackRequest | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);

  // Store the file changes to revert so the confirm handler can access them
  const pendingFileChangesRef = useRef<UndoFileEntry[]>([]);
  // Store the original onUndoAllFileResult to restore after interception
  const originalUndoAllResultRef = useRef<((json: string) => void) | undefined>(undefined);

  const showRollbackDialog = useCallback(
    (messageIndex: number, message: ClaudeMessage) => {
      // Don't show dialog during streaming
      if (streamingActive) return;

      // Skip tool_result-only user messages
      let targetIndex = messageIndex;
      let targetMessage: ClaudeMessage = message;
      if (isToolResultOnlyUserMessage(message)) {
        for (let i = messageIndex - 1; i >= 0; i -= 1) {
          const candidate = messages[i];
          if (candidate.type !== 'user') continue;
          if (isToolResultOnlyUserMessage(candidate)) continue;
          targetIndex = i;
          targetMessage = candidate;
          break;
        }
      }

      // Don't allow rollback on the last message if it's the target itself
      // (nothing to discard)
      if (targetIndex >= messages.length - 1) return;

      const messagesAfterCount = messages.length - targetIndex - 1;

      // Collect file changes after this message
      const fileChanges = collectFileChangesAfterIndex(
        targetIndex,
        messages,
        getContentBlocks,
        findToolResult,
      );
      const hasFileChanges = fileChanges.length > 0;

      // Get display content for the dialog
      const content = targetMessage.content || getMessageText(targetMessage);
      const timestamp = targetMessage.timestamp
        ? formatTime(targetMessage.timestamp)
        : undefined;

      setCurrentRollbackRequest({
        messageIndex: targetIndex,
        messageContent: content,
        messageTimestamp: timestamp,
        messagesAfterCount,
        hasFileChanges,
        fileChangesCount: fileChanges.length,
      });
      setRollbackDialogOpen(true);
    },
    [streamingActive, messages, getContentBlocks, findToolResult, getMessageText],
  );

  const handleRollbackConfirm = useCallback(() => {
    if (!currentRollbackRequest) return;

    const { messageIndex, messageContent } = currentRollbackRequest;

    // Collect file changes after the target message
    const fileChanges = collectFileChangesAfterIndex(
      messageIndex,
      messages,
      getContentBlocks,
      findToolResult,
    );

    if (fileChanges.length > 0) {
      // Save for the callback
      pendingFileChangesRef.current = fileChanges;

      // Intercept onUndoAllFileResult to handle our rollback-specific logic
      originalUndoAllResultRef.current = window.onUndoAllFileResult;

      setIsRollingBack(true);

      window.onUndoAllFileResult = (json: string) => {
        // Restore original handler first
        window.onUndoAllFileResult = originalUndoAllResultRef.current;

        try {
          const result = JSON.parse(json);
          if (result.success) {
            // File revert succeeded — truncate messages and restore input
            setMessages((prev) => prev.slice(0, messageIndex + 1));
            setDraftInput(messageContent);
            resetProcessedFiles();
            setRollbackDialogOpen(false);
            setCurrentRollbackRequest(null);
            setIsRollingBack(false);
            addToast(t('rollback.success'), 'success');
          } else {
            setIsRollingBack(false);
            addToast(result.error || t('rollback.failed'), 'error');
          }
        } catch {
          setIsRollingBack(false);
          addToast(t('rollback.failed'), 'error');
        }
      };

      // Send batch undo request to Java
      const files = fileChanges.map((fc) => ({
        filePath: fc.filePath,
        status: fc.status,
        operations: fc.operations,
      }));
      sendToJava('undo_all_file_changes', { files });
    } else {
      // No file changes — just truncate messages and restore input
      setMessages((prev) => prev.slice(0, messageIndex + 1));
      setDraftInput(messageContent);
      resetProcessedFiles();
      setRollbackDialogOpen(false);
      setCurrentRollbackRequest(null);
      addToast(t('rollback.success'), 'success');
    }
  }, [
    currentRollbackRequest,
    messages,
    getContentBlocks,
    findToolResult,
    setMessages,
    setDraftInput,
    resetProcessedFiles,
    addToast,
    t,
  ]);

  const handleRollbackCancel = useCallback(() => {
    if (isRollingBack) {
      // If rollback is in progress, restore the original callback
      if (originalUndoAllResultRef.current !== undefined) {
        window.onUndoAllFileResult = originalUndoAllResultRef.current;
        originalUndoAllResultRef.current = undefined;
      }
      setIsRollingBack(false);
    }
    setRollbackDialogOpen(false);
    setCurrentRollbackRequest(null);
  }, [isRollingBack]);

  return {
    rollbackDialogOpen,
    currentRollbackRequest,
    isRollingBack,
    showRollbackDialog,
    handleRollbackConfirm,
    handleRollbackCancel,
  };
}
