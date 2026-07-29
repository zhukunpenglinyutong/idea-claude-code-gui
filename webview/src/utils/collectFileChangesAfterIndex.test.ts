import { describe, expect, it } from 'vitest';
import { collectFileChangesAfterIndex } from './collectFileChangesAfterIndex';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(text: string, rawUuid?: string): ClaudeMessage {
  return {
    type: 'user',
    content: text,
    timestamp: '2026-01-01T00:00:00Z',
    raw: rawUuid ? { uuid: rawUuid } : undefined,
  };
}

function makeToolUseBlock(
  name: string,
  input: Record<string, unknown>,
  id = 't1',
): ClaudeContentBlock {
  return { type: 'tool_use', name, input, id } as ClaudeContentBlock;
}

function makeAssistantMessage(blocks: ClaudeContentBlock[]): ClaudeMessage {
  return {
    type: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:01Z',
    raw: { content: blocks },
  };
}

function makeSuccessfulResult(toolUseId: string): ToolResultBlock {
  return {
    type: 'tool_result',
    content: 'ok',
    tool_use_id: toolUseId,
    is_error: false,
  };
}

function makeFailedResult(toolUseId: string): ToolResultBlock {
  return {
    type: 'tool_result',
    content: 'error',
    tool_use_id: toolUseId,
    is_error: true,
  };
}

// getContentBlocks extracts raw.content array into ClaudeContentBlock[]
function getContentBlocks(msg: ClaudeMessage): ClaudeContentBlock[] {
  if (!msg.raw || typeof msg.raw === 'string') return [];
  const rawObj = msg.raw as Record<string, unknown>;
  const rawContent = rawObj.content;
  return Array.isArray(rawContent) ? (rawContent as ClaudeContentBlock[]) : [];
}

// findToolResult searches raw.content for the matching tool_result
function findToolResult(
  toolUseId: string | undefined,
  _messageIndex: number,
): ToolResultBlock | null {
  if (!toolUseId) return null;
  // This test helper doesn't search by index — it returns based on the id.
  // Tests below use unique IDs so the mapping is straightforward.
  if (toolUseId.startsWith('success-')) {
    return makeSuccessfulResult(toolUseId);
  }
  if (toolUseId.startsWith('fail-')) {
    return makeFailedResult(toolUseId);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectFileChangesAfterIndex', () => {
  it('returns empty for empty messages', () => {
    const result = collectFileChangesAfterIndex(0, [], getContentBlocks, findToolResult);
    expect(result).toEqual([]);
  });

  it('returns empty when no messages after startIndex', () => {
    const messages = [makeUserMessage('hello')];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toEqual([]);
  });

  it('returns empty when no assistant messages exist', () => {
    const messages = [makeUserMessage('hello'), makeUserMessage('world')];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toEqual([]);
  });

  it('ignores non-file-modifying tool_use blocks', () => {
    const messages = [
      makeUserMessage('read file'),
      makeAssistantMessage([
        makeToolUseBlock('read', { path: '/a/b.ts' }, 'success-r1'),
      ]),
    ];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toEqual([]);
  });

  it('collects a single edit', () => {
    const messages = [
      makeUserMessage('fix bug'),
      makeAssistantMessage([
        makeToolUseBlock('edit', { file_path: '/a/b.ts', old_string: 'a', new_string: 'b' }, 'success-e1'),
      ]),
    ];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('/a/b.ts');
    expect(result[0].status).toBe('M');
    expect(result[0].operations).toHaveLength(1);
    expect(result[0].operations[0].oldString).toBe('a');
    expect(result[0].operations[0].newString).toBe('b');
  });

  it('collects a write (new file) as status A', () => {
    const messages = [
      makeUserMessage('create file'),
      makeAssistantMessage([
        makeToolUseBlock('write', { file_path: '/a/new.ts', content: 'code' }, 'success-w1'),
      ]),
    ];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('/a/new.ts');
    expect(result[0].status).toBe('A');
  });

  it('skips failed tool calls', () => {
    const messages = [
      makeUserMessage('fix bug'),
      makeAssistantMessage([
        makeToolUseBlock('edit', { file_path: '/a/b.ts', old_string: 'a', new_string: 'b' }, 'fail-e1'),
      ]),
    ];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toHaveLength(0);
  });

  it('groups multiple operations on the same file', () => {
    const messages = [
      makeUserMessage('refactor'),
      makeAssistantMessage([
        makeToolUseBlock('edit', { file_path: '/a/b.ts', old_string: 'a', new_string: 'b' }, 'success-e1'),
        makeToolUseBlock('edit', { file_path: '/a/b.ts', old_string: 'b', new_string: 'c' }, 'success-e2'),
      ]),
    ];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('/a/b.ts');
    expect(result[0].operations).toHaveLength(2);
  });

  it('handles multiple files', () => {
    const messages = [
      makeUserMessage('refactor'),
      makeAssistantMessage([
        makeToolUseBlock('edit', { file_path: '/a/a.ts', old_string: 'a', new_string: 'b' }, 'success-e1'),
        makeToolUseBlock('edit', { file_path: '/b/b.ts', old_string: 'x', new_string: 'y' }, 'success-e2'),
      ]),
    ];
    const result = collectFileChangesAfterIndex(0, messages, getContentBlocks, findToolResult);
    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe('/a/a.ts');
    expect(result[1].filePath).toBe('/b/b.ts');
  });

  it('respects startIndex (collects only changes AFTER the target)', () => {
    const messages = [
      makeUserMessage('first'),
      makeAssistantMessage([
        makeToolUseBlock('edit', { file_path: '/a/first.ts', old_string: 'a', new_string: 'b' }, 'success-e1'),
      ]),
      makeUserMessage('second'),
      makeAssistantMessage([
        makeToolUseBlock('edit', { file_path: '/a/second.ts', old_string: 'a', new_string: 'b' }, 'success-e2'),
      ]),
    ];
    // Start from index 2 (excluding the first edit)
    const result = collectFileChangesAfterIndex(2, messages, getContentBlocks, findToolResult);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('/a/second.ts');
  });
});
