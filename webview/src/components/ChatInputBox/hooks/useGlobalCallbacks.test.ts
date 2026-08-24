import { act, renderHook } from '@testing-library/react';
import { useGlobalCallbacks } from './useGlobalCallbacks.js';
import { useFileTags } from './useFileTags.js';
import { useTextContent } from './useTextContent.js';

function createEditable(): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  document.body.appendChild(el);

  if (typeof (el as HTMLDivElement & { innerText?: string }).innerText === 'undefined') {
    Object.defineProperty(el, 'innerText', {
      get() {
        return readEditableText(this as HTMLDivElement);
      },
      set(value: string) {
        this.textContent = value;
      },
      configurable: true,
    });
  }

  return el;
}

function readEditableText(element: HTMLDivElement): string {
  let text = '';
  element.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node.nodeName === 'BR') {
      text += '\n';
    }
  });
  return text;
}

function placeCaretInsideFirstTextNode(element: HTMLDivElement, offset: number): void {
  const textNode = element.firstChild;
  if (!textNode) {
    throw new Error('editable has no text node');
  }
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaretAtEnd(element: HTMLDivElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderUseGlobalCallbacks(editable: HTMLDivElement) {
  const pathMappingRef = { current: new Map<string, string>() };
  const setHasContent = vi.fn();
  const adjustHeight = vi.fn();
  const renderFileTags = vi.fn();
  const renderQuoteTags = vi.fn();
  const onInput = vi.fn();
  const closeAllCompletions = vi.fn();
  const focusInput = vi.fn(() => editable.focus());
  const getTextContent = () => readEditableText(editable);

  renderHook(() =>
    useGlobalCallbacks({
      editableRef: { current: editable },
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      renderQuoteTags,
      setHasContent,
      onInput,
      closeAllCompletions,
      focusInput,
    })
  );

  return {
    getTextContent,
    pathMappingRef,
    setHasContent,
    adjustHeight,
    renderFileTags,
    renderQuoteTags,
    onInput,
  };
}

function renderFileReferenceHarness(editable: HTMLDivElement) {
  const editableRef = { current: editable };
  const setHasContent = vi.fn();
  const adjustHeight = vi.fn();
  const renderQuoteTags = vi.fn();
  const onInput = vi.fn();
  const closeAllCompletions = vi.fn();
  const focusInput = vi.fn(() => editable.focus());

  return renderHook(() => {
    const { getTextContent } = useTextContent({ editableRef });
    const fileTags = useFileTags({
      editableRef,
      getTextContent,
      onCloseCompletions: closeAllCompletions,
    });

    useGlobalCallbacks({
      editableRef,
      pathMappingRef: fileTags.pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags: fileTags.renderFileTags,
      renderQuoteTags,
      setHasContent,
      onInput,
      closeAllCompletions,
      focusInput,
    });

    return {
      getTextContent,
      extractFileTags: fileTags.extractFileTags,
      renderFileTags: fileTags.renderFileTags,
    };
  });
}

describe('useGlobalCallbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete window.insertCodeSnippetAtCursor;
    delete window.insertFileReferencesAtCursor;
    delete window.handleFilePathFromJava;
    document.body.innerHTML = '';
  });

  it('appends external snippet directly when input is empty', () => {
    const editable = createEditable();
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('console payload');
    vi.runAllTimers();

    expect(getTextContent()).toBe('console payload ');
  });

  it('appends external snippet on a new line when input already has content', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('draft question'));
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('console payload');
    vi.runAllTimers();

    expect(getTextContent()).toBe('draft question\nconsole payload ');
  });

  it('inserts external snippet at caret position when caret is inside editable', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('abc'));
    placeCaretInsideFirstTextNode(editable, 1);
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('XYZ');
    vi.runAllTimers();

    expect(getTextContent()).toBe('aXYZ bc');
  });

  it('falls back to appending at end when caret is not inside editable', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('draft question'));
    // Place caret outside editable to simulate external action (e.g. project tree right-click)
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('@/path/to/file');
    vi.runAllTimers();

    expect(getTextContent()).toBe('draft question\n@/path/to/file ');
  });

  it('does not wipe existing content when a stale non-collapsed selection exists (#1700)', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('existing draft'));
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    // Simulate the real repro: user selected text inside the box earlier, then went
    // back to the IDE editor and triggered "Add selection to CC GUI". The webview's
    // stale select-all range is still non-collapsed and still anchored in editable.
    editable.blur();
    const selectAll = document.createRange();
    selectAll.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selectAll);

    window.insertCodeSnippetAtCursor?.('@src/file.ts#L10-20');
    vi.runAllTimers();

    // The snippet is appended at the end; the pre-existing draft must survive.
    expect(getTextContent()).toBe('existing draft\n@src/file.ts#L10-20 ');
  });

  it('handleFilePathFromJava does not wipe content on stale non-collapsed selection (#1700)', () => {
    const editable = createEditable();
    editable.appendChild(document.createTextNode('existing draft'));
    const { getTextContent } = renderUseGlobalCallbacks(editable);

    editable.blur();
    const selectAll = document.createRange();
    selectAll.selectNodeContents(editable);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(selectAll);

    window.handleFilePathFromJava?.('/abs/path/Helper.ts');
    vi.runAllTimers();

    expect(getTextContent()).toContain('existing draft');
    expect(getTextContent()).toContain('@/abs/path/Helper.ts ');
  });

  it('registers multiple dedicated absolute file references before rendering', () => {
    const editable = createEditable();
    const { getTextContent, pathMappingRef } = renderUseGlobalCallbacks(editable);

    window.insertFileReferencesAtCursor?.([
      'C:\\project\\templates\\view file.xml',
      'C:\\project\\pages\\index.vue',
    ]);
    vi.runAllTimers();

    expect(getTextContent()).toBe(
      '@C:\\project\\templates\\view file.xml @C:\\project\\pages\\index.vue '
    );
    expect(pathMappingRef.current.get('view file.xml')).toBe(
      'C:\\project\\templates\\view file.xml'
    );
    expect(pathMappingRef.current.get('index.vue')).toBe(
      'C:\\project\\pages\\index.vue'
    );
  });

  it('keeps a legacy non-absolute payload as plain text instead of dropping it', () => {
    const editable = createEditable();
    const { getTextContent, pathMappingRef } = renderUseGlobalCallbacks(editable);

    window.handleFilePathFromJava?.('docs/relative/note.md');
    vi.runAllTimers();

    expect(getTextContent()).toBe('docs/relative/note.md ');
    expect(pathMappingRef.current.size).toBe(0);
    expect(editable.querySelectorAll('.file-tag')).toHaveLength(0);
  });

  it('keeps ordinary text separate across repeated external file insertions and reparsing', () => {
    const editable = createEditable();
    const { result } = renderFileReferenceHarness(editable);
    const firstPath = 'C:\\project\\templates\\view.xml';
    const secondPath = 'C:\\project\\pages\\index.vue';

    act(() => {
      window.insertFileReferencesAtCursor?.([firstPath]);
      vi.runAllTimers();
    });

    act(() => {
      editable.appendChild(document.createTextNode('1234'));
      placeCaretAtEnd(editable);
      window.insertFileReferencesAtCursor?.([secondPath]);
      vi.runAllTimers();
    });

    expect(result.current.getTextContent()).toBe(
      `@${firstPath} 1234@${secondPath} `
    );
    expect(result.current.extractFileTags()).toEqual([
      { displayPath: firstPath, absolutePath: firstPath },
      { displayPath: secondPath, absolutePath: secondPath },
    ]);
    expect(editable.querySelectorAll('.file-tag')).toHaveLength(2);

    act(() => {
      editable.appendChild(document.createTextNode('@'));
      placeCaretAtEnd(editable);
      result.current.renderFileTags();
    });

    expect(result.current.getTextContent()).toBe(
      `@${firstPath} 1234@${secondPath} @`
    );
    expect(editable.querySelectorAll('.file-tag')).toHaveLength(2);
    expect(editable.textContent).toContain('1234');
  });

  it('keeps a generic code snippet separate from file-list parsing', () => {
    const editable = createEditable();
    const { pathMappingRef } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.(
      '@C:\\project\\templates\\view file.xml @C:\\project\\pages\\index.vue'
    );
    vi.runAllTimers();

    expect(pathMappingRef.current.size).toBe(0);
  });

  it('registers a strict line-number reference with spaces through the generic bridge', () => {
    const editable = createEditable();
    const { getTextContent, pathMappingRef } = renderUseGlobalCallbacks(editable);

    window.insertCodeSnippetAtCursor?.('@C:\\Program Files\\src\\Main.java#L10-12');
    vi.runAllTimers();

    expect(getTextContent()).toBe('@C:\\Program Files\\src\\Main.java#L10-12 ');
    expect(pathMappingRef.current.get('C:\\Program Files\\src\\Main.java')).toBe(
      'C:\\Program Files\\src\\Main.java'
    );
    expect(pathMappingRef.current.get('C:\\Program Files\\src\\Main.java#L10-12')).toBe(
      'C:\\Program Files\\src\\Main.java'
    );
  });
});
