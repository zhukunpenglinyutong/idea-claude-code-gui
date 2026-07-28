import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeContentBlock } from '../../types';
import { ContentBlockRenderer } from './ContentBlockRenderer';

// Capture the props MarkdownBlock receives without rendering the real marked
// pipeline. The block-level streaming flag is the value under test here.
const { markdownProps } = vi.hoisted(() => ({
  markdownProps: { isStreaming: undefined as boolean | undefined },
}));

vi.mock('../MarkdownBlock', () => ({
  default: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => {
    markdownProps.isStreaming = isStreaming;
    return <div data-testid="md">{content}</div>;
  },
}));

vi.mock('../CollapsibleTextBlock', () => ({ default: () => <div /> }));
vi.mock('../toolBlocks', () => ({
  BashToolBlock: () => null,
  EditToolBlock: () => null,
  GenericToolBlock: () => null,
  TaskExecutionBlock: () => null,
}));

const t = ((key: string) => key) as unknown as React.ComponentProps<
  typeof ContentBlockRenderer
>['t'];

const tableBlock = (): ClaudeContentBlock =>
  ({ type: 'text', text: '| a |\n|---|\n| 1 |' }) as unknown as ClaudeContentBlock;

function renderTextBlock({ isStreaming, isLastBlock }: { isStreaming: boolean; isLastBlock: boolean }) {
  markdownProps.isStreaming = undefined;
  return render(
    <ContentBlockRenderer
      block={tableBlock()}
      messageIndex={0}
      messageType="assistant"
      isStreaming={isStreaming}
      isThinkingExpanded={false}
      isThinking={false}
      isLastMessage={false}
      isLastBlock={isLastBlock}
      t={t}
      onToggleThinking={() => {}}
      findToolResult={() => null}
    />,
  );
}

describe('ContentBlockRenderer block-level streaming', () => {
  it('keeps the last block streaming while the message is still streaming', () => {
    renderTextBlock({ isStreaming: true, isLastBlock: true });
    expect(markdownProps.isStreaming).toBe(true);
  });

  it('drops an earlier text block out of streaming once a later block arrives', () => {
    // A tool call (or any later block) arriving makes this text block non-last.
    // It must leave the lightweight streaming renderer for the full marked
    // pipeline, otherwise tables/lists stay hidden until the whole turn ends.
    renderTextBlock({ isStreaming: true, isLastBlock: false });
    expect(markdownProps.isStreaming).toBe(false);
  });

  it('renders with the full pipeline once the message has stopped streaming', () => {
    renderTextBlock({ isStreaming: false, isLastBlock: true });
    expect(markdownProps.isStreaming).toBe(false);
  });
});
