import { describe, expect, it } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage, ToolResultBlock } from '../types';
import { extractSubagentsFromMessages } from './useSubagents';

const assistantWithAgent = (toolUseId: string): ClaudeMessage => ({
  type: 'assistant',
  content: '',
  raw: {
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Agent',
          input: {
            subagent_type: 'research',
            description: '分析后端历史索引服务的设计模式',
            prompt: '分析 ClaudeHistoryIndexService',
          },
        },
      ],
    },
  },
});

const toolResultMessage = (toolUseId: string): ClaudeMessage => ({
  type: 'user',
  content: '',
  raw: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: 'final report' }],
      },
    ],
    toolUseResult: {
      status: 'completed',
      agentId: 'af5a83aa15ca39691',
      agentType: 'research',
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
      toolStats: { readCount: 4, searchCount: 0 },
    },
  } as any,
});

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw === 'string') return [];
  const content = raw.message?.content ?? raw.content;
  return Array.isArray(content) ? content.filter((block): block is ClaudeContentBlock => block.type === 'tool_use') : [];
};

const findToolResult = (messages: ClaudeMessage[]) => (toolUseId?: string): ToolResultBlock | null => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (!Array.isArray(content)) continue;
    const result = content.find((block): block is ToolResultBlock => block.type === 'tool_result' && block.tool_use_id === toolUseId);
    if (result) return result;
  }
  return null;
};

const getToolResultRaw = (messages: ClaudeMessage[]) => (toolUseId: string) => {
  for (const message of messages) {
    const raw = message.raw;
    if (!raw || typeof raw === 'string') continue;
    const content = raw.content ?? raw.message?.content;
    if (Array.isArray(content) && content.some((block) => block.type === 'tool_result' && (block as ToolResultBlock).tool_use_id === toolUseId)) {
      return raw as Record<string, unknown>;
    }
  }
  return null;
};

describe('extractSubagentsFromMessages', () => {
  it('attaches completed Agent result metadata including stable agent id', () => {
    const messages = [assistantWithAgent('tooluse_backend'), toolResultMessage('tooluse_backend')];

    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'tooluse_backend',
      agentId: 'af5a83aa15ca39691',
      type: 'research',
      description: '分析后端历史索引服务的设计模式',
      status: 'completed',
      totalDurationMs: 62629,
      totalTokens: 110586,
      totalToolUseCount: 4,
    });
    expect(subagents[0].toolStats).toMatchObject({ readCount: 4 });
  });

  it('finds a running foreground Agent buried mid-message among other tool_use blocks', () => {
    // Regression for the 0d009806 live session: ClaudeMessageHandler merges the
    // whole turn into ONE assistant message, so the Agent tool_use sits between
    // the parent's earlier tool calls and later blocks. The derivation must
    // still surface it — as running while its tool_result has not arrived.
    const bash = (id: string): Record<string, unknown> => (
      { type: 'tool_use', id, name: 'Bash', input: { command: 'git status' } }
    );
    const monster: ClaudeMessage = {
      type: 'assistant',
      content: 'Lecę. Najpierw dociągnę szczegóły…',
      raw: {
        message: {
          content: [
            { type: 'thinking', thinking: 'plan…' },
            { type: 'text', text: 'Lecę. Najpierw dociągnę szczegóły…' },
            bash('toolu_b1'), bash('toolu_b2'), bash('toolu_b3'),
            {
              type: 'tool_use',
              id: 'toolu_agent_mid',
              name: 'Agent',
              input: {
                subagent_type: 'general-purpose',
                description: 'Review spec document',
                prompt: 'Review the spec…',
              },
            },
            bash('toolu_b4'), bash('toolu_b5'),
            { type: 'text', text: 'Spec gotowy.' },
          ],
        },
      } as any,
    };

    const messages = [monster];
    const subagents = extractSubagentsFromMessages(
      messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
    );

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'toolu_agent_mid',
      type: 'general-purpose',
      description: 'Review spec document',
      status: 'running',
    });
  });

  describe('background launches (run_in_background)', () => {
    const backgroundLaunchResult = (toolUseId: string): ClaudeMessage => ({
      type: 'user',
      content: '',
      raw: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: [{
              type: 'text',
              text: 'Async agent launched successfully.\n'
                + "agentId: a0deadbeef1234567 (internal ID - do not mention to user. Use SendMessage with to: 'a0deadbeef1234567' to continue this agent.)\n"
                + 'The agent is working in the background.',
            }],
          },
        ],
      } as any,
    });

    it('stays running while only the launch confirmation has arrived', () => {
      const messages = [assistantWithAgent('tooluse_bg'), backgroundLaunchResult('tooluse_bg')];

      const subagents = extractSubagentsFromMessages(
        messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
      );

      expect(subagents[0]).toMatchObject({
        status: 'running',
        isBackground: true,
        // No toolUseResult metadata yet — the launch text is the only agent-id source.
        agentId: 'a0deadbeef1234567',
      });
    });

    it('completes once the task-notification lands (matched by tool_use id)', () => {
      const messages = [assistantWithAgent('tooluse_bg'), backgroundLaunchResult('tooluse_bg')];

      const subagents = extractSubagentsFromMessages(
        messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
        new Map([['tooluse_bg', 'completed']]),
      );

      expect(subagents[0].status).toBe('completed');
    });

    it('reports error when the background task finished with status failed', () => {
      const messages = [assistantWithAgent('tooluse_bg'), backgroundLaunchResult('tooluse_bg')];

      const subagents = extractSubagentsFromMessages(
        messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
        new Map([['a0deadbeef1234567', 'failed']]),
      );

      expect(subagents[0].status).toBe('error');
    });

    it('reports stopped when the task was ended via TaskStop', () => {
      const messages = [assistantWithAgent('tooluse_bg'), backgroundLaunchResult('tooluse_bg')];

      const subagents = extractSubagentsFromMessages(
        messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
        new Map([['tooluse_bg', 'stopped']]),
      );

      expect(subagents[0].status).toBe('stopped');
    });

    it('reports error when the background task was killed', () => {
      const messages = [assistantWithAgent('tooluse_bg'), backgroundLaunchResult('tooluse_bg')];

      const subagents = extractSubagentsFromMessages(
        messages, getContentBlocks, findToolResult(messages), getToolResultRaw(messages),
        new Map([['tooluse_bg', 'killed']]),
      );

      expect(subagents[0].status).toBe('error');
    });
  });
});
