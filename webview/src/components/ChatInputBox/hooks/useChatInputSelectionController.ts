import { useCallback } from 'react';
import type { ForwardedRef, MutableRefObject, RefObject } from 'react';
import { cutSelection } from '../../../hooks/useContextMenu.js';
import type { ChatInputBoxHandle, FileTagInfo } from '../types.js';
import { useChatInputImperativeHandle } from './useChatInputImperativeHandle.js';

interface InlineCompletionController {
  applySuggestion: () => string | null;
}

interface ContextMenuSelectionState {
  savedRange: Range | null;
  selectedText: string;
  targetFileTag?: HTMLElement | null;
}

interface UseChatInputSelectionControllerOptions {
  ref: ForwardedRef<ChatInputBoxHandle>;
  editableRef: RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  invalidateCache: () => void;
  isExternalUpdateRef: MutableRefObject<boolean>;
  setHasContent: (hasContent: boolean) => void;
  adjustHeight: () => void;
  clearInput: () => void;
  hasContent: boolean;
  extractFileTags: () => FileTagInfo[];
  inlineCompletion: InlineCompletionController;
  handleInput: () => void;
  ctxMenu: ContextMenuSelectionState;
  onClearContext?: () => void;
  onAutoOpenFileEnabledChange?: (enabled: boolean) => void;
}

export function useChatInputSelectionController({
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
}: UseChatInputSelectionControllerOptions) {
  const focusInput = useCallback(() => {
    // Don't steal focus while the user holds a selection elsewhere (e.g.
    // selecting a queued-message item to copy): moving focus to the editable
    // region collapses the active selection and discards it. isCollapsed is
    // O(1) and covers every selection shape (text, image, element), so prefer
    // it over serializing the selection to a string on every focus call.
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    editableRef.current?.focus();
  }, [editableRef]);

  const applyInlineCompletion = useCallback(() => {
    const fullText = inlineCompletion.applySuggestion();
    if (!fullText || !editableRef.current) return false;

    editableRef.current.innerText = fullText;

    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(editableRef.current);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);

    handleInput();
    return true;
  }, [editableRef, handleInput, inlineCompletion]);

  const handleCtxMenuCut = useCallback(() => {
    if (!editableRef.current) return;
    cutSelection(ctxMenu.savedRange, ctxMenu.selectedText, editableRef.current, ctxMenu.targetFileTag);
    handleInput();
  }, [ctxMenu.savedRange, ctxMenu.selectedText, ctxMenu.targetFileTag, editableRef, handleInput]);

  const handleClearFileContext = useCallback(() => {
    onClearContext?.();
    onAutoOpenFileEnabledChange?.(false);
  }, [onClearContext, onAutoOpenFileEnabledChange]);

  const handleRequestEnableFileContext = useCallback(() => {
    onAutoOpenFileEnabledChange?.(true);
  }, [onAutoOpenFileEnabledChange]);

  useChatInputImperativeHandle({
    ref,
    editableRef,
    getTextContent,
    invalidateCache,
    isExternalUpdateRef,
    setHasContent,
    adjustHeight,
    focusInput,
    clearInput,
    hasContent,
    extractFileTags,
  });

  return {
    focusInput,
    applyInlineCompletion,
    handleCtxMenuCut,
    handleClearFileContext,
    handleRequestEnableFileContext,
  };
}
