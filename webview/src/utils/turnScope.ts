import type { ClaudeMessage, TodoItem, SubagentInfo } from '../types';

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

export function findLatestConversationTurnStart(messages: ClaudeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user') continue;
    if (isToolResultOnlyUserMessage(message)) continue;
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
