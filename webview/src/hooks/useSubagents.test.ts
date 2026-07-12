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
  });
});
