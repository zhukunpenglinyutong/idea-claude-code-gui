import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SubagentHistoryResponse, SubagentInfo } from '../../types';
import { requestSubagentHistory, SUBAGENT_POLL_INTERVAL_MS, SUBAGENT_POLL_TAIL } from '../../utils/subagentHistoryRequests';
import { extractWorkflowRunId } from '../../utils/workflowStatusStore';
import WorkflowAgentsSection, { getWorkflowCounts, useWorkflowLiveStatus } from '../toolBlocks/WorkflowAgentsSection';
import { subagentStatusIconMap } from './types';
import SubagentProcessDetails from './SubagentProcessDetails';

interface SubagentListProps {
  subagents: SubagentInfo[];
  histories?: Record<string, SubagentHistoryResponse>;
  currentSessionId?: string | null;
  isStreaming?: boolean;
}

interface SubagentRowProps {
  subagent: SubagentInfo;
  isExpanded: boolean;
  history: SubagentHistoryResponse | undefined;
  canLoad: boolean;
  sessionId?: string | null;
  onToggle: (id: string) => void;
  t: TFunction;
}

const SubagentRow = memo(({ subagent, isExpanded, history, canLoad, sessionId, onToggle, t }: SubagentRowProps) => {
  const statusIcon = subagentStatusIconMap[subagent.status] ?? 'codicon-circle-outline';
  const statusClass = `status-${subagent.status}`;

  // Workflow rows have no per-agent sidechain log — their children live in
  // the run's journal, polled via the shared workflow status store.
  const isWorkflow = subagent.type === 'Workflow';
  const workflowRunId = isWorkflow
    ? (extractWorkflowRunId(subagent.resultText) ?? (subagent.status === 'running' ? 'latest' : undefined))
    : undefined;
  const workflowStatus = useWorkflowLiveStatus(sessionId, workflowRunId, subagent.id, subagent.status === 'running');
  const workflowCounts = getWorkflowCounts(workflowStatus);

  const handleClick = useCallback(() => {
    onToggle(subagent.id);
  }, [onToggle, subagent.id]);

  return (
    <div className={`subagent-item-wrapper ${statusClass}`}>
      <button
        type="button"
        className={`subagent-item ${statusClass}`}
        onClick={handleClick}
      >
        <span className={`subagent-status-icon ${statusClass}`}>
          <span className={`codicon ${statusIcon}`} />
        </span>
        <span className="subagent-type">{subagent.type || t('statusPanel.subagentTab')}</span>
        {workflowCounts && (
          <span className="subagent-type">
            {t('tools.workflowAgentProgress', '{{done}}/{{started}} agents', {
              done: workflowCounts.done,
              started: workflowCounts.started,
            })}
          </span>
        )}
        <span className="subagent-description" title={subagent.prompt}>
          {subagent.description || subagent.prompt?.slice(0, 50)}
        </span>
        <span className={`subagent-chevron codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} />
      </button>

      {isExpanded && (
        isWorkflow ? (
          <WorkflowAgentsSection
            workflowStatus={workflowStatus}
            workflowRunId={workflowRunId}
            runEnded={subagent.status !== 'running'}
          />
        ) : (
          <SubagentProcessDetails
            agentId={subagent.agentId}
            totalDurationMs={subagent.totalDurationMs}
            totalTokens={subagent.totalTokens}
            totalToolUseCount={subagent.totalToolUseCount}
            resultText={subagent.resultText}
            history={history}
            canLoad={canLoad}
          />
        )
      )}
    </div>
  );
});

SubagentRow.displayName = 'SubagentRow';

const SubagentList = memo(({ subagents, histories = {}, currentSessionId, isStreaming = false }: SubagentListProps) => {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Keep latest subagents/histories in refs so the polling effect can read fresh
  // values without re-running (and rebuilding the interval) on every change.
  const subagentsRef = useRef(subagents);
  const historiesRef = useRef(histories);
  useEffect(() => { subagentsRef.current = subagents; }, [subagents]);
  useEffect(() => { historiesRef.current = histories; }, [histories]);

  const requestHistory = useCallback((subagent: SubagentInfo, tail?: number, minIntervalMs?: number) => {
    if (!currentSessionId) return;
    requestSubagentHistory({
      sessionId: currentSessionId,
      agentId: subagent.agentId,
      description: subagent.description,
      toolUseId: subagent.id,
      tail,
    }, minIntervalMs);
  }, [currentSessionId]);

  useEffect(() => {
    if (!expandedId) return;
    const subagent = subagentsRef.current.find((item) => item.id === expandedId);
    // Workflow rows read the run journal instead of a sidechain log.
    if (!subagent || subagent.type === 'Workflow' || !currentSessionId) return;
    const existing = historiesRef.current[expandedId];
    // Full fetch when the row is opened without history, or when only a
    // tail-limited live-poll snapshot is held for a finished subagent.
    if (!existing || (subagent.status !== 'running' && existing.truncated === true)) {
      requestHistory(subagent, undefined, 0);
    }
  }, [currentSessionId, expandedId, requestHistory]);

  // Poll every running subagent while the turn streams — not just the expanded
  // row — so the panel reflects live progress. Background launches keep
  // running after the turn settles, so they keep the poll alive until their
  // task-notification flips them out of "running". Tail-limited, and
  // requestSubagentHistory throttles per subagent, deduplicating against the
  // transcript blocks' own polling.
  const hasRunningBackground = useMemo(
    () => subagents.some((subagent) => subagent.status === 'running' && subagent.isBackground),
    [subagents],
  );
  useEffect(() => {
    if (!currentSessionId || !(isStreaming || hasRunningBackground)) return;
    const poll = () => {
      subagentsRef.current
        .filter((subagent) => subagent.status === 'running' && subagent.type !== 'Workflow')
        .forEach((subagent) => requestHistory(subagent, SUBAGENT_POLL_TAIL));
    };
    poll();
    const timer = window.setInterval(poll, SUBAGENT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [currentSessionId, hasRunningBackground, isStreaming, requestHistory]);

  const historyById = useMemo(() => histories, [histories]);

  const handleToggleRow = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const canLoad = Boolean(currentSessionId);

  if (subagents.length === 0) {
    return <div className="status-panel-empty">{t('statusPanel.noSubagents')}</div>;
  }

  return (
    <div className="subagent-list">
      {subagents.map((subagent, index) => {
        const history = historyById[subagent.id] ?? (subagent.agentId ? historyById[subagent.agentId] : undefined);
        // Index fallback guards against rare cases where the bridge emits a
        // subagent without a stable id; without it React surfaces a duplicate-key
        // warning and may miscompare rows during streaming updates.
        return (
          <SubagentRow
            key={subagent.id ?? `subagent-${index}`}
            subagent={subagent}
            isExpanded={expandedId === subagent.id}
            history={history}
            canLoad={canLoad}
            sessionId={currentSessionId}
            onToggle={handleToggleRow}
            t={t}
          />
        );
      })}
    </div>
  );
});

SubagentList.displayName = 'SubagentList';

export default SubagentList;
