import { renderHook, act } from '@testing-library/react';
import type { ChatInputBoxHandle } from '../types.js';
import { useChatInputSelectionController } from './useChatInputSelectionController.js';

function createEditable() {
  const el = document.createElement('div');
  document.body.appendChild(el);

  if (typeof (el as unknown as { innerText?: unknown }).innerText === 'undefined') {
    Object.defineProperty(el, 'innerText', {
      get() {
        return this.textContent ?? '';
      },
      set(value: string) {
        this.textContent = value;
      },
      configurable: true,
    });
  }

  return el as HTMLDivElement;
}

describe('useChatInputSelectionController', () => {
  it('applies inline completion and proxies context callbacks', () => {
    const editable = createEditable();
    const refObj: { current: ChatInputBoxHandle | null } = { current: null };
    const handleInput = vi.fn();
    const onClearContext = vi.fn();
    const onAutoOpenFileEnabledChange = vi.fn();
    const focusSpy = vi.spyOn(editable, 'focus');

    const selection = {
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
      // A real Selection exposes these; focusInput checks isCollapsed to
      // decide whether the user is holding a selection. Mock an empty
      // (collapsed) selection so focus is allowed.
      toString: () => '',
      isCollapsed: true,
      rangeCount: 0,
    };
    vi.spyOn(window, 'getSelection').mockReturnValue(selection as unknown as Selection);

    const { result } = renderHook(() =>
      useChatInputSelectionController({
        ref: refObj,
        editableRef: { current: editable },
        getTextContent: () => editable.innerText,
        invalidateCache: vi.fn(),
        isExternalUpdateRef: { current: false },
        setHasContent: vi.fn(),
        adjustHeight: vi.fn(),
        clearInput: vi.fn(),
        hasContent: false,
        extractFileTags: () => [],
        inlineCompletion: {
          applySuggestion: () => 'full suggestion',
        },
        handleInput,
        ctxMenu: {
          savedRange: null,
          selectedText: '',
          targetFileTag: null,
        },
        onClearContext,
        onAutoOpenFileEnabledChange,
      })
    );

    expect(result.current.applyInlineCompletion()).toBe(true);
    expect(editable.innerText).toBe('full suggestion');
    expect(handleInput).toHaveBeenCalled();

    act(() => {
      result.current.handleClearFileContext();
      result.current.handleRequestEnableFileContext();
      result.current.focusInput();
    });

    expect(onClearContext).toHaveBeenCalled();
    expect(onAutoOpenFileEnabledChange).toHaveBeenNthCalledWith(1, false);
    expect(onAutoOpenFileEnabledChange).toHaveBeenNthCalledWith(2, true);
    expect(focusSpy).toHaveBeenCalled();
    expect(refObj.current).not.toBeNull();
  });
});
