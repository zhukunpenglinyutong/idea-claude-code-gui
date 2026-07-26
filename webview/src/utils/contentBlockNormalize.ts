import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ClaudeRawMessage } from '../types';

// ---------------------------------------------------------------------------
// Constants - avoid magic strings throughout the codebase
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = {
  USER: 'user',
  ASSISTANT: 'assistant',
  TASK_NOTIFICATION: 'task_notification',
  NOTIFICATION: 'notification',
  COMPACT_NOTIFICATION: 'compact_notification',
  ERROR: 'error',
} as const;

export const ORIGIN_KINDS = {
  HUMAN: 'human',
  TASK_NOTIFICATION: 'task-notification',
  HOOK: 'hook',
  AGENT: 'agent',
  QUEUE: 'queue',
  CHANNEL: 'channel',
} as const;

// ---------------------------------------------------------------------------
// Command tag extraction (supports multiline content).
// NOTE: The CLI does NOT emit these tags in one fixed order — the dominant
// real-world layout is command-name → command-message → command-args, but
// message-first also occurs. Each tag is therefore extracted with its own
// independent regex so intervening tags can never break the match.
// ---------------------------------------------------------------------------

const COMMAND_MESSAGE_REGEX = /<command-message>([\s\S]*?)<\/command-message>/;
const COMMAND_NAME_REGEX = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_REGEX = /<command-args>([\s\S]*?)<\/command-args>/;
const SKILL_FORMAT_REGEX = /<skill-format>([\s\S]*?)<\/skill-format>/;

// Regex to extract task-notification tags (supports multiline content)
// Actual SDK format: <task-notification><task-id>...<status>...<summary>...<result>...<usage>...</task-notification>
// We only need status and summary, so match them regardless of position
// Two regexes: one for full format (with status), one for minimal format (only summary)
const TASK_NOTIFICATION_REGEX_WITH_STATUS = /<task-notification>[\s\S]*?<status>([\s\S]*?)<\/status>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/task-notification>/;
const TASK_NOTIFICATION_REGEX_NO_STATUS = /<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/task-notification>/;
// Monitor events carry the observed payload (log line, error, …) in <event>
const TASK_NOTIFICATION_EVENT_REGEX = /<event>([\s\S]*?)<\/event>/;

// ---------------------------------------------------------------------------
// Internal XML tags that should be hidden (not rendered as user messages)
// ---------------------------------------------------------------------------

/** Tags that represent hidden terminal output */
export const HIDDEN_OUTPUT_TAGS = ['<local-command-stdout>', '<local-command-stderr>'] as const;

/** Tags that represent internal command metadata (no <command-message>) */
export const INTERNAL_METADATA_TAGS = ['<command-name>', '<command-args>', '<skill-format>', '<local-command-caveat>'] as const;

/** All tags that should be filtered out in normalizeBlocks text entries.
 *  Composed from INTERNAL_METADATA_TAGS + HIDDEN_OUTPUT_TAGS to stay in sync. */
export const FILTERED_NORMALIZE_TAGS = [...INTERNAL_METADATA_TAGS, ...HIDDEN_OUTPUT_TAGS] as const;

/** Check if text contains any tag from the given array */
export function containsAnyTag(text: string, tags: readonly string[]): boolean {
  return tags.some(tag => text.includes(tag));
}

/**
 * Check if text contains a <command-message> tag
 */
export function hasCommandMessageTag(text: string): boolean {
  if (!text) return false;
  return text.includes('<command-message>') && text.includes('</command-message>');
}

/**
 * Format command message for display, matching CLI's UserCommandMessage behavior.
 * - If <skill-format>true</skill-format>: return "Skill(name)"
 * - Otherwise: return "/name args" (prepend / to command-message)
 *
 * @param text - Raw text containing XML tags
 * @returns Formatted display string, or null if no command-message tag
 */
export function formatCommandForDisplay(text: string): string | null {
  if (!text) return null;

  // Independent per-tag extraction — tolerant to any tag order
  const messageMatch = COMMAND_MESSAGE_REGEX.exec(text);
  if (!messageMatch?.[1]) return null;

  const commandMessage = messageMatch[1].trim();
  if (!commandMessage) return null;

  const args = COMMAND_ARGS_REGEX.exec(text)?.[1]?.trim() ?? '';
  const isSkillFormat = SKILL_FORMAT_REGEX.exec(text)?.[1]?.trim() === 'true';

  if (isSkillFormat) {
    // Skill loading message: "Skill(name)"
    // CLI's UserCommandMessage ignores args in skill-format mode
    return `Skill(${commandMessage})`;
  }

  // Slash command format: "/name args" (no prefix symbol for GUI)
  return args ? `/${commandMessage} ${args}` : `/${commandMessage}`;
}

/**
 * Format command message for copy/resubmit, matching CLI's textForResubmit behavior.
 * Uses <command-name> tag which already contains the / prefix.
 *
 * @param text - Raw text containing XML tags
 * @returns Formatted resubmit string, or null if no command-name tag
 */
export function formatCommandForResubmit(text: string): string | null {
  if (!text) return null;

  // command-name and command-args are extracted independently: the CLI puts
  // <command-message> between them, which used to defeat a single combined regex
  // and silently dropped the args from copy/export.
  const nameMatch = COMMAND_NAME_REGEX.exec(text);
  if (!nameMatch?.[1]) return null;

  const commandName = nameMatch[1].trim();
  if (!commandName) return null;

  const args = COMMAND_ARGS_REGEX.exec(text)?.[1]?.trim() ?? '';
  return args ? `${commandName} ${args}` : commandName;
}

/**
 * Check if text contains a <task-notification> tag
 */
export function hasTaskNotificationTag(text: string): boolean {
  if (!text) return false;
  return text.includes('<task-notification>');
}

/**
 * Task notification status color mapping, matching CLI behavior.
 */
export const TASK_STATUS_COLORS: Record<string, string> = {
  completed: 'success',
  failed: 'error',
  killed: 'warning',
  stopped: 'text',
};

/**
 * Format task-notification for display, matching CLI's UserAgentNotificationMessage behavior.
 * Returns "● summary" with status-based color (no status text prefix).
 * Monitor events additionally carry the observed payload in <event>, returned as `detail`
 * so an error-carrying event stays distinguishable from a benign one.
 *
 * @param text - Raw text containing <task-notification> tags
 * @returns Object with icon, summary, status, and optional detail, or null if no summary
 */
export function formatTaskNotificationForDisplay(
  text: string
): { icon: string; summary: string; status: string; detail?: string } | null {
  if (!text) return null;

  const detail = TASK_NOTIFICATION_EVENT_REGEX.exec(text)?.[1]?.trim() || undefined;

  // Try full format first (with status)
  const matchWithStatus = TASK_NOTIFICATION_REGEX_WITH_STATUS.exec(text);
  if (matchWithStatus?.[2]) {
    const summary = matchWithStatus[2].trim();
    if (!summary) return null;
    const status = matchWithStatus[1]?.trim() ?? 'completed';
    return detail ? { icon: '●', summary, status, detail } : { icon: '●', summary, status };
  }

  // Fallback: minimal format (only summary)
  const matchNoStatus = TASK_NOTIFICATION_REGEX_NO_STATUS.exec(text);
  if (matchNoStatus?.[1]) {
    const summary = matchNoStatus[1].trim();
    if (!summary) return null;
    return detail
      ? { icon: '●', summary, status: 'completed', detail }
      : { icon: '●', summary, status: 'completed' };
  }

  return null;
}

/**
 * Create a task_notification content block from raw text.
 * Shared helper to avoid duplicating creation logic across normalizeBlocks/getContentBlocks.
 */
export function createTaskNotificationBlock(text: string): ClaudeContentBlock | null {
  const n = formatTaskNotificationForDisplay(text);
  if (!n) return null;
  return { type: 'task_notification' as const, icon: n.icon, summary: n.summary, status: n.status, detail: n.detail };
}

/**
 * Extract content from <command-message> and <command-args> tags if present.
 * Returns the combined content: "command-message content command-args content"
 *
 * @deprecated Use {@link formatCommandForDisplay} instead. Kept as fallback only.
 *
 * Example:
 *   Input: "<command-message>aimax:auto</command-message>\n<command-name>/aimax:auto</command-name>\n<command-args>hello there</command-args>"
 *   Output: "aimax:auto hello there"
 */
export function extractCommandMessageContent(text: string): string {
  if (!text) return text;

  const parts: string[] = [];

  // Extract <command-message> content
  const messageMatch = text.match(/<command-message>([\s\S]*?)<\/command-message>/);
  if (messageMatch) {
    const content = messageMatch[1].trim();
    if (content) {
      parts.push(content);
    }
  }

  // Extract <command-args> content
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch) {
    const content = argsMatch[1].trim();
    if (content) {
      parts.push(content);
    }
  }

  // If we found any parts, return them combined
  if (parts.length > 0) {
    return parts.join(' ');
  }

  // No command tags found, return original text
  return text;
}

export type LocalizeMessageFn = (text: string) => string;

export function isSyntheticToolMessageContent(
  content: string | undefined,
  rawBlocks: readonly ClaudeContentBlock[] | null | undefined
): boolean {
  if (!content || !content.trim() || !rawBlocks?.some((block) => block.type === 'tool_use')) {
    return false;
  }

  return content
    .split(/\r?\n/)
    .every((line) => {
      const trimmed = line.trim();
      // Match any non-whitespace tool name to cover MCP tools whose canonical
      // names (e.g. mcp__server__tool, plugin:foo/bar) include characters
      // outside [\w.-]. Empty lines are also treated as synthetic.
      return !trimmed || /^Tool:\s+\S+$/.test(trimmed);
    });
}

/**
 * Normalize raw message content into content blocks
 */
export function normalizeBlocks(
  raw: ClaudeRawMessage | string | undefined,
  localizeMessage: LocalizeMessageFn,
  t: TFunction
): ClaudeContentBlock[] | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'string') {
    return [{ type: 'text' as const, text: raw }];
  }

  // Check if this is a user message - only user messages should have command-message formatting
  // Use index access since ClaudeRawMessage has [key: string]: unknown
  const rawMessage = raw.message as Record<string, unknown> | undefined;
  const isUserMessage =
    raw.type === 'user' ||
    raw['role'] === 'user' ||
    rawMessage?.['role'] === 'user';

  const buildBlocksFromArray = (entries: unknown[]): ClaudeContentBlock[] => {
    const blocks: ClaudeContentBlock[] = [];
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const candidate = entry as Record<string, unknown>;
      const type = candidate.type as string | undefined;
      if (type === 'text') {
        const rawText = typeof candidate.text === 'string' ? candidate.text : '';
        // Some replies contain placeholder text "(no content)", skip to avoid rendering empty content
        if (rawText.trim() === '(no content)') {
          return;
        }

        // Check for XML tags and format accordingly
        if (hasTaskNotificationTag(rawText)) {
          const block = createTaskNotificationBlock(rawText);
          if (block) {
            blocks.push(block);
            return;
          }
        }

        // Only format <command-message> for user messages
        // Assistant messages may contain these tags in code examples
        if (isUserMessage && hasCommandMessageTag(rawText)) {
          const displayContent = formatCommandForDisplay(rawText);
          if (displayContent) {
            blocks.push({
              type: 'text',
              text: localizeMessage(displayContent),
            });
            return;
          }
        }

        // Filter out messages that only contain command tags without command-message
        // But only for user messages - assistant messages may have these in code examples
        if (isUserMessage && containsAnyTag(rawText, FILTERED_NORMALIZE_TAGS)) {
          return;
        }

        blocks.push({
          type: 'text',
          text: localizeMessage(rawText),
        });
      } else if (type === 'thinking') {
        const thinking =
          typeof candidate.thinking === 'string'
            ? (candidate.thinking as string)
            : typeof candidate.text === 'string'
              ? (candidate.text as string)
              : '';
        blocks.push({
          type: 'thinking',
          thinking,
          text: thinking,
        });
      } else if (type === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: typeof candidate.id === 'string' ? (candidate.id as string) : undefined,
          name: typeof candidate.name === 'string' ? (candidate.name as string) : t('tools.unknownTool'),
          input: (candidate.input as Record<string, unknown>) ?? {},
        });
      } else if (type === 'image') {
        const source = (candidate as any).source;
        let src: string | undefined;
        let mediaType: string | undefined;

        // Support two formats:
        // 1. Backend/history format: { type: 'image', source: { type: 'base64', media_type: '...', data: '...' } }
        // 2. Frontend direct format: { type: 'image', src: 'data:...', mediaType: '...' }
        if (source && typeof source === 'object') {
          const st = source.type;
          if (st === 'base64' && typeof source.data === 'string') {
            const mt = typeof source.media_type === 'string' ? source.media_type : 'image/png';
            src = `data:${mt};base64,${source.data}`;
            mediaType = mt;
          } else if (st === 'url' && typeof source.url === 'string') {
            src = source.url;
            mediaType = source.media_type;
          }
        } else if (typeof candidate.src === 'string') {
          // Frontend direct format
          src = candidate.src as string;
          mediaType = candidate.mediaType as string | undefined;
        }

        if (src) {
          blocks.push({ type: 'image', src, mediaType });
        }
      } else if (type === 'attachment') {
        blocks.push({
          type: 'attachment',
          fileName: typeof candidate.fileName === 'string' ? candidate.fileName : undefined,
          mediaType: typeof candidate.mediaType === 'string' ? candidate.mediaType : undefined,
        });
      }
    });
    return blocks;
  };

  const pickContent = (content: unknown): ClaudeContentBlock[] | null => {
    if (!content) {
      return null;
    }
    if (typeof content === 'string') {
      // Handle <task-notification> messages - create special block type
      if (hasTaskNotificationTag(content)) {
        const block = createTaskNotificationBlock(content);
        if (block) return [block];
        return null;
      }

      // Only format <command-message> for user messages
      // Assistant messages may contain these tags in code examples
      if (isUserMessage && hasCommandMessageTag(content)) {
        const displayContent = formatCommandForDisplay(content);
        if (displayContent) {
          return [{ type: 'text' as const, text: localizeMessage(displayContent) }];
        }
        // Fallback to old extraction if formatCommandForDisplay returned null
        const processedContent = extractCommandMessageContent(content);
        return [{ type: 'text' as const, text: localizeMessage(processedContent) }];
      }

      // Filter empty strings and command tags (without <command-message>)
      // But only for user messages - assistant messages with these tags should pass through
      if (!content.trim() || (isUserMessage && containsAnyTag(content, FILTERED_NORMALIZE_TAGS))) {
        return null;
      }
      return [{ type: 'text' as const, text: localizeMessage(content) }];
    }
    if (Array.isArray(content)) {
      const result = buildBlocksFromArray(content);
      return result.length ? result : null;
    }
    return null;
  };

  const contentBlocks = pickContent(raw.message?.content ?? raw.content);

  // If unable to parse content, try getting from other fields
  if (!contentBlocks) {
    // Try getting from raw.text or other possible fields
    if (typeof raw === 'object') {
      if ('text' in raw && typeof raw.text === 'string' && raw.text.trim()) {
        return [{ type: 'text' as const, text: localizeMessage(raw.text) }];
      }
      // If no content at all, return null instead of showing "(unable to parse content)"
      // This way shouldShowMessage will filter out this message
    }
    return null;
  }

  return contentBlocks;
}
