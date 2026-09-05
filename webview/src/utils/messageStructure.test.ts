import { describe, expect, it } from 'vitest';
import { computeStructureVersion, getMessageStructureFingerprint } from './messageStructure';
import type { ClaudeMessage } from '../types';

function assistantMessage(raw: Record<string, unknown>): ClaudeMessage {
  return { type: 'assistant', content: '', raw: raw as ClaudeMessage['raw'] };
}

function textDeltaFrame(base: ClaudeMessage, extraText: string): ClaudeMessage {
  // Simulates a streaming delta frame: new tail object, text/thinking changed,
  // tool structure untouched.
  const raw = JSON.parse(JSON.stringify(base.raw)) as Record<string, unknown>;
  const message = (raw.message ?? {}) as Record<string, unknown>;
  message.content = [
    { type: 'text', text: extraText },
    ...(((message.content ?? []) as unknown[])).filter(
      (block) => (block as Record<string, unknown>).type !== 'text',
    ),
  ];
  raw.message = message;
  return { ...base, raw: raw as ClaudeMessage['raw'] };
}

describe('getMessageStructureFingerprint', () => {
  it('is stable across streaming text/thinking deltas', () => {
    const base = assistantMessage({
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} },
          { type: 'text', text: 'partial' },
        ],
      },
    });

    const delta = textDeltaFrame(base, 'partial response so far');

    expect(getMessageStructureFingerprint(delta))
      .toBe(getMessageStructureFingerprint(base));
  });

  it('changes when a tool_use block is added', () => {
    const base = assistantMessage({ message: { content: [{ type: 'text', text: 'hi' }] } });
    const withTool = assistantMessage({
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'tu-2', name: 'Edit', input: {} },
        ],
      },
    });

    expect(getMessageStructureFingerprint(withTool)
      !== getMessageStructureFingerprint(base)).toBe(true);
  });

  it('changes when a tool_result arrives (error flag included)', () => {
    const ok = assistantMessage({
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] },
    });
    const errored = assistantMessage({
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true }] },
    });

    expect(getMessageStructureFingerprint(errored)
      !== getMessageStructureFingerprint(ok)).toBe(true);
  });
});

describe('computeStructureVersion', () => {
  it('keeps the version stable across text-only delta frames', () => {
    const user: ClaudeMessage = { type: 'user', content: 'do the thing' };
    const assistant = assistantMessage({
      message: {
        content: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} },
        ],
      },
    });
    const turn = [user, assistant];

    const first = computeStructureVersion(turn, { fingerprints: [], version: 0 });
    const deltaTurn = [user, textDeltaFrame(assistant, 'working on it...')];
    const second = computeStructureVersion(deltaTurn, first);

    expect(second.version).toBe(first.version);
  });

  it('bumps the version when a message is added or structure changes', () => {
    const user: ClaudeMessage = { type: 'user', content: 'go' };
    const assistant = assistantMessage({ message: { content: [{ type: 'text', text: 'a' }] } });
    const result = assistantMessage({
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] },
    });

    let state = { fingerprints: [] as string[], version: 0 };
    state = computeStructureVersion([user, assistant], state);
    const afterTurn = state.version;

    state = computeStructureVersion([user, assistant, result], state);
    expect(state.version).toBe(afterTurn + 1);
  });
});
