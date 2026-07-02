import { useRef } from 'react';
import type { ClaudeMessage } from '../types';

/** A single block inside `raw.message.content`. */
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

// Match backend StreamDeltaThrottler interval (33ms) so frontend renders
// each backend flush batch without extra accumulation lag.
export const THROTTLE_INTERVAL = 33;

interface UseStreamingMessagesReturn {
  // Content refs
  streamingContentRef: React.MutableRefObject<string>;
  streamingThinkingRef: React.MutableRefObject<string>;
  isStreamingRef: React.MutableRefObject<boolean>;
  useBackendStreamingRenderRef: React.MutableRefObject<boolean>;
  streamingMessageIndexRef: React.MutableRefObject<number>;

  // Throttle control refs (stores rAF IDs)
  contentUpdateTimeoutRef: React.MutableRefObject<number | null>;
  thinkingUpdateTimeoutRef: React.MutableRefObject<number | null>;
  lastContentUpdateRef: React.MutableRefObject<number>;
  lastThinkingUpdateRef: React.MutableRefObject<number>;

  // Auto-expanded thinking keys
  autoExpandedThinkingKeysRef: React.MutableRefObject<Set<string>>;

  // Turn tracking
  streamingTurnIdRef: React.MutableRefObject<number>;
  turnIdCounterRef: React.MutableRefObject<number>;

  // Helper functions
  findLastAssistantIndex: (list: ClaudeMessage[]) => number;
  extractRawBlocks: (raw: unknown) => ContentBlock[];
  getOrCreateStreamingAssistantIndex: (list: ClaudeMessage[]) => number;
  patchAssistantForStreaming: (assistant: ClaudeMessage) => ClaudeMessage;

  // Reset function
  resetStreamingState: () => void;
}

/**
 * Hook for managing streaming message state and helper functions
 */
export function useStreamingMessages(): UseStreamingMessagesReturn {
  // Content refs
  const streamingContentRef = useRef('');
  const streamingThinkingRef = useRef('');
  const isStreamingRef = useRef(false);
  const useBackendStreamingRenderRef = useRef(false);
  const streamingMessageIndexRef = useRef<number>(-1);

  // Throttle control refs
  const contentUpdateTimeoutRef = useRef<number | null>(null);
  const thinkingUpdateTimeoutRef = useRef<number | null>(null);
  const lastContentUpdateRef = useRef(0);
  const lastThinkingUpdateRef = useRef(0);

  // Auto-expanded thinking keys
  const autoExpandedThinkingKeysRef = useRef<Set<string>>(new Set());

  // Text length at the moment trailing structural blocks (tool_use/tool_result)
  // first appeared. Later text deltas belong after those blocks.
  const trailingStructuralTextBoundaryRef = useRef<{ signature: string; textLength: number } | null>(null);

  // Turn tracking
  const streamingTurnIdRef = useRef(-1);
  const turnIdCounterRef = useRef(0);

  // Helper: Find last assistant message index
  const findLastAssistantIndex = (list: ClaudeMessage[]): number => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.type === 'assistant') return i;
    }
    return -1;
  };

  // Helper: Extract raw blocks from message
  const extractRawBlocks = (raw: unknown): ContentBlock[] => {
    if (!raw || typeof raw !== 'object') return [];
    const rawObj = raw as Record<string, unknown>;
    const msg = rawObj.message as Record<string, unknown> | undefined;
    const blocks = rawObj.content ?? msg?.content;
    return Array.isArray(blocks) ? blocks : [];
  };

  const getStructuralBlockSignature = (block: ContentBlock): string => {
    if (block.type === 'tool_use') {
      return `tool_use:${block.id ?? ''}:${block.name ?? ''}`;
    }
    if (block.type === 'tool_result') {
      return `tool_result:${block.tool_use_id ?? ''}:${block.is_error === true ? '1' : '0'}`;
    }
    return String(block.type ?? '');
  };

  const syncTextBlocksWithContent = (blocks: ContentBlock[], content: string): ContentBlock[] => {
    if (!content) return blocks;

    const textIndices = blocks
      .map((block, index) => (block?.type === 'text' ? index : -1))
      .filter((index) => index >= 0);

    if (textIndices.length === 0) {
      return [...blocks, { type: 'text', text: content }];
    }

    const lastTextIdx = textIndices[textIndices.length - 1];
    const prefixText = textIndices
      .slice(0, -1)
      .map((index) => (typeof blocks[index]?.text === 'string' ? blocks[index].text : ''))
      .join('');
    const allText = textIndices
      .map((index) => (typeof blocks[index]?.text === 'string' ? blocks[index].text : ''))
      .join('');
    const trailingStructuralBlocks = blocks
      .slice(lastTextIdx + 1)
      .filter((block) => block?.type !== 'text' && block?.type !== 'thinking');
    const trailingStructuralSignature = trailingStructuralBlocks
      .map(getStructuralBlockSignature)
      .join('|');

    // When a tool block is already rendered at the end of the raw structure and
    // new text deltas arrive afterward, append a new text block after the tool
    // instead of growing the old pre-tool text block. The first time a trailing
    // structural block appears we intentionally keep all buffered text before it:
    // the backend snapshot can be stale, and the buffered suffix may still belong
    // to the pre-tool prose. Subsequent growth beyond this boundary is post-tool.
    if (trailingStructuralSignature && allText && content.startsWith(allText)) {
      const previousBoundary = trailingStructuralTextBoundaryRef.current;
      const canReuseBoundary =
        previousBoundary &&
        (trailingStructuralSignature === previousBoundary.signature ||
          trailingStructuralSignature.startsWith(`${previousBoundary.signature}|`));

      if (!canReuseBoundary) {
        trailingStructuralTextBoundaryRef.current = {
          signature: trailingStructuralSignature,
          textLength: allText.length,
        };
      }

      const boundary = trailingStructuralTextBoundaryRef.current;
      if (boundary && content.length > boundary.textLength) {
        const textBeforeStructuralBlocks = content.slice(0, boundary.textLength);
        const textAfterStructuralBlocks = content.slice(boundary.textLength);
        const desiredLastPreToolText = textBeforeStructuralBlocks.startsWith(prefixText)
          ? textBeforeStructuralBlocks.slice(prefixText.length)
          : textBeforeStructuralBlocks;
        const nextBlocks = [...blocks];
        nextBlocks[lastTextIdx] = { ...nextBlocks[lastTextIdx], text: desiredLastPreToolText };
        if (trailingStructuralSignature !== boundary.signature) {
          trailingStructuralTextBoundaryRef.current = {
            signature: trailingStructuralSignature,
            textLength: boundary.textLength,
          };
        }
        return [...nextBlocks, { type: 'text', text: textAfterStructuralBlocks }];
      }
    } else if (!trailingStructuralSignature && !trailingStructuralTextBoundaryRef.current) {
      trailingStructuralTextBoundaryRef.current = null;
    }

    // Cannot reconcile the cumulative buffer with the split blocks — e.g. the
    // backend dedup rewrote an earlier block, or a new turn's text has not yet
    // been delivered as its own block.  Leave the structure untouched and let
    // the next backend snapshot author the correct blocks.  Mirror of
    // syncThinkingBlocksWithContent's prefix guard.  (The previous single-block
    // overwrite branch here was unreachable: a single text block makes
    // prefixText '' so content.startsWith('') is always true.)
    if (!content.startsWith(prefixText)) {
      return blocks;
    }

    // Trailing-block guard: only grow the message's final text block, the single
    // active prose segment of the current turn.  When any later block (tool_use,
    // tool_result, thinking) already follows it, the segment is closed — post-tool
    // growth is handled by the trailingStructuralTextBoundaryRef branch above, so
    // reaching here means the cumulative buffer diverged from the snapshot.  Wait
    // for updateMessages instead of overwriting the closed pre-tool block with the
    // new turn's content.  Mirror of syncThinkingBlocksWithContent's trailing-block
    // guard.
    if (lastTextIdx !== blocks.length - 1) {
      return blocks;
    }

    const desiredLastText = content.slice(prefixText.length);
    if (!desiredLastText) {
      return blocks;
    }

    const currentLastText = typeof blocks[lastTextIdx]?.text === 'string' ? blocks[lastTextIdx].text : '';
    if (currentLastText === desiredLastText) {
      return blocks;
    }

    const nextBlocks = [...blocks];
    nextBlocks[lastTextIdx] = { ...nextBlocks[lastTextIdx], text: desiredLastText };
    return nextBlocks;
  };

  const getThinkingText = (block: ContentBlock | undefined): string => {
    if (!block) return '';
    if (typeof block.thinking === 'string') return block.thinking;
    if (typeof block.text === 'string') return block.text;
    return '';
  };

  // Mirror of syncTextBlocksWithContent for thinking blocks.
  // streamingThinkingRef accumulates ALL thinking deltas in the current turn,
  // including segments separated by tool_use blocks (extended thinking can
  // resume after a tool call).  We must therefore strip the prefix carried by
  // earlier thinking blocks before assigning the remainder to the last block,
  // otherwise the last block would receive the concatenation of every segment
  // and duplicate earlier content.
  const syncThinkingBlocksWithContent = (blocks: ContentBlock[], thinking: string): ContentBlock[] => {
    if (!thinking) return blocks;

    const thinkingIndices = blocks
      .map((block, index) => (block?.type === 'thinking' ? index : -1))
      .filter((index) => index >= 0);

    if (thinkingIndices.length === 0) {
      return [{ type: 'thinking', thinking, text: thinking }, ...blocks];
    }

    const lastThinkingIdx = thinkingIndices[thinkingIndices.length - 1];
    const prefixThinking = thinkingIndices
      .slice(0, -1)
      .map((index) => getThinkingText(blocks[index]))
      .join('');

    // Cannot reconcile the cumulative buffer with the split blocks — e.g. the
    // backend dedup rewrote an earlier block, or a new turn's thinking has not
    // yet been delivered as its own block.  Leave the structure untouched and
    // let the next backend snapshot author the correct blocks.  Overwriting a
    // finalized segment here was the source of the cross-turn "last thinking
    // block briefly shows the next turn's content" flicker.
    if (!thinking.startsWith(prefixThinking)) {
      return blocks;
    }

    // Trailing-block guard: only grow the message's final thinking block, which
    // is the single active segment of the current turn.  When any later block
    // (text, tool_use, tool_result) already follows it, the segment is closed —
    // the buffered suffix belongs to a NEW turn whose own thinking block the
    // backend snapshot has not delivered yet.  Overwriting the closed block
    // would leak the new turn's content into the previous turn.  The Java layer
    // keeps one assistant message across the whole turn and appends each turn's
    // thinking as a fresh block, so waiting for updateMessages is always safe.
    if (lastThinkingIdx !== blocks.length - 1) {
      return blocks;
    }

    const desiredLastThinking = thinking.slice(prefixThinking.length);
    if (!desiredLastThinking) {
      return blocks;
    }

    const currentLastThinking = getThinkingText(blocks[lastThinkingIdx]);
    if (currentLastThinking === desiredLastThinking) {
      return blocks;
    }

    const nextBlocks = [...blocks];
    nextBlocks[lastThinkingIdx] = {
      ...nextBlocks[lastThinkingIdx],
      thinking: desiredLastThinking,
      text: desiredLastThinking,
    };
    return nextBlocks;
  };

  /**
   * Get or create streaming assistant message index.
   * NOTE: This function MUTATES the passed list array by pushing a new message
   * if no assistant message exists. Call this only with a copied array (e.g., [...prev]).
   * @param list - Mutable message array (should be a copy, not the original state)
   * @returns The index of the assistant message
   */
  const getOrCreateStreamingAssistantIndex = (list: ClaudeMessage[]): number => {
    const currentIdx = streamingMessageIndexRef.current;
    if (currentIdx >= 0 && currentIdx < list.length && list[currentIdx]?.type === 'assistant') {
      return currentIdx;
    }
    const lastAssistantIdx = findLastAssistantIndex(list);
    if (lastAssistantIdx >= 0) {
      streamingMessageIndexRef.current = lastAssistantIdx;
      return lastAssistantIdx;
    }
    // No assistant: append a placeholder (mutates the list)
    streamingMessageIndexRef.current = list.length;
    list.push({
      type: 'assistant',
      content: '',
      isStreaming: true,
      timestamp: new Date().toISOString(),
      raw: { message: { content: [] } } as ClaudeMessage['raw'],
    });
    return streamingMessageIndexRef.current;
  };

  // Helper: Patch assistant message for streaming.
  // Backend snapshots remain the source of truth for structure, but the currently
  // growing text/thinking blocks must stay aligned with the delta buffers because
  // the UI renders primarily from raw blocks. For the top-level .content string,
  // use the longer of streamingContentRef (delta-accumulated) and assistant.content
  // (backend snapshot). This prevents content from "jumping back" when updateMessages
  // arrives before the delta throttler flushes.
  const patchAssistantForStreaming = (assistant: ClaudeMessage): ClaudeMessage => {
    const deltaContent = streamingContentRef.current || '';
    const backendContent = assistant.content || '';
    const bestContent = deltaContent.length >= backendContent.length ? deltaContent : backendContent;

    const deltaThinking = streamingThinkingRef.current || '';
    let patchedRaw = assistant.raw;

    if (patchedRaw && typeof patchedRaw === 'object') {
      const rawObj = patchedRaw as Record<string, unknown>;
      const msg = rawObj.message as Record<string, unknown> | undefined;
      const rawContent = Array.isArray(rawObj.content)
        ? rawObj.content
        : Array.isArray(msg?.content) ? msg.content : [];

      let blocks = [...rawContent] as ContentBlock[];
      blocks = syncThinkingBlocksWithContent(blocks, deltaThinking);
      blocks = syncTextBlocksWithContent(blocks, bestContent);

      patchedRaw = (msg
        ? { ...rawObj, message: { ...msg, content: blocks } }
        : { ...rawObj, content: blocks }) as ClaudeMessage['raw'];
    } else if (deltaThinking) {
      let blocks: ContentBlock[] = [];
      blocks = syncThinkingBlocksWithContent(blocks, deltaThinking);
      blocks = syncTextBlocksWithContent(blocks, bestContent);
      patchedRaw = { message: { content: blocks } } as ClaudeMessage['raw'];
    }

    return {
      ...assistant,
      content: bestContent,
      raw: patchedRaw,
      isStreaming: true,
    } as ClaudeMessage;
  };

  // Reset all streaming state
  const resetStreamingState = () => {
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    streamingMessageIndexRef.current = -1;
    lastContentUpdateRef.current = 0;
    lastThinkingUpdateRef.current = 0;
    autoExpandedThinkingKeysRef.current.clear();
    trailingStructuralTextBoundaryRef.current = null;
    streamingTurnIdRef.current = -1;

    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }
  };

  return {
    // Content refs
    streamingContentRef,
    streamingThinkingRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    streamingMessageIndexRef,

    // Throttle control refs
    contentUpdateTimeoutRef,
    thinkingUpdateTimeoutRef,
    lastContentUpdateRef,
    lastThinkingUpdateRef,

    // Auto-expanded thinking keys
    autoExpandedThinkingKeysRef,

    // Turn tracking
    streamingTurnIdRef,
    turnIdCounterRef,

    // Helper functions
    findLastAssistantIndex,
    extractRawBlocks,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,

    // Reset function
    resetStreamingState,
  };
}
