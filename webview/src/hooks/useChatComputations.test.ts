import { describe, expect, it } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';
import { sliceLatestConversationTurn } from '../utils/turnScope';
import { deriveTodosForTurn } from './useChatComputations';

interface TestMessage extends ClaudeMessage {
  __blocks?: ClaudeContentBlock[];
}

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] =>
  (message as TestMessage).__blocks ?? [];

const user = (content: string): ClaudeMessage => ({ type: 'user', content });

const assistant = (blocks: ClaudeContentBlock[]): ClaudeMessage =>
  ({ type: 'assistant', __blocks: blocks }) as TestMessage;

const toolUse = (id: string, name: string, input: Record<string, unknown>): ClaudeContentBlock =>
  ({ type: 'tool_use', id, name, input });

describe('deriveTodosForTurn', () => {
  it('does not carry a completed plan into a new user turn', () => {
    const messages = [
      user('previous request'),
      assistant([
        toolUse('plan-1', 'update_plan', {
          plan: Array.from({ length: 5 }, (_, index) => ({
            step: `Previous step ${index + 1}`,
            status: 'completed',
          })),
        }),
      ]),
      user('Only answer OK'),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true)).toEqual([]);
  });

  it('shows the latest plan created in the current turn', () => {
    const messages = [
      user('previous request'),
      assistant([toolUse('old-plan', 'update_plan', {
        plan: [{ step: 'Old step', status: 'completed' }],
      })]),
      user('new request'),
      assistant([toolUse('new-plan', 'update_plan', {
        plan: [
          { step: 'First', status: 'in_progress' },
          { step: 'Second', status: 'pending' },
          { step: 'Third', status: 'pending' },
        ],
      })]),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true)).toEqual([
      { content: 'First', status: 'in_progress' },
      { content: 'Second', status: 'pending' },
      { content: 'Third', status: 'pending' },
    ]);
  });

  it('does not carry completed structured tasks into a new user turn', () => {
    const messages = [
      user('previous request'),
      assistant([toolUse('task-create-1', 'TaskCreate', { subject: 'Previous task' })]),
      {
        type: 'user',
        raw: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-create-1',
            content: 'Task #1 created successfully',
          }],
        },
      } as ClaudeMessage,
      assistant([toolUse('task-update-1', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      user('Only answer OK'),
    ];

    const latestTurn = sliceLatestConversationTurn(messages);
    expect(deriveTodosForTurn(latestTurn, getContentBlocks, true)).toEqual([]);
  });
});
