/**
 * messageSync.ts
 *
 * Pure utility functions for message identity preservation, optimistic message
 * handling, and streaming content repair.  These functions have no React state
 * dependencies and receive everything they need via parameters.
 */

import type { MutableRefObject } from 'react';
import type { ClaudeContentOrResultBlock, ClaudeMessage, ClaudeRawMessage } from '../../types';

/** Time window (ms) for matching optimistic messages with backend messages. */
export const OPTIMISTIC_MESSAGE_TIME_WINDOW = 5000;

export const getStreamEndHandlingMode = (
  provider: string,
  isStreaming: boolean,
  currentTurnId: number,
): 'full' | 'minimal' | 'skip' => {
  if (isStreaming || currentTurnId > 0) {
    return 'full';
  }
  if (provider === 'codex') {
    return 'minimal';
  }
  return 'skip';
};

// ---------------------------------------------------------------------------
// Raw-field helpers
// ---------------------------------------------------------------------------

export const getRawUuid = (msg: ClaudeMessage | undefined): string | undefined => {
  const raw = msg?.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const rawObj = raw as Record<string, unknown>;
  return typeof rawObj.uuid === 'string' ? rawObj.uuid : undefined;
};

export const stripUuidFromRaw = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const rawObj = raw as any;
  if (!('uuid' in rawObj)) return raw;
  const { uuid: _uuid, ...rest } = rawObj;
  return rest;
};

// ---------------------------------------------------------------------------
// Identity preservation
// ---------------------------------------------------------------------------

/**
 * Merge identity fields (timestamp, uuid) from prevMsg into nextMsg so that
 * React referential equality checks remain stable across backend re-sends.
 */
export const preserveMessageIdentity = (
  prevMsg: ClaudeMessage | undefined,
  nextMsg: ClaudeMessage,
): ClaudeMessage => {
  if (!prevMsg?.timestamp) return nextMsg;
  if (prevMsg.type !== nextMsg.type) return nextMsg;

  const prevUuid = getRawUuid(prevMsg);
  const nextUuid = getRawUuid(nextMsg);

  const nextWithStableTimestamp =
    nextMsg.timestamp === prevMsg.timestamp
      ? nextMsg
      : { ...nextMsg, timestamp: prevMsg.timestamp };

  if (!prevUuid && nextUuid) {
    return {
      ...nextWithStableTimestamp,
      raw: stripUuidFromRaw(nextWithStableTimestamp.raw) as any,
    };
  }

  return nextWithStableTimestamp;
};

/**
 * If the previous list ended with an optimistic user message that has not yet
 * been matched by a backend message, keep it appended to nextList.
 * Also merges attachment blocks from the optimistic message into the matched
 * backend message so non-image file attachments remain visible.
 */
export const appendOptimisticMessageIfMissing = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
): ClaudeMessage[] => {
  const lastPrev = prevList[prevList.length - 1];
  if (!lastPrev?.isOptimistic) return nextList;

  const optimisticMsg = lastPrev;
  const optimisticText = getUserMessageComparableContent(optimisticMsg);
  const optimisticTime = getMessageTimestampMs(optimisticMsg) ?? Number.NaN;

  const matchFn = (m: ClaudeMessage) => {
    if (m.type !== 'user') return false;
    if (getUserMessageComparableContent(m) !== optimisticText) return false;
    const candidateTime = getMessageTimestampMs(m) ?? Number.NaN;
    if (!Number.isFinite(candidateTime) || !Number.isFinite(optimisticTime)) return false;
    return Math.abs(candidateTime - optimisticTime) < OPTIMISTIC_MESSAGE_TIME_WINDOW;
  };

  let matchedIndex = nextList.findIndex(matchFn);
  if (matchedIndex < 0 && optimisticText) {
    for (let i = nextList.length - 1; i >= 0; i -= 1) {
      const candidate = nextList[i];
      if (candidate?.type !== 'user') continue;
      if (getUserMessageComparableContent(candidate) !== optimisticText) continue;
      const candidateTime = getMessageTimestampMs(candidate) ?? Number.NaN;
      // Allow match when candidate is within time window (even if older than optimistic).
      // This handles cases where Java's timestamp (number format) may differ from
      // frontend's ISO string format due to clock skew or async processing delays.
      // Reject only if candidate is significantly older (> time window) to avoid
      // matching historical duplicate messages.
      if (Number.isFinite(optimisticTime) && Number.isFinite(candidateTime) &&
          optimisticTime - candidateTime > OPTIMISTIC_MESSAGE_TIME_WINDOW) {
        continue;
      }
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex < 0) {
    // No timestamp-window match. Distinguish two cases by CONTENT, not by time:
    //
    // 1. The snapshot already contains a user message with identical text — that
    //    IS the backend copy of this optimistic message, whose timestamp merely
    //    skewed outside the match window. Appending would duplicate it, so drop
    //    the optimistic bubble and let the backend copy stand.
    //
    // 2. The snapshot contains no user message with this text — the just-sent
    //    message simply hasn't been persisted into this snapshot yet (the COMMON
    //    case: snapshots are generated before the send lands, and even more so
    //    now that a turn can be deferred behind an in-flight CLI run or a
    //    background session_updated reload arrives mid-send). Keep the optimistic
    //    bubble so the user's own message never vanishes while it's being
    //    answered. A later snapshot that includes the persisted message matches
    //    above and replaces it.
    //
    // The previous "optimistic is newer than everything in the snapshot" time
    // heuristic could not tell these apart and dropped case 2 as well — that was
    // the "my message disappears but the agent answers it" bug.
    if (optimisticText) {
      const backendCopyExists = nextList.some(
        (m) => m.type === 'user' && getUserMessageComparableContent(m) === optimisticText,
      );
      if (backendCopyExists) {
        return nextList;
      }
    }
    return [...nextList, optimisticMsg];
  }

  // Backend message matched the optimistic message.  Preserve attachment blocks
  // from the optimistic message into the backend message's raw data; otherwise
  // non-image file attachments won't be visible.
  const optimisticRaw = optimisticMsg.raw as any;
  const optimisticContent: unknown[] | undefined = optimisticRaw?.message?.content;
  if (Array.isArray(optimisticContent)) {
    const attachmentBlocks = optimisticContent.filter(
      (b: any) => b && typeof b === 'object' && b.type === 'attachment',
    );
    if (attachmentBlocks.length > 0) {
      const backendMsg = nextList[matchedIndex];
      const backendRaw = (backendMsg.raw ?? {}) as any;
      const backendContent: unknown[] = Array.isArray(backendRaw?.message?.content)
        ? backendRaw.message.content
        : Array.isArray(backendRaw?.content)
          ? backendRaw.content
          : [];
      const mergedContent = [...attachmentBlocks, ...backendContent];
      const mergedRaw = {
        ...backendRaw,
        message: { ...(backendRaw?.message ?? {}), content: mergedContent },
      };
      const result = [...nextList];
      result[matchedIndex] = { ...backendMsg, raw: mergedRaw };
      return result;
    }
  }

  return nextList;
};

/**
 * Extract comparable text content from a user message for deduplication matching.
 * Handles both direct content string and raw.message.content array format.
 */
const getUserMessageComparableContent = (message: ClaudeMessage): string => {
  if (message.type !== 'user') return message.content || '';
  const rawContent = (message.raw as any)?.message?.content ?? (message.raw as any)?.content;
  if (!Array.isArray(rawContent)) {
    return message.content || '';
  }
  const rawText = rawContent
    .filter((block: any) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');
  return rawText || message.content || '';
};

/**
 * Extract comparable text from an assistant message for duplicate detection.
 * Prefers the top-level `content` string; falls back to concatenating the text
 * blocks in `raw` (object or JSON-string form). Trimmed; empty when no text.
 */
const getAssistantComparableContent = (message: ClaudeMessage): string => {
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content.trim();
  }
  let raw: unknown = message.raw;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return '';
    }
  }
  const content = (raw as any)?.message?.content ?? (raw as any)?.content;
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((b: any) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
  return text;
};

/**
 * Extract timestamp from a message, handling both formats:
 * - Java Message.timestamp: number (milliseconds)
 * - SDK message.raw.timestamp: string (ISO format)
 *
 * Returns milliseconds since epoch for consistent comparison.
 */
export const getMessageTimestampMs = (message: ClaudeMessage): number | undefined => {
  // First check the raw.timestamp field (SDK source, ISO string format)
  const rawTimestamp = (message.raw as any)?.timestamp;
  if (rawTimestamp != null) {
    if (typeof rawTimestamp === 'string') {
      const parsed = new Date(rawTimestamp).getTime();
      if (Number.isFinite(parsed)) return parsed;
    } else if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
      // Raw timestamp might already be milliseconds (numeric)
      return rawTimestamp;
    }
  }

  // Fall back to message.timestamp field (may be number from Java or string from frontend)
  const timestamp = message.timestamp;
  if (timestamp != null) {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp;
    } else if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
};

/**
 * Preserve the identity (timestamp / uuid) of the last assistant message
 * across list updates.
 */
export const preserveLastAssistantIdentity = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number,
): ClaudeMessage[] => {
  const prevAssistantIdx = findLastAssistantIndex(prevList);
  const nextAssistantIdx = findLastAssistantIndex(nextList);
  if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

  const prevAssistant = prevList[prevAssistantIdx];
  const nextAssistant = nextList[nextAssistantIdx];
  // Guard: do not merge identity across different streaming turns
  // Block when either side has __turnId and they differ
  if ((prevAssistant.__turnId !== undefined || nextAssistant.__turnId !== undefined) &&
      prevAssistant.__turnId !== nextAssistant.__turnId) {
    return nextList;
  }
  const stabilized = preserveMessageIdentity(prevAssistant, nextAssistant);
  if (stabilized === nextAssistant) return nextList;

  const copy = [...nextList];
  copy[nextAssistantIdx] = stabilized;
  return copy;
};

// ---------------------------------------------------------------------------
// Raw blocks merging during streaming
// ---------------------------------------------------------------------------

const isTextLikeBlock = (block: unknown): block is Record<string, unknown> => {
  if (!block || typeof block !== 'object') return false;
  const t = (block as Record<string, unknown>).type;
  return t === 'text' || t === 'thinking';
};

const getTextLikeLength = (block: Record<string, unknown>): number => {
  if (block.type === 'text') return typeof block.text === 'string' ? block.text.length : 0;
  if (block.type === 'thinking') {
    const t = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
    return t.length;
  }
  return 0;
};

const getTextLikeContent = (block: Record<string, unknown>): string => {
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
  if (block.type === 'thinking') {
    return typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
  }
  return '';
};

/**
 * Merge raw message blocks during active streaming so that the frontend's
 * accumulated segment text/thinking always wins over a stale backend snapshot,
 * while structural blocks (tool_use, tool_result, image, attachment) are
 * always taken from the backend (authoritative source for message structure).
 *
 * Matching is positional: the i-th text/thinking block in prevRaw is compared
 * against the i-th text/thinking block in nextRaw.
 *
 * Returns nextRaw unchanged (same reference) when no block needs protecting.
 */
export const mergeRawBlocksDuringStreaming = (
  prevRaw: unknown,
  nextRaw: unknown,
): unknown => {
  if (!prevRaw || typeof prevRaw !== 'object') return nextRaw;
  if (!nextRaw || typeof nextRaw !== 'object') return nextRaw;

  const prevObj = prevRaw as Record<string, unknown>;
  const nextObj = nextRaw as Record<string, unknown>;

  const prevMsg = prevObj.message as Record<string, unknown> | undefined;
  const nextMsg = nextObj.message as Record<string, unknown> | undefined;

  const prevBlocks: unknown[] = Array.isArray(prevMsg?.content)
    ? (prevMsg.content as unknown[])
    : Array.isArray(prevObj.content)
      ? (prevObj.content as unknown[])
      : [];

  const nextBlocks: unknown[] = Array.isArray(nextMsg?.content)
    ? (nextMsg.content as unknown[])
    : Array.isArray(nextObj.content)
      ? (nextObj.content as unknown[])
      : [];

  if (nextBlocks.length === 0) return nextRaw;

  let prevTextLikeIdx = 0;
  let changed = false;

  const mergedBlocks = nextBlocks.map((nextBlock) => {
    if (!isTextLikeBlock(nextBlock)) return nextBlock;

    // Advance to the next text-like block in prev
    while (prevTextLikeIdx < prevBlocks.length && !isTextLikeBlock(prevBlocks[prevTextLikeIdx])) {
      prevTextLikeIdx += 1;
    }

    const prevBlock = prevBlocks[prevTextLikeIdx] as Record<string, unknown> | undefined;
    prevTextLikeIdx += 1;

    if (!prevBlock) return nextBlock;

    const prevLen = getTextLikeLength(prevBlock);
    const nextLen = getTextLikeLength(nextBlock);
    if (prevLen <= nextLen) return nextBlock; // next is at least as long — keep it

    // prev is longer. Only let prev win when it is a prefix-extension of next
    // (prev starts with next: the same segment, grown further on the frontend).
    // When prev and next are unrelated content they belong to DIFFERENT segments —
    // e.g. a new post-tool_use assistant turn whose last block is shorter than the
    // previous turn's. Taking prev there would overwrite the new turn's text with
    // the old turn's, the "dedup merged into the wrong part" symptom seen when
    // several tabs stream concurrently and EDT coalescing delays the __turnId
    // commit that normally guards this path. Keep next instead. MarkdownBlock
    // renders from these raw blocks, so this guard directly protects the UI.
    const prevContent = getTextLikeContent(prevBlock);
    const nextContent = getTextLikeContent(nextBlock);
    // An empty next is a backend snapshot lagging to an empty block while the
    // frontend already accumulated content - the same segment, just behind - so
    // let prev fill it ("" is a prefix of every string, which the startsWith
    // check below already honours). Only NON-empty, non-prefix next belongs to a
    // different segment and must be kept as-is.
    if (nextContent && !prevContent.startsWith(nextContent)) {
      return nextBlock; // unrelated non-empty content - do not cross-merge segments
    }
    changed = true;
    if (nextBlock.type === 'thinking') {
      return { ...nextBlock, thinking: prevContent, text: prevContent };
    }
    return { ...nextBlock, text: prevContent };
  });

  if (!changed) return nextRaw;

  if (nextMsg !== undefined) {
    return { ...nextObj, message: { ...nextMsg, content: mergedBlocks } };
  }
  return { ...nextObj, content: mergedBlocks };
};

/**
 * When streaming is active, prevent the backend from replacing the streamed
 * content with a shorter (stale) snapshot.
 *
 * Guards both the top-level .content string AND .raw.message.content blocks:
 * - .content: protected when prev/buffered content is longer than backend's
 * - .raw blocks: text/thinking blocks are protected via mergeRawBlocksDuringStreaming
 *   regardless of .content string length, since MarkdownBlock renders from blocks.
 */
export const preserveStreamingAssistantContent = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  isStreamingRef: MutableRefObject<boolean>,
  streamingContentRef: MutableRefObject<string>,
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number,
  patchAssistantForStreaming: (msg: ClaudeMessage) => ClaudeMessage,
): ClaudeMessage[] => {
  if (!isStreamingRef.current) return nextList;

  const prevAssistantIdx = findLastAssistantIndex(prevList);
  const nextAssistantIdx = findLastAssistantIndex(nextList);
  if (prevAssistantIdx < 0 || nextAssistantIdx < 0) return nextList;

  const prevAssistant = prevList[prevAssistantIdx];
  const nextAssistant = nextList[nextAssistantIdx];
  if (prevAssistant.type !== 'assistant' || nextAssistant.type !== 'assistant') {
    return nextList;
  }

  // Guard: do not merge content across different streaming turns
  // Block when either side has __turnId and they differ
  if ((prevAssistant.__turnId !== undefined || nextAssistant.__turnId !== undefined) &&
      prevAssistant.__turnId !== nextAssistant.__turnId) {
    return nextList;
  }

  const previousContent = prevAssistant.content || '';
  const bufferedContent = streamingContentRef.current || '';
  const preferredContent =
    bufferedContent.length > previousContent.length ? bufferedContent : previousContent;
  const nextContent = nextAssistant.content || '';

  // Always protect raw blocks: text/thinking blocks use the longer value from prev,
  // structural blocks (tool_use etc.) always come from backend.
  const mergedRaw = mergeRawBlocksDuringStreaming(prevAssistant.raw, nextAssistant.raw);
  const rawChanged = mergedRaw !== nextAssistant.raw;

  if (!preferredContent || preferredContent.length <= nextContent.length) {
    // Content string doesn't need protection, but raw blocks might still be stale
    if (!rawChanged) return nextList;
    const copy = [...nextList];
    copy[nextAssistantIdx] = { ...nextAssistant, raw: mergedRaw as ClaudeMessage['raw'] };
    return copy;
  }

  const copy = [...nextList];
  // NOTE: patchAssistantForStreaming internally does content = max(delta, backend).
  // Here backend = preferredContent = max(streamingRef, prevContent), so the final
  // result is max(streamingRef, prevContent, nextContent) — content never goes backwards.
  copy[nextAssistantIdx] = patchAssistantForStreaming({
    ...nextAssistant,
    content: preferredContent,
    raw: mergedRaw as ClaudeMessage['raw'],
    isStreaming: true,
  });
  return copy;
};

const getMessageContentArray = (message: ClaudeMessage): ClaudeContentOrResultBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return [];

  const content = Array.isArray(raw.message?.content)
    ? raw.message.content
    : Array.isArray(raw.content)
      ? raw.content
      : [];

  return content.filter((entry): entry is ClaudeContentOrResultBlock => Boolean(entry) && typeof entry === 'object');
};

const getToolEventKey = (block: ClaudeContentOrResultBlock): string | null => {
  if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
    return `tool_use:${block.id}`;
  }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
    return `tool_result:${block.tool_use_id}`;
  }
  return null;
};

const getMessageToolEventKeys = (message: ClaudeMessage): string[] => {
  const keys = new Set<string>();
  for (const block of getMessageContentArray(message)) {
    const key = getToolEventKey(block);
    if (key) {
      keys.add(key);
    }
  }
  return [...keys];
};

const isToolOnlyMessage = (message: ClaudeMessage): boolean => {
  if (typeof message.content === 'string' && message.content.trim()) {
    return false;
  }
  const blocks = getMessageContentArray(message);
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_use' || block.type === 'tool_result');
};

export const stripDuplicateTrailingToolMessages = (
  nextList: ClaudeMessage[],
  provider: string,
): ClaudeMessage[] => {
  if (provider !== 'codex') return nextList;
  if (nextList.length === 0) return nextList;

  // Pre-compute keys per message once, then use a reference-count map so we
  // can walk backwards from the tail in O(n) total instead of rebuilding a
  // Set on every iteration.
  const allKeys = nextList.map((msg) => getMessageToolEventKeys(msg));
  const keyCounts = new Map<string, number>();
  for (const keys of allKeys) {
    for (const key of keys) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }

  let endIndex = nextList.length;
  while (endIndex > 0) {
    const lastMessage = nextList[endIndex - 1];
    if (!isToolOnlyMessage(lastMessage)) break;

    const candidateKeys = allKeys[endIndex - 1];
    if (candidateKeys.length === 0) break;

    // A key is duplicated if it appears more than once across all remaining messages.
    if (!candidateKeys.every((key) => (keyCounts.get(key) ?? 0) > 1)) {
      break;
    }

    // Decrement counts for the removed message's keys.
    for (const key of candidateKeys) {
      const count = keyCounts.get(key) ?? 0;
      if (count <= 1) {
        keyCounts.delete(key);
      } else {
        keyCounts.set(key, count - 1);
      }
    }

    endIndex--;
  }

  return endIndex === nextList.length ? nextList : nextList.slice(0, endIndex);
};

/**
 * When backend snapshots briefly shrink (e.g., Codex compaction or Claude
 * conversation summarization), preserve the newest in-memory turn locally
 * until the backend catches up, instead of wiping it from the UI.
 *
 * KEY FIX: Applies to all providers (not just Codex), and filters out
 * optimistic messages if nextList already contains a matching user message.
 * This prevents duplicate display after compact operation.
 */
export const preserveLatestMessagesOnShrink = (
  prevList: ClaudeMessage[],
  nextList: ClaudeMessage[],
  provider: string,
): ClaudeMessage[] => {
  // Always check for shrink regardless of provider
  if (nextList.length >= prevList.length) return nextList;
  if (prevList.length === 0 || nextList.length === 0) return nextList;

  const preservedTail = prevList.slice(nextList.length);
  if (preservedTail.length === 0) return nextList;

  // Check if the preserved tail contains streaming/recent assistant messages
  const hasStreamingTail = preservedTail.some((msg) => msg.type === 'assistant' && (msg.isStreaming || !!msg.__turnId));
  const hasUserTail = preservedTail.some((msg) => msg.type === 'user');

  // Codex: always preserve shrink tail (handles compaction/summarization)
  // Other providers: only preserve if tail contains streaming/recent messages
  if (provider !== 'codex' && !hasStreamingTail && !hasUserTail) {
    return nextList;
  }

  // FIX: Filter out messages from preservedTail that nextList already contains,
  // to avoid duplicate display when a shorter snapshot (compact / background
  // reload) still carries its own copy of the tail turn.
  const nextListUserTexts = new Set<string>();
  const nextListAssistantTurnIds = new Set<number>();
  const nextListAssistantTexts = new Set<string>();
  // Assistant text is a weak identity — two distinct turns can share short text like "Done." or
  // "ok". Only treat a text match as a duplicate within a recency window at the END of nextList,
  // where a genuinely re-appended tail turn would live; otherwise an older turn with identical
  // text could cause the newest turn to be dropped. Turn ids are exact and collected unbounded.
  const assistantTextWindowStart = Math.max(0, nextList.length - (preservedTail.length + 2));
  for (let i = 0; i < nextList.length; i++) {
    const msg = nextList[i];
    if (msg.type === 'user') {
      const text = getUserMessageComparableContent(msg);
      if (text) nextListUserTexts.add(text);
    } else if (msg.type === 'assistant') {
      if (typeof msg.__turnId === 'number' && msg.__turnId > 0) {
        nextListAssistantTurnIds.add(msg.__turnId);
      }
      if (i >= assistantTextWindowStart) {
        const text = getAssistantComparableContent(msg);
        if (text) nextListAssistantTexts.add(text);
      }
    }
  }

  const filteredTail = preservedTail.filter((msg) => {
    // Don't preserve optimistic user messages if nextList has matching content.
    if (msg.type === 'user') {
      if (msg.isOptimistic) {
        const optimisticText = getUserMessageComparableContent(msg);
        if (optimisticText && nextListUserTexts.has(optimisticText)) {
          return false; // Skip this optimistic to avoid duplicate
        }
      }
      return true;
    }
    // Don't re-append an assistant turn the snapshot already contains. A
    // finalized streaming bubble keeps its __turnId for the merge-guard window,
    // so hasStreamingTail pulls it into the preserved tail even though the same
    // turn is already present in the (shorter) snapshot. Re-appending it renders
    // the answer twice, and the __turnId merge-guard then refuses to collapse the
    // two — so drop it here, matched by turn id or by identical text.
    if (msg.type === 'assistant') {
      if (typeof msg.__turnId === 'number' && msg.__turnId > 0
          && nextListAssistantTurnIds.has(msg.__turnId)) {
        return false;
      }
      const text = getAssistantComparableContent(msg);
      if (text && nextListAssistantTexts.has(text)) {
        return false;
      }
      return true;
    }
    // Preserve all other message types (tool results, notifications, …).
    return true;
  });

  if (filteredTail.length === 0) return nextList;
  return [...nextList, ...filteredTail];
};

// ---------------------------------------------------------------------------
// Streaming assistant preservation
// ---------------------------------------------------------------------------

/**
 * Ensure a streaming assistant message is not lost when updateMessages replaces
 * the entire message list.  Returns the (possibly amended) result list and the
 * index of the streaming assistant inside it.
 *
 * The function has two paths:
 * 1. Primary — refs are valid (normal streaming).
 * 2. Fallback — refs already cleared (race condition). Uses message-level
 *    `isStreaming` + `__turnId` markers to recover.
 */
export const ensureStreamingAssistantInList = (
  prevList: ClaudeMessage[],
  resultList: ClaudeMessage[],
  isStreaming: boolean,
  streamingTurnId: number,
): { list: ClaudeMessage[]; streamingIndex: number } => {
  // Primary path: refs are still valid
  if (isStreaming && streamingTurnId > 0) {
    let streamingAssistant: ClaudeMessage | undefined;
    for (let i = prevList.length - 1; i >= 0; i--) {
      if (prevList[i].__turnId === streamingTurnId && prevList[i].type === 'assistant') {
        streamingAssistant = prevList[i];
        break;
      }
    }

    // Match the current turn's assistant already in the snapshot. Prefer the exact turn-id match;
    // fall back to a text match only near the end of the list (the backend's persisted copy carries
    // no __turnId). Text is a weak identity, so bounding it to the tail avoids pointing the
    // streaming bubble at an older identical-text turn.
    const streamingText = streamingAssistant ? getAssistantComparableContent(streamingAssistant) : '';
    let existingIdx = resultList.findIndex(
      (m) => m.type === 'assistant' && m.__turnId === streamingTurnId,
    );
    if (existingIdx < 0 && streamingText) {
      const windowStart = Math.max(0, resultList.length - 3);
      for (let i = resultList.length - 1; i >= windowStart; i--) {
        const m = resultList[i];
        if (m.type === 'assistant' && getAssistantComparableContent(m) === streamingText) {
          existingIdx = i;
          break;
        }
      }
    }
    if (existingIdx >= 0) {
      return { list: resultList, streamingIndex: existingIdx };
    }

    if (streamingAssistant) {
      const result = [...resultList, streamingAssistant];
      return { list: result, streamingIndex: result.length - 1 };
    }

    return { list: resultList, streamingIndex: -1 };
  }

  // Fallback path: refs already cleared (race condition).
  // Only consider the most recent streaming assistant in prevList.
  for (let i = prevList.length - 1; i >= 0; i--) {
    const msg = prevList[i];
    if (msg.type === 'assistant' && msg.isStreaming && msg.__turnId && msg.__turnId > 0) {
      const msgText = getAssistantComparableContent(msg);
      const textWindowStart = Math.max(0, resultList.length - 3);
      const alreadyPresent = resultList.some((m, idx) => {
        if (m.type !== 'assistant') return false;
        if (m.__turnId === msg.__turnId) return true;
        if (msg.timestamp && m.timestamp === msg.timestamp) return true;
        // Backend copy carries a fresh timestamp and no __turnId — match by text so the finalized
        // bubble is not appended on top of its persisted copy, but only near the tail so an older
        // identical-text turn can't suppress recovery of the current one.
        if (msgText && idx >= textWindowStart && getAssistantComparableContent(m) === msgText) return true;
        return false;
      });
      const assistantAlreadyAtOrAfterPosition =
        i < resultList.length && resultList.slice(i).some((m) => m.type === 'assistant');

      if (!alreadyPresent && !assistantAlreadyAtOrAfterPosition) {
        const result = [...resultList, msg];
        return { list: result, streamingIndex: result.length - 1 };
      }
      // Already in resultList — no recovery needed
      break;
    }
  }

  return { list: resultList, streamingIndex: -1 };
};

// ---------------------------------------------------------------------------
// Re-export ClaudeRawMessage so callers can use it without an extra import
// ---------------------------------------------------------------------------
export type { ClaudeRawMessage };
