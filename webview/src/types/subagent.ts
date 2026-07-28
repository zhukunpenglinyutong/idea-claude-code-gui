/**
 * Subagent status
 */
export type SubagentStatus = 'running' | 'completed' | 'error' | 'stopped';

/**
 * Terminal status carried by a Claude Code task_notification SDK event.
 * Maps onto SubagentStatus: failed/stopped -> error, completed -> completed.
 */
export type TaskEventStatus = 'completed' | 'failed' | 'stopped';

/**
 * A task_* SDK system event for a background (async Agent) subagent — one
 * invoked via the Agent/Task tool with run_in_background:true. The mainstream
 * only carries these lightweight events; the agent's detailed messages live in
 * a background sidechain. task_notification arrives once the agent finishes and
 * carries the result summary plus usage.
 */
export interface TaskEvent {
  /** tool_use_id of the background Agent call; matches SubagentInfo.id */
  toolUseId: string;
  /** Runtime agent id (SDK task_id); locates the sidechain transcript */
  agentId?: string;
  /** Terminal status reported by task_notification */
  status: TaskEventStatus;
  /** Human-readable result summary */
  summary?: string;
  /** Token usage reported at completion */
  totalTokens?: number;
  /** Tool invocation count reported at completion */
  totalToolUseCount?: number;
  /** Total runtime in milliseconds, when reported */
  totalDurationMs?: number;
  /** Path to the sidechain JSONL transcript */
  outputFilePath?: string;
}

/** Map of tool_use_id -> latest task_* event for async subagents. */
export type TaskEventMap = Record<string, TaskEvent>;

export interface SubagentHistoryResponse {
  success: boolean;
  /** True only when the sidechain transcript ends with an assistant end_turn. */
  completed?: boolean;
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
  /**
   * True for async agents (Agent/Task tool with run_in_background:true).
   * Their terminal status arrives live via task_notification; after history
   * reload it is recovered from the sidechain transcript's terminal end_turn.
   */
  isAsync?: boolean;
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
