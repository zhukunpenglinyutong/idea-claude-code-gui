/**
 * Character-span of a text selection inside a container, used to ferry a
 * selection across an `innerHTML` rebuild.
 */
export interface TextSelectionOffsets {
  start: number;
  end: number;
}

/**
 * Read the active selection as character offsets over `container`'s
 * concatenated text nodes. Returns null when there is no non-collapsed
 * selection, or when the selection is rooted outside `container`.
 *
 * Capture must happen *before* the container's innerHTML is rewritten: once
 * the old text nodes are gone the selection is gone with them, so the offsets
 * are the only thing that can survive the rebuild.
 */
export function captureRangeOffsets(container: HTMLElement): TextSelectionOffsets | null {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let covered = 0;
  let startOffset = -1;
  let endOffset = -1;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (startOffset === -1 && node === range.startContainer) {
      startOffset = covered + range.startOffset;
    }
    if (endOffset === -1 && node === range.endContainer) {
      endOffset = covered + range.endOffset;
    }
    // Both anchors resolved - no need to walk the rest of the container.
    if (startOffset !== -1 && endOffset !== -1) break;
    covered += len;
    node = walker.nextNode() as Text | null;
  }
  if (startOffset === -1 || endOffset === -1) return null;
  return { start: startOffset, end: endOffset };
}

/**
 * Re-anchor a selection inside `container` from offsets previously captured by
 * {@link captureRangeOffsets}. Best-effort: if the rebuilt DOM has no text at
 * those offsets (the structure shifted under the selection), the call is a
 * no-op rather than throwing.
 */
export function restoreRangeOffsets(
  container: HTMLElement,
  offsets: TextSelectionOffsets,
): void {
  if (typeof window === 'undefined') return;
  const { start, end } = offsets;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let covered = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (!startNode && covered + len >= start) {
      startNode = node;
      startOff = start - covered;
    }
    if (!endNode && covered + len >= end) {
      endNode = node;
      endOff = end - covered;
    }
    if (startNode && endNode) break;
    covered += len;
    node = walker.nextNode() as Text | null;
  }
  if (!startNode || !endNode) return;

  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  selection.removeAllRanges();
  selection.addRange(range);
}
