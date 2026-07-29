import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { sendToJava } from '../utils/bridge';
import { collectFileChangesAfterIndex } from '../utils/collectFileChangesAfterIndex';
import { formatTime } from '../utils/helpers';

/** Max time (ms) to wait for Java backend to respond before resetting. */
const ROLLBACK_TIMEOUT_MS = 30_000;

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

  // Store the original callbacks to restore after interception
  const originalRollbackResultRef = useRef<((json: string) => void) | undefined>(undefined);
  const originalUndoAllResultRef = useRef<((json: string) => void) | undefined>(undefined);
  const rollbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Clear the rollback timeout, if active. */
  const clearRollbackTimeout = useCallback(() => {
    if (rollbackTimeoutRef.current !== null) {
      clearTimeout(rollbackTimeoutRef.current);
      rollbackTimeoutRef.current = null;
    }
  }, []);

  /** Start a timeout that resets rollback state if Java never responds. */
  const startRollbackTimeout = useCallback(() => {
    clearRollbackTimeout();
    rollbackTimeoutRef.current = setTimeout(() => {
      rollbackTimeoutRef.current = null;
      // Restore original callbacks
      if (originalRollbackResultRef.current !== undefined) {
        window.onRollbackResult = originalRollbackResultRef.current;
        originalRollbackResultRef.current = undefined;
      }
      if (originalUndoAllResultRef.current !== undefined) {
        window.onUndoAllFileResult = originalUndoAllResultRef.current;
        originalUndoAllResultRef.current = undefined;
      }
      setIsRollingBack(false);
      setRollbackDialogOpen(false);
      setCurrentRollbackRequest(null);
      addToast(t('rollback.timeout', 'Rollback timed out — no response from backend'), 'error');
    }, ROLLBACK_TIMEOUT_MS);
  }, [clearRollbackTimeout, addToast, t]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (rollbackTimeoutRef.current !== null) {
        clearTimeout(rollbackTimeoutRef.current);
        rollbackTimeoutRef.current = null;
      }
    };
  }, []);

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
      clearRollbackTimeout();
      setDraftInput(messageContent);
      resetProcessedFiles();
      setRollbackDialogOpen(false);
      setCurrentRollbackRequest(null);
      setIsRollingBack(false);
      addToast(t('rollback.success'), 'success');
    },
    [clearRollbackTimeout, setDraftInput, resetProcessedFiles, addToast, t],
  );

  /** Send rollback_to_message to Java and wait for onRollbackResult. */
  const sendRollback = useCallback(
    (messageContent: string) => {
      originalRollbackResultRef.current = window.onRollbackResult;

      window.onRollbackResult = (json: string) => {
        window.onRollbackResult = originalRollbackResultRef.current;
        clearRollbackTimeout();
        try {
          const r = JSON.parse(json);
          if (!r.success) {
            setIsRollingBack(false);
            addToast(r.message || t('rollback.failed'), 'error');
            return;
          }
          finishRollback(messageContent);
        } catch {
          setIsRollingBack(false);
          addToast(t('rollback.failed'), 'error');
        }
      };

      sendToJava('rollback_to_message', {
        messageUuid: currentRollbackRequest?.messageUuid,
      });
    },
    [currentRollbackRequest, clearRollbackTimeout, finishRollback, addToast, t],
  );

  const handleRollbackConfirm = useCallback(() => {
    if (!currentRollbackRequest) return;

    const { messageIndex, messageContent } = currentRollbackRequest;

    // Collect file changes BEFORE any truncation
    const fileChanges = collectFileChangesAfterIndex(
      messageIndex,
      messages,
      getContentBlocks,
      findToolResult,
    );

    setIsRollingBack(true);
    startRollbackTimeout();

    if (fileChanges.length > 0) {
      // ── Path A: revert files first, then truncate messages ──
      originalUndoAllResultRef.current = window.onUndoAllFileResult;

      window.onUndoAllFileResult = (undoJson: string) => {
        window.onUndoAllFileResult = originalUndoAllResultRef.current;
        clearRollbackTimeout();
        try {
          const r = JSON.parse(undoJson);
          if (!r.success) {
            setIsRollingBack(false);
            addToast(r.error || t('rollback.failed'), 'error');
            return;
          }
          // Files reverted — now truncate messages (starts a new timeout)
          sendRollback(messageContent);
        } catch {
          setIsRollingBack(false);
          addToast(t('rollback.failed'), 'error');
        }
      };

      const files = fileChanges.map((fc) => ({
        filePath: fc.filePath,
        status: fc.status,
        operations: fc.operations,
      }));
      sendToJava('undo_all_file_changes', { files });
    } else {
      // ── Path B: no files to revert, truncate directly ──
      sendRollback(messageContent);
    }
  }, [
    currentRollbackRequest,
    messages,
    getContentBlocks,
    findToolResult,
    sendRollback,
    startRollbackTimeout,
    addToast,
    t,
  ]);

  const handleRollbackCancel = useCallback(() => {
    clearRollbackTimeout();
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
  }, [clearRollbackTimeout, isRollingBack]);

  return {
    rollbackDialogOpen,
    currentRollbackRequest,
    isRollingBack,
    showRollbackDialog,
    handleRollbackConfirm,
    handleRollbackCancel,
  };
}
