import { describe, expect, it } from 'vitest';
import { isAsyncAgentInput, extractResultText, parseAgentToolMeta } from './subagentResult';

describe('isAsyncAgentInput', () => {
  it('returns true for run_in_background: true (snake_case)', () => {
    expect(isAsyncAgentInput({ run_in_background: true })).toBe(true);
  });

  it('returns true for runInBackground: true (camelCase guard)', () => {
    expect(isAsyncAgentInput({ runInBackground: true })).toBe(true);
  });

  it('returns false for run_in_background: false', () => {
    expect(isAsyncAgentInput({ run_in_background: false })).toBe(false);
  });

  it('returns false for truthy non-boolean values (strict === true)', () => {
    // A string like "false" must not flip the flag - this is the regression
    // the strict === true check exists to prevent.
    expect(isAsyncAgentInput({ run_in_background: 'false' })).toBe(false);
    expect(isAsyncAgentInput({ run_in_background: 'true' })).toBe(false);
    expect(isAsyncAgentInput({ run_in_background: 1 })).toBe(false);
  });

  it('returns false when the field is absent', () => {
    expect(isAsyncAgentInput({ prompt: 'do stuff' })).toBe(false);
  });

  it('returns false for non-object / nullish input', () => {
    expect(isAsyncAgentInput(null)).toBe(false);
    expect(isAsyncAgentInput(undefined)).toBe(false);
    expect(isAsyncAgentInput('not-an-object')).toBe(false);
    expect(isAsyncAgentInput(42)).toBe(false);
  });
});

describe('extractResultText', () => {
  it('returns undefined for no result', () => {
    expect(extractResultText(undefined)).toBeUndefined();
    expect(extractResultText(null)).toBeUndefined();
  });

  it('returns string content directly', () => {
    expect(extractResultText({ type: 'tool_result', content: 'done' })).toBe('done');
  });

  it('joins text blocks from array content', () => {
    expect(
      extractResultText({
        type: 'tool_result',
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      }),
    ).toBe('a\nb');
  });

  it('returns undefined for empty/whitespace-only text', () => {
    expect(
      extractResultText({ type: 'tool_result', content: [{ type: 'text', text: '' }] }),
    ).toBeUndefined();
  });

  it('returns undefined when content has no text blocks', () => {
    expect(extractResultText({ type: 'tool_result', content: [{ type: 'image' }] })).toBeUndefined();
  });
});

describe('parseAgentToolMeta', () => {
  it('returns empty object when toolUseId is missing', () => {
    expect(parseAgentToolMeta(() => null)).toEqual({});
  });

  it('returns empty object when raw has no toolUseResult', () => {
    const getter = () => ({ content: 'x' });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({});
  });

  it('extracts agentId/usage metadata from toolUseResult', () => {
    const getter = () => ({
      toolUseResult: {
        agentId: 'af5a83aa',
        totalDurationMs: 18000,
        totalTokens: 4200,
        totalToolUseCount: 7,
      },
    });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({
      agentId: 'af5a83aa',
      totalDurationMs: 18000,
      totalTokens: 4200,
      totalToolUseCount: 7,
    });
  });

  it('ignores non-object toolUseResult (e.g. raw error string)', () => {
    // The SDK may overwrite toolUseResult with a raw error string; the helper
    // must fall back to {} rather than reading properties off a string.
    const getter = () => ({ toolUseResult: 'some error string' });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({});
  });

  it('ignores non-finite / wrong-typed numeric fields', () => {
    const getter = () => ({
      toolUseResult: { totalTokens: NaN, totalDurationMs: Infinity, totalToolUseCount: '7' },
    });
    expect(parseAgentToolMeta(getter, 'tu_1')).toEqual({});
  });
});
