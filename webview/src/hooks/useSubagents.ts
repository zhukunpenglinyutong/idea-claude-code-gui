import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, ClaudeContentBlock, ToolResultBlock, SubagentHistoryResponse, SubagentInfo, SubagentStatus, TaskEvent, TaskEventMap } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { AGENT_TOOL_NAMES, normalizeToolName } from '../utils/toolConstants';
import { extractWorkflowMeta } from '../utils/workflowMeta';
import {
  type BackgroundLaunchInfo,
  type BackgroundTaskUsage,
  getBackgroundTaskUsage,
  getFinishedBackgroundTaskStatus,
  parseBackgroundLaunch,
  useBackgroundTaskUsageMap,
  useFinishedBackgroundTasks,
} from '../utils/backgroundTasks';
import { extractResultText, isAsyncAgentInput } from '../utils/subagentResult';
import { useTaskEvents } from '../contexts/SubagentContext';

type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;
  subagentHistories?: Record<string, SubagentHistoryResponse>;
}

/**
 * Determine subagent status.
 *
 * Async agents (Agent/Task tool invoked with run_in_background:true) only
 * receive a launch acknowledgment tool_result, not a completion signal. The
 * terminal status arrives from a live task_notification event, and — when no
 * live event exists — from the notification the CLI persisted in the transcript.
 * Both sources are needed: task events only exist for the session that produced
 * them, so after a webview reload or when opening a past session the transcript
 * is the only evidence a background agent ever finished.
 *
 * Sync agents (task/agent without run_in_background) run inline: a tool_result
 * means the agent is done.
 */
function determineStatus(
  result: ToolResultBlock | null,
  isAsync: boolean,
  taskEvent: TaskEvent | undefined,
  launch: BackgroundLaunchInfo,
  toolUseId: string,
  finishedBackgroundTasks: ReadonlyMap<string, string>,
): SubagentStatus {
  if (isAsync) {
    if (taskEvent) {
      return taskEvent.status === 'failed' || taskEvent.status === 'stopped' ? 'error' : 'completed';
    }
    // Reload / history fallback: the transcript's own task-notification.
    const persisted = getFinishedBackgroundTaskStatus(finishedBackgroundTasks, launch, toolUseId);
    if (persisted) {
      if (persisted === 'failed' || persisted === 'killed') return 'error';
      if (persisted === 'stopped') return 'stopped';
      return 'completed';
    }
    // A failed launch (validation error before the background task was
    // registered) returns an is_error tool_result and never emits a
    // task_notification - surface it as an error instead of staying stuck on
    // "running" forever.
    if (result?.is_error) {
      return 'error';
    }
    return 'running';
  }
  if (!result) {
    return 'running';
  }
  if (result.is_error) {
    return 'error';
  }
  return 'completed';
}

function extractResultMetadata(
  result: ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  toolUseId: string,
  taskEvent: TaskEvent | undefined,
): Partial<SubagentInfo> {
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const toolStats = record?.toolStats && typeof record.toolStats === 'object' && !Array.isArray(record.toolStats)
    ? Object.fromEntries(
      Object.entries(record.toolStats as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : undefined;

  // task_notification wins over toolUseResult: for async agents the launch
  // tool_result carries no usage, so the event is the only source of truth.
  return {
    agentId: taskEvent?.agentId ?? getString(record?.agentId),
    totalDurationMs: taskEvent?.totalDurationMs ?? getNumber(record?.totalDurationMs),
    totalTokens: taskEvent?.totalTokens ?? getNumber(record?.totalTokens),
    totalToolUseCount: taskEvent?.totalToolUseCount ?? getNumber(record?.totalToolUseCount),
    toolStats,
    resultText: taskEvent?.summary ?? extractResultText(result),
  };
}

export function extractSubagentsFromMessages(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  taskEvents: TaskEventMap = {},
  finishedBackgroundTasks: ReadonlyMap<string, string> = new Map(),
  backgroundTaskUsage: ReadonlyMap<string, BackgroundTaskUsage> = new Map(),
): SubagentInfo[] {
  const subagents: SubagentInfo[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.type !== 'assistant') return;

    const blocks = getContentBlocks(message);

    blocks.forEach((block) => {
      if (block.type !== 'tool_use') return;

      const toolName = normalizeToolName(block.name ?? '');

      // Only process task/agent-style subagent tool calls (incl. Workflow).
      if (!AGENT_TOOL_NAMES.has(toolName)) return;

      const rawInput = block.input as Record<string, unknown> | undefined;
      const input = rawInput ? normalizeToolInput(block.name, rawInput) as Record<string, unknown> : undefined;
      if (!input) return;

      const isWorkflow = toolName === 'workflow';
      const workflowMeta = isWorkflow ? extractWorkflowMeta(input) : {};

      // Defensive: ensure all string values are actually strings
      const id = String(block.id ?? `task-${messageIndex}-${subagents.length}`);
      // An Agent call without subagent_type runs the default agent — label it
      // "Agent" instead of the meaningless "Unknown".
      const subagentType = isWorkflow
        ? 'Workflow'
        : String((input.subagent_type as string) ?? (input.subagentType as string) ?? 'Agent');
      const description = String(
        (input.description as string)
          ?? workflowMeta.description
          ?? workflowMeta.name
          ?? '',
      );
      const prompt = String((input.prompt as string) ?? (isWorkflow ? (input.script as string) ?? '' : ''));

      // Check tool result to determine status
      const toolUseId = block.id ?? '';
      const result = findToolResult(toolUseId, messageIndex);
      const taskEvent = taskEvents[toolUseId];
      const resultMetadata = extractResultMetadata(result, getToolResultRaw, toolUseId, taskEvent);
      const launch = parseBackgroundLaunch(resultMetadata.resultText);
      // The run_in_background input flag is authoritative (shared with the
      // inline Agent cards via isAsyncAgentInput). The launch-text fallback
      // still matters for launches whose input carries no flag — notably a
      // SendMessage that revives a background agent.
      const isAsync = isAsyncAgentInput(input) || launch.isBackground;
      const status = determineStatus(result, isAsync, taskEvent, launch, toolUseId, finishedBackgroundTasks);
      // A background launch's toolUseResult carries no stats; the live task
      // event supplies them, and for a reloaded session the transcript
      // notification's <usage> block is the only remaining source.
      const usage = getBackgroundTaskUsage(backgroundTaskUsage, launch, toolUseId);

      subagents.push({
        id,
        type: subagentType,
        description,
        prompt,
        status,
        isAsync,
        messageIndex,
        isBackground: launch.isBackground,
        ...resultMetadata,
        // A background launch's toolUseResult has no agentId — the launch
        // text is the only place the sidechain id appears.
        agentId: resultMetadata.agentId ?? launch.agentId,
        totalDurationMs: resultMetadata.totalDurationMs ?? usage?.totalDurationMs,
        totalTokens: resultMetadata.totalTokens ?? usage?.totalTokens,
        totalToolUseCount: resultMetadata.totalToolUseCount ?? usage?.totalToolUseCount,
      });
    });
  });

  return subagents;
}

export function applySubagentHistoryCompletion(
  subagents: SubagentInfo[],
  subagentHistories: Record<string, SubagentHistoryResponse>,
): SubagentInfo[] {
  return subagents.map((subagent) => {
    if (!subagent.isAsync || subagent.status !== 'running') return subagent;
    const history = subagentHistories[subagent.id]
      ?? (subagent.agentId ? subagentHistories[subagent.agentId] : undefined);
    return history?.completed ? { ...subagent, status: 'completed' as const } : subagent;
  });
}

/**
 * Hook to extract subagent information from Task tool calls.
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
  getToolResultRaw,
  subagentHistories = {},
}: UseSubagentsParams): SubagentInfo[] {
  const taskEvents = useTaskEvents();
  const finishedBackgroundTasks = useFinishedBackgroundTasks();
  const backgroundTaskUsage = useBackgroundTaskUsageMap();
  return useMemo(() => {
    const extracted = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult,
      getToolResultRaw,
      taskEvents,
      finishedBackgroundTasks,
      backgroundTaskUsage,
    );
    return applySubagentHistoryCompletion(extracted, subagentHistories);
  }, [
    messages, getContentBlocks, findToolResult, getToolResultRaw,
    taskEvents, finishedBackgroundTasks, backgroundTaskUsage, subagentHistories,
  ]);
}
