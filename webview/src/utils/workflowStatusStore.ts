import { useSyncExternalStore } from 'react';
import { sendBridgeEvent } from './bridge';

/**
 * Live status of a Workflow (ultracode) run, read from the run's
 * journal.jsonl by the backend (`load_workflow_status`).
 */
export interface WorkflowAgentStatus {
  agentId: string;
  done: boolean;
  resultPreview?: string;
}

export interface WorkflowStatus {
  success: boolean;
  runId?: string;
  /** Echo of the run id the webview asked for (may be the "latest" alias). */
  requestedRunId?: string;
  toolUseId?: string;
  sessionId?: string;
  error?: string;
  startedCount?: number;
  doneCount?: number;
  updatedAtMs?: number;
  agents?: WorkflowAgentStatus[];
}

type Listener = () => void;

const statuses = new Map<string, WorkflowStatus>();
const listeners = new Set<Listener>();
const lastRequestAt = new Map<string, number>();

function emit() {
  listeners.forEach((listener) => listener());
}

// Registered at module load — independent of the central window-callback
// registration so the store stays self-contained.
window.onWorkflowStatusLoaded = (json: string) => {
  try {
    const status = JSON.parse(json) as WorkflowStatus;
    // Key by the id the component asked with (the "latest" alias stays
    // "latest"), so the polling hook finds its own response.
    const key = status.requestedRunId ?? status.runId;
    if (!key) return;
    const existing = statuses.get(key);
    if (existing && JSON.stringify(existing) === JSON.stringify(status)) return;
    statuses.set(key, status);
    emit();
  } catch {
    // Malformed payload — the next poll retries.
  }
};

export function requestWorkflowStatus(
  request: { sessionId: string; runId: string; toolUseId?: string },
  minIntervalMs = 1_500,
): void {
  if (!request.sessionId || !request.runId) return;
  const now = Date.now();
  const last = lastRequestAt.get(request.runId) ?? 0;
  if (now - last < minIntervalMs) return;
  lastRequestAt.set(request.runId, now);
  sendBridgeEvent('load_workflow_status', JSON.stringify(request));
}

export function useWorkflowStatus(runId: string | undefined): WorkflowStatus | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (runId ? statuses.get(runId) : undefined),
  );
}

/**
 * Extract the workflow run id from a Workflow tool result text. Both the
 * foreground and background result formats mention "Run ID: wf_..." and the
 * transcript-dir path ends in /workflows/<runId>.
 */
export function extractWorkflowRunId(resultText: string | undefined): string | undefined {
  if (!resultText) return undefined;
  const direct = /\bRun ID:\s*(wf_[A-Za-z0-9_-]+)/.exec(resultText);
  if (direct) return direct[1];
  const fromPath = /\/workflows\/(wf_[A-Za-z0-9_-]+)/.exec(resultText);
  return fromPath ? fromPath[1] : undefined;
}

/**
 * A run is settled (polling can stop) when every started agent has a result
 * and the journal has been quiet for a minute. New phases restart polling
 * because startedCount grows past doneCount again.
 */
export function isWorkflowSettled(status: WorkflowStatus | undefined): boolean {
  if (!status || !status.success) return false;
  const started = status.startedCount ?? 0;
  const done = status.doneCount ?? 0;
  if (started === 0 || done < started) return false;
  const updatedAt = status.updatedAtMs ?? 0;
  return Date.now() - updatedAt > 60_000;
}
