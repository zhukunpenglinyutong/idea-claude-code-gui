import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage, ToolResultBlock } from '../../types';
import { extractMarkdownContent } from '../../utils/copyUtils';
import { MessageItem } from './MessageItem';

vi.mock('../MarkdownBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-block">{content}</div>,
}));

vi.mock('../toolBlocks', () => ({
  ReadToolBlock: () => <div data-testid="read-tool-block">read</div>,
  ReadToolGroupBlock: () => <div data-testid="read-tool-group-block">read-group</div>,
  EditToolBlock: () => <div data-testid="edit-tool-block">edit</div>,
  EditToolGroupBlock: () => <div data-testid="edit-tool-group-block">edit-group</div>,
  BashToolBlock: () => <div data-testid="bash-tool-block">bash</div>,
  BashToolGroupBlock: () => <div data-testid="bash-tool-group-block">bash-group</div>,
  SearchToolGroupBlock: () => <div data-testid="search-tool-group-block">search-group</div>,
}));

vi.mock('./ContentBlockRenderer', () => ({
  ContentBlockRenderer: ({ block }: { block: ClaudeContentBlock }) => (
    <div data-testid={`content-block-${block.type}`}>{block.type}</div>
  ),
}));

vi.mock('./ProviderNotConfiguredCard', () => ({
  ProviderNotConfiguredCard: () => <div data-testid="provider-not-configured-card">provider-card</div>,
  isProviderNotConfiguredError: () => false,
}));

const t = ((key: string, opts?: Record<string, string>) => {
  const translations: Record<string, string> = {
    'markdown.copyMessage': '复制消息',
    'markdown.copySuccess': '已复制',
    'chat.streamingConnected': '已连接',
    'chat.totalDuration': '本次耗时',
    'chat.tokenUsage': '输入 {{input}} / 输出 {{output}}',
    'chat.tokenUsageDetail': '本轮合计 — 输入 {{input}} · 缓存写入 {{cacheWrite}} · 缓存读取 {{cacheRead}} · 输出 {{output}}',
    'chat.cacheHitsWithRatio': '（缓存命中 {{tokens}}，{{ratio}}）',
  };
  let result = translations[key] ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      result = result.replace(`{{${k}}}`, v);
    }
  }
  return result;
}) as any;

const getMessageText = (message: ClaudeMessage) => message.content ?? '';

const getContentBlocks = (message: ClaudeMessage): ClaudeContentBlock[] => {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') {
    return [];
  }

  const content = Array.isArray(raw.content)
    ? raw.content
    : Array.isArray(raw.message?.content)
      ? raw.message.content
      : [];

  return content as ClaudeContentBlock[];
};

const findToolResult = (_toolId: string | undefined, _messageIndex: number): ToolResultBlock | null => null;

function renderMessageItem(message: ClaudeMessage, options: { detailedOutputEnabled?: boolean } = {}) {
  return render(
    <MessageItem
      message={message}
      messageIndex={0}
      messageKey="message-0"
      isLast={false}
      streamingActive={false}
      isThinking={false}
      t={t}
      getMessageText={getMessageText}
      getContentBlocks={getContentBlocks}
      findToolResult={findToolResult}
      extractMarkdownContent={extractMarkdownContent}
      detailedOutputEnabled={options.detailedOutputEnabled}
    />
  );
}

describe('MessageItem copy button visibility', () => {
  it('hides the assistant copy button for tool-only messages', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Tool: shell_command',
      raw: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'shell_command',
            input: { cmd: 'git status' },
          },
        ],
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByTestId('bash-tool-block')).toBeTruthy();
    expect(screen.queryByTestId('content-block-text')).toBeNull();
    expect(screen.queryByRole('button', { name: '复制消息' })).toBeNull();
  });

  it('keeps the assistant copy button when tool output is followed by reply text', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      raw: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'shell_command',
            input: { cmd: 'git status' },
          },
          {
            type: 'text',
            text: '提交完成。',
          },
        ],
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByTestId('bash-tool-block')).toBeTruthy();
    expect(screen.getByTestId('content-block-text')).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制消息' })).toBeTruthy();
  });

  it('groups consecutive exec_command blocks into the batch command tool block', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      raw: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'exec_command',
            input: { command: 'git status' },
          },
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'exec_command',
            input: { command: 'git diff --cached' },
          },
        ],
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByTestId('bash-tool-group-block')).toBeTruthy();
    expect(screen.queryAllByTestId('content-block-tool_use')).toHaveLength(0);
  });
});

describe('MessageItem token usage display', () => {
  it('shows whole-turn token usage without detailed extras by default', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Hello',
      durationMs: 16000,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
        turnUsage: {
          input_tokens: 1200,
          output_tokens: 456,
        },
        turnCostUsd: 0.006,
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByText('0:16')).toBeTruthy();
    expect(screen.getByText('输入 1.2K / 输出 456')).toBeTruthy();
    expect(screen.queryByText(/\$0\.0060/)).toBeNull();
  });

  it('shows turn cost only when detailed output is enabled', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Hello',
      durationMs: 16000,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
        turnUsage: {
          input_tokens: 1200,
          output_tokens: 456,
        },
        turnCostUsd: 0.006,
      } as any,
    };

    renderMessageItem(message, { detailedOutputEnabled: true });

    expect(screen.getByText('0:16')).toBeTruthy();
    expect(screen.getByText('输入 1.2K / 输出 456')).toBeTruthy();
    expect(screen.getByText('$0.0060')).toBeTruthy();
  });

  it('counts cache tokens in the input total and details them in the tooltip', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Hello',
      durationMs: 10000,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
        turnUsage: {
          input_tokens: 37,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 36310,
          output_tokens: 353,
        },
      } as any,
    };

    renderMessageItem(message, { detailedOutputEnabled: true });

    // Input shows the full input side (37 + 0 + 36310 = 36347 → "36.3K"),
    // so heavy cache reads are never hidden from the user.
    const tokens = screen.getByText('输入 36.3K（缓存命中 36.3K，100%） / 输出 353');
    expect(tokens).toBeTruthy();
    expect(tokens.getAttribute('title')).toBe(
      '本轮合计 — 输入 37 · 缓存写入 0 · 缓存读取 36.3K · 输出 353'
    );
  });

  it('hides cache hit ratio when detailed output is disabled', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Hello',
      durationMs: 10000,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
        turnUsage: {
          input_tokens: 37,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 36310,
          output_tokens: 353,
        },
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByText('输入 36.3K / 输出 353')).toBeTruthy();
    expect(screen.queryByText(/缓存命中/)).toBeNull();
  });

  it('ignores per-call usage fields (message.usage / top-level usage)', () => {
    // Regression guard: message.usage is the per-call context-occupancy value
    // for the status bar and top-level usage is the session-cumulative Codex
    // value — rendering either would misstate what the turn consumed.
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Hello',
      durationMs: 5000,
      raw: {
        content: [{ type: 'text', text: 'Hello' }],
        usage: {
          input_tokens: 500000,
          output_tokens: 9000,
        },
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          usage: {
            input_tokens: 37,
            output_tokens: 353,
          },
        },
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByText('0:05')).toBeTruthy();
    expect(screen.queryByText(/输入/)).toBeNull();
  });

  it('does not show token usage when no turnUsage is present', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Hello',
      durationMs: 3000,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByText('0:03')).toBeTruthy();
    expect(screen.queryByText(/输入/)).toBeNull();
  });

  it('does not show token usage when tokens are all zero', () => {
    const message: ClaudeMessage = {
      type: 'assistant',
      content: 'Hello',
      durationMs: 3000,
      raw: {
        message: {
          content: [{ type: 'text', text: 'Hello' }],
        },
        turnUsage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      } as any,
    };

    renderMessageItem(message);

    expect(screen.getByText('0:03')).toBeTruthy();
    expect(screen.queryByText(/输入/)).toBeNull();
  });
});
