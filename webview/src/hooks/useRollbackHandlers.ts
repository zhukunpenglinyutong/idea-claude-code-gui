import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { sendToJava } from '../utils/bridge';
import { collectFileChangesAfterIndex, type UndoFileEntry } from '../utils/collectFileChangesAfterIndex';
import { formatTime } from '../utils/helpers';

export interface RollbackRequest {
  messageIndex: number;
  messageUuid: string;
  messageContent: string;
  messageTimestamp?: string;
  messagesAfterCount: number;
  hasFileChanges: boolean;
  fileChangesCount: number;
}

export interface UseRollbackHandlersOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  /** Merged/filtered messages — used for dialog display and file change calculation */
  messages: ClaudeMessage[];
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

  // Store the file changes to revert after message truncation completes
  const pendingFileChangesRef = useRef<UndoFileEntry[]>([]);
  // Store the original callbacks to restore after interception
  const originalRollbackResultRef = useRef<((json: string) => void) | undefined>(undefined);
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

      const messagesAfterCount = messages.length - targetIndex - 1;

      // Collect file changes after this message
      const fileChanges = collectFileChangesAfterIndex(
        targetIndex,
        messages,
        getContentBlocks,
        findToolResult,
      );
      const hasFileChanges = fileChanges.length > 0;

      // Extract UUID from raw message (same approach as Rewind)
      const raw = targetMessage.raw;
      const uuid = typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>).uuid as string | undefined
        : undefined;
      if (!uuid) {
        addToast(t('rollback.notAvailable', 'Rollback not available for this message'), 'warning');
        return;
      }

      // Get display content for the dialog
      const content = targetMessage.content || getMessageText(targetMessage);
      const timestamp = targetMessage.timestamp
        ? formatTime(targetMessage.timestamp)
        : undefined;

      setCurrentRollbackRequest({
        messageIndex: targetIndex,
        messageUuid: uuid,
        messageContent: content,
        messageTimestamp: timestamp,
        messagesAfterCount,
        hasFileChanges,
        fileChangesCount: fileChanges.length,
      });
      setRollbackDialogOpen(true);
    },
    [streamingActive, messages, getContentBlocks, findToolResult, getMessageText, addToast, t],
  );

  /** Common cleanup after both message truncation and file revert succeed. */
  const finishRollback = useCallback(
    (messageContent: string) => {
      setDraftInput(messageContent);
      resetProcessedFiles();
      setRollbackDialogOpen(false);
      setCurrentRollbackRequest(null);
      setIsRollingBack(false);
      addToast(t('rollback.success'), 'success');
    },
    [setDraftInput, resetProcessedFiles, addToast, t],
  );

  const handleRollbackConfirm = useCallback(() => {
    if (!currentRollbackRequest) return;

    const { messageIndex, messageContent } = currentRollbackRequest;

    // Collect file changes BEFORE truncation (messages state still has full list)
    const fileChanges = collectFileChangesAfterIndex(
      messageIndex,
      messages,
      getContentBlocks,
      findToolResult,
    );
    pendingFileChangesRef.current = fileChanges;

    setIsRollingBack(true);

    // Step 1: Intercept onRollbackResult for post-truncation actions
    originalRollbackResultRef.current = window.onRollbackResult;

    window.onRollbackResult = (json: string) => {
      // Restore original handler
      window.onRollbackResult = originalRollbackResultRef.current;

      try {
        const result = JSON.parse(json);
        if (!result.success) {
          setIsRollingBack(false);
          addToast(result.message || t('rollback.failed'), 'error');
          return;
        }

        // Java already pushed clearMessages + updateMessages with the
        // truncated list — the UI is already updated at this point.

        // Step 2: If file changes exist, revert them via undo_all_file_changes
        if (fileChanges.length > 0) {
          originalUndoAllResultRef.current = window.onUndoAllFileResult;

          window.onUndoAllFileResult = (undoJson: string) => {
            window.onUndoAllFileResult = originalUndoAllResultRef.current;

            try {
              const undoResult = JSON.parse(undoJson);
              if (undoResult.success) {
                finishRollback(messageContent);
              } else {
                setIsRollingBack(false);
                addToast(
                  undoResult.error || t('rollback.failed'),
                  'error',
                );
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
          // No file changes — rollback is complete
          finishRollback(messageContent);
        }
      } catch {
        setIsRollingBack(false);
        addToast(t('rollback.failed'), 'error');
      }
    };

    // Send rollback request to Java — this finds the message by UUID and
    // truncates SessionState.messages for persistence across webview reloads.
    sendToJava('rollback_to_message', { messageUuid: currentRollbackRequest.messageUuid });
  }, [
    currentRollbackRequest,
    messages,
    getContentBlocks,
    findToolResult,
    finishRollback,
    addToast,
    t,
  ]);

  const handleRollbackCancel = useCallback(() => {
    if (isRollingBack) {
      // Restore any intercepted callbacks
      if (originalRollbackResultRef.current !== undefined) {
        window.onRollbackResult = originalRollbackResultRef.current;
        originalRollbackResultRef.current = undefined;
      }
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
