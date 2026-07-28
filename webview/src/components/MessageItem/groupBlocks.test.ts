import { describe, it, expect } from 'vitest';
import { groupBlocks } from './MessageItem';
import type { ClaudeContentBlock } from '../../types';

const tool = (id: string, name: string): ClaudeContentBlock => ({ type: 'tool_use', id, name, input: {} });
const text = (value: string): ClaudeContentBlock => ({ type: 'text', text: value });

describe('groupBlocks - restored Codex command batches', () => {
  it('renders replayed shell commands as one existing Bash command group', () => {
    const blocks: ClaudeContentBlock[] = [
      {
        type: 'tool_use',
        id: 'codex_exec_call_0',
        name: 'bash',
        input: { command: 'first', description: 'Run powershell.exe' },
      },
      {
        type: 'tool_use',
        id: 'codex_exec_call_1',
        name: 'bash',
        input: { command: 'second', description: 'Run powershell.exe' },
      },
      {
        type: 'tool_use',
        id: 'codex_exec_call_2',
        name: 'bash',
        input: { command: 'third', description: 'Run powershell.exe' },
      },
    ];

    const grouped = groupBlocks(blocks);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      type: 'bash_group',
      blocks,
      startIndex: 0,
    });
  });
});

describe('groupBlocks – agent group absorption', () => {
  it('absorbs following tool_use blocks into the agent group until a text boundary', () => {
    const blocks = [tool('a1', 'Task'), tool('r1', 'Read'), tool('e1', 'Edit'), text('done')];
    const grouped = groupBlocks(blocks);

    expect(grouped).toHaveLength(2);
    const agent = grouped[0];
    expect(agent.type).toBe('agent_group');
    if (agent.type === 'agent_group') {
      expect(agent.agentBlock).toBe(blocks[0]);
      expect(agent.followingBlocks).toEqual([blocks[1], blocks[2]]);
    }
    expect(grouped[1]).toMatchObject({ type: 'single' });
  });

  it('produces identical groups for the full snapshot regardless of completion state (live vs history-reload parity)', () => {
    // groupBlocks is now a pure function of `blocks` only. The previous frozen-count
    // logic depended on streaming-observed state, so reloaded agent groups dropped all
    // their absorbed children. Re-running on the same input must be deterministic AND
    // still absorb the following tool_use blocks.
    const blocks = [tool('a1', 'Task'), tool('r1', 'Read'), tool('b1', 'Bash')];
    const first = groupBlocks(blocks);
    const second = groupBlocks(blocks);
    expect(second).toEqual(first);

    const agent = first[0];
    expect(agent.type).toBe('agent_group');
    if (agent.type === 'agent_group') {
      expect(agent.followingBlocks).toEqual([blocks[1], blocks[2]]);
    }
  });

  it('starts a new agent group when another agent tool appears', () => {
    const blocks = [tool('a1', 'Task'), tool('r1', 'Read'), tool('a2', 'Task')];
    const grouped = groupBlocks(blocks);

    expect(grouped.map((g) => g.type)).toEqual(['agent_group', 'agent_group']);
    const g0 = grouped[0];
    if (g0.type === 'agent_group') expect(g0.followingBlocks).toEqual([blocks[1]]);
    const g1 = grouped[1];
    if (g1.type === 'agent_group') expect(g1.followingBlocks).toEqual([]);
  });

  it('ends the agent group at a non-tool block and processes it normally', () => {
    const blocks = [tool('a1', 'Task'), text('hello'), tool('r1', 'Read')];
    const grouped = groupBlocks(blocks);

    expect(grouped.map((g) => g.type)).toEqual(['agent_group', 'single', 'read_group']);
    const g0 = grouped[0];
    if (g0.type === 'agent_group') expect(g0.followingBlocks).toEqual([]);
  });
});
