/**
 * Subagent status
 */
export type SubagentStatus = 'running' | 'completed' | 'error';

export interface SubagentHistoryResponse {
  success: boolean;
  toolUseId?: string;
  agentId?: string;
  sessionId?: string;
  error?: string;
  messages?: unknown[];
  /** True when the backend returned only the transcript tail (live-progress poll). */
  truncated?: boolean;
}

/**
 * Subagent information extracted from Task tool calls
 */
export interface SubagentInfo {
  /** Unique identifier (tool_use block id) */
  id: string;
  /** Subagent type (e.g., 'Explore', 'Plan', 'Bash') */
  type: string;
  /** Short description of the task */
  description: string;
  /** Full prompt content */
  prompt?: string;
  /** Execution status */
  status: SubagentStatus;
  /** Message index where this subagent was invoked */
  messageIndex: number;
  /** Stable runtime agent id returned by Claude Code, used to locate sidechain logs */
  agentId?: string;
  /** Total runtime in milliseconds */
  totalDurationMs?: number;
  /** Total tokens reported by the Agent tool */
  totalTokens?: number;
  /** Total tool calls reported by the Agent tool */
  totalToolUseCount?: number;
  /** Per-tool usage counters reported by the Agent tool */
  toolStats?: Record<string, number>;
  /** Final Agent output, when available from the tool result */
  resultText?: string;
  /** Launched with run_in_background — may keep running after the turn settles */
  isBackground?: boolean;
}
