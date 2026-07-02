import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStreamingMessages } from './useStreamingMessages';
import type { ClaudeMessage } from '../types';
import { getContentBlocks, normalizeBlocks } from '../utils/messageUtils';

const localizeMessage = (text: string) => text;
const t = ((key: string) => key) as any;

const getRenderedBlocks = (message: ClaudeMessage) =>
  getContentBlocks(
    message,
    (raw) => normalizeBlocks(raw, localizeMessage, t),
    localizeMessage,
  );

describe('useStreamingMessages', () => {
  it('sets .content from streamingContentRef and syncs a single raw text block', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Hello world';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: false,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Backend text' }],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('Hello world');
    expect(patched.isStreaming).toBe(true);
    // raw text block should stay aligned with what the UI renders during streaming
    const rawContent = (patched.raw as any).message.content;
    expect(rawContent).toHaveLength(1);
    expect(rawContent[0]).toMatchObject({ type: 'text', text: 'Hello world' });
  });

  it('preserves tool_use blocks in raw unchanged', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Running command.';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'Running command.',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'text', text: 'Running command.' },
            { type: 'tool_use', id: 'bash-1', name: 'run_command', input: { command: 'ls' } },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('Running command.');
    const rawContent = (patched.raw as any).message.content;
    expect(rawContent).toHaveLength(2);
    expect(rawContent[1]).toMatchObject({ type: 'tool_use', id: 'bash-1' });
  });

  it('preserves thinking blocks in raw unchanged', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Done.';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'Done.',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think about this.' },
            { type: 'text', text: 'Done.' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    const rawContent = (patched.raw as any).message.content;
    expect(rawContent).toHaveLength(2);
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think about this.' });
  });

  it('uses backend content when it is longer than delta content (never goes backwards)', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Delta throttler hasn't flushed yet — streamingContentRef is behind
    result.current.streamingContentRef.current = 'ABC';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'ABCDE',  // backend snapshot is ahead
      isStreaming: true,
      raw: { message: { content: [{ type: 'text', text: 'ABCDE' }] } },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    // Should keep the longer backend content, not jump back to 'ABC'
    expect(patched.content).toBe('ABCDE');
    expect(patched.isStreaming).toBe(true);
  });

  it('uses delta content when it is longer than backend content', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'ABCDEF';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'ABC',
      isStreaming: true,
      raw: { message: { content: [{ type: 'text', text: 'ABC' }] } },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('ABCDEF');
  });

  it('handles missing raw gracefully', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Response';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
    };

    const patched = result.current.patchAssistantForStreaming(assistant);

    expect(patched.content).toBe('Response');
    expect(patched.isStreaming).toBe(true);
    expect(patched.raw).toBeUndefined();
  });

  it('extractRawBlocks correctly extracts blocks from raw', () => {
    const { result } = renderHook(() => useStreamingMessages());

    const blocks = result.current.extractRawBlocks({
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'thinking', thinking: 'Thinking...' },
        ],
      },
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'Hello' });
    expect(blocks[1]).toMatchObject({ type: 'thinking', thinking: 'Thinking...' });
  });

  it('extractRawBlocks returns empty array for null/undefined raw', () => {
    const { result } = renderHook(() => useStreamingMessages());

    expect(result.current.extractRawBlocks(null)).toEqual([]);
    expect(result.current.extractRawBlocks(undefined)).toEqual([]);
    expect(result.current.extractRawBlocks({})).toEqual([]);
  });

  it('keeps rendered text blocks in sync with streaming content when backend raw text is stale', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'ABCDE';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'ABC',
      isStreaming: true,
      raw: {
        message: {
          content: [{ type: 'text', text: 'ABC' }],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const renderedBlocks = getRenderedBlocks(patched);

    expect(renderedBlocks).toHaveLength(1);
    expect(renderedBlocks[0]).toMatchObject({ type: 'text', text: 'ABCDE' });
  });

  it('creates a visible thinking block before the first backend snapshot arrives', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingThinkingRef.current = 'Thinking before snapshot';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const renderedBlocks = getRenderedBlocks(patched);

    expect(renderedBlocks).toHaveLength(1);
    expect(renderedBlocks[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Thinking before snapshot',
      text: 'Thinking before snapshot',
    });
  });

  it('does not duplicate earlier thinking content when a second thinking block follows a tool_use', () => {
    // Extended thinking turn:
    //   thinking_seg1 → tool_use → thinking_seg2
    // streamingThinkingRef accumulates the whole turn ("Let me think...Now I need...").
    // Backend raw blocks already split it into [thinking_1, tool_use, thinking_2].
    // The sync function must only assign the suffix ("Now I need...") to the
    // second block, not the cumulative buffer.
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingThinkingRef.current = 'Let me think...Now I need...';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me think...', text: 'Let me think...' },
            { type: 'tool_use', id: 'search-1', name: 'search', input: { q: 'foo' } },
            { type: 'thinking', thinking: 'Now I need...', text: 'Now I need...' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent).toHaveLength(3);
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Let me think...' });
    expect(rawContent[1]).toMatchObject({ type: 'tool_use', id: 'search-1' });
    // The critical assertion: second thinking block must NOT contain "Let me think..."
    expect(rawContent[2]).toMatchObject({ type: 'thinking', thinking: 'Now I need...' });
  });

  it('appends streamed text after trailing tool_use blocks instead of moving the tool card to the bottom', () => {
    const { result } = renderHook(() => useStreamingMessages());

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'Before tool.',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'text', text: 'Before tool.' },
            { type: 'tool_use', id: 'bash-1', name: 'shell_command', input: { command: 'git status' } },
          ],
        },
      },
    };

    result.current.streamingContentRef.current = 'Before tool.';
    const toolAppeared = result.current.patchAssistantForStreaming(assistant);
    expect(((toolAppeared.raw as any).message.content as ContentBlockTest[]).map((block) => block.type))
      .toEqual(['text', 'tool_use']);

    result.current.streamingContentRef.current = 'Before tool.After tool.';
    const patched = result.current.patchAssistantForStreaming(toolAppeared);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent.map((block) => block.type)).toEqual(['text', 'tool_use', 'text']);
    expect(rawContent[0]).toMatchObject({ type: 'text', text: 'Before tool.' });
    expect(rawContent[1]).toMatchObject({ type: 'tool_use', id: 'bash-1' });
    expect(rawContent[2]).toMatchObject({ type: 'text', text: 'After tool.' });

    result.current.streamingContentRef.current = 'Before tool.After tool.More output.';
    const patchedAgain = result.current.patchAssistantForStreaming(patched);
    const updatedRawContent = (patchedAgain.raw as any).message.content as ContentBlockTest[];

    expect(updatedRawContent.map((block) => block.type)).toEqual(['text', 'tool_use', 'text']);
    expect(updatedRawContent[2]).toMatchObject({ type: 'text', text: 'After tool.More output.' });

    const staleBackendSnapshot: ClaudeMessage = {
      ...patchedAgain,
      content: 'Before tool.',
      raw: assistant.raw,
    };

    const recoveredFromStaleSnapshot = result.current.patchAssistantForStreaming(staleBackendSnapshot);
    const recoveredRawContent = (recoveredFromStaleSnapshot.raw as any).message.content as ContentBlockTest[];

    expect(recoveredRawContent.map((block) => block.type)).toEqual(['text', 'tool_use', 'text']);
    expect(recoveredRawContent[2]).toMatchObject({ type: 'text', text: 'After tool.More output.' });
  });

  it('splits already-buffered text when the first tool snapshot arrives late', () => {
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Before tool.After tool.';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'Before tool.',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'text', text: 'Before tool.' },
            { type: 'tool_use', id: 'bash-late', name: 'shell_command', input: { command: 'git status' } },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent.map((block) => block.type)).toEqual(['text', 'tool_use', 'text']);
    expect(rawContent[0]).toMatchObject({ type: 'text', text: 'Before tool.' });
    expect(rawContent[1]).toMatchObject({ type: 'tool_use', id: 'bash-late' });
    expect(rawContent[2]).toMatchObject({ type: 'text', text: 'After tool.' });
  });

  it('extends the last thinking block as new deltas arrive (single segment)', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // Backend snapshot is one frame behind the delta channel
    result.current.streamingThinkingRef.current = 'Thinking longer now';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [{ type: 'thinking', thinking: 'Thinking', text: 'Thinking' }],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent).toHaveLength(1);
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Thinking longer now' });
  });

  it('keeps backend raw structure intact when the cumulative thinking buffer cannot be reconciled', () => {
    const { result } = renderHook(() => useStreamingMessages());

    // streamingThinkingRef does not start with the earlier block's text — could
    // happen if the backend rewrote earlier blocks via dedup.  Sync function
    // should leave structure untouched rather than overwriting incorrectly.
    result.current.streamingThinkingRef.current = 'Completely different content';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Original first', text: 'Original first' },
            { type: 'tool_use', id: 't1', name: 'noop', input: {} },
            { type: 'thinking', thinking: 'Original second', text: 'Original second' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent[0]).toMatchObject({ thinking: 'Original first' });
    expect(rawContent[2]).toMatchObject({ thinking: 'Original second' });
  });

  it('does not overwrite a finalized thinking block when the new turn block has not arrived yet', () => {
    // Problem 2 (regression): Turn 1 ended with a tool_use so its thinking
    // block is finalized. Turn 2's thinking delta arrives BEFORE the backend
    // snapshot appended Turn 2's own block. streamingThinkingRef now carries
    // both turns (onBlockReset no longer clears it). The sync function must
    // leave Turn 1's block untouched and wait for updateMessages — NOT leak
    // Turn 2's content into Turn 1's block.
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingThinkingRef.current = 'Turn1ThinkingTurn2Thinking';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Turn1Thinking', text: 'Turn1Thinking' },
            { type: 'text', text: 'Turn1Content' },
            { type: 'tool_use', id: 'bash-1', name: 'run', input: {} },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    // Turn 1's thinking block preserved (NOT overwritten with the cumulative buffer).
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Turn1Thinking' });
    // Structure unchanged — no premature Turn 2 block fabricated from the buffer.
    expect(rawContent.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('streams the new turn thinking into its own trailing block once the backend delivers it', () => {
    // Problem 1 (regression): same cumulative buffer, but the backend snapshot
    // HAS appended Turn 2's thinking block at the tail. Prefix reconciliation
    // must assign only the Turn 2 suffix to that trailing block, restoring
    // live streaming instead of dropping every Turn 2 delta.
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingThinkingRef.current = 'Turn1ThinkingTurn2Thinking';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Turn1Thinking', text: 'Turn1Thinking' },
            { type: 'tool_use', id: 'bash-1', name: 'run', input: {} },
            { type: 'thinking', thinking: '', text: '' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent).toHaveLength(3);
    expect(rawContent[0]).toMatchObject({ type: 'thinking', thinking: 'Turn1Thinking' });
    expect(rawContent[1]).toMatchObject({ type: 'tool_use', id: 'bash-1' });
    // Turn 2's block receives exactly its suffix — streaming resumed.
    expect(rawContent[2]).toMatchObject({ type: 'thinking', thinking: 'Turn2Thinking' });
  });

  it('cross-turn thinking: waits patiently, then streams as the turn 2 block grows', () => {
    // End-to-end pacing for both regressions together.
    const { result } = renderHook(() => useStreamingMessages());

    // Turn 2's first delta arrives before its block exists in the snapshot.
    result.current.streamingThinkingRef.current = 'Turn1ThinkingTurn2a';
    const beforeTurn2Block: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Turn1Thinking', text: 'Turn1Thinking' },
            { type: 'tool_use', id: 'bash-1', name: 'run', input: {} },
          ],
        },
      },
    };
    const patchedBefore = result.current.patchAssistantForStreaming(beforeTurn2Block);
    expect((patchedBefore.raw as any).message.content[0]).toMatchObject({ thinking: 'Turn1Thinking' });
    expect((patchedBefore.raw as any).message.content.map((b: ContentBlockTest) => b.type))
      .toEqual(['thinking', 'tool_use']);

    // A second Turn 2 delta arrives; ref keeps accumulating across the turn.
    result.current.streamingThinkingRef.current = 'Turn1ThinkingTurn2ab';
    const withTurn2Block: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'Turn1Thinking', text: 'Turn1Thinking' },
            { type: 'tool_use', id: 'bash-1', name: 'run', input: {} },
            { type: 'thinking', thinking: 'Turn2a', text: 'Turn2a' },
          ],
        },
      },
    };
    const patchedAfter = result.current.patchAssistantForStreaming(withTurn2Block);
    const rawAfter = (patchedAfter.raw as any).message.content as ContentBlockTest[];
    expect(rawAfter).toHaveLength(3);
    expect(rawAfter[0]).toMatchObject({ thinking: 'Turn1Thinking' });
    // Turn 2 block now streams the latest suffix live.
    expect(rawAfter[2]).toMatchObject({ thinking: 'Turn2ab' });
  });

  it('does not overwrite a closed pre-tool text block when the content buffer diverges', () => {
    // Content-path mirror of the thinking trailing-block guard. The pre-tool
    // text block is finalized (a tool_use follows it). The cumulative content
    // buffer has diverged from that block (no prefix relationship — e.g. a
    // snapshot-mode provider dedup-rewrote the closed block). The sync function
    // must leave the closed block untouched and wait for updateMessages, NOT
    // overwrite it with the new turn's post-tool content. Before the guard, the
    // single-block happy path overwrote block[0] with the whole buffer.
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Completely different post-tool content';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: 'XYZ',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'text', text: 'XYZ' },
            { type: 'tool_use', id: 't1', name: 'run', input: {} },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    // Closed pre-tool block preserved (NOT overwritten with the diverged buffer).
    expect(rawContent[0]).toMatchObject({ type: 'text', text: 'XYZ' });
    // Structure unchanged — no leak into the previous segment.
    expect(rawContent.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('keeps backend raw structure intact when the cumulative content buffer cannot be reconciled (multi-block)', () => {
    // Content-path mirror of the thinking "cannot be reconciled" regression.
    // prefixText is 'A' (the earlier text block); the buffer 'disjoint' does not
    // start with it, so the structure must be returned untouched.
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'disjoint';

    const assistant: ClaudeMessage = {
      type: 'assistant',
      content: '',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'text', text: 'A' },
            { type: 'tool_use', id: 't1', name: 'run', input: {} },
            { type: 'text', text: 'B' },
          ],
        },
      },
    };

    const patched = result.current.patchAssistantForStreaming(assistant);
    const rawContent = (patched.raw as any).message.content as ContentBlockTest[];

    expect(rawContent.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);
    expect(rawContent[0]).toMatchObject({ type: 'text', text: 'A' });
    expect(rawContent[2]).toMatchObject({ type: 'text', text: 'B' });
  });

  it('streams post-tool text into its own trailing block, never the pre-tool block (cross-turn)', () => {
    // Happy-path cross-turn regression anchor: the boundary mechanism routes the
    // new turn's text into a freshly fabricated trailing block instead of growing
    // (or overwriting) the closed pre-tool block. Passes before AND after the
    // guard change — locks the correct streaming behavior in place.
    const { result } = renderHook(() => useStreamingMessages());

    result.current.streamingContentRef.current = 'Turn1Content';
    const beforeTurn2: ClaudeMessage = {
      type: 'assistant',
      content: 'Turn1Content',
      isStreaming: true,
      raw: {
        message: {
          content: [
            { type: 'text', text: 'Turn1Content' },
            { type: 'tool_use', id: 'b1', name: 'run', input: {} },
          ],
        },
      },
    };
    const patchedBefore = result.current.patchAssistantForStreaming(beforeTurn2);
    expect((patchedBefore.raw as any).message.content.map((b: ContentBlockTest) => b.type))
      .toEqual(['text', 'tool_use']);

    result.current.streamingContentRef.current = 'Turn1ContentTurn2Content';
    const patchedAfter = result.current.patchAssistantForStreaming(patchedBefore);
    const rawAfter = (patchedAfter.raw as any).message.content as ContentBlockTest[];

    expect(rawAfter.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);
    expect(rawAfter[0]).toMatchObject({ type: 'text', text: 'Turn1Content' });
    expect(rawAfter[2]).toMatchObject({ type: 'text', text: 'Turn2Content' });
  });
});

interface ContentBlockTest {
  type: string;
  thinking?: string;
  text?: string;
  id?: string;
}
