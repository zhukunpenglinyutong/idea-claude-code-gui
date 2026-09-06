import { useCallback, type RefObject } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';
import {
  EFFORT_SUPPORTED_CLAUDE_MODELS,
  apply1MContextSuffix,
} from '../components/ChatInputBox/types';
import type { Attachment, ChatInputBoxHandle, PermissionMode, ReasoningEffort, SelectedAgent, CodexFastMode } from '../components/ChatInputBox/types';
import { expandQuoteTokens } from '../components/ChatInputBox/utils/quoteRegistry';
import type { ViewMode } from './useModelProviderState';

/**
 * Command sets for local handling (shared with App.tsx to avoid duplication)
 */
export const NEW_SESSION_COMMANDS = new Set(['/new', '/clear', '/reset']);
export const RESUME_COMMANDS = new Set(['/resume', '/continue']);
export const PLAN_COMMANDS = new Set(['/plan']);
export const CONTEXT_COMMANDS = new Set(['/context']);

// Hoisted regex to avoid creating new RegExp on every call
const WHITESPACE_REGEX = /\s+/;

function createContextUsageRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `context-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function shouldSendReasoningEffort(provider: string, model: string): boolean {
  if (provider !== 'claude') {
    return true;
  }
  return EFFORT_SUPPORTED_CLAUDE_MODELS.has(model);
}

export interface UseMessageSenderOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  currentProvider: string;
  selectedModel: string;
  permissionMode: PermissionMode;
  reasoningEffort: ReasoningEffort;
  codexFastMode: CodexFastMode;
  codexNativeAutoReviewAvailable: boolean;
  dshPreset?: string;
  selectedAgent: SelectedAgent | null;
  sdkStatusLoading: boolean;
  currentSdkInstalled: boolean;
  sentAttachmentsRef: RefObject<Map<string, Array<{ fileName: string; mediaType: string }>>>;
  chatInputRef: RefObject<ChatInputBoxHandle | null>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: RefObject<boolean>;
  userPausedRef: RefObject<boolean>;
  isStreamingRef: RefObject<boolean>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsInitialTab: React.Dispatch<React.SetStateAction<any>>;
  setCurrentView: React.Dispatch<React.SetStateAction<ViewMode>>;
  forceCreateNewSession: () => void;
  handleModeSelect?: (mode: PermissionMode) => void;
  longContextEnabled?: boolean;
  openContextUsageDialog: (requestId?: string | null, loading?: boolean) => void;
  closeContextUsageDialog: (requestId?: string | null) => boolean;
}

/**
 * Handles message building, validation, and sending to the backend.
 */
export function useMessageSender({
  t,
  addToast,
  currentProvider,
  selectedModel,
  permissionMode,
  reasoningEffort,
  codexFastMode,
  codexNativeAutoReviewAvailable,
  dshPreset,
  selectedAgent,
  sdkStatusLoading,
  currentSdkInstalled,
  sentAttachmentsRef,
  chatInputRef,
  messagesContainerRef,
  isUserAtBottomRef,
  userPausedRef,
  isStreamingRef,
  setMessages,
  setLoading,
  setLoadingStartTime,
  setStreamingActive,
  setSettingsInitialTab,
  setCurrentView,
  forceCreateNewSession,
  handleModeSelect,
  longContextEnabled,
  openContextUsageDialog,
  closeContextUsageDialog,
}: UseMessageSenderOptions) {
  /**
   * Check if the input is a new session command
   */
  const checkNewSessionCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const command = text.split(/\s+/)[0].toLowerCase();
    if (NEW_SESSION_COMMANDS.has(command)) {
      forceCreateNewSession();
      return true;
    }
    return false;
  }, [forceCreateNewSession]);

  /**
   * Check for local-handled slash commands (/resume, /plan)
   * Returns true if the command was handled locally
   * Note: This is also checked in App.tsx handleSubmit to bypass loading queue
   */
  const checkLocalCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const command = text.split(/\s+/)[0].toLowerCase();

    // /resume - open history view
    if (RESUME_COMMANDS.has(command)) {
      setCurrentView('history');
      return true;
    }

    // /plan - switch to plan mode (Claude only; Codex sends as normal text)
    if (PLAN_COMMANDS.has(command) && currentProvider === 'claude') {
      if (handleModeSelect) {
        handleModeSelect('plan');
        addToast(t('chat.planModeEnabled', { defaultValue: 'Plan mode enabled' }), 'info');
      }
      return true;
    }

    return false;
  }, [setCurrentView, handleModeSelect, currentProvider, addToast, t]);

  /**
   * Check for context usage command (/context)
   * Only available for Claude provider. Opens a dialog to display context window usage.
   */
  const checkContextCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;
    const command = text.split(WHITESPACE_REGEX)[0].toLowerCase();
    if (CONTEXT_COMMANDS.has(command)) {
      if (currentProvider !== 'claude') {
        addToast(t('chat.commandProviderOnly', {
          command,
          provider: 'Claude',
          defaultValue: `${command} is only available for Claude provider`,
        }), 'warning');
        return true;
      }

      const requestId = createContextUsageRequestId();

      // Open dialog with loading state immediately
      openContextUsageDialog(requestId, true);

      // Send bridge event to fetch context usage with current model
      // Apply [1m] suffix if long context is enabled so the SDK creates
      // a runtime with the correct context window limit.
      const sent = sendBridgeEvent('get_context_usage', JSON.stringify({
        model: apply1MContextSuffix(selectedModel, longContextEnabled ?? false),
        requestId,
      }));

      if (!sent) {
        closeContextUsageDialog(requestId);
        addToast(t('chat.bridgeUnavailable', {
          defaultValue: 'Bridge is not available right now',
        }), 'error');
      }
      return true;
    }
    return false;
  }, [currentProvider, selectedModel, longContextEnabled, addToast, t, openContextUsageDialog, closeContextUsageDialog]);

  /**
   * Check for unimplemented slash commands
   */
  const checkUnimplementedCommand = useCallback((text: string): boolean => {
    if (!text.startsWith('/')) return false;

    const command = text.split(/\s+/)[0].toLowerCase();
    const unimplementedCommands = ['/plugin', '/plugins'];

    if (unimplementedCommands.includes(command)) {
      const userMessage: ClaudeMessage = {
        type: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };
      const assistantMessage: ClaudeMessage = {
        type: 'assistant',
        content: t('chat.commandNotImplemented', { command }),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      return true;
    }
    return false;
  }, [t, setMessages]);

  /**
   * Build content blocks for the user message
   */
  const buildUserContentBlocks = useCallback((
    text: string,
    attachments: Attachment[] | undefined
  ): ClaudeContentBlock[] => {
    const blocks: ClaudeContentBlock[] = [];

    const hasImageAttachments = Array.isArray(attachments) &&
      attachments.some(att => att.mediaType?.startsWith('image/'));

    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (att.mediaType?.startsWith('image/')) {
          blocks.push({
            type: 'image',
            src: `data:${att.mediaType};base64,${att.data}`,
            mediaType: att.mediaType,
          });
        } else {
          blocks.push({
            type: 'attachment',
            fileName: att.fileName,
            mediaType: att.mediaType,
          });
        }
      }
    }

    // Filter placeholder text: skip if there are image attachments and text is placeholder
    const isPlaceholderText = text && text.trim().startsWith('[Uploaded ');

    if (text && !(hasImageAttachments && isPlaceholderText)) {
      blocks.push({ type: 'text', text });
    }

    return blocks;
  }, []);

  /**
   * Send message to backend
   */
  const sendMessageToBackend = useCallback((
    text: string,
    attachments: Attachment[] | undefined,
    agentInfo: { id: string; name: string; prompt?: string } | null,
    fileTagsInfo: { displayPath: string; absolutePath: string }[] | null,
    requestedPermissionMode: PermissionMode
  ) => {
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    const effectivePermissionMode: PermissionMode = currentProvider === 'codex'
      && (requestedPermissionMode === 'plan'
        || (requestedPermissionMode === 'auto' && !codexNativeAutoReviewAvailable))
      ? 'default'
      : requestedPermissionMode;
    console.debug('[ModeSync][Frontend] send request mode', {
      provider: currentProvider,
      requestedMode: requestedPermissionMode,
      effectiveMode: effectivePermissionMode,
    });

    const reasoningEffortPayload = shouldSendReasoningEffort(currentProvider, selectedModel)
      ? { reasoningEffort }
      : {};

    if (hasAttachments) {
      try {
        const payload = JSON.stringify({
          text,
          attachments: (attachments || []).map(a => ({
            fileName: a.fileName,
            mediaType: a.mediaType,
            data: a.data,
          })),
          agent: agentInfo,
          fileTags: fileTagsInfo,
          permissionMode: effectivePermissionMode,
          ...reasoningEffortPayload,
          ...(currentProvider === 'dsh' ? { dshPreset: dshPreset || '' } : {}),
          codexFastMode,
        });
        sendBridgeEvent('send_message_with_attachments', payload);
      } catch (error) {
        console.error('[Frontend] Failed to serialize attachments payload', error);
        const fallbackPayload = JSON.stringify({
          text,
          agent: agentInfo,
          fileTags: fileTagsInfo,
          permissionMode: effectivePermissionMode,
          ...reasoningEffortPayload,
          ...(currentProvider === 'dsh' ? { dshPreset: dshPreset || '' } : {}),
          codexFastMode,
        });
        sendBridgeEvent('send_message', fallbackPayload);
      }
    } else {
      const payload = JSON.stringify({
        text,
        agent: agentInfo,
        fileTags: fileTagsInfo,
        permissionMode: effectivePermissionMode,
        ...reasoningEffortPayload,
        ...(currentProvider === 'dsh' ? { dshPreset: dshPreset || '' } : {}),
        codexFastMode,
      });
      sendBridgeEvent('send_message', payload);
    }
  }, [codexFastMode, codexNativeAutoReviewAvailable, currentProvider, dshPreset, selectedModel, reasoningEffort]);

  /**
   * Execute message sending (from queue or directly)
   */
  const executeMessage = useCallback((content: string, attachments?: Attachment[]) => {
    // Expand inline quote chips (tokens) into their full Markdown blockquotes.
    const text = expandQuoteTokens(content).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!text && !hasAttachments) return;

    // Check SDK status
    if (sdkStatusLoading) {
      addToast(t('chat.sdkStatusLoading'), 'info');
      return;
    }
    if (!currentSdkInstalled) {
      addToast(
        t('chat.sdkNotInstalled', { provider: currentProvider === 'codex' ? 'Codex' : 'Claude Code' }) + ' ' + t('chat.goInstallSdk'),
        'warning'
      );
      setSettingsInitialTab('dependencies');
      setCurrentView('settings');
      return;
    }

    // Build user message content blocks
    const userContentBlocks = buildUserContentBlocks(text, attachments);
    if (userContentBlocks.length === 0) return;

    // Persist non-image attachment metadata
    const nonImageAttachments = Array.isArray(attachments)
      ? attachments.filter(a => !a.mediaType?.startsWith('image/'))
      : [];
    if (nonImageAttachments.length > 0) {
      const MAX_ATTACHMENT_CACHE_SIZE = 100;
      if (sentAttachmentsRef.current.size >= MAX_ATTACHMENT_CACHE_SIZE) {
        const firstKey = sentAttachmentsRef.current.keys().next().value;
        if (firstKey !== undefined) {
          sentAttachmentsRef.current.delete(firstKey);
        }
      }
      sentAttachmentsRef.current.set(text || '', nonImageAttachments.map(a => ({
        fileName: a.fileName,
        mediaType: a.mediaType,
      })));
    }

    // Create and add user message (optimistic update)
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: text || '',
      timestamp: new Date().toISOString(),
      isOptimistic: true,
      raw: { message: { content: userContentBlocks } },
    };
    setMessages((prev) => [...prev, userMessage]);

    // Set loading state
    setLoading(true);
    setLoadingStartTime(Date.now());

    // Scroll to bottom
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });

    // Sync provider setting
    sendBridgeEvent('set_provider', currentProvider);

    // Build agent info
    const agentInfo = selectedAgent ? {
      id: selectedAgent.id,
      name: selectedAgent.name,
      prompt: selectedAgent.prompt,
    } : null;

    // Extract file tag info
    const fileTags = chatInputRef.current?.getFileTags() ?? [];
    const fileTagsInfo = fileTags.length > 0 ? fileTags.map(tag => ({
      displayPath: tag.displayPath,
      absolutePath: tag.absolutePath,
    })) : null;

    // Send message to backend
    sendMessageToBackend(text, attachments, agentInfo, fileTagsInfo, permissionMode);
  }, [
    sdkStatusLoading,
    currentSdkInstalled,
    currentProvider,
    dshPreset,
    permissionMode,
    selectedAgent,
    buildUserContentBlocks,
    sendMessageToBackend,
    addToast,
    t,
  ]);

  /**
   * Handle message submission (from ChatInputBox)
   */
  const handleSubmit = useCallback((content: string, attachments?: Attachment[]) => {
    const text = content.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!text && !hasAttachments) return;

    // Check new session commands
    if (checkNewSessionCommand(text)) return;

    // Check local-handled commands (/resume, /plan)
    if (checkLocalCommand(text)) return;

    // Check context usage command (/context)
    if (checkContextCommand(text)) return;

    // Check for unimplemented commands
    if (checkUnimplementedCommand(text)) return;

    // Execute message
    executeMessage(content, attachments);
  }, [checkNewSessionCommand, checkLocalCommand, checkContextCommand, checkUnimplementedCommand, executeMessage]);

  /**
   * Interrupt the current session
   */
  const interruptSession = useCallback(() => {
    setLoading(false);
    setLoadingStartTime(null);
    setStreamingActive(false);
    isStreamingRef.current = false;

    sendBridgeEvent('interrupt_session');
  }, []);

  return {
    handleSubmit,
    executeMessage,
    interruptSession,
  };
}
