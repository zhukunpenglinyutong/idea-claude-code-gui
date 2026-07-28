import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TFunction } from 'i18next';
import { createLocalizeMessage } from '../utils/localizationUtils';
import {
  normalizeBlocks as normalizeBlocksUtil,
  getMessageText as getMessageTextUtil,
  shouldShowMessage as shouldShowMessageUtil,
  getContentBlocks as getContentBlocksUtil,
  mergeConsecutiveAssistantMessages,
  attachCompactBoundaryMetadata,
  isTaskNotificationOnlyMessage,
  hasNonHumanOrigin,
  isCompactRelatedMessage,
  isCompactCommandMessage,
  MESSAGE_TYPES,
} from '../utils/messageUtils';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage } from '../types';

export interface UseMessageProcessingOptions {
  messages: ClaudeMessage[];
  currentSessionId: string | null;
  t: TFunction;
}

/**
 * Message utility functions with memoization and caching.
 * Handles normalizeBlocks, getMessageText, shouldShowMessage, getContentBlocks,
 * and computes mergedMessages.
 */
export function useMessageProcessing({ messages, currentSessionId, t }: UseMessageProcessingOptions) {
  const localizeMessage = useMemo(() => createLocalizeMessage(t), [t]);

  // Cache for normalizeBlocks to avoid re-parsing unchanged messages
  const normalizeBlocksCache = useRef(new WeakMap<object, ClaudeContentBlock[]>());
  const shouldShowMessageCache = useRef(new WeakMap<object, boolean>());
  const mergedAssistantMessageCache = useRef(new Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>());
  // Persistent storage: non-image attachment metadata from sent messages
  const sentAttachmentsRef = useRef(new Map<string, Array<{ fileName: string; mediaType: string }>>());

  // Clear cache when dependencies change
  useEffect(() => {
    normalizeBlocksCache.current = new WeakMap();
    shouldShowMessageCache.current = new WeakMap();
    mergedAssistantMessageCache.current = new Map();
    sentAttachmentsRef.current.clear();
  }, [localizeMessage, t, currentSessionId]);

  const normalizeBlocks = useCallback(
    (raw?: ClaudeRawMessage | string) => {
      if (!raw) return null;
      if (typeof raw === 'object') {
        const cache = normalizeBlocksCache.current;
        if (cache.has(raw)) {
          return cache.get(raw)!;
        }
        const result = normalizeBlocksUtil(raw, localizeMessage, t);
        if (result) {
          cache.set(raw, result);
        }
        return result;
      }
      return normalizeBlocksUtil(raw, localizeMessage, t);
    },
    [localizeMessage, t]
  );

  const getMessageText = useCallback(
    (message: ClaudeMessage) => getMessageTextUtil(message, localizeMessage, t),
    [localizeMessage, t]
  );

  const shouldShowMessage = useCallback(
    (message: ClaudeMessage) => shouldShowMessageUtil(message, getMessageText, normalizeBlocks, t),
    [getMessageText, normalizeBlocks, t]
  );

  const shouldShowMessageCached = useCallback(
    (message: ClaudeMessage) => {
      const cache = shouldShowMessageCache.current;
      if (cache.has(message)) {
        return cache.get(message)!;
      }
      const result = shouldShowMessage(message);
      cache.set(message, result);
      return result;
    },
    [shouldShowMessage]
  );

  const getContentBlocks = useCallback(
    (message: ClaudeMessage) => {
      const blocks = getContentBlocksUtil(message, normalizeBlocks, localizeMessage);
      // Inject attachment blocks from persistent storage
      if (message.type === 'user' && !blocks.some(b => b.type === 'attachment')) {
        const meta = sentAttachmentsRef.current.get(message.content || '');
        if (meta && meta.length > 0) {
          const attachmentBlocks: ClaudeContentBlock[] = meta.map(a => ({
            type: 'attachment' as const,
            fileName: a.fileName,
            mediaType: a.mediaType,
          }));
          return [...attachmentBlocks, ...blocks];
        }
      }
      return blocks;
    },
    [normalizeBlocks, localizeMessage]
  );

  // Merge assistant fragments before visibility filtering so hidden boundary
  // messages still separate distinct turns in the rendered timeline.
  // Also transform non-human origin messages to have 'notification' type
  // instead of 'user' type so they render correctly (left-aligned, no bubble).
  // This includes task_notification, hook, agent, queue, channel, etc.
  const mergedMessages = useMemo(() => {
    // Pair compact_boundary system lines with their compact-summary user line
    // (attaches compactMetadata, drops the metadata-only boundary line).
    const merged = mergeConsecutiveAssistantMessages(
      attachCompactBoundaryMetadata(messages),
      normalizeBlocks,
      mergedAssistantMessageCache.current
    );

    const visible: ClaudeMessage[] = [];

    for (const message of merged) {
      // ── Compact summary → notification ─────────────────────────────────
      // Must happen before shouldShowMessage because isCompactSummary
      // messages are filtered out there. Show as left-aligned collapsible
      // notification block with title, metadata, and expandable summary.
      // /compact command messages pass through to shouldShowMessage where
      // hasCommandMessageTag returns true → rendered as normal user message.
      // stdout messages are hidden by HIDDEN_OUTPUT_TAGS filter.
      if (message.type === MESSAGE_TYPES.USER && isCompactRelatedMessage(message) && !isTaskNotificationOnlyMessage(message)) {
        const raw = message.raw;
        const isCompactSummary = raw && typeof raw === 'object' && 'isCompactSummary' in raw && raw.isCompactSummary;
        if (isCompactSummary) {
          visible.push({ ...message, type: MESSAGE_TYPES.NOTIFICATION });
          continue;
        }
      }

      // ── Standard visibility + type transforms ──────────────────────────
      if (shouldShowMessageCached(message)) {
        if (message.type === MESSAGE_TYPES.USER && isTaskNotificationOnlyMessage(message)) {
          visible.push({ ...message, type: MESSAGE_TYPES.TASK_NOTIFICATION });
        }
        else if (message.type === MESSAGE_TYPES.USER && hasNonHumanOrigin(message)) {
          visible.push({ ...message, type: MESSAGE_TYPES.NOTIFICATION });
        } else {
          visible.push(message);
        }
      }
    }

    // Post-process: ensure /compact command appears before its compact
    // summary notification. In CLI output the isCompactSummary message can
    // precede the /compact command in the JSONL file, so after filtering
    // intermediate messages they may end up adjacent in the wrong order:
    // [notification, /compact user]. Swap them.
    //
    // Assumption: each /compact invocation produces exactly one summary, so
    // we only ever need to swap a single adjacent pair per cluster. After a
    // swap we advance by 2 (via `i += 2`) to avoid re-considering the just-
    // swapped notification as the `curr` of the next iteration, which would
    // otherwise undo the swap if a second compact pair follows immediately.
    for (let i = 0; i < visible.length - 1; i++) {
      const curr = visible[i];
      const next = visible[i + 1];
      const currRaw = curr.raw;
      if (curr.type === MESSAGE_TYPES.NOTIFICATION
        && currRaw && typeof currRaw === 'object' && currRaw.isCompactSummary
        && next.type === MESSAGE_TYPES.USER && isCompactCommandMessage(next)) {
        visible[i] = next;
        visible[i + 1] = curr;
        i++; // Skip the swapped pair to keep ordering stable for chained compacts
      }
    }

    return visible;
    // Note: isTaskNotificationOnlyMessage, hasNonHumanOrigin, isCompactRelatedMessage
    // are stable module-level pure functions imported from messageUtils — their references
    // never change, so they don't need to be in the dependency array.
  }, [messages, shouldShowMessageCached, normalizeBlocks]);

  return {
    normalizeBlocks,
    getMessageText,
    getContentBlocks,
    mergedMessages,
    sentAttachmentsRef,
  };
}
