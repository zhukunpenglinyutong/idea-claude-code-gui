import type { TaskEvent } from '../types';

/**
 * Parse a raw SDK task_notification payload into a {@link TaskEvent}, or return
 * null when the payload is not a task_notification or lacks the required
 * tool_use_id/status.
 *
 * Extracted as a pure function so the JSON -> TaskEvent mapping (subtype guard,
 * usage extraction, field extraction) is unit-testable independent of the React
 * state setter in registerCallbacks.
 *
 * SDK field names are snake_case and mirror Claude Code's
 * SDKTaskNotificationMessageSchema (subtype / tool_use_id / status / task_id /
 * summary / output_file / usage). The usage object is optional; when present it
 * carries only {total_tokens, tool_uses, duration_ms} - see
 * sdkEventQueue.ts TaskNotificationSdkEvent and print.ts's XML task_notification
 * parser, which are the only two emit sites. There is no input_tokens /
 * output_tokens field on a task_notification.
 */

// The SDK only ever emits these three terminal statuses (sdkEventQueue.ts
// emitTaskTerminatedSdk; print.ts maps XML 'killed' -> 'stopped'). Validating
// at runtime keeps an unexpected value from sneaking through the type system
// and masquerading as a known terminal status downstream.
const TASK_EVENT_STATUSES: readonly TaskEvent['status'][] = ['completed', 'failed', 'stopped'];
function isTaskEventStatus(value: unknown): value is TaskEvent['status'] {
  return typeof value === 'string' && (TASK_EVENT_STATUSES as readonly string[]).includes(value);
}

export function parseTaskNotification(raw: unknown): TaskEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw as Record<string, unknown>;
  if (ev.subtype !== 'task_notification') return null;

  const toolUseId = typeof ev.tool_use_id === 'string' ? ev.tool_use_id : undefined;
  const status = ev.status;
  if (!toolUseId || !isTaskEventStatus(status)) return null;

  const usage = ev.usage && typeof ev.usage === 'object'
    ? ev.usage as Record<string, unknown>
    : {};

  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  const totalToolUseCount = typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined;
  const totalDurationMs = typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined;
  const summary = typeof ev.summary === 'string' ? ev.summary : undefined;

  return {
    toolUseId,
    agentId: typeof ev.task_id === 'string' ? ev.task_id : undefined,
    status,
    summary,
    totalTokens,
    totalToolUseCount,
    totalDurationMs,
    // Treat an empty output_file the same as a missing one: the SDK defaults
    // output_file to '' when no sidechain transcript was produced, and '' is
    // not a usable path. Coalescing to undefined keeps dedup stable across the
    // dual delivery paths ('' would otherwise differ from undefined).
    outputFilePath: typeof ev.output_file === 'string' && ev.output_file ? ev.output_file : undefined,
  };
}
