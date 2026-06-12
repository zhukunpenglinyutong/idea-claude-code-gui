import {
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ChatInputBoxHandle,
  ChatInputBoxProps,
  PermissionMode,
} from './types.js';
import { ChatInputBoxHeader } from './ChatInputBoxHeader.js';
import { ChatInputBoxFooter } from './ChatInputBoxFooter.js';
import { ResizeHandles } from './ResizeHandles.js';
import {
  useTextContent,
  useFileTags,
  useTooltip,
  useKeyboardNavigation,
  useIMEComposition,
  usePasteAndDrop,
  usePromptEnhancer,
  useGlobalCallbacks,
  useInputHistory,
  useSubmitHandler,
  useKeyboardHandler,
  useNativeEventCapture,
  useControlledValueSync,
  useChatInputAttachmentsCoordinator,
  useChatInputCompletionsCoordinator,
  useChatInputSelectionController,
  useOpenSourceBannerState,
  useResetAttachmentsOnSessionChange,
  useSpaceKeyListener,
  useResizableChatInputBox,
} from './hooks/index.js';
import { debounce } from './utils/debounce.js';
import { perfTimer } from '../../utils/debug.js';
import { DEBOUNCE_TIMING } from '../../constants/performance.js';
import { SessionContext } from '../../contexts/SessionContext.js';
import { ContextMenu } from '../ContextMenu';
import { useContextMenu, copySelection, pasteAtCursor, insertNewline } from '../../hooks/useContextMenu.js';
import './styles.css';

/**
 * ChatInputBox - Chat input component
 * Uses contenteditable div with auto height adjustment, IME handling, @ file references, / slash commands
 *
 * Performance optimizations:
 * - Uses uncontrolled mode with useImperativeHandle for minimal re-renders
 * - Debounced onInput callback to reduce parent component updates
 * - Cached getTextContent to avoid repeated DOM traversal
 */
export const ChatInputBox = memo(forwardRef<ChatInputBoxHandle, ChatInputBoxProps>(
  (
    {
      isLoading = false,
      selectedModel = 'claude-sonnet-4-6',
      permissionMode = 'bypassPermissions',
      currentProvider = 'claude',
      usagePercentage = 0,
      usageUsedTokens,
      usageMaxTokens,
      showUsage = true,
      attachments: externalAttachments,
      placeholder = '', // Will be passed from parent via t('chat.inputPlaceholder')
      disabled = false,
      value,
      onSubmit,
      onStop,
      onInput,
      onAddAttachment,
      onRemoveAttachment,
      onModeSelect,
      onModelSelect,
      onProviderSelect,
      reasoningEffort = 'high',
      onReasoningChange,
      codexFastMode = 'normal',
      onCodexFastModeChange,
      activeFile,
      selectedLines,
      onClearContext,
      alwaysThinkingEnabled,
      onToggleThinking,
      streamingEnabled,
      onStreamingEnabledChange,
      sendShortcut = 'enter',
      selectedAgent,
      onAgentSelect,
      onOpenAgentSettings,
      onOpenPromptSettings,
      onOpenModelSettings,
      hasMessages = false,
      onRewind,
      statusPanelExpanded = true,
      onToggleStatusPanel,
      sdkInstalled = true, // Default to true to avoid disabling input box on initial state
      sdkStatusLoading = false, // SDK status loading state
      onInstallSdk,
      addToast,
      messageQueue,
      onRemoveFromQueue,
      autoOpenFileEnabled,
      onAutoOpenFileEnabledChange,
      longContextEnabled = true,
      onLongContextChange,
    }: ChatInputBoxProps,
    ref: React.ForwardedRef<ChatInputBoxHandle>
  ) => {
    const { t } = useTranslation();

    const { showOpenSourceBanner, handleDismissOpenSourceBanner } = useOpenSourceBannerState();
    const {
      attachments,
      setInternalAttachments,
      clearAttachmentsDraft,
      handleAddAttachment,
      handleRemoveAttachment,
    } = useChatInputAttachmentsCoordinator({
      externalAttachments,
      onAddAttachment,
      onRemoveAttachment,
    });

    // Reset draft attachments + clear JCEF ghosting when the session changes, so
    // attachments don't drift into a new conversation and leave stale thumbnails.
    // SessionContext is read null-safely so this component still mounts in tests
    // without a SessionProvider.
    const sessionCtx = useContext(SessionContext);
    const clearInternalAttachments = useCallback(() => {
      setInternalAttachments([]);
      clearAttachmentsDraft?.();
    }, [setInternalAttachments, clearAttachmentsDraft]);
    useResetAttachmentsOnSessionChange({
      currentSessionId: sessionCtx?.currentSessionId ?? null,
      isControlled: externalAttachments !== undefined,
      clearInternalAttachments,
    });

    // Input element refs and state
    const containerRef = useRef<HTMLDivElement>(null);
    const editableRef = useRef<HTMLDivElement>(null);
    const editableWrapperRef = useRef<HTMLDivElement>(null);
    const submittedOnEnterRef = useRef(false);
    const completionSelectedRef = useRef(false);
    const closeAllCompletionsRef = useRef<() => void>(() => {});
    const handleInputRef = useRef<() => void>(() => {});
    const [hasContent, setHasContent] = useState(false);

    // Flag to track if we're updating from external value
    const isExternalUpdateRef = useRef(false);

    // Shared composing state ref - created early so it can be used by detectAndTriggerCompletion
    // This ref is synced with useIMEComposition's isComposingRef
    const sharedComposingRef = useRef(false);

    // Text content hook
    const { getTextContent, invalidateCache } = useTextContent({ editableRef });

    // Close all completions helper
    const closeAllCompletions = useCallback(() => {
      closeAllCompletionsRef.current();
    }, []);

    // File tags hook
    const { renderFileTags, pathMappingRef, justRenderedTagRef, extractFileTags, setCursorAfterPath } = useFileTags({
      editableRef,
      getTextContent,
      onCloseCompletions: closeAllCompletions,
    });

    // Tooltip hook
    const { tooltip, handleMouseOver, handleMouseLeave } = useTooltip();

    // Context menu hook
    const ctxMenu = useContextMenu();

    /**
     * Clear input box
     */
    const clearInput = useCallback(() => {
      if (editableRef.current) {
        editableRef.current.innerHTML = '';
        editableRef.current.style.height = 'auto';
        setHasContent(false);
        // Notify parent component that input is cleared
        onInput?.('');
      }
    }, [onInput]);

    /**
     * Adjust input box height
     * Let contenteditable element expand naturally (height: auto),
     * outer container (.input-editable-wrapper) controls scrolling via max-height and overflow-y.
     * This avoids double scrollbar issue from outer + inner element scrolling.
     */
    const adjustHeight = useCallback(() => {
      const el = editableRef.current;
      if (!el) return;

      // Ensure height is auto, expanded by content
      el.style.height = 'auto';
      // Hide inner scrollbar, completely rely on outer container scrolling
      el.style.overflowY = 'hidden';
    }, []);

    // Create debounced version of renderFileTags
    const debouncedRenderFileTags = useMemo(
      () => debounce(renderFileTags, DEBOUNCE_TIMING.FILE_TAG_RENDERING_MS),
      [renderFileTags]
    );

    const {
      fileCompletion,
      commandCompletion,
      agentCompletion,
      promptCompletion,
      dollarCommandCompletion,
      inlineCompletion,
      debouncedDetectCompletion,
      syncInlineCompletion,
      setRenderFileTags,
    } = useChatInputCompletionsCoordinator({
      editableRef,
      sharedComposingRef,
      justRenderedTagRef,
      getTextContent,
      pathMappingRef,
      setCursorAfterPath,
      closeAllCompletionsRef,
      handleInputRef,
      currentProvider,
      onAgentSelect,
      onOpenAgentSettings,
      onOpenPromptSettings,
    });

    // Performance optimization: Debounced onInput callback
    // Reduces parent component re-renders during rapid typing
    // Also skips during IME composition to prevent parent re-renders that cause JCEF stutter
    const debouncedOnInput = useMemo(
      () =>
        debounce((text: string) => {
          // Skip if this is an external value update to avoid loops
          if (isExternalUpdateRef.current) {
            isExternalUpdateRef.current = false;
            return;
          }
          // Skip during active IME composition to prevent parent re-renders
          // that can disrupt Korean/CJK input in JCEF environments.
          // The update will be triggered after compositionEnd via handleInput.
          if (sharedComposingRef.current) {
            return;
          }
          onInput?.(text);
        }, DEBOUNCE_TIMING.ON_INPUT_CALLBACK_MS),
      [onInput]
    );

    /**
     * Handle input event (optimized: use debounce to reduce performance overhead)
     */
    const handleInput = useCallback(
      () => {
        const timer = perfTimer('handleInput');

        // Only trust our own isComposingRef for IME state detection.
        // JCEF's InputEvent.isComposing is unreliable (can be false during active
        // composition, or true after compositionEnd). Our ref is set synchronously
        // by compositionStart/End and keyCode 229 detection, making it the sole
        // reliable source of truth.
        if (isComposingRef.current) {
          return;
        }

        // Cancel any pending compositionEnd fallback timeout.
        // The normal input event path handles state sync, so the fallback
        // (which would redundantly call handleInput again) is no longer needed.
        // This prevents: 1) double handleInput calls, 2) debouncedOnInput timer
        // reset that delays parent notification by an extra 100ms.
        cancelPendingFallback();

        // Invalidate cache since content changed
        invalidateCache();
        timer.mark('invalidateCache');

        const text = getTextContent();
        timer.mark('getTextContent');

        // Remove zero-width and other invisible characters before checking if empty, ensure placeholder shows when only zero-width characters remain
        const cleanText = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
        const isEmpty = !cleanText.trim();

        // If content is empty, clear innerHTML to ensure :empty pseudo-class works (show placeholder)
        if (isEmpty && editableRef.current) {
          editableRef.current.innerHTML = '';
        }

        // Adjust height
        adjustHeight();
        timer.mark('adjustHeight');

        // Trigger completion detection and state update
        debouncedDetectCompletion();
        setHasContent(!isEmpty);

        // Update inline history completion
        syncInlineCompletion(text);

        // Notify parent component (use debounced version to reduce re-renders)
        // If determined empty (only zero-width characters), pass empty string to parent
        debouncedOnInput(isEmpty ? '' : text);

        timer.end();
      },
      [
        getTextContent,
        adjustHeight,
        debouncedDetectCompletion,
        debouncedOnInput,
        invalidateCache,
        syncInlineCompletion,
      ]
    );

    useEffect(() => {
      handleInputRef.current = handleInput;
    }, [handleInput]);

    // IME composition hook (ref-only, no React state to avoid re-renders during composition)
    const {
      isComposingRef,
      lastCompositionEndTimeRef,
      handleCompositionStart: rawHandleCompositionStart,
      handleCompositionEnd: rawHandleCompositionEnd,
      cancelPendingFallback,
    } = useIMEComposition({
      handleInput,
    });

    // Wrap composition handlers to sync sharedComposingRef (used by completion detection)
    // Both refs are now set synchronously — no RAF, no race conditions.
    const handleCompositionStart = useCallback(() => {
      rawHandleCompositionStart();
      sharedComposingRef.current = true;
    }, [rawHandleCompositionStart]);

    const handleCompositionEnd = useCallback(() => {
      rawHandleCompositionEnd();
      sharedComposingRef.current = false;
    }, [rawHandleCompositionEnd]);

    useEffect(() => {
      setRenderFileTags(renderFileTags);
    }, [renderFileTags, setRenderFileTags]);

    const { record: recordInputHistory, handleKeyDown: handleHistoryKeyDown } = useInputHistory({
      editableRef,
      getTextContent,
      handleInput,
    });

    // Keyboard navigation hook
    const { handleMacCursorMovement } = useKeyboardNavigation({
      editableRef,
      handleInput,
    });

    /**
     * Handle keyboard down event (for detecting space to trigger file tag rendering)
     * Optimized: use debounce for delayed rendering
     */
    const handleKeyDownForTagRendering = useCallback(
      (e: KeyboardEvent) => {
        // If space key pressed, use debounce for delayed file tag rendering
        if (e.key === ' ') {
          debouncedRenderFileTags();
        }
      },
      [debouncedRenderFileTags]
    );

    const handleSubmit = useSubmitHandler({
      getTextContent,
      invalidateCache,
      attachments,
      isLoading,
      sdkStatusLoading,
      sdkInstalled,
      currentProvider,
      clearInput,
      cancelPendingInput: () => {
        debouncedOnInput.cancel();
      },
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
    });

    // Prompt enhancer hook
    const {
      isEnhancing,
      showEnhancerDialog,
      originalPrompt,
      enhancedPrompt,
      handleEnhancePrompt,
      handleUseEnhancedPrompt,
      handleKeepOriginalPrompt,
      handleCloseEnhancerDialog,
    } = usePromptEnhancer({
      editableRef,
      getTextContent,
      setHasContent,
      onInput,
    });

    const {
      focusInput,
      applyInlineCompletion,
      handleCtxMenuCut,
      handleClearFileContext,
      handleRequestEnableFileContext,
    } = useChatInputSelectionController({
      ref,
      editableRef,
      getTextContent,
      invalidateCache,
      isExternalUpdateRef,
      setHasContent,
      adjustHeight,
      clearInput,
      hasContent,
      extractFileTags,
      inlineCompletion,
      handleInput,
      ctxMenu,
      onClearContext,
      onAutoOpenFileEnabledChange,
    });

    const { onKeyDown: handleKeyDown, onKeyUp: handleKeyUp } = useKeyboardHandler({
      isComposingRef,
      lastCompositionEndTimeRef,
      sendShortcut,
      sdkStatusLoading,
      sdkInstalled,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      promptCompletion,
      dollarCommandCompletion,
      handleMacCursorMovement,
      handleHistoryKeyDown,
      // Inline completion: Tab key applies suggestion
      inlineCompletion: inlineCompletion.hasSuggestion ? {
        applySuggestion: applyInlineCompletion,
      } : undefined,
      completionSelectedRef,
      submittedOnEnterRef,
      handleSubmit,
    });

    useControlledValueSync({
      value,
      editableRef,
      isComposingRef,
      isExternalUpdateRef,
      getTextContent,
      setHasContent,
      adjustHeight,
      invalidateCache,
    });

    useNativeEventCapture({
      editableRef,
      isComposingRef,
      lastCompositionEndTimeRef,
      sendShortcut,
      fileCompletion,
      commandCompletion,
      agentCompletion,
      promptCompletion,
      dollarCommandCompletion,
      completionSelectedRef,
      submittedOnEnterRef,
      handleSubmit,
      handleEnhancePrompt,
    });

    // Listen for IDEA shortcut send event (dispatched by window.execContextAction)
    useEffect(() => {
      const handler = () => {
        if (!isLoading && !isComposingRef.current) {
          handleSubmit();
        }
      };
      document.addEventListener('ideaSend', handler);
      return () => document.removeEventListener('ideaSend', handler);
    }, [handleSubmit, isLoading]);

    // Paste and drop hook
    const { handlePaste, handleDragOver, handleDrop } = usePasteAndDrop({
      editableRef,
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      setHasContent,
      setInternalAttachments,
      onInput,
      closeAllCompletions,
      handleInput,
      flushInput: () => {
        debouncedOnInput.flush();
      },
    });

    /**
     * Handle mode select
     */
    const handleModeSelect = useCallback(
      (mode: PermissionMode) => {
        onModeSelect?.(mode);
      },
      [onModeSelect]
    );

    /**
     * Handle model select
     */
    const handleModelSelect = useCallback(
      (modelId: string) => {
        onModelSelect?.(modelId);
      },
      [onModelSelect]
    );

    // Global callbacks hook
    useGlobalCallbacks({
      editableRef,
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      setHasContent,
      onInput,
      closeAllCompletions,
      focusInput,
    });

    useSpaceKeyListener({ editableRef, onKeyDown: handleKeyDownForTagRendering });

    const {
      isResizing: isResizingInputBox,
      containerStyle,
      editableWrapperStyle,
      getHandleProps,
      nudge,
    } = useResizableChatInputBox({
      containerRef,
      editableWrapperRef,
    });

    return (
      <div
        className={`chat-input-box ${isResizingInputBox ? 'is-resizing' : ''}`}
        onClick={focusInput}
        ref={containerRef}
        style={containerStyle}
        onMouseOver={handleMouseOver}
        onMouseLeave={handleMouseLeave}
      >
        <ResizeHandles getHandleProps={getHandleProps} nudge={nudge} />

        <ChatInputBoxHeader
          sdkStatusLoading={sdkStatusLoading}
          sdkInstalled={sdkInstalled}
          currentProvider={currentProvider}
          onInstallSdk={onInstallSdk}
          t={t}
          attachments={attachments}
          onRemoveAttachment={handleRemoveAttachment}
          activeFile={activeFile}
          selectedLines={selectedLines}
          usagePercentage={usagePercentage}
          usageUsedTokens={usageUsedTokens}
          usageMaxTokens={usageMaxTokens}
          showUsage={showUsage}
          onClearContext={handleClearFileContext}
          onAddAttachment={handleAddAttachment}
          selectedAgent={selectedAgent}
          onClearAgent={() => onAgentSelect?.(null)}
          hasMessages={hasMessages}
          onRewind={onRewind}
          statusPanelExpanded={statusPanelExpanded}
          onToggleStatusPanel={onToggleStatusPanel}
          messageQueue={messageQueue}
          onRemoveFromQueue={onRemoveFromQueue}
          showOpenSourceBanner={showOpenSourceBanner}
          onDismissOpenSourceBanner={handleDismissOpenSourceBanner}
          autoOpenFileEnabled={autoOpenFileEnabled}
          onRequestEnableFileContext={handleRequestEnableFileContext}
        />

        {/* Input area */}
        <div
          ref={editableWrapperRef}
          className="input-editable-wrapper"
          style={editableWrapperStyle}
        >
          <div
            ref={editableRef}
            className="input-editable"
            contentEditable={!disabled}
            spellCheck={false}
            data-placeholder={placeholder}
            data-completion-suffix={inlineCompletion.suffix || ''}
            onInput={() => {
              // Don't pass browser's isComposing — it's unreliable in JCEF.
              // isComposingRef (set by compositionStart/End + keyCode 229) is the
              // sole source of truth for IME state.
              handleInput();
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onBeforeInput={(e) => {
              const inputType =
                'inputType' in e.nativeEvent
                  ? (e.nativeEvent as InputEvent).inputType
                  : undefined;
              if (inputType === 'insertParagraph') {
                e.preventDefault();
                // If item was just selected in completion menu with enter, don't send message
                if (completionSelectedRef.current) {
                  completionSelectedRef.current = false;
                  return;
                }
                // Don't send message when completion menu is open
                if (
                  fileCompletion.isOpen ||
                  commandCompletion.isOpen ||
                  agentCompletion.isOpen ||
                  promptCompletion.isOpen ||
                  dollarCommandCompletion.isOpen
                ) {
                  return;
                }
                // Only allow submit when not loading and not in IME composition
                if (!isLoading && !isComposingRef.current) {
                  handleSubmit();
                }
              }
              // Fix: Remove delete key special handling during IME
              // Let browser naturally handle delete operations, sync state uniformly after compositionend
            }}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onContextMenu={ctxMenu.open}
            suppressContentEditableWarning
          />
          {ctxMenu.visible && (
            <ContextMenu
              x={ctxMenu.x}
              y={ctxMenu.y}
              onClose={ctxMenu.close}
              items={[
                { label: t('contextMenu.copy', 'Copy'), action: () => copySelection(ctxMenu.savedRange, ctxMenu.selectedText), disabled: !ctxMenu.hasSelection },
                { label: t('contextMenu.cut', 'Cut'), action: handleCtxMenuCut, disabled: !ctxMenu.hasSelection },
                { label: t('contextMenu.paste', 'Paste'), action: () => { if (editableRef.current) { pasteAtCursor(ctxMenu.savedRange, editableRef.current, handleInput); } } },
                { separator: true },
                { label: t('contextMenu.newline', 'Insert Newline'), action: () => { if (editableRef.current) { insertNewline(ctxMenu.savedRange, editableRef.current); handleInput(); } } },
              ]}
            />
          )}
        </div>

        <ChatInputBoxFooter
          disabled={disabled}
          hasInputContent={hasContent || attachments.length > 0}
          isLoading={isLoading}
          isEnhancing={isEnhancing}
          selectedModel={selectedModel}
          permissionMode={permissionMode}
          currentProvider={currentProvider}
          reasoningEffort={reasoningEffort}
          codexFastMode={codexFastMode}
          onSubmit={handleSubmit}
          onStop={onStop}
          onModeSelect={handleModeSelect}
          onModelSelect={handleModelSelect}
          onProviderSelect={onProviderSelect}
          onReasoningChange={onReasoningChange}
          onCodexFastModeChange={onCodexFastModeChange}
          onEnhancePrompt={handleEnhancePrompt}
          alwaysThinkingEnabled={alwaysThinkingEnabled}
          onToggleThinking={onToggleThinking}
          streamingEnabled={streamingEnabled}
          onStreamingEnabledChange={onStreamingEnabledChange}
          selectedAgent={selectedAgent}
          onAgentSelect={(agent) => onAgentSelect?.(agent)}
          onOpenAgentSettings={onOpenAgentSettings}
          onAddModel={onOpenModelSettings}
          onClearAgent={() => onAgentSelect?.(null)}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
          fileCompletion={fileCompletion}
          commandCompletion={commandCompletion}
          agentCompletion={agentCompletion}
          promptCompletion={promptCompletion}
          dollarCommandCompletion={dollarCommandCompletion}
          tooltip={tooltip}
          promptEnhancer={{
            isOpen: showEnhancerDialog,
            isLoading: isEnhancing,
            originalPrompt,
            enhancedPrompt,
            onUseEnhanced: handleUseEnhancedPrompt,
            onKeepOriginal: handleKeepOriginalPrompt,
            onClose: handleCloseEnhancerDialog,
          }}
          t={t}
        />
      </div>
    );
  }
));

// Display name for React DevTools
ChatInputBox.displayName = 'ChatInputBox';

export default ChatInputBox;
