import { useSyncExternalStore } from 'react';
import type { ClaudeMessage } from '../types';

/**
 * Background-launched agents (Task/Agent/Workflow with run_in_background)
 * return a tool_result immediately — "Async agent launched successfully…",
 * "Workflow launched in background. Task ID: …" — while the agent keeps
 * running. Treating that result as completion showed a green check the moment
 * the agent started and stopped all live polling.
 *
 * Launch detection parses the result text; completion is detected from the
 * <task-notification> the CLI appends to the transcript when the background
 * task reaches a terminal state. The notification carries the launch's ids:
 *
 *   <task-notification>
 *   <task-id>a01c596b617a75624</task-id>           ← agentId for Agent, Task ID for Workflow
 *   <tool-use-id>toolu_01KfcSbbqTc2…</tool-use-id>  ← the launching tool_use id
 *   <status>completed</status>                      ← completed | failed | killed | stopped
 *   …
 *   </task-notification>
 */
export interface BackgroundLaunchInfo {
  isBackground: boolean;
  taskId?: string;
  agentId?: string;
}

const LAUNCH_PATTERN = /launched\s+(?:successfully\s+)?in(?:\s+the)?\s+background|async\s+agent\s+launched|running\s+in\s+the\s+background/i;

export function parseBackgroundLaunch(resultText?: string): BackgroundLaunchInfo {
  if (!resultText || !LAUNCH_PATTERN.test(resultText)) {
    return { isBackground: false };
  }
  const taskId = /task[\s_-]?id\s*[:=]\s*([A-Za-z0-9_-]{4,})/i.exec(resultText)?.[1];
  const agentId = /agent[\s_-]?id\s*[:=]\s*'?([A-Za-z0-9_-]{6,})'?/i.exec(resultText)?.[1];
  return { isBackground: true, taskId, agentId };
}

// ── Finished-task store ────────────────────────────────────────────────────
// Populated from the message list by useChatComputations; consumed by the
// tool cards via useSyncExternalStore so no extra context plumbing is needed.
// Keys are every id a notification carries (task-id and tool-use-id — the
// namespaces don't collide), values are the terminal <status>.

let finishedTasks: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function setFinishedBackgroundTasks(tasks: ReadonlyMap<string, string>): void {
  if (
    tasks.size === finishedTasks.size
    && [...tasks].every(([id, status]) => finishedTasks.get(id) === status)
  ) {
    return;
  }
  finishedTasks = tasks;
  listeners.forEach((listener) => listener());
}

export function useFinishedBackgroundTasks(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => finishedTasks,
  );
}

/**
 * Terminal status of a background launch, or undefined while it still runs.
 * Matches by the launching tool_use id first (always present in the
 * notification), then by the ids parsed from the launch text.
 */
export function getFinishedBackgroundTaskStatus(
  finished: ReadonlyMap<string, string>,
  launch: BackgroundLaunchInfo,
  toolUseId?: string,
): string | undefined {
  if (!launch.isBackground) return undefined;
  if (toolUseId && finished.has(toolUseId)) return finished.get(toolUseId);
  if (launch.taskId && finished.has(launch.taskId)) return finished.get(launch.taskId);
  if (launch.agentId && finished.has(launch.agentId)) return finished.get(launch.agentId);
  return undefined;
}

const NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function collectFromText(text: string, into: Map<string, string>): void {
  NOTIFICATION_PATTERN.lastIndex = 0;
  let match = NOTIFICATION_PATTERN.exec(text);
  while (match) {
    const body = match[1];
    const status = /<status>\s*([a-z_]+)\s*<\/status>/.exec(body)?.[1] ?? 'completed';
    const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(body)?.[1];
    const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(body)?.[1];
    if (taskId) into.set(taskId, status);
    if (toolUseId) into.set(toolUseId, status);
    match = NOTIFICATION_PATTERN.exec(text);
  }
}

export function collectFinishedBackgroundTasks(messages: ClaudeMessage[]): Map<string, string> {
  const tasks = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string' && message.content.includes('<task-notification>')) {
      collectFromText(message.content, tasks);
    }
    const raw = message.raw;
    if (raw && typeof raw !== 'string') {
      const content = raw.content ?? raw.message?.content;
      if (typeof content === 'string' && content.includes('<task-notification>')) {
        collectFromText(content, tasks);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const text = block && typeof block === 'object' ? (block as { text?: unknown }).text : undefined;
          if (typeof text === 'string' && text.includes('<task-notification>')) {
            collectFromText(text, tasks);
          }
        }
      }
    }
  }
  return tasks;
}
