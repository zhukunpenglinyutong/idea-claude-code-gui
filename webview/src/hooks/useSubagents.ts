import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, ClaudeContentBlock, ToolResultBlock, SubagentInfo, SubagentStatus } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { AGENT_TOOL_NAMES, normalizeToolName } from '../utils/toolConstants';
import { extractWorkflowMeta } from '../utils/workflowMeta';
import {
  type BackgroundLaunchInfo,
  getFinishedBackgroundTaskStatus,
  parseBackgroundLaunch,
  useFinishedBackgroundTasks,
} from '../utils/backgroundTasks';

type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;
}

/**
 * Determine subagent status based on tool result. A background launch's
 * immediate tool_result is not completion — the subagent stays running until
 * its task-notification lands in the transcript.
 */
function determineStatus(
  result: ToolResultBlock | null,
  launch: BackgroundLaunchInfo,
  toolUseId: string,
  finishedBackgroundTasks: ReadonlyMap<string, string>,
): SubagentStatus {
  if (!result) {
    return 'running';
  }
  if (result.is_error) {
    return 'error';
  }
  if (launch.isBackground) {
    const terminalStatus = getFinishedBackgroundTaskStatus(finishedBackgroundTasks, launch, toolUseId);
    if (!terminalStatus) return 'running';
    return terminalStatus === 'failed' ? 'error' : 'completed';
  }
  return 'completed';
}

function extractResultText(result: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') return result.content;
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function extractResultMetadata(
  result: ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  toolUseId: string,
): Partial<SubagentInfo> {
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { resultText: extractResultText(result) };
  }

  const record = metadata as Record<string, unknown>;
  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const toolStats = record.toolStats && typeof record.toolStats === 'object' && !Array.isArray(record.toolStats)
    ? Object.fromEntries(
      Object.entries(record.toolStats as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : undefined;

  return {
    agentId: getString(record.agentId),
    totalDurationMs: getNumber(record.totalDurationMs),
    totalTokens: getNumber(record.totalTokens),
    totalToolUseCount: getNumber(record.totalToolUseCount),
    toolStats,
    resultText: extractResultText(result),
  };
}

export function extractSubagentsFromMessages(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  finishedBackgroundTasks: ReadonlyMap<string, string> = new Map(),
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
      const subagentType = isWorkflow
        ? 'Workflow'
        : String((input.subagent_type as string) ?? (input.subagentType as string) ?? 'Unknown');
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
      const resultMetadata = extractResultMetadata(result, getToolResultRaw, toolUseId);
      const launch = parseBackgroundLaunch(resultMetadata.resultText);
      const status = determineStatus(result, launch, toolUseId, finishedBackgroundTasks);

      subagents.push({
        id,
        type: subagentType,
        description,
        prompt,
        status,
        messageIndex,
        isBackground: launch.isBackground,
        ...resultMetadata,
        // A background launch's toolUseResult has no agentId — the launch
        // text is the only place the sidechain id appears.
        agentId: resultMetadata.agentId ?? launch.agentId,
      });
    });
  });

  return subagents;
}

/**
 * Hook to extract subagent information from Task tool calls
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
  getToolResultRaw,
}: UseSubagentsParams): SubagentInfo[] {
  const finishedBackgroundTasks = useFinishedBackgroundTasks();
  return useMemo(
    () => extractSubagentsFromMessages(messages, getContentBlocks, findToolResult, getToolResultRaw, finishedBackgroundTasks),
    [messages, getContentBlocks, findToolResult, getToolResultRaw, finishedBackgroundTasks],
  );
}
