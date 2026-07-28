import { describe, it, expect, beforeEach } from 'vitest';
import { captureRangeOffsets, restoreRangeOffsets } from './selectionOffsets';

describe('selectionOffsets', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
  });

  function selectRange(startNode: Text, startOff: number, endNode: Text, endOff: number) {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  it('ferries a selection across an innerHTML rebuild', () => {
    container.innerHTML = '<p>Hello world</p>';
    const text = container.querySelector('p')!.firstChild as Text;
    selectRange(text, 0, text, 5); // "Hello"

    const offsets = captureRangeOffsets(container);
    expect(offsets).toEqual({ start: 0, end: 5 });

    // Simulate a streaming append that rebuilds the DOM with the same prefix.
    container.innerHTML = '<p>Hello world and more</p>';
    restoreRangeOffsets(container, offsets!);

    expect(window.getSelection()?.toString()).toBe('Hello');
  });

  it('accumulates length across sibling text nodes', () => {
    container.innerHTML = '<p>foo<b>bar</b>baz</p>';
    const foo = container.querySelector('p')!.firstChild as Text; // "foo"
    const bar = container.querySelector('b')!.firstChild as Text; // "bar"
    selectRange(foo, 1, bar, 2); // "oo" + "ba"
    const offsets = captureRangeOffsets(container);
    expect(offsets).toEqual({ start: 1, end: 5 });
  });

  it('returns null for a collapsed selection', () => {
    container.innerHTML = '<p>Hello</p>';
    const text = container.querySelector('p')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    expect(captureRangeOffsets(container)).toBeNull();
  });

  it('returns null when nothing is selected', () => {
    container.innerHTML = '<p>Hello</p>';
    window.getSelection()?.removeAllRanges();
    expect(captureRangeOffsets(container)).toBeNull();
  });

  it('is a no-op when the rebuilt DOM is shorter than the offsets', () => {
    container.innerHTML = '<p>Hello world</p>';
    const text = container.querySelector('p')!.firstChild as Text;
    selectRange(text, 6, text, 11); // "world"

    const offsets = captureRangeOffsets(container);
    expect(offsets).toEqual({ start: 6, end: 11 });

    // Rebuild loses the selected suffix — restore must not throw and must
    // simply leave the selection empty.
    container.innerHTML = '<p>Hi</p>';
    expect(() => restoreRangeOffsets(container, offsets!)).not.toThrow();
  });
});
