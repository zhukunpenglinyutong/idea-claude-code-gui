import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import { MessageList } from './MessageList';

// Mock MessageItem to keep this suite focused on list-level paging behaviour.
vi.mock('./MessageItem', () => ({
  MessageItem: ({ messageKey, message }: { messageKey: string; message: ClaudeMessage }) => (
    <div data-testid="message-item" data-key={messageKey} data-type={message.type}>
      {message.content}
    </div>
  ),
}));

vi.mock('./WaitingIndicator', () => ({
  default: () => <div data-testid="waiting-indicator">waiting</div>,
}));

vi.mock('./ContextMenu', () => ({
  ContextMenu: () => null,
}));

vi.mock('../hooks/useContextMenu.js', () => ({
  useContextMenu: () => ({
    visible: false,
    x: 0,
    y: 0,
    savedRange: null,
    selectedText: '',
    open: vi.fn(),
    close: vi.fn(),
  }),
  copySelection: vi.fn(),
}));

const t = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'chat.showEarlierMessages') {
    const count = opts?.count ?? 0;
    return `Show ${count} earlier`;
  }
  if (key === 'chat.showEarlierTurns') {
    return `Show ${opts?.count ?? 0} earlier turns (${opts?.remaining ?? 0} remaining)`;
  }
  if (key === 'chat.loadEarlierTurns') {
    return `Load ${opts?.count ?? 0} earlier turns (${opts?.remaining ?? 0} remaining)`;
  }
  if (key === 'chat.loadingEarlierTurns') return 'Loading earlier turns...';
  return key;
}) as never;

function makeMessages(count: number, idPrefix = 'm'): ClaudeMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    id: `${idPrefix}-${i}`,
  }) as unknown as ClaudeMessage);
}

function makeToolDenseTurns(turnCount: number): ClaudeMessage[] {
  return Array.from({ length: turnCount }, (_, turn) => [
    { type: 'user', content: `user ${turn}`, id: `user-${turn}` },
    { type: 'assistant', content: `thinking ${turn}`, id: `thinking-${turn}` },
    {
      type: 'assistant',
      content: `tool ${turn}`,
      id: `tool-${turn}`,
      raw: { content: [{ type: 'tool_use', id: `call-${turn}`, name: 'Read', input: {} }] },
    },
    {
      type: 'user',
      content: '[tool_result]',
      id: `result-${turn}`,
      raw: { content: [{ type: 'tool_result', tool_use_id: `call-${turn}`, content: 'ok' }] },
    },
    { type: 'assistant', content: `answer ${turn}`, id: `answer-${turn}` },
  ]).flat() as unknown as ClaudeMessage[];
}

const noopGetText = (m: ClaudeMessage) => m.content ?? '';
const noopGetBlocks = (_m: ClaudeMessage): ClaudeContentBlock[] => [];
const noopFindToolResult = (_id: string | undefined, _i: number): ToolResultBlock | null => null;
const noopExtractMd = (_m: ClaudeMessage) => '';

function renderList(messages: ClaudeMessage[]) {
  const endRef = createRef<HTMLDivElement>();
  return render(
    <MessageList
      messages={messages}
      streamingActive={false}
      isThinking={false}
      loading={false}
      loadingStartTime={null}
      t={t}
      getMessageText={noopGetText}
      getContentBlocks={noopGetBlocks}
      findToolResult={noopFindToolResult}
      extractMarkdownContent={noopExtractMd}
      messagesEndRef={endRef}
    />
  );
}

describe('MessageList paged collapse', () => {
  afterEach(() => {
    cleanup();
    delete window.sendToJava;
    delete window.__codexHistoryPageInfo;
  });

  it('renders all messages when there are at most five user turns', () => {
    renderList(makeMessages(10));
    expect(screen.getAllByTestId('message-item')).toHaveLength(10);
    expect(screen.queryByText(/Show.*earlier/)).toBeNull();
  });

  it('collapses earlier complete turns when there are more than five user turns', () => {
    const { container } = renderList(makeMessages(50));
    expect(screen.getAllByTestId('message-item')).toHaveLength(10);
    const indicator = container.querySelector('.collapsed-messages-indicator');
    expect(indicator).toBeTruthy();
    expect(indicator?.textContent).toBe('Show 5 earlier turns (20 remaining)');
  });

  it('reveals five complete turns per click instead of expanding everything', () => {
    const { container } = renderList(makeMessages(100));
    expect(screen.getAllByTestId('message-item')).toHaveLength(10);

    const indicator = container.querySelector('.collapsed-messages-indicator');
    expect(indicator?.textContent).toBe('Show 5 earlier turns (45 remaining)');
    fireEvent.click(indicator!);
    expect(screen.getAllByTestId('message-item')).toHaveLength(20);

    fireEvent.click(container.querySelector('.collapsed-messages-indicator')!);
    expect(screen.getAllByTestId('message-item')).toHaveLength(30);
  });

  it('removes the indicator once everything is revealed', () => {
    const { container } = renderList(makeMessages(16));
    const indicator = container.querySelector('.collapsed-messages-indicator');
    expect(indicator?.textContent).toBe('Show 3 earlier turns (3 remaining)');

    fireEvent.click(indicator!);
    expect(screen.getAllByTestId('message-item')).toHaveLength(16);
    expect(container.querySelector('.collapsed-messages-indicator')).toBeNull();
  });

  it('never starts rendering in the middle of an assistant and tool chain', () => {
    const { container } = renderList(makeToolDenseTurns(8));
    const visible = screen.getAllByTestId('message-item');

    expect(visible).toHaveLength(25);
    expect(visible[0].textContent).toBe('user 3');
    expect(container.querySelector('.collapsed-messages-indicator')?.textContent)
      .toBe('Show 3 earlier turns (3 remaining)');
  });

  it('tolerates malformed raw content blocks from history transport', () => {
    const messages = makeMessages(14);
    messages[0] = {
      ...messages[0],
      raw: { content: [null, 'unexpected'] },
    } as unknown as ClaudeMessage;

    expect(() => renderList(messages)).not.toThrow();
    expect(screen.getAllByTestId('message-item')).toHaveLength(10);
  });

  it('reports collapsedCount changes to parent for anchor rail sync', () => {
    const onCollapsedCountChange = vi.fn();
    const messages = makeMessages(60);
    const endRef = createRef<HTMLDivElement>();
    const { rerender, container } = render(
      <MessageList
        messages={messages}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
        onCollapsedCountChange={onCollapsedCountChange}
      />
    );

    expect(onCollapsedCountChange).toHaveBeenLastCalledWith(50);

    // Reveal one chunk
    const indicator = container.querySelector('.collapsed-messages-indicator');
    fireEvent.click(indicator!);
    expect(onCollapsedCountChange).toHaveBeenLastCalledWith(40);

    // Trigger a session switch via first-message-id change
    rerender(
      <MessageList
        messages={makeMessages(50, 'session2')}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
        onCollapsedCountChange={onCollapsedCountChange}
      />
    );
    expect(onCollapsedCountChange).toHaveBeenLastCalledWith(40);
  });

  it('resets revealed turns when id-less history messages switch sessions', () => {
    const firstSession = makeMessages(40).map(({ id: _id, ...message }, index) => ({
      ...message,
      timestamp: `2026-07-16T10:00:${String(index).padStart(2, '0')}.000Z`,
    })) as ClaudeMessage[];
    const secondSession = makeMessages(40).map(({ id: _id, ...message }, index) => ({
      ...message,
      timestamp: `2026-07-17T10:00:${String(index).padStart(2, '0')}.000Z`,
    })) as ClaudeMessage[];
    const endRef = createRef<HTMLDivElement>();
    const { container, rerender } = render(
      <MessageList
        messages={firstSession}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
      />
    );

    fireEvent.click(container.querySelector('.collapsed-messages-indicator')!);
    expect(screen.getAllByTestId('message-item')).toHaveLength(20);

    rerender(
      <MessageList
        messages={secondSession}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
      />
    );

    expect(screen.getAllByTestId('message-item')).toHaveLength(10);
  });

  it('requests the previous disk page only after all loaded turns are revealed', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    const endRef = createRef<HTMLDivElement>();
    const { container } = render(
      <MessageList
        messages={makeMessages(20)}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
        currentProvider="codex"
        currentSessionId="session-1"
      />
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('codex-history-page-info', {
        detail: {
          pageId: 'page-1',
          sessionId: 'session-1',
          mode: 'replace',
          fromTurn: 70,
          toTurn: 100,
          totalTurns: 100,
          hasMore: true,
          loadedMessageCount: 20,
        },
      }));
    });

    fireEvent.click(container.querySelector('.collapsed-messages-indicator')!);
    expect(container.querySelector('.collapsed-messages-indicator')?.textContent)
      .toBe('Load 30 earlier turns (70 remaining)');

    fireEvent.click(container.querySelector('.collapsed-messages-indicator')!);
    expect(sendToJava).toHaveBeenCalledWith(
      'load_codex_history_page:{"sessionId":"session-1","beforeTurn":70}',
    );
    expect(container.querySelector('.collapsed-messages-indicator')?.textContent)
      .toBe('Loading earlier turns...');
  });
});

describe('MessageList container behaviour', () => {
  afterEach(cleanup);

  it('uses the latest message index for isLast even when paginated', () => {
    const messages = makeMessages(40);
    renderList(messages);
    const items = screen.getAllByTestId('message-item');
    const last = items[items.length - 1];
    // The last item must correspond to messages[39]
    expect(last.textContent).toBe('message 39');
  });

  it('renders waiting indicator when loading', () => {
    const endRef = createRef<HTMLDivElement>();
    render(
      <MessageList
        messages={makeMessages(3)}
        streamingActive={false}
        isThinking={false}
        loading={true}
        loadingStartTime={Date.now()}
        t={t}
        getMessageText={noopGetText}
        getContentBlocks={noopGetBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={noopExtractMd}
        messagesEndRef={endRef}
      />
    );
    expect(screen.getByTestId('waiting-indicator')).toBeTruthy();
  });
});
