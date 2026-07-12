import { sendBridgeEvent } from './bridge';

export interface SubagentHistoryRequest {
  sessionId: string;
  toolUseId?: string;
  agentId?: string;
  description?: string;
}

// Several components (transcript blocks, the status panel) may poll the same
// running subagent concurrently. Throttle per subagent so the bridge sees at
// most one load_subagent_session request per key per interval.
const lastRequestAt = new Map<string, number>();

export function requestSubagentHistory(request: SubagentHistoryRequest, minIntervalMs = 1_500): void {
  if (!request.sessionId) return;
  const key = request.toolUseId || request.agentId || request.description;
  if (!key) return;
  const now = Date.now();
  const last = lastRequestAt.get(key) ?? 0;
  if (now - last < minIntervalMs) return;
  lastRequestAt.set(key, now);
  sendBridgeEvent('load_subagent_session', JSON.stringify(request));
}
