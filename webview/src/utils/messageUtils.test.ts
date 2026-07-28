import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import {
  getMessageKey,
  getContentBlocks,
  mergeConsecutiveAssistantMessages,
  formatCommandForDisplay,
  formatCommandForResubmit,
  formatTaskNotificationForDisplay,
  createTaskNotificationBlock,
  attachCompactBoundaryMetadata,
  hasCommandMessageTag,
  hasTaskNotificationTag,
  isTaskNotificationOnlyMessage,
  isSyntheticToolMessageContent,
  hasNonHumanOrigin,
  shouldShowMessage,
  isCompactCommandMessage,
  isCompactStdoutMessage,
  isCompactRelatedMessage,
  extractCompactItems,
  buildCompactNotification,
  TASK_STATUS_COLORS,
} from './messageUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (
  type: ClaudeMessage['type'],
  content: string,
  extra?: Partial<ClaudeMessage>,
): ClaudeMessage => ({
  type,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

// ---------------------------------------------------------------------------
// getMessageKey — __turnId support
// ---------------------------------------------------------------------------

describe('getMessageKey', () => {
  it('returns uuid when present', () => {
    const msg = makeMsg('assistant', 'hello', { raw: { uuid: 'abc-123' } as any });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns uuid even when __turnId is also present', () => {
    const msg = makeMsg('assistant', 'hello', {
      raw: { uuid: 'abc-123' } as any,
      __turnId: 5,
    });
    expect(getMessageKey(msg, 0)).toBe('abc-123');
  });

  it('returns __turnId-based key when uuid is absent', () => {
    const msg = makeMsg('assistant', 'hello', { __turnId: 3 });
    expect(getMessageKey(msg, 0)).toBe('turn-3');
  });

  it('falls back to type-timestamp when both uuid and __turnId are absent', () => {
    const ts = '2024-01-01T00:00:00Z';
    const msg = makeMsg('user', 'hello', { timestamp: ts });
    expect(getMessageKey(msg, 0)).toBe(`user-${ts}`);
  });

  it('falls back to type-index when no uuid, __turnId, or timestamp', () => {
    const msg: ClaudeMessage = { type: 'assistant', content: 'hi' };
    expect(getMessageKey(msg, 7)).toBe('assistant-7');
  });
});

// ---------------------------------------------------------------------------
// getContentBlocks — synthetic tool content filtering
// ---------------------------------------------------------------------------

describe('getContentBlocks', () => {
  const normalizeBlocks = (raw: any) => raw?.content ?? null;
  const localizeMessage = (text: string) => text;

  it('does not append synthetic Tool content for tool-only messages', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Tool: shell_command',
      raw: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } },
        ],
      } as any,
    };

    const result = getContentBlocks(message, normalizeBlocks, localizeMessage);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
  });

  it('does not append repeated synthetic Tool content for merged tool-only messages', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Tool: shell_command\nTool: shell_command',
      raw: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } },
          { type: 'tool_use', id: 'tool-2', name: 'shell_command', input: { command: 'git diff' } },
        ],
      } as any,
    };

    const result = getContentBlocks(message, normalizeBlocks, localizeMessage);

    expect(result).toHaveLength(2);
    expect(result.every((block) => block.type === 'tool_use')).toBe(true);
  });

  it('still appends real fallback content when raw has only tool blocks', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: '命令已经执行完成。',
      raw: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } },
        ],
      } as any,
    };

    const result = getContentBlocks(message, normalizeBlocks, localizeMessage);

    expect(result.map((block) => block.type)).toEqual(['tool_use', 'text']);
    expect((result[1] as any).text).toBe('命令已经执行完成。');
  });
});

describe('isSyntheticToolMessageContent', () => {
  it('requires a tool_use block', () => {
    expect(isSyntheticToolMessageContent('Tool: shell_command', [{ type: 'text', text: 'x' }])).toBe(false);
  });

  it('matches single and repeated synthetic tool titles', () => {
    const blocks = [{ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: {} }] as any;

    expect(isSyntheticToolMessageContent('Tool: shell_command', blocks)).toBe(true);
    expect(isSyntheticToolMessageContent('Tool: shell_command\nTool: apply_patch', blocks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeConsecutiveAssistantMessages — __turnId preservation
// ---------------------------------------------------------------------------

describe('mergeConsecutiveAssistantMessages', () => {
  const normalizeBlocks = (raw: unknown): any[] => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as any;
    const blocks = r.content ?? r.message?.content;
    return Array.isArray(blocks) ? blocks : [];
  };

  it('preserves __turnId from first message in merged group', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        __turnId: 2,
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBe(2);
  });

  it('does not add __turnId when first message has none', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].__turnId).toBeUndefined();
  });

  it('does not merge across user messages', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'a1', { __turnId: 1 }),
      makeMsg('user', 'q'),
      makeMsg('assistant', 'a2', { __turnId: 2 }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(3);
    expect(result[0].__turnId).toBe(1);
    expect(result[2].__turnId).toBe(2);
  });

  it('does not merge assistant messages from different turns', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'first turn answer', {
        __turnId: 10,
        raw: { content: [{ type: 'text', text: 'first turn answer' }] } as any,
      }),
      makeMsg('assistant', 'second turn answer', {
        __turnId: 11,
        raw: { content: [{ type: 'text', text: 'second turn answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result.map((message) => message.__turnId)).toEqual([10, 11]);
  });

  it('does not merge streaming message (has __turnId) with history message (no __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'streaming turn', {
        __turnId: 5,
        raw: { content: [{ type: 'text', text: 'streaming turn' }] } as any,
      }),
      makeMsg('assistant', 'history message', {
        raw: { content: [{ type: 'text', text: 'history message' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result[0].__turnId).toBe(5);
    expect(result[1].__turnId).toBeUndefined();
  });

  it('does not merge history message (no __turnId) with streaming message (has __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'history message', {
        raw: { content: [{ type: 'text', text: 'history message' }] } as any,
      }),
      makeMsg('assistant', 'streaming turn', {
        __turnId: 5,
        raw: { content: [{ type: 'text', text: 'streaming turn' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(2);
    expect(result[0].__turnId).toBeUndefined();
    expect(result[1].__turnId).toBe(5);
  });

  it('merges history messages without __turnId together', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', 'part1', {
        raw: { content: [{ type: 'text', text: 'part1' }] } as any,
      }),
      makeMsg('assistant', 'part2', {
        raw: { content: [{ type: 'text', text: 'part2' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('part1\npart2');
  });

  it('merges tool-only assistant messages across user tool_result boundaries', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'shell_command', input: { command: 'git status' } }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } as any,
      }),
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-2', name: 'shell_command', input: { command: 'git diff --cached' } }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);

    expect(result).toHaveLength(1);
    const mergedRaw = result[0].raw as { content?: Array<{ type?: string; id?: string }> };
    expect(mergedRaw.content?.filter((block) => block.type === 'tool_use').map((block) => block.id)).toEqual(['tool-1', 'tool-2']);
  });

  // ---------------------------------------------------------------------------
  // hasToolUse + __turnId absence — tool_use merging behavior
  // ---------------------------------------------------------------------------

  it('merges tool_use with final answer for history messages (no __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file' }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] } as any,
      }),
      makeMsg('assistant', 'final answer', {
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    expect(result).toHaveLength(1);
    const mergedRaw = result[0].raw as { content?: Array<{ type?: string }> };
    expect(mergedRaw.content?.some((b) => b.type === 'tool_use')).toBe(true);
    expect(mergedRaw.content?.some((b) => b.type === 'text')).toBe(true);
  });

  it('keeps tool_use separated from final answer for streaming messages (has __turnId)', () => {
    const messages: ClaudeMessage[] = [
      makeMsg('assistant', '', {
        __turnId: 1,
        raw: { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file' }] } as any,
      }),
      makeMsg('user', '[tool_result]', {
        raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }] } as any,
      }),
      makeMsg('assistant', 'final answer', {
        __turnId: 1,
        raw: { content: [{ type: 'text', text: 'final answer' }] } as any,
      }),
    ];

    const result = mergeConsecutiveAssistantMessages(messages, normalizeBlocks);
    // Should have 2 assistant messages: tool_use block and final answer block
    // (user tool_result is skipped, but assistant blocks stay separated)
    expect(result.filter((m) => m.type === 'assistant')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatCommandForDisplay — CLI-aligned command message rendering
// ---------------------------------------------------------------------------

describe('formatCommandForDisplay', () => {
  it('returns null for text without command-message tag', () => {
    expect(formatCommandForDisplay('hello world')).toBeNull();
    expect(formatCommandForDisplay('<command-name>/clear</command-name>')).toBeNull();
  });

  it('returns Skill format when skill-format=true', () => {
    const text = '<command-message>opsx:ff</command-message><skill-format>true</skill-format>';
    expect(formatCommandForDisplay(text)).toBe('Skill(opsx:ff)');
  });

  it('returns Skill format with skill-format and no args', () => {
    const text = '<command-message>init</command-message>\n<skill-format>true</skill-format>';
    expect(formatCommandForDisplay(text)).toBe('Skill(init)');
  });

  it('returns slash format without skill-format', () => {
    const text = '<command-message>opsx:ff</command-message>';
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff');
  });

  it('returns slash format with args', () => {
    const text = '<command-message>opsx:ff</command-message><command-args>hello there</command-args>';
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff hello there');
  });

  it('returns slash format without args when command-args is empty', () => {
    const text = '<command-message>clear</command-message><command-args></command-args>';
    expect(formatCommandForDisplay(text)).toBe('/clear');
  });

  it('handles multiline XML content', () => {
    const text = `<command-message>opsx:ff</command-message>
<command-args>hello world</command-args>`;
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff hello world');
  });

  it('trims whitespace from extracted content', () => {
    const text = '<command-message>  opsx:ff  </command-message><command-args>  hello  </command-args>';
    expect(formatCommandForDisplay(text)).toBe('/opsx:ff hello');
  });
});

// ---------------------------------------------------------------------------
// formatCommandForResubmit — CLI-aligned copy/resubmit behavior
// ---------------------------------------------------------------------------

describe('formatCommandForResubmit', () => {
  it('returns null for text without command-name tag', () => {
    expect(formatCommandForResubmit('hello world')).toBeNull();
    expect(formatCommandForResubmit('<command-message>opsx:ff</command-message>')).toBeNull();
  });

  it('returns command-name with args', () => {
    const text = '<command-name>/opsx:ff</command-name><command-args>hello</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/opsx:ff hello');
  });

  it('returns command-name without args', () => {
    const text = '<command-name>/clear</command-name>';
    expect(formatCommandForResubmit(text)).toBe('/clear');
  });

  it('command-name already contains the / prefix', () => {
    const text = '<command-name>/review</command-name><command-args>code</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/review code');
  });

  it('handles multiline XML content', () => {
    const text = `<command-name>/opsx:ff</command-name>
<command-args>hello world</command-args>`;
    expect(formatCommandForResubmit(text)).toBe('/opsx:ff hello world');
  });
});

// ---------------------------------------------------------------------------
// formatTaskNotificationForDisplay — CLI-aligned task notification rendering
// ---------------------------------------------------------------------------

describe('formatTaskNotificationForDisplay', () => {
  it('returns null for text without summary tag', () => {
    expect(formatTaskNotificationForDisplay('<task-notification><status>completed</status></task-notification>')).toBeNull();
    expect(formatTaskNotificationForDisplay('hello world')).toBeNull();
  });

  it('returns ● summary with completed status', () => {
    const text = '<task-notification><status>completed</status><summary>Review finished</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Review finished',
      status: 'completed',
    });
  });

  it('returns ● summary with failed status', () => {
    const text = '<task-notification><status>failed</status><summary>Connection error</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Connection error',
      status: 'failed',
    });
  });

  it('returns ● summary with killed status', () => {
    const text = '<task-notification><status>killed</status><summary>User cancelled</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'User cancelled',
      status: 'killed',
    });
  });

  it('defaults to completed status when status tag missing', () => {
    const text = '<task-notification><summary>Task done</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Task done',
      status: 'completed',
    });
  });

  it('trims whitespace from summary', () => {
    const text = '<task-notification><status>completed</status><summary>  Task done  </summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result?.summary).toBe('Task done');
  });

  it('handles actual SDK format with task-id, result, usage tags', () => {
    // Actual SDK format from JSONL: task-id, tool-use-id, output-file, status, summary, result, usage
    const text = `<task-notification>
<task-id>a31e69ffd788b2055</task-id>
<tool-use-id>toolu_tool-62921666a9104a878d13f7aa038f05af</tool-use-id>
<output-file>C:\\Users\\test\\output.file</output-file>
<status>completed</status>
<summary>Agent "分析仓库结构" completed</summary>
<result>## 仓库分析报告\n\n详细内容...</result>
<usage><total_tokens>19874</total_tokens><tool_uses>12</tool_uses><duration_ms>19665</duration_ms></usage>
</task-notification>`;
    const result = formatTaskNotificationForDisplay(text);
    expect(result).toEqual({
      icon: '●',
      summary: 'Agent "分析仓库结构" completed',
      status: 'completed',
    });
  });
});

// ---------------------------------------------------------------------------
// TASK_STATUS_COLORS — status color mapping
// ---------------------------------------------------------------------------

describe('TASK_STATUS_COLORS', () => {
  it('maps completed to success', () => {
    expect(TASK_STATUS_COLORS['completed']).toBe('success');
  });

  it('maps failed to error', () => {
    expect(TASK_STATUS_COLORS['failed']).toBe('error');
  });

  it('maps killed to warning', () => {
    expect(TASK_STATUS_COLORS['killed']).toBe('warning');
  });

  it('maps stopped to text', () => {
    expect(TASK_STATUS_COLORS['stopped']).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// Tag detection helpers
// ---------------------------------------------------------------------------

describe('hasCommandMessageTag', () => {
  it('returns true for text with command-message tag', () => {
    expect(hasCommandMessageTag('<command-message>test</command-message>')).toBe(true);
  });

  it('returns false for text without command-message tag', () => {
    expect(hasCommandMessageTag('<command-name>/test</command-name>')).toBe(false);
    expect(hasCommandMessageTag('hello world')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(hasCommandMessageTag('')).toBe(false);
    expect(hasCommandMessageTag(null as any)).toBe(false);
  });
});

describe('hasTaskNotificationTag', () => {
  it('returns true for text with task-notification tag', () => {
    expect(hasTaskNotificationTag('<task-notification><status>completed</status></task-notification>')).toBe(true);
  });

  it('returns false for text without task-notification tag', () => {
    expect(hasTaskNotificationTag('hello world')).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(hasTaskNotificationTag('')).toBe(false);
    expect(hasTaskNotificationTag(null as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTaskNotificationOnlyMessage — detect task-notification user messages
// ---------------------------------------------------------------------------

describe('isTaskNotificationOnlyMessage', () => {
  it('returns false for non-user messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: '<task-notification><summary>done</summary></task-notification>',
      timestamp: '1',
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(false);
  });

  it('returns true when message.content has task-notification tag', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '<task-notification><status>completed</status><summary>done</summary></task-notification>',
      timestamp: '1',
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns true when raw.content array has task-notification text block', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        content: [
          { type: 'text', text: '<task-notification><summary>task done</summary></task-notification>' },
        ],
      },
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns true when raw.message.content string has task-notification', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        message: {
          content: '<task-notification><summary>hello</summary></task-notification>',
        },
      },
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns true when raw.message.content array has task-notification', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        message: {
          content: [
            { type: 'text', text: '<task-notification><summary>hey</summary></task-notification>' },
          ],
        },
      },
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(true);
  });

  it('returns false when no task-notification tag found', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hello world',
      timestamp: '1',
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(false);
  });

  it('returns false when raw is undefined', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'normal message',
      timestamp: '1',
      raw: undefined,
    };
    expect(isTaskNotificationOnlyMessage(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasNonHumanOrigin — detect synthetic messages via origin.kind
// ---------------------------------------------------------------------------

describe('hasNonHumanOrigin', () => {
  it('returns false for non-user messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: 'hello',
      timestamp: '1',
      raw: { origin: { kind: 'task-notification' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });

  it('returns true for user message with origin.kind = task-notification', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'notification',
      timestamp: '1',
      raw: { origin: { kind: 'task-notification' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(true);
  });

  it('returns true for user message with origin.kind = hook', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hook msg',
      timestamp: '1',
      raw: { origin: { kind: 'hook' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(true);
  });

  it('returns false for user message with origin.kind = human', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hi',
      timestamp: '1',
      raw: { origin: { kind: 'human' } },
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });

  it('returns false when raw has no origin field', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hi',
      timestamp: '1',
      raw: { content: 'hi' },
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });

  it('returns false when raw is undefined', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hi',
      timestamp: '1',
      raw: undefined,
    };
    expect(hasNonHumanOrigin(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldShowMessage — message visibility filtering
// ---------------------------------------------------------------------------

describe('shouldShowMessage', () => {
  const mockGetMessageText = (msg: ClaudeMessage) => msg.content || '';
  const mockNormalizeBlocks = () => null;
  const mockT = ((key: string) => key) as any;

  it('filters toolUseResult messages', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'some content',
      timestamp: '1',
      raw: { toolUseResult: true },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(false);
  });

  it('filters isCompactSummary messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: 'summary content',
      timestamp: '1',
      raw: { isCompactSummary: true },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(false);
  });

  it('does not filter messages without toolUseResult or isCompactSummary', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'normal message',
      timestamp: '1',
      raw: { content: 'normal message' },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(true);
  });

  it('filters isMeta messages', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'meta content',
      timestamp: '1',
      raw: { isMeta: true },
    };
    expect(shouldShowMessage(msg, mockGetMessageText, mockNormalizeBlocks, mockT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compact notification detection
// ---------------------------------------------------------------------------

describe('isCompactCommandMessage', () => {
  it('returns true for message with <command-name>/compact in raw.content string', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        message: {
          content: '<command-name>/compact</command-name><command-message>compact</command-message>',
        },
      },
    };
    expect(isCompactCommandMessage(msg)).toBe(true);
  });

  it('returns true for message with <command-name>/compact with args', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        content: '<command-name>/compact</command-name><command-args>注意保留cli源码地址</command-args>',
      },
    };
    expect(isCompactCommandMessage(msg)).toBe(true);
  });

  it('returns false for message with other command', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        message: {
          content: '<command-name>/aimax:auto</command-name><command-message>aimax:auto</command-message>',
        },
      },
    };
    expect(isCompactCommandMessage(msg)).toBe(false);
  });

  it('returns false for non-user messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: '<command-name>/compact</command-name>',
      timestamp: '1',
    };
    expect(isCompactCommandMessage(msg)).toBe(false);
  });

  it('returns false when raw is undefined and content is not /compact', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hello',
      timestamp: '1',
    };
    expect(isCompactCommandMessage(msg)).toBe(false);
  });

  it('does not detect optimistic /compact command by content (no XML tags)', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '/compact',
      timestamp: '1',
    };
    expect(isCompactCommandMessage(msg)).toBe(false);
  });

  it('detects /compact in raw.content array of text blocks', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        content: [
          { type: 'text', text: '<command-name>/compact</command-name><command-message>compact</command-message>' },
        ],
      },
    };
    expect(isCompactCommandMessage(msg)).toBe(true);
  });

  it('does not detect optimistic /compact with arguments by content (no XML tags)', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '/compact --verbose',
      timestamp: '1',
    };
    expect(isCompactCommandMessage(msg)).toBe(false);
  });

  it('does not match non-compact content without XML tags', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '/compactextra',
      timestamp: '1',
    };
    expect(isCompactCommandMessage(msg)).toBe(false);
  });
});

describe('isCompactStdoutMessage', () => {
  it('returns true for message with <local-command-stdout> in raw', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: {
        message: {
          content: '<local-command-stdout>Compacted Tip: You have access to Opus 1M</local-command-stdout>',
        },
      },
    };
    expect(isCompactStdoutMessage(msg)).toBe(true);
  });

  it('returns false for message without stdout tag', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'regular message',
      timestamp: '1',
      raw: { content: 'regular message' },
    };
    expect(isCompactStdoutMessage(msg)).toBe(false);
  });

  it('returns false for non-user messages', () => {
    const msg: ClaudeMessage = {
      type: 'assistant',
      content: '<local-command-stdout>output</local-command-stdout>',
      timestamp: '1',
    };
    expect(isCompactStdoutMessage(msg)).toBe(false);
  });
});

describe('isCompactRelatedMessage', () => {
  it('returns true for compact command message', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: { message: { content: '<command-name>/compact</command-name>' } },
    };
    expect(isCompactRelatedMessage(msg)).toBe(true);
  });

  it('returns true for compact stdout message', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: '',
      timestamp: '1',
      raw: { message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } },
    };
    expect(isCompactRelatedMessage(msg)).toBe(true);
  });

  it('returns true for isCompactSummary message', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'summary',
      timestamp: '1',
      raw: { isCompactSummary: true },
    };
    expect(isCompactRelatedMessage(msg)).toBe(true);
  });

  it('returns false for regular message', () => {
    const msg: ClaudeMessage = {
      type: 'user',
      content: 'hello',
      timestamp: '1',
    };
    expect(isCompactRelatedMessage(msg)).toBe(false);
  });
});

describe('extractCompactItems', () => {
  it('extracts stdout text from messages', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        timestamp: '1',
        raw: { message: { content: '<local-command-stdout>Compacted Tip: test</local-command-stdout>' } },
      },
    ];
    const items = extractCompactItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'stdout', text: 'Compacted Tip: test' });
  });

  it('returns empty for messages without stdout', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        timestamp: '1',
        raw: { message: { content: '<command-name>/compact</command-name>' } },
      },
    ];
    expect(extractCompactItems(messages)).toHaveLength(0);
  });

  it('extracts multiple stdout items from group', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        timestamp: '1',
        raw: { message: { content: '<local-command-stdout>line one</local-command-stdout>' } },
      },
      {
        type: 'user',
        content: '',
        timestamp: '2',
        raw: { message: { content: '<local-command-stdout>line two</local-command-stdout>' } },
      },
    ];
    const items = extractCompactItems(messages);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe('line one');
    expect(items[1].text).toBe('line two');
  });
});

describe('buildCompactNotification', () => {
  it('returns null for empty group', () => {
    expect(buildCompactNotification([])).toBeNull();
  });

  it('returns null when group has no command message', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        timestamp: '1',
        raw: { message: { content: '<local-command-stdout>output</local-command-stdout>' } },
      },
    ];
    expect(buildCompactNotification(messages)).toBeNull();
  });

  it('builds notification with command and stdout', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        timestamp: '2026-01-01T00:00:00Z',
        raw: { message: { content: '<command-name>/compact</command-name><command-message>compact</command-message>' } },
      },
      {
        type: 'user',
        content: '',
        timestamp: '2026-01-01T00:00:01Z',
        raw: { message: { content: '<local-command-stdout>Compacted Tip: test</local-command-stdout>' } },
      },
    ];
    const result = buildCompactNotification(messages);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('compact_notification');
    expect(result!.content).toBe('/compact');
    expect(result!.timestamp).toBe('2026-01-01T00:00:00Z');
    const compactItems = (result!.raw as any)?.compactItems;
    expect(compactItems).toHaveLength(1);
    expect(compactItems[0]).toEqual({ type: 'stdout', text: 'Compacted Tip: test' });
  });

  it('uses formatCommandForDisplay for header text with args', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        timestamp: '1',
        raw: {
          message: {
            content: '<command-name>/compact</command-name><command-message>compact</command-message><command-args>注意保留cli源码地址</command-args>',
          },
        },
      },
    ];
    const result = buildCompactNotification(messages);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('/compact 注意保留cli源码地址');
  });

  it('falls back to /compact when formatCommandForDisplay returns null', () => {
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        timestamp: '1',
        raw: { message: { content: '<command-name>/compact</command-name>' } },
      },
    ];
    const result = buildCompactNotification(messages);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('/compact');
  });
});


// ---------------------------------------------------------------------------
// formatCommandForResubmit — real CLI tag order (command-name → command-message
// → command-args). A combined regex used to require args to IMMEDIATELY follow
// the name, silently dropping them from copy/export.
// ---------------------------------------------------------------------------

describe('formatCommandForResubmit — name → message → args tag order', () => {
  it('extracts args when <command-message> sits between name and args', () => {
    const text = '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>ultracode</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/effort ultracode');
  });

  it('extracts multi-word args in the real order', () => {
    const text = '<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>marketplace list</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/plugin marketplace list');
  });

  it('extracts multiline args bodies (e.g. /compact instructions)', () => {
    const text = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the source paths\nand the test counts</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/compact keep the source paths\nand the test counts');
  });

  it('still supports the message-first order', () => {
    const text = '<command-message>effort</command-message>\n<command-name>/effort</command-name>\n<command-args>ultracode</command-args>';
    expect(formatCommandForResubmit(text)).toBe('/effort ultracode');
  });
});

describe('formatCommandForDisplay — tag order tolerance', () => {
  it('renders args when command-name precedes command-message (real CLI order)', () => {
    const text = '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>ultracode</command-args>';
    expect(formatCommandForDisplay(text)).toBe('/effort ultracode');
  });

  it('renders skill format regardless of tag position', () => {
    const text = '<skill-format>true</skill-format>\n<command-message>opsx:ff</command-message>';
    expect(formatCommandForDisplay(text)).toBe('Skill(opsx:ff)');
  });
});

// ---------------------------------------------------------------------------
// formatTaskNotificationForDisplay — <event> payload (monitor notifications)
// ---------------------------------------------------------------------------

describe('formatTaskNotificationForDisplay — <event> payload', () => {
  it('returns the event body as detail for status-less monitor events', () => {
    const text = '<task-notification>\n<task-id>bkvs4037z</task-id>\n<summary>Monitor event: "verify gate exit + result"</summary>\n<event>2026-07-13 14:14:23.887 [main] ERROR c.k.p.s.StatusClient - Failed to check branch status 123456\nEXIT=</event>\n</task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result?.summary).toBe('Monitor event: "verify gate exit + result"');
    expect(result?.status).toBe('completed');
    expect(result?.detail).toBe('2026-07-13 14:14:23.887 [main] ERROR c.k.p.s.StatusClient - Failed to check branch status 123456\nEXIT=');
  });

  it('returns detail together with an explicit status', () => {
    const text = '<task-notification><status>failed</status><summary>Build watch</summary><event>[ERROR] compilation failed</event></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result?.status).toBe('failed');
    expect(result?.detail).toBe('[ERROR] compilation failed');
  });

  it('omits detail when there is no event tag', () => {
    const text = '<task-notification><status>completed</status><summary>Review finished</summary></task-notification>';
    const result = formatTaskNotificationForDisplay(text);
    expect(result?.detail).toBeUndefined();
  });

  it('propagates detail into the task_notification content block', () => {
    const text = '<task-notification><summary>Monitor event</summary><event>[INFO] BUILD SUCCESS</event></task-notification>';
    const block = createTaskNotificationBlock(text);
    expect(block).toMatchObject({ type: 'task_notification', summary: 'Monitor event', detail: '[INFO] BUILD SUCCESS' });
  });
});

// ---------------------------------------------------------------------------
// attachCompactBoundaryMetadata — pairing the compact_boundary system line with
// the compact-summary user line (real two-line transcript shape)
// ---------------------------------------------------------------------------

describe('attachCompactBoundaryMetadata', () => {
  // Mirrors the real JSONL pair: a type:'system', subtype:'compact_boundary'
  // line carrying compactMetadata, immediately followed by the summary line.
  const boundaryMessage = (): ClaudeMessage => ({
    type: 'system',
    content: 'Conversation compacted',
    raw: {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      compactMetadata: {
        trigger: 'manual',
        preTokens: 524835,
        durationMs: 109542,
        postTokens: 14582,
        preCompactDiscoveredTools: ['TaskCreate', 'TaskUpdate'],
      },
    } as ClaudeMessage['raw'],
  });

  const summaryMessage = (): ClaudeMessage => ({
    type: 'user',
    content: '',
    raw: {
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
    } as ClaudeMessage['raw'],
  });

  it('attaches compactMetadata to the following compact-summary message and drops the boundary line', () => {
    const other = makeMsg('user', 'hello');
    const result = attachCompactBoundaryMetadata([other, boundaryMessage(), summaryMessage()]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(other);
    const raw = result[1].raw as Record<string, unknown>;
    expect(raw.isCompactSummary).toBe(true);
    expect(raw.compactMetadata).toMatchObject({
      trigger: 'manual',
      preTokens: 524835,
      postTokens: 14582,
      durationMs: 109542,
    });
  });

  it('returns the same array reference when no boundary line is present', () => {
    const messages = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')];
    expect(attachCompactBoundaryMetadata(messages)).toBe(messages);
  });

  it('does not overwrite metadata the summary already carries', () => {
    const summary = summaryMessage();
    (summary.raw as Record<string, unknown>).compactMetadata = { trigger: 'auto', preTokens: 1 };
    const result = attachCompactBoundaryMetadata([boundaryMessage(), summary]);

    expect(result).toHaveLength(1);
    expect((result[0].raw as Record<string, unknown>).compactMetadata).toMatchObject({ trigger: 'auto', preTokens: 1 });
  });

  it('pairs across intermediate messages between boundary and summary', () => {
    const between = makeMsg('assistant', 'unrelated');
    const result = attachCompactBoundaryMetadata([boundaryMessage(), between, summaryMessage()]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(between);
    expect((result[1].raw as Record<string, unknown>).compactMetadata).toMatchObject({ trigger: 'manual' });
  });
});

// ---------------------------------------------------------------------------
// getContentBlocks — compact summary metadata subtitle wiring
// ---------------------------------------------------------------------------

describe('getContentBlocks — compact summary compactMetadata', () => {
  const normalizeBlocksFn = () => null;
  const localizeMessage = (text: string) => text;

  it('exposes compactMetadata as the compact_summary block metadata', () => {
    const message: ClaudeMessage = {
      type: 'notification',
      content: '',
      raw: {
        type: 'user',
        isCompactSummary: true,
        compactMetadata: { trigger: 'manual', preTokens: 524835, postTokens: 14582, durationMs: 109542 },
        message: { role: 'user', content: 'This session is being continued…' },
      } as ClaudeMessage['raw'],
    };

    const blocks = getContentBlocks(message, normalizeBlocksFn, localizeMessage);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'compact_summary',
      content: 'This session is being continued…',
      metadata: { trigger: 'manual', preTokens: 524835, postTokens: 14582, durationMs: 109542 },
    });
  });

  it('still honors the legacy summarizeMetadata shape', () => {
    const message: ClaudeMessage = {
      type: 'notification',
      content: '',
      raw: {
        type: 'user',
        isCompactSummary: true,
        summarizeMetadata: { messagesSummarized: 12, direction: 'up_to' },
        message: { role: 'user', content: 'summary' },
      } as ClaudeMessage['raw'],
    };

    const blocks = getContentBlocks(message, normalizeBlocksFn, localizeMessage);
    expect(blocks[0]).toMatchObject({
      type: 'compact_summary',
      title: 'chat.compactSummary.summarizedConversation',
      metadata: { messagesSummarized: 12 },
    });
  });
});
