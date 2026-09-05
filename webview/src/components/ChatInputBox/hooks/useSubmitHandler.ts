import { useCallback } from 'react';
import type { Attachment } from '../types.js';
import type { Dispatch, SetStateAction } from 'react';

interface CompletionLike {
  close: () => void;
}

export interface UseSubmitHandlerOptions {
  getTextContent: () => string;
  attachments: Attachment[];
  isLoading: boolean;
  sdkStatusLoading: boolean;
  sdkInstalled: boolean;
  currentProvider: string;
  clearInput: () => void;
  /** Cancel any pending debounced input callbacks to prevent stale values from refilling the input */
  cancelPendingInput: () => void;
  /** Invalidate text content cache to force fresh DOM read on submit */
  invalidateCache: () => void;
  externalAttachments: Attachment[] | undefined;
  setInternalAttachments: Dispatch<SetStateAction<Attachment[]>>;
  /** Clear attachments draft from localStorage */
  clearAttachmentsDraft?: () => void;
  fileCompletion: CompletionLike;
  commandCompletion: CompletionLike;
  agentCompletion: CompletionLike;
  promptCompletion: CompletionLike;
  dollarCommandCompletion: CompletionLike;
  recordInputHistory: (text: string) => void;
  onSubmit?: (content: string, attachmentsToSend?: Attachment[]) => void;
  onInstallSdk?: () => void;
  addToast?: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * useSubmitHandler - Submit logic for the chat input box
 *
 * - Validates SDK state and empty input
 * - Records input history
 * - Clears input/attachments for responsiveness
 * - Defers onSubmit to allow UI update
 */
export function useSubmitHandler({
  getTextContent,
  attachments,
  isLoading,
  sdkStatusLoading,
  sdkInstalled,
  currentProvider,
  clearInput,
  cancelPendingInput,
  invalidateCache,
  externalAttachments,
  setInternalAttachments,
  clearAttachmentsDraft,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  promptCompletion,
  dollarCommandCompletion,
  recordInputHistory,
  onSubmit,
  onInstallSdk,
  addToast,
  t,
}: UseSubmitHandlerOptions) {
  return useCallback(() => {
    // Force fresh DOM read to avoid stale cache (e.g., after paste)
    invalidateCache();
    const content = getTextContent();
    const cleanContent = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

    if (sdkStatusLoading) {
      addToast?.(t('chat.sdkStatusLoading'), 'info');
      return;
    }

    if (!sdkInstalled) {
      addToast?.(
        t('chat.sdkNotInstalled', {
          provider: currentProvider === 'codex' ? 'Codex' : currentProvider === 'codebuddy' ? 'CodeBuddy' : 'Claude Code',
        }) +
          ' ' +
          t('chat.goInstallSdk'),
        'warning'
      );
      onInstallSdk?.();
      return;
    }

    if (!cleanContent && attachments.length === 0) return;

    // Close completions
    fileCompletion.close();
    commandCompletion.close();
    agentCompletion.close();
    promptCompletion.close();
    dollarCommandCompletion.close();

    // Record input history
    recordInputHistory(content);

    const attachmentsToSend = attachments.length > 0 ? [...attachments] : undefined;

    // Cancel any pending debounced input callbacks before clearing
    // This prevents stale values from refilling the input after submit
    cancelPendingInput();
    clearInput();
    if (externalAttachments === undefined) {
      setInternalAttachments([]);
      // Clear attachments draft from localStorage
      clearAttachmentsDraft?.();
    }

    // Call onSubmit even when loading - let parent handle queueing
    setTimeout(() => {
      onSubmit?.(content, attachmentsToSend);
    }, 10);
  }, [
    getTextContent,
    invalidateCache,
    attachments,
    isLoading,
    sdkStatusLoading,
    sdkInstalled,
    currentProvider,
    clearInput,
    cancelPendingInput,
    externalAttachments,
    setInternalAttachments,
    clearAttachmentsDraft,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    recordInputHistory,
    onSubmit,
    onInstallSdk,
    addToast,
    t,
  ]);
}
