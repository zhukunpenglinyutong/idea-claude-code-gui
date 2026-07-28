import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { useFileChangesManagement } from './useFileChangesManagement.js';
import type { ClaudeMessage } from '../types';

function makeMessages(count: number): ClaudeMessage[] {
  return Array.from({ length: count }, () => ({ raw: { role: 'assistant', content: [] } }) as unknown as ClaudeMessage);
}

function makeOptions(messages: ClaudeMessage[], sessionId: string | null) {
  const currentSessionIdRef: RefObject<string | null> = { current: sessionId };
  return {
    currentSessionId: sessionId,
    currentSessionIdRef,
    messages,
    getContentBlocks: () => [],
    findToolResult: () => null,
  };
}

describe('useFileChangesManagement > handleKeepAll', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('sets baseMessageIndex to the current messages length and persists it', () => {
    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions(makeMessages(3), 'session-1'),
    });

    act(() => {
      result.current.handleKeepAll();
    });

    expect(result.current.baseMessageIndex).toBe(3);
    expect(localStorage.getItem('keep-all-base-session-1')).toBe('3');
  });

  // Regression for #1456: a handleKeepAll reference captured before messages grow
  // must still read the LATEST length (ref-based), not the stale captured value.
  it('reads the latest messages length even from a stale callback reference', () => {
    const { result, rerender } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions(makeMessages(3), 'session-1'),
    });

    // Capture the callback while messages.length === 3, then grow messages.
    const staleKeepAll = result.current.handleKeepAll;
    rerender(makeOptions(makeMessages(7), 'session-1'));

    act(() => {
      staleKeepAll();
    });

    expect(result.current.baseMessageIndex).toBe(7);
    expect(localStorage.getItem('keep-all-base-session-1')).toBe('7');
  });
});
