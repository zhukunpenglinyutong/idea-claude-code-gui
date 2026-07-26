import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { reconstructTurnMetadata } from './turnMetadataReconstruction';

// ---------------------------------------------------------------------------
// Fixture helpers — raw shapes mirror real transcript JSONL lines:
// user lines carry message.content, assistant lines carry message.{id,usage},
// both carry an ISO timestamp.
// ---------------------------------------------------------------------------

const userPrompt = (text: string, timestamp?: string): ClaudeMessage => ({
  type: 'user',
  content: text,
  raw: {
    type: 'user',
    ...(timestamp ? { timestamp } : {}),
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as ClaudeMessage['raw'],
});

const assistantMsg = (
  opts: {
    text?: string;
    timestamp?: string;
    id?: string;
    usage?: Record<string, number>;
    durationMs?: number;
    turnUsage?: Record<string, number>;
  } = {},
): ClaudeMessage => ({
  type: 'assistant',
  content: opts.text ?? 'reply',
  ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
  raw: {
    type: 'assistant',
    ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
    ...(opts.turnUsage ? { turnUsage: opts.turnUsage } : {}),
    message: {
      role: 'assistant',
      ...(opts.id ? { id: opts.id } : {}),
      ...(opts.usage ? { usage: opts.usage } : {}),
      content: [{ type: 'text', text: opts.text ?? 'reply' }],
    },
  } as ClaudeMessage['raw'],
});

const toolResultUser = (): ClaudeMessage => ({
  type: 'user',
  content: '[tool_result]',
  raw: {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }] },
  } as ClaudeMessage['raw'],
});

const getTurnUsage = (message: ClaudeMessage): Record<string, number> | undefined =>
  (message.raw as Record<string, unknown> | undefined)?.turnUsage as Record<string, number> | undefined;

describe('reconstructTurnMetadata', () => {
  it('stamps durationMs on the last assistant message of a settled turn', () => {
    const messages = [
      userPrompt('fix the bug', '2026-07-08T10:00:00.000Z'),
      assistantMsg({ text: 'looking', timestamp: '2026-07-08T10:00:30.000Z' }),
      toolResultUser(),
      assistantMsg({ text: 'done', timestamp: '2026-07-08T10:02:00.000Z' }),
      userPrompt('thanks, next task', '2026-07-08T10:05:00.000Z'),
      assistantMsg({ text: 'sure', timestamp: '2026-07-08T10:05:20.000Z' }),
    ];

    const result = reconstructTurnMetadata(messages);

    // First turn: 10:02:00 - 10:00:00 = 120000ms on the LAST assistant only
    expect(result[1].durationMs).toBeUndefined();
    expect(result[3].durationMs).toBe(120_000);
    // Second (trailing, not skipped) turn: 20s
    expect(result[5].durationMs).toBe(20_000);
  });

  it('reconstructs turnUsage by summing usage across the turn, deduping shared message ids', () => {
    const messages = [
      userPrompt('prompt', '2026-07-08T10:00:00.000Z'),
      // Two transcript lines from the SAME API response (shared id + identical usage)
      assistantMsg({
        id: 'msg_A',
        timestamp: '2026-07-08T10:00:10.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
      }),
      assistantMsg({
        id: 'msg_A',
        timestamp: '2026-07-08T10:00:11.000Z',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
      }),
      toolResultUser(),
      // Second API call in the same turn
      assistantMsg({
        id: 'msg_B',
        timestamp: '2026-07-08T10:00:40.000Z',
        usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 30 },
      }),
    ];

    const result = reconstructTurnMetadata(messages);
    const turnUsage = getTurnUsage(result[4]);

    expect(turnUsage).toEqual({
      input_tokens: 15,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 3000,
      output_tokens: 80,
    });
    // Intermediate assistants stay untouched
    expect(getTurnUsage(result[1])).toBeUndefined();
    expect(getTurnUsage(result[2])).toBeUndefined();
  });

  it('never overwrites an existing durationMs or turnUsage', () => {
    const existingUsage = { input_tokens: 1, output_tokens: 2 };
    const messages = [
      userPrompt('prompt', '2026-07-08T10:00:00.000Z'),
      assistantMsg({
        timestamp: '2026-07-08T10:03:00.000Z',
        durationMs: 42,
        turnUsage: existingUsage,
        usage: { input_tokens: 999, output_tokens: 999 },
      }),
    ];

    const result = reconstructTurnMetadata(messages);

    expect(result[1].durationMs).toBe(42);
    expect(getTurnUsage(result[1])).toEqual(existingUsage);
    // Nothing changed → the exact same array/object references are returned
    expect(result).toBe(messages);
  });

  it('skips duration silently when timestamps are absent and usage when not present', () => {
    const messages = [
      userPrompt('prompt'),
      assistantMsg({ text: 'reply without timestamp or usage' }),
    ];

    const result = reconstructTurnMetadata(messages);

    expect(result).toBe(messages);
    expect(result[1].durationMs).toBeUndefined();
    expect(getTurnUsage(result[1])).toBeUndefined();
  });

  it('leaves the trailing turn untouched when skipTrailingTurn is set (live streaming)', () => {
    const messages = [
      userPrompt('first', '2026-07-08T10:00:00.000Z'),
      assistantMsg({ timestamp: '2026-07-08T10:01:00.000Z' }),
      userPrompt('second — in flight', '2026-07-08T10:02:00.000Z'),
      assistantMsg({ timestamp: '2026-07-08T10:02:30.000Z' }),
    ];

    const result = reconstructTurnMetadata(messages, { skipTrailingTurn: true });

    expect(result[1].durationMs).toBe(60_000);
    expect(result[3].durationMs).toBeUndefined();
  });

  it('does not treat tool_result carriers, meta caveats, or task notifications as turn starts', () => {
    const messages = [
      userPrompt('real prompt', '2026-07-08T10:00:00.000Z'),
      assistantMsg({ timestamp: '2026-07-08T10:00:20.000Z' }),
      toolResultUser(),
      {
        type: 'user',
        content: 'Caveat: generated by local commands',
        raw: { type: 'user', isMeta: true, timestamp: '2026-07-08T10:00:25.000Z', message: { role: 'user', content: '<local-command-caveat>Caveat…</local-command-caveat>' } },
      } as ClaudeMessage,
      {
        type: 'user',
        content: '',
        raw: {
          type: 'user',
          timestamp: '2026-07-08T10:00:28.000Z',
          message: { role: 'user', content: [{ type: 'text', text: '<task-notification><task-id>t1</task-id><summary>done</summary></task-notification>' }] },
        },
      } as ClaudeMessage,
      assistantMsg({ timestamp: '2026-07-08T10:01:00.000Z' }),
    ];

    const result = reconstructTurnMetadata(messages);

    // All assistants belong to the single real turn; only the last one is stamped
    expect(result[1].durationMs).toBeUndefined();
    expect(result[5].durationMs).toBe(60_000);
  });

  it('handles snapshots without any real prompt', () => {
    const messages = [toolResultUser(), assistantMsg({ timestamp: '2026-07-08T10:00:00.000Z' })];
    expect(reconstructTurnMetadata(messages)).toBe(messages);
  });

  it('produces the exact shape extractTokenUsage expects (all four token fields)', () => {
    const messages = [
      userPrompt('prompt', '2026-07-08T10:00:00.000Z'),
      assistantMsg({
        id: 'msg_A',
        timestamp: '2026-07-08T10:00:10.000Z',
        usage: { input_tokens: 3, output_tokens: 7 },
      }),
    ];

    const turnUsage = getTurnUsage(reconstructTurnMetadata(messages)[1]);
    expect(turnUsage).toEqual({
      input_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 7,
    });
  });
});
