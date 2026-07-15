import type { ClaudeMessage, TodoItem, SubagentInfo } from '../types';
import { hasTaskNotificationTag } from './contentBlockNormalize';

/**
 * Task-notification messages are appended by the CLI when a background task
 * finishes or emits an event. They arrive as user-typed messages but are not
 * user prompts — they must not start a new conversation turn, or every
 * monitor event would wipe the status panel (todos, subagents) mid-run.
 */
export function isTaskNotificationUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;
  if (typeof message.content === 'string' && hasTaskNotificationTag(message.content)) return true;
  const raw = message.raw;
  if (raw && typeof raw !== 'string') {
    const content = raw.content ?? raw.message?.content;
    if (typeof content === 'string' && hasTaskNotificationTag(content)) return true;
    if (Array.isArray(content)) {
      return content.some((block) =>
        block && typeof block === 'object'
        && typeof (block as { text?: unknown }).text === 'string'
        && hasTaskNotificationTag((block as { text: string }).text),
      );
    }
  }
  return false;
}

export function isToolResultOnlyUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;
  if ((message.content ?? '').trim() === '[tool_result]') return true;

  const raw = message.raw;
  if (!raw || typeof raw === 'string') return false;

  const content = raw.content ?? raw.message?.content;
  if (!Array.isArray(content)) return false;

  return content.some((block) =>
    block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result',
  );
}

/** How long a trailing task-notification counts as "response in flight". */
export const BACKGROUND_TURN_FRESHNESS_MS = 10 * 60_000;

export interface BackgroundTurnActivity {
  active: boolean;
  /** Notification delivery time (ms epoch) when known — start for the elapsed timer. */
  startTimeMs?: number;
}

/**
 * A task-notification at the very end of the transcript means the CLI is
 * about to generate (or is generating) an inter-turn background response.
 * There is no GUI-owned streaming state for that turn, so without this the
 * chat looks dead until the finished reply appears in a reload. Freshness-
 * gated on the message's transcript timestamp so a session that died right
 * after a notification doesn't show a forever-spinner; a missing timestamp
 * counts as fresh (only live-streamed messages lack one).
 */
export function getBackgroundTurnActivity(messages: ClaudeMessage[], nowMs: number): BackgroundTurnActivity {
  const last = messages[messages.length - 1];
  if (!last || !isTaskNotificationUserMessage(last)) return { active: false };
  const rawTs = last.raw && typeof last.raw !== 'string'
    ? (last.raw as { timestamp?: unknown }).timestamp
    : undefined;
  const startTimeMs = typeof rawTs === 'string'
    ? Date.parse(rawTs)
    : typeof rawTs === 'number' ? rawTs : Number.NaN;
  if (Number.isFinite(startTimeMs)) {
    if (nowMs - startTimeMs > BACKGROUND_TURN_FRESHNESS_MS) return { active: false };
    return { active: true, startTimeMs };
  }
  return { active: true };
}

export function findLatestConversationTurnStart(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    if (isToolResultOnlyUserMessage(message)) continue;
    if (isTaskNotificationUserMessage(message)) continue;
    return i;
  }
  return -1;
}

export function sliceLatestConversationTurn(messages: ClaudeMessage[]): ClaudeMessage[] {
  const start = findLatestConversationTurnStart(messages);
  return start >= 0 ? messages.slice(start) : [];
}

export function finalizeTodosForSettledTurn(todos: TodoItem[], isStreaming: boolean): TodoItem[] {
  if (isStreaming) return todos;
  return todos.map((todo) => (
    todo.status === 'in_progress'
      ? { ...todo, status: 'completed' }
      : todo
  ));
}

export function finalizeSubagentsForSettledTurn(subagents: SubagentInfo[], isStreaming: boolean): SubagentInfo[] {
  if (isStreaming) return subagents;
  return subagents.map((subagent) => (
    // Background launches legitimately outlive the turn — their completion
    // arrives later as a task-notification, so leave them running.
    subagent.status === 'running' && !subagent.isBackground
      ? { ...subagent, status: 'completed' }
      : subagent
  ));
}
