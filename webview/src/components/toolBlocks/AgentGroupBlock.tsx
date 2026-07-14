import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { normalizeToolName } from '../../utils/toolConstants';
import { requestSubagentHistory, SUBAGENT_POLL_TAIL } from '../../utils/subagentHistoryRequests';
import { extractWorkflowMeta } from '../../utils/workflowMeta';
import { getPersistedExpanded, setPersistedExpanded } from '../../utils/expandedState';
import {
  getFinishedBackgroundTaskStatus,
  isTerminalFailure,
  parseBackgroundLaunch,
  useFinishedBackgroundTasks,
} from '../../utils/backgroundTasks';
import { extractWorkflowRunId } from '../../utils/workflowStatusStore';
import WorkflowAgentsSection, { getWorkflowCounts, useWorkflowLiveStatus } from './WorkflowAgentsSection';
import { useSubagentHistoryGetter, useSessionId, useGetToolResultRaw, type GetToolResultRawFn } from '../../contexts/SubagentContext';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';
import { ContentBlockRenderer } from '../MessageItem/ContentBlockRenderer';

// Constants extracted from magic numbers
const MAX_SUMMARY_LENGTH = 120;
const SUBAGENT_POLL_INTERVAL_MS = 3_000;
const NORMAL_WEIGHT_STYLE: React.CSSProperties = { fontWeight: 'normal' };

interface AgentGroupBlockProps {
  agentBlock: ClaudeContentBlock;
  followingBlocks: ClaudeContentBlock[];
  messageIndex: number;
  isStreaming: boolean;
  isLastMessage: boolean;
  isThinking: boolean;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

function isWorkflowBlock(block: ClaudeContentBlock): boolean {
  return block.type === 'tool_use' && normalizeToolName(block.name ?? '') === 'workflow';
}

function getAgentSummary(block: ClaudeContentBlock): string {
  if (block.type !== 'tool_use') return '';
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return '';
  if (isWorkflowBlock(block)) {
    const meta = extractWorkflowMeta(input);
    const desc = meta.description ?? meta.name;
    return typeof desc === 'string' ? desc.slice(0, MAX_SUMMARY_LENGTH) : '';
  }
  const desc = input.description ?? input.prompt;
  return typeof desc === 'string' ? desc.slice(0, MAX_SUMMARY_LENGTH) : '';
}

function getAgentType(block: ClaudeContentBlock): string {
  if (block.type !== 'tool_use') return '';
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return '';
  if (isWorkflowBlock(block)) {
    return extractWorkflowMeta(input).name ?? 'Workflow';
  }
  const t = input.subagent_type ?? input.subagentType;
  return typeof t === 'string' ? t : '';
}

function extractResultText(result?: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((item): item is { type: string; text: string } => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n') || undefined;
  }
  return undefined;
}

function parseAgentToolMeta(
  getToolResultRaw: GetToolResultRawFn,
  toolUseId?: string,
): { agentId?: string; totalDurationMs?: number; totalTokens?: number; totalToolUseCount?: number } {
  if (!toolUseId) return {};
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const record = metadata as Record<string, unknown>;
  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    agentId: getString(record.agentId),
    totalDurationMs: getNumber(record.totalDurationMs),
    totalTokens: getNumber(record.totalTokens),
    totalToolUseCount: getNumber(record.totalToolUseCount),
  };
}

const AgentGroupBlock = memo(function AgentGroupBlock({
  agentBlock,
  followingBlocks,
  messageIndex,
  isStreaming,
  isLastMessage,
  isThinking,
  findToolResult,
}: AgentGroupBlockProps) {
  const { t } = useTranslation();
  const getSubagentHistory = useSubagentHistoryGetter();
  const currentSessionId = useSessionId();
  const getToolResultRaw = useGetToolResultRaw();

  const toolId = agentBlock.type === 'tool_use' ? agentBlock.id : undefined;
  const stateKey = `agent-group-${toolId ?? messageIndex}`;
  const [expanded, setExpandedRaw] = useState(() => getPersistedExpanded(stateKey));
  const setExpanded = useCallback((updater: (prev: boolean) => boolean) => {
    setExpandedRaw((prev) => {
      const next = updater(prev);
      setPersistedExpanded(stateKey, next);
      return next;
    });
  }, [stateKey]);

  const input = agentBlock.type === 'tool_use' ? (agentBlock.input as Record<string, unknown> | undefined) : undefined;
  const result = findToolResult(toolId, messageIndex);
  const resultText = extractResultText(result);
  // A background launch (run_in_background) returns its tool_result
  // immediately while the agent keeps running — completion arrives later as
  // a task-notification. Until then the card must stay in "running" state.
  const finishedBackgroundTasks = useFinishedBackgroundTasks();
  const backgroundLaunch = parseBackgroundLaunch(resultText);
  const backgroundTerminalStatus = getFinishedBackgroundTaskStatus(finishedBackgroundTasks, backgroundLaunch, toolId);
  const backgroundRunning = backgroundLaunch.isBackground && !backgroundTerminalStatus;
  const hasResult = result !== undefined && result !== null;
  const isCompleted = hasResult && !backgroundRunning;
  const isError = (isCompleted && result?.is_error === true) || isTerminalFailure(backgroundTerminalStatus);

  const agentType = getAgentType(agentBlock);
  const summary = getAgentSummary(agentBlock);
  const toolName = agentBlock.type === 'tool_use' ? normalizeToolName(agentBlock.name ?? '') : '';
  const isWorkflow = toolName === 'workflow';

  // Workflow (ultracode) children live under the run's journal, not a
  // per-toolUseId sidechain log — poll that instead of subagent history.
  // Foreground runs have no result (and thus no run id) until they finish,
  // and a background launch's result may carry only a Task ID — "latest"
  // makes the backend resolve the most recently active run in both cases.
  const workflowRunId = isWorkflow
    ? (extractWorkflowRunId(resultText) ?? ((!hasResult && isStreaming) || backgroundRunning ? 'latest' : undefined))
    : undefined;
  const workflowStatus = useWorkflowLiveStatus(currentSessionId, workflowRunId, toolId, !hasResult || backgroundRunning);
  const workflowCounts = getWorkflowCounts(workflowStatus);

  const agentToolMeta = parseAgentToolMeta(getToolResultRaw, toolId);
  const agentId = agentToolMeta.agentId
    ?? (input?.agent_id as string | undefined)
    ?? (input?.agentId as string | undefined)
    ?? backgroundLaunch.agentId;
  const history = (toolId ? getSubagentHistory(toolId) : undefined) ?? (agentId ? getSubagentHistory(agentId) : undefined);

  const noopToggleThinking = useCallback(() => {}, []);

  // Use ref to store timer ID and avoid unnecessary timer restarts
  const pollingTimerRef = useRef<number | null>(null);

  // Full (untruncated) fetch when opening a card without history, or when the
  // subagent completed and only a tail snapshot from live polling is held.
  // Workflow cards have no per-toolUseId sidechain log to fetch — the journal
  // poll above covers them.
  const needsFullHistory = !history || (isCompleted && history.truncated === true);
  useEffect(() => {
    if (!expanded || isWorkflow || !currentSessionId || !toolId || !needsFullHistory) return;
    requestSubagentHistory({
      sessionId: currentSessionId,
      agentId,
      description: typeof summary === 'string' ? summary : undefined,
      toolUseId: toolId,
    }, 0);
  }, [agentId, currentSessionId, summary, expanded, isWorkflow, needsFullHistory, toolId]);

  useEffect(() => {
    // Poll while the subagent runs — even collapsed and after the first history
    // snapshot — so its progress stays live. requestSubagentHistory throttles
    // per subagent, so overlapping pollers don't duplicate bridge requests.
    // Background agents outlive the streaming turn, so they poll until their
    // task-notification arrives instead of until the turn settles.
    // Clear existing timer when dependencies change or conditions no longer met.
    if (!currentSessionId || !toolId || isWorkflow || !(isStreaming || backgroundRunning) || isCompleted) {
      if (pollingTimerRef.current !== null) {
        window.clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
      return;
    }

    // Only start a new timer if one doesn't exist
    if (pollingTimerRef.current === null) {
      pollingTimerRef.current = window.setInterval(() => {
        requestSubagentHistory({
          sessionId: currentSessionId,
          agentId,
          description: typeof summary === 'string' ? summary : undefined,
          toolUseId: toolId,
          tail: SUBAGENT_POLL_TAIL,
        });
      }, SUBAGENT_POLL_INTERVAL_MS);
    }

    return () => {
      if (pollingTimerRef.current !== null) {
        window.clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [agentId, backgroundRunning, currentSessionId, summary, isStreaming, isCompleted, isWorkflow, toolId]);

  return (
    <div className="task-container agent-group-container">
      <div
        className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
        role="button"
        aria-expanded={expanded}
        aria-label={t('tools.agentGroupToggle', 'Toggle agent group details')}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
      >
        <div className="task-title-section">
          <span className="codicon codicon-type-hierarchy tool-title-icon" />
          <span className="tool-title-text">
            {toolName === 'spawn_agent'
              ? 'spawn_agent'
              : toolName === 'workflow'
                ? t('tools.workflow', 'Workflow')
                : t('tools.agent', 'Agent')}
          </span>
          {agentType && (
            <span className="tool-title-summary">{agentType}</span>
          )}
          {summary && (
            <span className="task-summary-text tool-title-summary" title={summary}>
              {summary}
            </span>
          )}
          {workflowCounts && (
            <span className="tool-title-summary" style={NORMAL_WEIGHT_STYLE}>
              · {t('tools.workflowAgentProgress', '{{done}}/{{started}} agents', {
                done: workflowCounts.done,
                started: workflowCounts.started,
              })}
            </span>
          )}
        </div>

        <div className="task-header-right">
          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
          <span className={`codicon agent-group-chevron ${expanded ? 'codicon-chevron-up' : 'codicon-chevron-down'}`} />
        </div>
      </div>

      {expanded && (
        <div className="task-details agent-group-content">
          {isWorkflow ? (
            <WorkflowAgentsSection workflowStatus={workflowStatus} workflowRunId={workflowRunId} />
          ) : (
            <SubagentProcessDetails
              agentId={agentId}
              totalDurationMs={agentToolMeta.totalDurationMs}
              totalTokens={agentToolMeta.totalTokens}
              totalToolUseCount={agentToolMeta.totalToolUseCount}
              resultText={resultText}
              history={history}
              canLoad={Boolean(currentSessionId)}
            />
          )}
          {followingBlocks.map((block, idx) => {
            // Use block id as stable key; fall back to index for non-tool-use blocks
            const blockKey = (block as { id?: string }).id ?? `${messageIndex}-agent-${idx}`;
            return (
              <div key={blockKey} className="content-block">
                <ContentBlockRenderer
                  block={block}
                  messageIndex={messageIndex}
                  messageType="assistant"
                  isStreaming={isStreaming}
                  isThinkingExpanded={false}
                  isThinking={isThinking}
                  isLastMessage={isLastMessage}
                  isLastBlock={idx === followingBlocks.length - 1}
                  t={t}
                  onToggleThinking={noopToggleThinking}
                  findToolResult={findToolResult}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default AgentGroupBlock;
