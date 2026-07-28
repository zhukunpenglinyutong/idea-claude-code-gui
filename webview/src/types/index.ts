export type ClaudeRole = 'user' | 'assistant' | 'error' | 'task_notification' | 'notification' | 'compact_notification' | string;

export type ToolInput = Record<string, unknown>;

export interface CompactNotificationItem {
  type: 'stdout';
  text: string;
}

/**
 * Metadata for compact summary messages.
 * Contains information about the compaction operation.
 * The real transcript shape lives on a separate `type: 'system',
 * subtype: 'compact_boundary'` line under `compactMetadata`
 * ({ trigger, preTokens, postTokens, durationMs, … }).
 */
export interface CompactSummaryMetadata {
  messagesSummarized?: number;
  direction?: 'up_to' | 'from';
  userContext?: string;
  /** What initiated the compaction ('manual' | 'auto'). */
  trigger?: string;
  /** Context tokens before compaction. */
  preTokens?: number;
  /** Context tokens after compaction. */
  postTokens?: number;
  /** How long the compaction took, in milliseconds. */
  durationMs?: number;
}

/**
 * Type guard for CompactSummaryMetadata.
 */
export function isCompactSummaryMetadata(obj: unknown): obj is CompactSummaryMetadata {
  if (!obj || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  if (m.messagesSummarized !== undefined && typeof m.messagesSummarized !== 'number') return false;
  if (m.direction !== undefined && m.direction !== 'up_to' && m.direction !== 'from') return false;
  if (m.userContext !== undefined && typeof m.userContext !== 'string') return false;
  if (m.trigger !== undefined && typeof m.trigger !== 'string') return false;
  if (m.preTokens !== undefined && typeof m.preTokens !== 'number') return false;
  if (m.postTokens !== undefined && typeof m.postTokens !== 'number') return false;
  if (m.durationMs !== undefined && typeof m.durationMs !== 'number') return false;
  return true;
}

export type ClaudeContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: ToolInput }
  | { type: 'image'; src?: string; mediaType?: string; alt?: string }
  | { type: 'attachment'; fileName?: string; mediaType?: string }
  | { type: 'task_notification'; icon: string; summary: string; status: string; detail?: string }
  | { type: 'compact_notification'; headerText: string; items: CompactNotificationItem[] }
  | { type: 'compact_summary'; title: string; content: string; metadata?: CompactSummaryMetadata };

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
  [key: string]: unknown;
}

export type ClaudeContentOrResultBlock = ClaudeContentBlock | ToolResultBlock;

export interface ClaudeRawMessage {
  content?: string | ClaudeContentOrResultBlock[];
  message?: { content?: string | ClaudeContentOrResultBlock[] };
  type?: string;
  /** Origin indicates message source - used to filter synthetic messages */
  origin?: { kind: string };
  isMeta?: boolean;
  toolUseResult?: unknown;
  isCompactSummary?: boolean;
  [key: string]: unknown;
}

/** Represents a single message in the chat conversation. */
export interface ClaudeMessage {
  type: ClaudeRole;
  content?: string;
  raw?: ClaudeRawMessage | string;
  timestamp?: string;
  isStreaming?: boolean;
  isOptimistic?: boolean;
  /**
   * Runtime-only: numeric turn identifier for streaming assistant isolation.
   * Set by frontend during streaming to distinguish messages from different
   * conversation turns. Messages with different __turnId values should never
   * be merged. Undefined for history messages loaded from JSONL files.
   */
  __turnId?: number;
  [key: string]: unknown;
}

export interface TodoItem {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** IDs of tasks that block this task (numeric string format from TaskCreate/TaskUpdate, e.g., "1", "2") */
  blockedBy?: string[];
}

export interface HistorySessionSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  lastTimestamp?: string;
  isFavorited?: boolean;
  favoritedAt?: number;
  provider?: string; // 'claude' or 'codex'
  fileSize?: number;
  entrypoint?: string; // Session entrypoint: 'cli', 'sdk-cli', 'claude-vscode', etc.
}

export interface HistoryData {
  success: boolean;
  error?: string;
  sessions?: HistorySessionSummary[];
  total?: number;
  favorites?: Record<string, { favoritedAt: number }>;
}

// File changes types
export type { FileChangeStatus, EditOperation, FileChangeSummary } from './fileChanges';

// Subagent types
export type { SubagentStatus, SubagentInfo, SubagentHistoryResponse } from './subagent';
