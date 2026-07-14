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

// Matches every background-launch confirmation the CLI emits:
//   "Async agent launched successfully. agentId: a01c…"           (Agent/Task)
//   "Workflow launched in background. Task ID: w057006cy"          (Workflow)
//   "Command running in background with ID: b06hiiaoj. Output…"    (Bash)
//   "Monitor started (task bkvs4037z, timeout 600000ms)."          (Monitor)
//   '{"success":true,"message":"Agent \"a2d7…\" had no active task; resumed
//    from transcript in the background with your message. …"}'   (SendMessage)
// Anchored to the start of the result text: tool outputs that merely CONTAIN
// such a phrase (grep over transcripts, a Read of this file, a web page)
// must not put the card into a never-ending running state.
const LAUNCH_PATTERN = /^\s*(?:async\s+agent\s+launched|workflow\s+launched\s+in(?:\s+the)?\s+background|command\s+running\s+in(?:\s+the)?\s+background\s+with\s+id|monitor\s+started\s+\(task\s|.{0,40}launched\s+(?:successfully\s+)?in(?:\s+the)?\s+background|[^\n]{0,160}?resumed\s+from\s+transcript\s+in(?:\s+the)?\s+background)/i;

export function parseBackgroundLaunch(resultText?: string): BackgroundLaunchInfo {
  if (!resultText || !LAUNCH_PATTERN.test(resultText)) {
    return { isBackground: false };
  }
  const taskId = /task[\s_-]?id\s*[:=]\s*([A-Za-z0-9_-]{4,})/i.exec(resultText)?.[1]
    ?? /with\s+id\s*[:=]?\s*([A-Za-z0-9_-]{4,})/i.exec(resultText)?.[1]
    ?? /\(task\s+([A-Za-z0-9_-]{4,})[,)]/i.exec(resultText)?.[1]
    ?? /\/tasks\/([A-Za-z0-9_-]{4,})\.output/.exec(resultText)?.[1];
  const agentId = /agent[\s_-]?id\s*[:=]\s*'?([A-Za-z0-9_-]{6,})'?/i.exec(resultText)?.[1]
    // SendMessage resume: 'Agent \"a2d72de8cb107fa0d\" had no active task; …'
    ?? /agent\s+\\?"([A-Za-z0-9_-]{6,})\\?"/i.exec(resultText)?.[1];
  return { isBackground: true, taskId, agentId };
}

/**
 * Terminal statuses that should render as an error state. 'stopped' is a
 * deliberate user action and keeps the neutral completed look.
 */
export function isTerminalFailure(status?: string): boolean {
  return status === 'failed' || status === 'killed';
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
 * One-stop state for tool cards: is this result a background launch, is the
 * task still running, and what terminal status did it end with.
 */
export interface BackgroundTaskState {
  isBackground: boolean;
  running: boolean;
  terminalStatus?: string;
}

export function getBackgroundTaskState(
  finished: ReadonlyMap<string, string>,
  resultText: string | undefined,
  toolUseId?: string,
): BackgroundTaskState {
  const launch = parseBackgroundLaunch(resultText);
  if (!launch.isBackground) return { isBackground: false, running: false };
  const terminalStatus = getFinishedBackgroundTaskStatus(finished, launch, toolUseId);
  return { isBackground: true, running: !terminalStatus, terminalStatus };
}

export function useBackgroundTaskState(resultText: string | undefined, toolUseId?: string): BackgroundTaskState {
  const finished = useFinishedBackgroundTasks();
  return getBackgroundTaskState(finished, resultText, toolUseId);
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

// TaskStop produces no task-notification — its own tool_result is the only
// terminal record: '{"message":"Successfully stopped task: wy0d80iqp (…)",
// "task_id":"wy0d80iqp","task_type":"local_workflow",…}'.
function collectStopsFromText(text: string, into: Map<string, string>): void {
  if (!/successfully (?:stopped|killed) task/i.test(text)) return;
  const fromMessage = /successfully (?:stopped|killed) task:?\s*"?([A-Za-z0-9_-]{4,})/i.exec(text)?.[1];
  const fromField = /"task_id"\s*:\s*"([A-Za-z0-9_-]{4,})"/.exec(text)?.[1];
  const status = /successfully killed/i.test(text) ? 'killed' : 'stopped';
  if (fromMessage) into.set(fromMessage, status);
  if (fromField) into.set(fromField, status);
}

function collectFromText(text: string, into: Map<string, string>): void {
  NOTIFICATION_PATTERN.lastIndex = 0;
  let match = NOTIFICATION_PATTERN.exec(text);
  while (match) {
    const body = match[1];
    // Only notifications carrying an explicit terminal <status> end a task.
    // Monitor *events* and agent messages arrive as task-notifications with
    // the same <task-id> but no <status> — the task keeps running.
    const status = /<status>\s*([a-z_]+)\s*<\/status>/.exec(body)?.[1];
    if (status) {
      const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(body)?.[1];
      const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(body)?.[1];
      if (taskId) into.set(taskId, status);
      if (toolUseId) into.set(toolUseId, status);
    }
    match = NOTIFICATION_PATTERN.exec(text);
  }
}

function collectFromAnyText(text: string, into: Map<string, string>): void {
  if (text.includes('<task-notification>')) collectFromText(text, into);
  collectStopsFromText(text, into);
}

function extractBlockText(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const record = block as { text?: unknown; type?: unknown; content?: unknown };
  if (typeof record.text === 'string') return record.text;
  // tool_result blocks (TaskStop confirmations) carry their text in content.
  if (record.type === 'tool_result') {
    if (typeof record.content === 'string') return record.content;
    if (Array.isArray(record.content)) {
      const joined = record.content
        .map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : ''))
        .filter(Boolean)
        .join('\n');
      return joined || undefined;
    }
  }
  return undefined;
}

export function collectFinishedBackgroundTasks(messages: ClaudeMessage[]): Map<string, string> {
  const tasks = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') {
      collectFromAnyText(message.content, tasks);
    }
    const raw = message.raw;
    if (raw && typeof raw !== 'string') {
      const content = raw.content ?? raw.message?.content;
      if (typeof content === 'string') {
        collectFromAnyText(content, tasks);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const text = extractBlockText(block);
          if (text) collectFromAnyText(text, tasks);
        }
      }
    }
  }
  return tasks;
}
