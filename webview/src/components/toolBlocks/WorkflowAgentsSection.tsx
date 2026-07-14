import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isWorkflowSettled,
  requestWorkflowStatus,
  useWorkflowStatus,
  type WorkflowStatus,
} from '../../utils/workflowStatusStore';
import { SUBAGENT_POLL_INTERVAL_MS } from '../../utils/subagentHistoryRequests';

const MONO_FONT_STYLE: React.CSSProperties = {
  fontFamily: "var(--cc-gui-code-font-family, var(--idea-editor-font-family, 'JetBrains Mono', 'Consolas', monospace))",
};

export function getWorkflowCounts(status: WorkflowStatus | undefined): { started: number; done: number } | null {
  return status?.success && (status.startedCount ?? 0) > 0
    ? { started: status.startedCount ?? 0, done: status.doneCount ?? 0 }
    : null;
}

/**
 * Poll the workflow run's journal while it is unsettled and return its live
 * status. requestWorkflowStatus throttles per run id, so overlapping pollers
 * (transcript card + status panel) don't duplicate bridge requests. A
 * non-workflow caller passes runId undefined and the hook is inert.
 *
 * `stillRunning` = the caller believes the run is alive. When false (the
 * task-notification/TaskStop already flipped it to a terminal state) only a
 * single fetch runs to populate the final child list — a TaskStop-killed run
 * leaves started > done in its journal forever, so waiting for
 * isWorkflowSettled would poll indefinitely.
 */
export function useWorkflowLiveStatus(
  sessionId: string | null | undefined,
  runId: string | undefined,
  toolUseId?: string,
  stillRunning = true,
): WorkflowStatus | undefined {
  const status = useWorkflowStatus(runId);
  const settled = isWorkflowSettled(status);
  const hasStatus = Boolean(status);
  useEffect(() => {
    if (!sessionId || !runId) return;
    const poll = () => requestWorkflowStatus({ sessionId, runId, toolUseId });
    if (!stillRunning) {
      if (!hasStatus) poll();
      return;
    }
    if (settled) return;
    poll();
    const timer = window.setInterval(poll, SUBAGENT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, runId, settled, stillRunning, hasStatus, toolUseId]);
  return status;
}

function shortenAgentId(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
}

interface WorkflowAgentsSectionProps {
  workflowStatus: WorkflowStatus | undefined;
  workflowRunId: string | undefined;
}

/**
 * Expanded-card field listing a Workflow (ultracode) run's child agents with
 * their live running/done state, or a pending hint while the journal is
 * still empty.
 */
export default function WorkflowAgentsSection({ workflowStatus, workflowRunId }: WorkflowAgentsSectionProps) {
  const { t } = useTranslation();
  const counts = getWorkflowCounts(workflowStatus);

  if (workflowStatus?.success && (workflowStatus.agents?.length ?? 0) > 0) {
    return (
      <div className="task-field">
        <div className="task-field-label">
          <span className="codicon codicon-type-hierarchy" />
          {t('tools.workflowAgents', 'Workflow agents')}
          {counts && ` (${counts.done}/${counts.started})`}
        </div>
        <div className="task-field-content">
          {(workflowStatus.agents ?? []).map((agent) => (
            <div key={agent.agentId} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span className={`codicon ${agent.done ? 'codicon-check' : 'codicon-loading codicon-modifier-spin'}`} />
              <span style={MONO_FONT_STYLE}>{shortenAgentId(agent.agentId)}</span>
              {agent.resultPreview && (
                <span className="tool-title-summary" title={agent.resultPreview}>
                  {agent.resultPreview.slice(0, 120)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (workflowRunId && !workflowStatus?.success) {
    return (
      <div className="task-field">
        <div className="task-field-label">{t('tools.workflowAgents', 'Workflow agents')}</div>
        <div className="task-field-content">
          {t('tools.workflowStatusPending', 'Waiting for workflow journal…')}
        </div>
      </div>
    );
  }

  return null;
}
