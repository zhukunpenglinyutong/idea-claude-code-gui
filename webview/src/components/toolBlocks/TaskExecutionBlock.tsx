import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubagentHistoryResponse, ToolInput, ToolResultBlock } from '../../types';
import { AGENT_TOOL_NAMES, normalizeToolName } from '../../utils/toolConstants';
import { requestSubagentHistory, SUBAGENT_POLL_INTERVAL_MS, SUBAGENT_POLL_TAIL } from '../../utils/subagentHistoryRequests';
import { extractWorkflowMeta } from '../../utils/workflowMeta';
import { useSubagentHistoryGetter, useSessionId, useGetToolResultRaw, type GetToolResultRawFn } from '../../contexts/SubagentContext';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';

const MONO_FONT_STYLE: React.CSSProperties = {
  fontFamily: "var(--cc-gui-code-font-family, var(--idea-editor-font-family, 'JetBrains Mono', 'Consolas', monospace))",
};
const NORMAL_WEIGHT_STYLE: React.CSSProperties = { fontWeight: 'normal' };

interface TaskExecutionBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
  isStreaming?: boolean;
}

type SpawnAgentMeta = {
  agentId?: string;
  nickname?: string;
  model?: string;
  reasoningEffort?: string;
};

function extractResultText(result?: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

function parseSpawnAgentMeta(input: ToolInput, result?: ToolResultBlock | null): SpawnAgentMeta {
  const text = extractResultText(result)?.trim();
  let parsed: Record<string, unknown> | null = null;

  if (text && (text.startsWith('{') || text.startsWith('['))) {
    try {
      const candidate = JSON.parse(text);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  const getString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  };

  const agentId = getString(
    parsed?.agent_id,
    parsed?.agentId,
    parsed?.agent_path,
    parsed?.agentPath,
  ) ?? (text?.match(/\b([0-9a-f]{8}-[0-9a-f-]{27})\b/i)?.[1]);

  const nickname = getString(
    parsed?.nickname,
    parsed?.name,
  );

  const model = getString(
    parsed?.model,
    input.model,
  ) ?? (text?.match(/\(([A-Za-z0-9._:-]+)(?:\s+(low|medium|high|xhigh))?\)/i)?.[1]);

  const reasoningEffort = getString(
    parsed?.reasoning_effort,
    parsed?.reasoningEffort,
    input.reasoning_effort,
    input.reasoningEffort,
  ) ?? (text?.match(/\(([A-Za-z0-9._:-]+)(?:\s+(low|medium|high|xhigh))?\)/i)?.[2]);

  return { agentId, nickname, model, reasoningEffort };
}

function parseAgentToolMeta(
  getToolResultRaw: GetToolResultRawFn,
  toolUseId?: string,
): {
  agentId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
} {
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

function shortenAgentId(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
}

/**
 * Compact live-progress summary of a running subagent, derived from its
 * polled sidechain transcript: number of tool calls and the last tool name.
 */
function summarizeLiveProgress(history?: SubagentHistoryResponse): { toolCount: number; lastTool?: string } | null {
  if (!history?.success || !Array.isArray(history.messages)) return null;
  let toolCount = 0;
  let lastTool: string | undefined;
  for (const message of history.messages) {
    const raw = message && typeof message === 'object' ? message as Record<string, any> : {};
    const content = raw.message?.content ?? raw.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
        toolCount += 1;
        const name = (block as { name?: string }).name;
        if (typeof name === 'string' && name) lastTool = name;
      }
    }
  }
  return { toolCount, lastTool };
}

const TaskExecutionBlock = memo(function TaskExecutionBlock({ name, input, result, toolId, isStreaming = false }: TaskExecutionBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const getSubagentHistory = useSubagentHistoryGetter();
  const currentSessionId = useSessionId();
  const getToolResultRaw = useGetToolResultRaw();

  if (!input) {
    return null;
  }

  const normalizedName = normalizeToolName(name ?? '');
  const isSpawnAgent = normalizedName === 'spawn_agent';
  const isWorkflow = normalizedName === 'workflow';
  const isAgentTool = AGENT_TOOL_NAMES.has(normalizedName);
  const {
    description: inputDescription,
    prompt: inputPrompt,
    script: _script,
    subagent_type: subagentType,
    model: _model,
    reasoning_effort: _reasoningEffort,
    reasoningEffort: _reasoningEffortCamel,
    nickname: _nickname,
    name: _inputName,
    agent_id: _agentId,
    agentId: _agentIdCamel,
    agent_path: _agentPath,
    agentPath: _agentPathCamel,
    ...rest
  } = input;
  const spawnMeta = isSpawnAgent ? parseSpawnAgentMeta(input, result) : {};
  const agentToolMeta = !isSpawnAgent ? parseAgentToolMeta(getToolResultRaw, toolId) : {};
  const workflowMeta = isWorkflow ? extractWorkflowMeta(input as Record<string, unknown>) : {};
  const description = typeof inputDescription === 'string' && inputDescription
    ? inputDescription
    : (workflowMeta.description ?? workflowMeta.name);
  const prompt = typeof inputPrompt === 'string' && inputPrompt
    ? inputPrompt
    : (isWorkflow && typeof _script === 'string' ? _script : undefined);
  const agentId = spawnMeta.agentId ?? agentToolMeta.agentId;
  const identityLabel = spawnMeta.nickname
    || (isWorkflow ? (workflowMeta.name ?? 'Workflow') : undefined)
    || (typeof subagentType === 'string' && subagentType ? subagentType : undefined);
  const modelSummary = [spawnMeta.model, spawnMeta.reasoningEffort].filter(Boolean).join(' ');
  const shortAgentId = shortenAgentId(agentId);

  // Determine status based on result
  const isCompleted = result !== undefined && result !== null;
  const isError = isCompleted && result?.is_error === true;
  const history = (toolId ? getSubagentHistory(toolId) : undefined) ?? (agentId ? getSubagentHistory(agentId) : undefined);

  // Full (untruncated) fetch when the user opens a card that has no history
  // yet, or when the subagent completed and we only hold a tail snapshot from
  // live polling. minIntervalMs 0 bypasses the poll throttle for this refresh.
  const needsFullHistory = !history || (isCompleted && history.truncated === true);
  useEffect(() => {
    if (!expanded || !isAgentTool || !currentSessionId || !toolId || !needsFullHistory) return;
    requestSubagentHistory({
      sessionId: currentSessionId,
      agentId,
      description: typeof description === 'string' ? description : undefined,
      toolUseId: toolId,
    }, 0);
  }, [agentId, currentSessionId, description, expanded, needsFullHistory, isAgentTool, toolId]);

  // Poll continuously while the subagent is running — even when collapsed —
  // so the header shows live progress and expanding the card is instant.
  // Tail-limited: repeatedly shipping full multi-MB agent logs into JCEF
  // stalls the UI thread. requestSubagentHistory throttles per subagent, so
  // overlapping pollers (transcript block + status panel) don't duplicate
  // bridge requests.
  const shouldPollHistory = isAgentTool
    && Boolean(currentSessionId)
    && Boolean(toolId)
    && isStreaming
    && !isCompleted;

  useEffect(() => {
    if (!shouldPollHistory || !currentSessionId || !toolId) return;
    const timer = window.setInterval(() => {
      requestSubagentHistory({
        sessionId: currentSessionId,
        agentId,
        description: typeof description === 'string' ? description : undefined,
        toolUseId: toolId,
        tail: SUBAGENT_POLL_TAIL,
      });
    }, SUBAGENT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [agentId, currentSessionId, description, shouldPollHistory, toolId]);

  const liveProgress = useMemo(
    () => (!isCompleted ? summarizeLiveProgress(history) : null),
    [history, isCompleted],
  );

  return (
    <div className="task-container">
      <div
        className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="task-title-section">
          <span className="codicon codicon-tools tool-title-icon" />

          <span className="tool-title-text">
            {name ?? t('tools.task')}
          </span>
          {identityLabel && (
            <span className="tool-title-summary">{identityLabel}</span>
          )}
          {modelSummary && (
            <span className="tool-title-summary">· {modelSummary}</span>
          )}
          {shortAgentId && (
            <span className="tool-title-summary" style={MONO_FONT_STYLE}>
              · {shortAgentId}
            </span>
          )}

          {!isSpawnAgent && typeof description === 'string' && (
            <span className="task-summary-text tool-title-summary" title={description} style={NORMAL_WEIGHT_STYLE}>
              {description}
            </span>
          )}

          {liveProgress && liveProgress.toolCount > 0 && (
            <span className="tool-title-summary" style={NORMAL_WEIGHT_STYLE}>
              · {t('tools.subagentLiveProgress', '{{count}} tool calls', { count: liveProgress.toolCount })}
              {liveProgress.lastTool ? ` · ${liveProgress.lastTool}` : ''}
            </span>
          )}
        </div>

        <div className="task-header-right">
          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
        </div>
      </div>

      {expanded && (
        <div className="task-details">
          <div className="task-content-wrapper">
            {spawnMeta.nickname && (
              <div className="task-field">
                <div className="task-field-label">nickname</div>
                <div className="task-field-content">{spawnMeta.nickname}</div>
              </div>
            )}

            {spawnMeta.model && (
              <div className="task-field">
                <div className="task-field-label">model</div>
                <div className="task-field-content">{spawnMeta.model}</div>
              </div>
            )}

            {spawnMeta.reasoningEffort && (
              <div className="task-field">
                <div className="task-field-label">reasoning_effort</div>
                <div className="task-field-content">{spawnMeta.reasoningEffort}</div>
              </div>
            )}

            {spawnMeta.agentId && (
              <div className="task-field">
                <div className="task-field-label">agent_id</div>
                <div className="task-field-content">{spawnMeta.agentId}</div>
              </div>
            )}

            {isAgentTool && (
              <SubagentProcessDetails
                agentId={agentId}
                totalDurationMs={agentToolMeta.totalDurationMs}
                totalTokens={agentToolMeta.totalTokens}
                totalToolUseCount={agentToolMeta.totalToolUseCount}
                resultText={extractResultText(result)}
                history={history}
                canLoad={Boolean(currentSessionId)}
              />
            )}

            {typeof prompt === 'string' && (
              <div className="task-field">
                <div className="task-field-label">
                  <span className="codicon codicon-comment" />
                  {t('tools.promptLabel')}
                </div>
                <div className="task-field-content">{prompt}</div>
              </div>
            )}

            {Object.entries(rest).map(([key, value]) => (
              <div key={key} className="task-field">
                <div className="task-field-label">{key}</div>
                <div className="task-field-content">
                  {typeof value === 'object' && value !== null
                    ? JSON.stringify(value, null, 2)
                    : String(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default TaskExecutionBlock;
