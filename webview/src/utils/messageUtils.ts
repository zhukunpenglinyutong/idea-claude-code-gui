import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRawMessage, CompactSummaryMetadata } from '../types';
import { isCompactSummaryMetadata } from '../types';
import {
  containsAnyTag,
  createTaskNotificationBlock,
  extractCommandMessageContent,
  formatCommandForDisplay,
  formatTaskNotificationForDisplay,
  hasCommandMessageTag,
  hasTaskNotificationTag,
  isSyntheticToolMessageContent,
  HIDDEN_OUTPUT_TAGS,
  INTERNAL_METADATA_TAGS,
  MESSAGE_TYPES,
  ORIGIN_KINDS,
  type LocalizeMessageFn,
} from './contentBlockNormalize';
import type { CompactNotificationItem } from '../types';
import { MESSAGE_MERGE_CACHE_LIMIT } from './messageMergeCache';
import { clearStaleStreamEndedMarker, hasRecentlyEndedTurnId } from './streamMarkers';

// ---------------------------------------------------------------------------
// Re-exports — keep messageUtils.ts as the public barrel so existing imports
// (from hooks, components, tests) keep working.
// ---------------------------------------------------------------------------

export {
  MESSAGE_TYPES,
  ORIGIN_KINDS,
  HIDDEN_OUTPUT_TAGS,
  INTERNAL_METADATA_TAGS,
  FILTERED_NORMALIZE_TAGS,
  TASK_STATUS_COLORS,
  containsAnyTag,
  hasCommandMessageTag,
  formatCommandForDisplay,
  formatCommandForResubmit,
  hasTaskNotificationTag,
  formatTaskNotificationForDisplay,
  createTaskNotificationBlock,
  extractCommandMessageContent,
  isSyntheticToolMessageContent,
  normalizeBlocks,
} from './contentBlockNormalize';
export type { LocalizeMessageFn } from './contentBlockNormalize';

/**
 * Generate a stable key for a message, used for React list keys and anchor navigation.
 * Prefer raw.uuid > __turnId > type-timestamp > fallback to type-index.
 */
export function getMessageKey(message: ClaudeMessage, index: number): string {
  const rawObj = typeof message.raw === 'object' ? message.raw as Record<string, unknown> : null;
  if (rawObj?.uuid) return rawObj.uuid as string;
  if (message.__turnId !== undefined) return `turn-${message.__turnId}`;
  return message.timestamp ? `${message.type}-${message.timestamp}` : `${message.type}-${index}`;
}

// ---------------------------------------------------------------------------
// Type guards - safer than type assertions
// ---------------------------------------------------------------------------

/**
 * Type guard: check if raw message has valid origin field
 */
function hasOriginField(raw: unknown): raw is { origin: { kind: string } } {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  const origin = r.origin;
  if (!origin || typeof origin !== 'object') return false;
  const o = origin as Record<string, unknown>;
  return typeof o.kind === 'string';
}

/**
 * Check if a message has non-human origin (should be rendered as system notification, not user message).
 * CLI uses origin.kind to distinguish synthetic messages from human input.
 */
export function hasNonHumanOrigin(message: ClaudeMessage): boolean {
  if (message.type !== MESSAGE_TYPES.USER) return false;

  const raw = message.raw;
  if (!hasOriginField(raw)) return false;

  // If origin.kind exists and is not 'human', this is a synthetic message
  return raw.origin.kind !== ORIGIN_KINDS.HUMAN;
}

/**
 * Extract all text strings from a raw message's content (handles various structures).
 * Shared helper to avoid duplicating traversal logic.
 */
function extractTextsFromRaw(raw: ClaudeRawMessage | string | undefined): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const texts: string[] = [];
  const extractFromContent = (content: unknown) => {
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text);
          }
        }
      }
    }
  };
  const rawObj = raw as Record<string, unknown>;
  extractFromContent(rawObj.content);
  if (rawObj.message && typeof rawObj.message === 'object') {
    extractFromContent((rawObj.message as Record<string, unknown>).content);
  }
  return texts;
}

/**
 * Check if a message is a task_notification only message (should be rendered as system notification, not user message).
 * This is used to change message type from 'user' to 'task_notification' for proper rendering.
 */
export function isTaskNotificationOnlyMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;

  // Check raw content structures for task-notification tag
  const rawTexts = extractTextsFromRaw(message.raw);
  if (rawTexts.some(hasTaskNotificationTag)) return true;

  // Fallback: check message.content (may differ from raw when set independently)
  return typeof message.content === 'string' && hasTaskNotificationTag(message.content);
}

// ---------------------------------------------------------------------------
// Compact notification detection and grouping
// ---------------------------------------------------------------------------

/**
 * Check if a message is a compact command message.
 * Only detects backend/history messages containing <command-name>/compact</command-name>
 * XML tags. Optimistic streaming messages (plain "/compact" text without tags) are
 * NOT detected — they render as normal user messages until the backend responds.
 */
export function isCompactCommandMessage(message: ClaudeMessage): boolean {
  if (message.type !== MESSAGE_TYPES.USER) return false;
  const texts = extractTextsFromRaw(message.raw);
  return texts.some(t => t.includes('<command-name>/compact</command-name>'));
}

/**
 * Check if a message is a compact stdout message (contains <local-command-stdout>).
 */
export function isCompactStdoutMessage(message: ClaudeMessage): boolean {
  if (message.type !== MESSAGE_TYPES.USER) return false;
  const texts = extractTextsFromRaw(message.raw);
  return texts.some(t => t.includes('<local-command-stdout>'));
}

/**
 * Check if a message is compact-related (command, stdout, or summary).
 */
export function isCompactRelatedMessage(message: ClaudeMessage): boolean {
  if (message.type !== MESSAGE_TYPES.USER) return false;
  if (isCompactCommandMessage(message) || isCompactStdoutMessage(message)) return true;
  // Also check isCompactSummary flag on raw
  if (message.raw && typeof message.raw === 'object' && 'isCompactSummary' in message.raw && message.raw.isCompactSummary) {
    return true;
  }
  return false;
}

/**
 * Check if a message is a compact-boundary system line. The CLI writes the real
 * compaction metadata ({ trigger, preTokens, postTokens, durationMs, … }) on a
 * separate `type: 'system', subtype: 'compact_boundary'` JSONL line, NOT on the
 * compact-summary user line itself.
 */
export function isCompactBoundaryMessage(message: ClaudeMessage): boolean {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return false;
  const rawObj = raw as Record<string, unknown>;
  const type = message.type === 'system' || rawObj.type === 'system';
  return type && rawObj.subtype === 'compact_boundary';
}

/**
 * Pair each compact-boundary system line with the compact-summary user line that
 * follows it: attach its `compactMetadata` to the summary message's raw (so the
 * CompactSummaryBlock can render the stats subtitle) and drop the boundary line
 * itself (it is a metadata carrier, not user-visible content).
 * Returns the input array unchanged when no boundary lines are present.
 */
export function attachCompactBoundaryMetadata(messages: ClaudeMessage[]): ClaudeMessage[] {
  if (!messages.some(isCompactBoundaryMessage)) return messages;

  const result: ClaudeMessage[] = [];
  let pendingMetadata: unknown = null;

  for (const message of messages) {
    if (isCompactBoundaryMessage(message)) {
      const rawObj = message.raw as Record<string, unknown>;
      const meta = rawObj.compactMetadata;
      if (meta && typeof meta === 'object') {
        pendingMetadata = meta;
      }
      continue; // boundary line carries no user-visible content
    }

    if (pendingMetadata && message.raw && typeof message.raw === 'object' && message.raw.isCompactSummary) {
      const rawObj = message.raw as Record<string, unknown>;
      result.push(
        rawObj.compactMetadata
          ? message
          : { ...message, raw: { ...(message.raw as ClaudeRawMessage), compactMetadata: pendingMetadata } },
      );
      pendingMetadata = null;
      continue;
    }

    result.push(message);
  }

  return result;
}

const COMPACT_STDOUT_REGEX = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;

/**
 * Extract compact notification items from a group of messages.
 */
export function extractCompactItems(group: ClaudeMessage[]): CompactNotificationItem[] {
  return group.flatMap(msg => {
    const texts = extractTextsFromRaw(msg.raw);
    return texts.flatMap(text => {
      const match = COMPACT_STDOUT_REGEX.exec(text);
      return match?.[1] ? [{ type: 'stdout' as const, text: match[1].trim() }] : [];
    });
  });
}

/**
 * Build a compact_notification message from a group of compact-related messages.
 * Returns null if no command message is found in the group.
 */
export function buildCompactNotification(group: ClaudeMessage[]): ClaudeMessage | null {
  if (group.length === 0) return null;

  // Find the command message as primary
  const commandMsg = group.find(m => isCompactCommandMessage(m));
  if (!commandMsg) return null;

  let headerText = '/compact';
  const commandTexts = extractTextsFromRaw(commandMsg.raw);
  for (const text of commandTexts) {
    const display = formatCommandForDisplay(text);
    if (display) {
      headerText = display;
      break;
    }
  }

  // Collect stdout items from the group
  const items = extractCompactItems(group);

  // Preserve timestamp from first message for ordering
  const timestamp = commandMsg.timestamp || group[0].timestamp;

  return {
    type: MESSAGE_TYPES.COMPACT_NOTIFICATION,
    content: headerText,
    timestamp,
    raw: {
      compactItems: items,
    },
  };
}

/**
 * Get text content from a message
 */
export function getMessageText(
  message: ClaudeMessage,
  localizeMessage: LocalizeMessageFn,
  t: TFunction
): string {
  let text = '';

  if (message.content) {
    text = message.content;
  } else {
    const raw = message.raw;
    if (!raw) {
      return `(${t('chat.emptyMessage')})`;
    }
    if (typeof raw === 'string') {
      text = raw;
    } else if (typeof raw.content === 'string') {
      text = raw.content;
    } else if (Array.isArray(raw.content)) {
      text = raw.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    } else if (raw.message?.content && Array.isArray(raw.message.content)) {
      text = raw.message.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    } else {
      return `(${t('chat.emptyMessage')})`;
    }
  }

  // Apply localization
  let result = localizeMessage(text);

  // Format <command-message> content using formatCommandForDisplay
  // Only apply to user messages - assistant messages may contain these tags in code examples
  if (message.type === 'user' && hasCommandMessageTag(result)) {
    const displayContent = formatCommandForDisplay(result);
    if (displayContent) {
      result = displayContent;
    } else {
      // Fallback to old extraction
      result = extractCommandMessageContent(result);
    }
  }

  // Format <task-notification> for copy/resubmit purposes
  if (hasTaskNotificationTag(result)) {
    const notification = formatTaskNotificationForDisplay(result);
    if (notification) {
      result = `${notification.icon} ${notification.summary}`;
    }
  }

  return result;
}

/**
 * Determine if a message should be shown in the UI
 */
export function shouldShowMessage(
  message: ClaudeMessage,
  getMessageTextFn: (msg: ClaudeMessage) => string,
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  t: TFunction
): boolean {
  // Filter isMeta messages (like "Caveat: The messages below were generated...")
  // CLI: isMeta messages are hidden in normal transcript (except channel messages)
  if (message.raw && typeof message.raw === 'object' && 'isMeta' in message.raw && message.raw.isMeta === true) {
    return false;
  }

  // Note: origin.kind filtering is ONLY for title extraction (extractTitleText, sessionTitle),
  // NOT for hiding messages in the main chat. CLI displays these messages with different formats.
  // See CLI's wrapCommandText() and isVisibleInTranscript() functions.

  // Filter toolUseResult and isCompactSummary messages (CLI filters these in extractTitleText)
  if (message.raw && typeof message.raw === 'object') {
    if ('toolUseResult' in message.raw && message.raw.toolUseResult) {
      return false;
    }
    if ('isCompactSummary' in message.raw && message.raw.isCompactSummary) {
      return false;
    }
  }

  // Filter command messages (containing <command-name> or <local-command-stdout> tags)
  // BUT allow <command-message> tags - they will be processed to show only inner content

  // Get raw text content for tag checking (before extraction)
  const getRawTextContent = (): string => {
    if (message.content) return message.content;
    const raw = message.raw;
    if (!raw) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw.content === 'string') return raw.content;
    if (Array.isArray(raw.content)) {
      return raw.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    }
    if (raw.message?.content) {
      if (typeof raw.message.content === 'string') return raw.message.content;
      if (Array.isArray(raw.message.content)) {
        return raw.message.content
          .filter((block) => block && block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
      }
    }
    return '';
  };

  const rawText = getRawTextContent();

  // CLI renders these messages with specific components:
  // - <command-message> → UserCommandMessage (skill/slash command)
  // - <local-command-stdout/stderr> → UserLocalCommandOutputMessage
  // - <task-notification> → UserAgentNotificationMessage
  // - Plain text (like "Unknown skill: xxx") → UserPromptMessage (displayed with ❯ prefix)
  // So we should NOT filter these messages, just handle their rendering.

  // If message has <command-message>, allow it to be shown
  // (the content will be extracted by formatCommandForDisplay)
  if (rawText && hasCommandMessageTag(rawText)) {
    return true;
  }

  // Messages with <local-command-stdout> or <local-command-stderr> should be shown
  // CLI renders them with UserLocalCommandOutputMessage component
  // But for GUI, we filter these as they are internal terminal output
  // Only filter for user messages - assistant messages may contain these tags in code examples
  if (message.type === 'user' && rawText && containsAnyTag(rawText, HIDDEN_OUTPUT_TAGS)) {
    return false;
  }

  // Filter messages with command tags (internal metadata, not user input)
  // BUT keep "Unknown skill: xxx" messages which are plain text user-visible messages
  // Only filter for user messages - assistant messages may contain these tags in code examples
  if (message.type === 'user' && rawText && containsAnyTag(rawText, INTERNAL_METADATA_TAGS)) {
    return false;
  }

  // Task-notification messages are always shown — normalizeBlocks converts them
  // to task_notification blocks, no need to re-parse here (performance optimization).
  if (rawText && hasTaskNotificationTag(rawText)) {
    return true;
  }

  const text = getMessageTextFn(message);
  if (message.type === 'user' && text === '[tool_result]') {
    return false;
  }
  if (message.type === 'assistant') {
    return true;
  }
  if (message.type === 'user' || message.type === 'error') {
    // Check if there's valid text content
    if (text && text.trim() && text !== `(${t('chat.emptyMessage')})` && text !== `(${t('chat.parseError')})`) {
      return true;
    }
    // Check if there are valid content blocks (like images)
    const rawBlocks = normalizeBlocksFn(message.raw);
    if (Array.isArray(rawBlocks) && rawBlocks.length > 0) {
      // Ensure at least one non-empty content block
      const hasValidBlock = rawBlocks.some(block => {
        if (block.type === 'text') {
          return block.text && block.text.trim().length > 0;
        }
        if (block.type === 'task_notification') {
          return block.summary && block.summary.trim().length > 0;
        }
        // Images, tool_use and other block types should be shown
        return true;
      });
      return hasValidBlock;
    }
    return false;
  }
  return true;
}

/**
 * Get content blocks from a message for rendering
 */
export function getContentBlocks(
  message: ClaudeMessage,
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  localizeMessage: LocalizeMessageFn
): ClaudeContentBlock[] {
  // Compact notification messages carry items in raw.compactItems
  if (message.type === MESSAGE_TYPES.COMPACT_NOTIFICATION) {
    const rawObj = typeof message.raw === 'object' ? (message.raw as Record<string, unknown> | null) : null;
    const items = rawObj?.compactItems as CompactNotificationItem[] | undefined;
    const headerText = message.content || '';
    return [{ type: 'compact_notification', headerText, items: items || [] }];
  }

  // Compact summary notifications — show title + metadata subtitle + full content (expanded)
  if (message.type === MESSAGE_TYPES.NOTIFICATION) {
    const rawObj = typeof message.raw === 'object' ? (message.raw as Record<string, unknown> | null) : null;
    if (rawObj && 'isCompactSummary' in rawObj && rawObj.isCompactSummary) {
      // Use type guard for safe metadata extraction. Real transcripts carry the
      // metadata as `compactMetadata` (attached from the compact_boundary system
      // line by attachCompactBoundaryMetadata); `summarizeMetadata` is a legacy shape.
      const meta: CompactSummaryMetadata | undefined = isCompactSummaryMetadata(rawObj.compactMetadata)
        ? rawObj.compactMetadata
        : isCompactSummaryMetadata(rawObj.summarizeMetadata)
          ? rawObj.summarizeMetadata
          : undefined;
      // Extract full summary text from raw.message.content
      const messageObj = rawObj.message as { content?: string | unknown[] } | undefined;
      let summaryText = '';
      if (messageObj?.content) {
        if (typeof messageObj.content === 'string') {
          summaryText = messageObj.content;
        } else if (Array.isArray(messageObj.content)) {
          // Use flatMap to filter and map in single iteration (Vercel best practice)
          summaryText = messageObj.content
            .flatMap((b: unknown) => {
              if (b && typeof b === 'object' && 'type' in (b as Record<string, unknown>) && (b as Record<string, unknown>).type === 'text') {
                return [((b as Record<string, unknown>).text as string) || ''];
              }
              return [];
            })
            .join('\n');
        }
      }
      // Fallback to message.content
      if (!summaryText && message.content) {
        summaryText = message.content;
      }

      // Pass i18n key as `title`; the renderer resolves it via t().
      // Keeps localization concerns out of this pure data helper.
      const title = meta && typeof meta.messagesSummarized === 'number'
        ? 'chat.compactSummary.summarizedConversation'
        : 'chat.compactSummary.compactSummary';
      return [{ type: 'compact_summary', title, content: summaryText, metadata: meta }];
    }
  }

  const rawBlocks = normalizeBlocksFn(message.raw);
  if (rawBlocks && rawBlocks.length > 0) {
    // Don't add message.content if we have task_notification blocks
    // (those are formatted from the raw XML content).
    // Note: command-message text blocks are already formatted by normalizeBlocks
    // (e.g., "/opsx:ff hello") and no longer contain raw XML tags.
    const hasSpecialBlock = rawBlocks.some((block) => block.type === 'task_notification');
    if (hasSpecialBlock) {
      return rawBlocks;
    }
    // Streaming/tool scenario: if raw doesn't have text but message.content has text, still need to show text
    const hasTextBlock = rawBlocks.some(
      (block) => block.type === 'text' && typeof block.text === 'string' && String(block.text).trim().length > 0,
    );
    if (
      !hasTextBlock &&
      message.content &&
      message.content.trim() &&
      !isSyntheticToolMessageContent(message.content, rawBlocks)
    ) {
      return [...rawBlocks, { type: 'text', text: localizeMessage(message.content) }];
    }
    return rawBlocks;
  }
  // If no raw blocks, check if content needs special handling
  if (message.content && message.content.trim()) {
    // Handle task-notification in message.content directly
    if (hasTaskNotificationTag(message.content)) {
      const block = createTaskNotificationBlock(message.content);
      if (block) return [block];
    }
    // Handle command-message in message.content directly
    if (hasCommandMessageTag(message.content)) {
      const displayContent = formatCommandForDisplay(message.content);
      if (displayContent) {
        return [{ type: 'text' as const, text: localizeMessage(displayContent) }];
      }
    }
    return [{ type: 'text', text: localizeMessage(message.content) }];
  }
  // If no content at all, return empty array instead of showing "(empty message)"
  // shouldShowMessage will filter out these messages
  return [];
}

/**
 * Merge consecutive assistant messages to fix style inconsistencies in history
 * where Thinking and ToolUse are separated.
 */
export function mergeConsecutiveAssistantMessages(
  messages: ClaudeMessage[],
  normalizeBlocksFn: (raw?: ClaudeRawMessage | string) => ClaudeContentBlock[] | null,
  cache?: Map<string, { source: ClaudeMessage[]; merged: ClaudeMessage }>
): ClaudeMessage[] {
  if (messages.length === 0) return [];

  // Clear stale stream-ended markers once at entry (5 second timeout)
  clearStaleStreamEndedMarker();

  const getStableId = (message: ClaudeMessage, index: number): string => {
    const rawObj = typeof message.raw === 'object' ? (message.raw as Record<string, unknown> | null) : null;
    const uuid = rawObj?.uuid;
    if (typeof uuid === 'string' && uuid) return uuid;
    if (message.timestamp) return `${message.type}-${message.timestamp}`;
    return `${message.type}-${index}`;
  };

  const getAssistantBlockSummary = (message: ClaudeMessage): { hasToolUse: boolean; hasText: boolean } => {
    const blocks = normalizeBlocksFn(message.raw) || [];
    return {
      hasToolUse: blocks.some((block) => block.type === 'tool_use'),
      hasText: blocks.some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
        || Boolean(message.content && message.content.trim()),
    };
  };

  const shouldMergeAssistantMessage = (previous: ClaudeMessage, next: ClaudeMessage): boolean => {
    // Distinct streaming turns must stay visually separated even when the
    // backend emits adjacent assistant fragments during synchronization.
    // Block merge when either side has a __turnId and they differ.
    // This prevents streaming messages from merging with history messages.
    // FIX: Also check __lastStreamEndedTurnId to distinguish recently-ended
    // streaming messages from true history messages.
    const prevTurnId = previous.__turnId;
    const nextTurnId = next.__turnId;

    // If either message has the recently-ended turn ID, block merging
    if (hasRecentlyEndedTurnId(prevTurnId) || hasRecentlyEndedTurnId(nextTurnId)) {
      return false;
    }

    // Block merge when either side has a __turnId and they differ
    if ((prevTurnId !== undefined || nextTurnId !== undefined) &&
        prevTurnId !== nextTurnId) {
      return false;
    }

    const previousSummary = getAssistantBlockSummary(previous);
    const nextSummary = getAssistantBlockSummary(next);

    // For messages without __turnId (loaded from history), allow merging across
    // tool_use boundary so that tool-execution and final answer appear as one block.
    // For streaming messages (with __turnId), keep tool_use separated from answer.
    const bothLackTurnId = prevTurnId === undefined && nextTurnId === undefined;
    if (!bothLackTurnId && previousSummary.hasToolUse !== nextSummary.hasToolUse) {
      return false;
    }

    return true;
  };

  const isToolResultOnlyUserMessage = (message: ClaudeMessage): boolean => {
    if (message.type !== 'user') {
      return false;
    }

    if ((message.content ?? '').trim() === '[tool_result]') {
      return true;
    }

    const raw = message.raw;
    if (!raw || typeof raw === 'string') {
      return false;
    }

    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content) || content.length === 0) {
      return false;
    }

    return content.every((block) => block && block.type === 'tool_result');
  };

  const buildMergedAssistantMessage = (group: ClaudeMessage[]): ClaudeMessage => {
    const first = group[0];

    const combinedBlocks: ClaudeContentBlock[] = [];
    const contentParts: string[] = [];

    for (const msg of group) {
      const blocks = normalizeBlocksFn(msg.raw) || [];
      if (blocks.length > 0) {
        combinedBlocks.push(...blocks);
      }
      if (msg.content) {
        const trimmed = msg.content.trim();
        if (trimmed) {
          contentParts.push(msg.content);
        }
      }
    }

    const rawBase: ClaudeRawMessage =
      (typeof first.raw === 'object' && first.raw ? { ...(first.raw as ClaudeRawMessage) } : ({} as ClaudeRawMessage));

    const nextRaw: ClaudeRawMessage = {
      ...rawBase,
      content: combinedBlocks,
      message: rawBase.message ? { ...rawBase.message, content: combinedBlocks } : rawBase.message,
    };

    const mergedContent = contentParts.join('\n');

    return {
      ...first,
      content: mergedContent,
      raw: nextRaw,
      __turnId: first.__turnId,
    };
  };

  const result: ClaudeMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.type !== 'assistant') {
      result.push(msg);
      i += 1;
      continue;
    }

    const assistantGroup: ClaudeMessage[] = [msg];
    let j = i + 1;
    let previousAssistant = msg;

    while (j < messages.length) {
      const candidate = messages[j];

      if (isToolResultOnlyUserMessage(candidate)) {
        j += 1;
        continue;
      }

      if (candidate.type === 'assistant' && shouldMergeAssistantMessage(previousAssistant, candidate)) {
        assistantGroup.push(candidate);
        previousAssistant = candidate;
        j += 1;
        continue;
      }

      break;
    }

    const group = messages.slice(i, j);
    if (assistantGroup.length <= 1) {
      result.push(msg);
      i = j;
      continue;
    }

    const groupKey = `${getStableId(group[0], i)}..${getStableId(group[group.length - 1], j - 1)}#${group.length}`;

    if (cache) {
      const cached = cache.get(groupKey);
      if (
        cached &&
        cached.source.length === group.length &&
        cached.source.every((m, idx) => m === group[idx])
      ) {
        result.push(cached.merged);
        i = j;
        continue;
      }
    }

    const merged = buildMergedAssistantMessage(assistantGroup);
    if (cache) {
      cache.set(groupKey, { source: group, merged });
      if (cache.size > MESSAGE_MERGE_CACHE_LIMIT) {
        cache.clear();
      }
    }
    result.push(merged);
    i = j;
  }

  return result;
}
