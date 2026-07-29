import { memo, useState, useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle, useLayoutEffect } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, CodexHistoryPageInfo, ToolResultBlock } from '../types';
import { getMessageKey } from '../utils/messageUtils';
import { sendBridgeEvent } from '../utils/bridge';
import { MessageItem } from './MessageItem';
import WaitingIndicator from './WaitingIndicator';
import { ContextMenu } from './ContextMenu';
import { useContextMenu, copySelection } from '../hooks/useContextMenu.js';
import type { MessageListRevealHandle } from './ConversationSearch/types';
import {
  DETAILED_OUTPUT_ENABLED_EVENT,
  getDetailedOutputEnabled,
  type DetailedOutputEnabledChangedDetail,
} from '../utils/detailedOutputPreference';

/** Keep pagination aligned to complete user turns so assistant/tool chains are never split. */
const INITIAL_VISIBLE_TURNS = 5;
const REVEAL_TURN_PAGE_SIZE = 5;
const HISTORY_DISK_PAGE_SIZE = 30;

function isHumanUserMessage(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;

  const raw = typeof message.raw === 'object' && message.raw !== null ? message.raw : null;
  const nestedMessage = raw?.message;
  const rawContent = raw?.content ?? (
    typeof nestedMessage === 'object' && nestedMessage !== null ? nestedMessage.content : undefined
  );

  if (Array.isArray(rawContent)) {
    return rawContent.some((block) => block
      && typeof block === 'object'
      && (block.type === 'text' || block.type === 'image'));
  }

  return message.content !== '[tool_result]';
}

function getFirstMessageBoundaryKey(message: ClaudeMessage | undefined): string | undefined {
  if (!message) return undefined;
  if (typeof message.id === 'string') return `id:${message.id}`;
  if (typeof message.raw === 'object' && message.raw !== null && typeof message.raw.uuid === 'string') {
    return `uuid:${message.raw.uuid}`;
  }
  if (message.timestamp) return `timestamp:${message.type}:${message.timestamp}`;
  return `content:${message.type}:${message.content ?? ''}`;
}

interface MessageRenderKeySnapshot {
  keys: string[];
  identityToKey: Map<string, string>;
}

function keepMessageRenderKeysSteady(
  messages: ClaudeMessage[],
  rememberedIdentities: ReadonlyMap<string, string>,
): MessageRenderKeySnapshot {
  const turnOccurrences = new Map<number, number>();
  const identityToKey = new Map<string, string>();

  const keys = messages.map((message, index) => {
    const rawUuid = typeof message.raw === 'object'
      && message.raw !== null
      && typeof message.raw.uuid === 'string'
      && message.raw.uuid.length > 0
      ? message.raw.uuid
      : undefined;
    const uuidIdentity = rawUuid ? `uuid:${rawUuid}` : undefined;
    let turnIdentity: string | undefined;
    let defaultTurnKey: string | undefined;

    if (typeof message.__turnId === 'number') {
      const occurrence = turnOccurrences.get(message.__turnId) ?? 0;
      turnOccurrences.set(message.__turnId, occurrence + 1);
      turnIdentity = `turn:${message.__turnId}:${occurrence}`;
      defaultTurnKey = occurrence === 0
        ? `turn-${message.__turnId}`
        : `turn-${message.__turnId}-${occurrence}`;
    }

    // A streaming placeholder starts without a backend UUID. When the tool-use
    // snapshot arrives, raw.uuid is added while __turnId continues to identify
    // the same live bubble. Keep the turn key during that identity enrichment
    // so React preserves MessageItem's thinking expansion state. Remember both
    // identities once they meet, which also keeps UUID-first replay messages
    // mounted when a runtime turn ID is attached later.
    const rememberedKey = (turnIdentity && rememberedIdentities.get(turnIdentity))
      || (uuidIdentity && rememberedIdentities.get(uuidIdentity));
    const renderKey = rememberedKey
      || (rawUuid ? getMessageKey(message, index) : defaultTurnKey)
      || getMessageKey(message, index);

    if (turnIdentity) identityToKey.set(turnIdentity, renderKey);
    if (uuidIdentity) identityToKey.set(uuidIdentity, renderKey);
    return renderKey;
  });

  return { keys, identityToKey };
}

function extractToolResultPreview(result: ToolResultBlock | null | undefined): string {
  if (!result) return 'pending';

  let text = '';
  if (typeof result.content === 'string') {
    text = result.content;
  } else if (Array.isArray(result.content)) {
    text = result.content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }

  const preview = text.length > 200 ? text.slice(0, 200) : text;
  return `${result.is_error === true ? 'error' : 'ok'}:${text.length}:${preview}`;
}

function getMessageToolResultSignature(
  message: ClaudeMessage,
  messageIndex: number,
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined,
): string {
  const toolUses = getContentBlocks(message).filter(
    (block): block is Extract<ClaudeContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
  );
  if (toolUses.length === 0) return '';

  return toolUses
    .map((block) => `${block.id ?? 'unknown'}:${extractToolResultPreview(findToolResult(block.id, messageIndex))}`)
    .join('|');
}

interface MessageListProps {
  messages: ClaudeMessage[];
  streamingActive: boolean;
  isThinking: boolean;
  loading: boolean;
  loadingStartTime: number | null;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent: (message: ClaudeMessage) => string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onMessageNodeRef?: (id: string, node: HTMLDivElement | null) => void;
  /** Notify parent when the number of collapsed (hidden) messages changes. */
  onCollapsedCountChange?: (count: number) => void;
  onNavigateToProviderSettings?: () => void;
  onNavigateToDependencySettings?: () => void;
  /** Current active provider id; forwarded to MessageItem for streaming-connect label. */
  currentProvider?: string;
  /** Callback when user clicks the rollback button on a user message */
  onRollbackUserMessage?: (messageIndex: number, message: ClaudeMessage) => void;
  /** Whether a rollback operation is currently in progress */
  isRollingBack?: boolean;
  currentSessionId?: string | null;
}

export const MessageList = memo(forwardRef<MessageListRevealHandle, MessageListProps>(function MessageList({
  messages,
  streamingActive,
  isThinking,
  loading,
  loadingStartTime,
  t,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
  messagesEndRef,
  onMessageNodeRef,
  onCollapsedCountChange,
  onNavigateToProviderSettings,
  onNavigateToDependencySettings,
  currentProvider,
  onRollbackUserMessage,
  isRollingBack = false,
  currentSessionId,
}, ref) {
  const [revealedTurnCount, setRevealedTurnCount] = useState(0);
  const [historyPageInfo, setHistoryPageInfo] = useState<CodexHistoryPageInfo | null>(null);
  const [loadingEarlierHistory, setLoadingEarlierHistory] = useState(false);
  const loadingEarlierHistoryRef = useRef(false);
  const [detailedOutputEnabled, setDetailedOutputEnabled] = useState(() =>
    getDetailedOutputEnabled()
  );

  // Context menu for message list (copy only, when text selected)
  const ctxMenu = useContextMenu();
  const handleMessageContextMenu = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      ctxMenu.open(e);
    }
  }, [ctxMenu.open]);

  // Use explicit session identity in production; keep the message boundary for isolated callers/tests.
  const previousSessionRef = useRef(currentSessionId);
  const firstMessageBoundaryRef = useRef(getFirstMessageBoundaryKey(messages[0]));
  useEffect(() => {
    const currentBoundary = getFirstMessageBoundaryKey(messages[0]);
    const sessionChanged = currentSessionId != null
      ? currentSessionId !== previousSessionRef.current
      : currentBoundary !== firstMessageBoundaryRef.current;
    if (sessionChanged) {
      setRevealedTurnCount(0);
      setLoadingEarlierHistory(false);
      loadingEarlierHistoryRef.current = false;
      const cached = window.__codexHistoryPageInfo;
      setHistoryPageInfo(
        currentProvider === 'codex' && cached?.sessionId === currentSessionId ? cached ?? null : null,
      );
    }
    previousSessionRef.current = currentSessionId;
    firstMessageBoundaryRef.current = currentBoundary;
  }, [currentProvider, currentSessionId, messages]);

  useEffect(() => {
    const handlePageInfo = (event: Event) => {
      const info = (event as CustomEvent<CodexHistoryPageInfo>).detail;
      if (currentProvider !== 'codex' || !info || info.sessionId !== currentSessionId) return;
      setHistoryPageInfo(info);
      setLoadingEarlierHistory(false);
      loadingEarlierHistoryRef.current = false;
    };
    const handlePageError = (event: Event) => {
      const error = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (!error?.sessionId || error.sessionId === currentSessionId) {
        setLoadingEarlierHistory(false);
        loadingEarlierHistoryRef.current = false;
      }
    };

    window.addEventListener('codex-history-page-info', handlePageInfo);
    window.addEventListener('codex-history-page-error', handlePageError);
    const cached = window.__codexHistoryPageInfo;
    if (currentProvider === 'codex' && cached?.sessionId === currentSessionId) {
      setHistoryPageInfo(cached ?? null);
    }
    return () => {
      window.removeEventListener('codex-history-page-info', handlePageInfo);
      window.removeEventListener('codex-history-page-error', handlePageError);
    };
  }, [currentProvider, currentSessionId]);

  const userTurnStartIndexes = useMemo(
    () => messages.reduce<number[]>((indexes, message, index) => {
      if (isHumanUserMessage(message)) indexes.push(index);
      return indexes;
    }, []),
    [messages],
  );
  const visibleTurnCount = Math.min(
    userTurnStartIndexes.length,
    INITIAL_VISIBLE_TURNS + revealedTurnCount,
  );
  const hiddenTurnCount = userTurnStartIndexes.length - visibleTurnCount;
  const collapsedCount = hiddenTurnCount > 0 ? userTurnStartIndexes[hiddenTurnCount] : 0;
  const shouldCollapse = collapsedCount > 0;
  const nextTurnCount = Math.min(REVEAL_TURN_PAGE_SIZE, hiddenTurnCount);

  const canLoadEarlierFromDisk = Boolean(currentProvider === 'codex'
    && historyPageInfo?.sessionId === currentSessionId
    && historyPageInfo?.hasMore);
  const handleRevealMore = useCallback(() => {
    if (hiddenTurnCount > 0) {
      setRevealedTurnCount((prev) => prev + REVEAL_TURN_PAGE_SIZE);
      return;
    }
    if (!canLoadEarlierFromDisk || loadingEarlierHistoryRef.current || !currentSessionId || !historyPageInfo) {
      return;
    }

    loadingEarlierHistoryRef.current = true;
    setLoadingEarlierHistory(true);
    const sent = sendBridgeEvent('load_codex_history_page', JSON.stringify({
      sessionId: currentSessionId,
      beforeTurn: historyPageInfo.fromTurn,
    }));
    if (!sent) {
      loadingEarlierHistoryRef.current = false;
      setLoadingEarlierHistory(false);
    }
  }, [canLoadEarlierFromDisk, currentSessionId, hiddenTurnCount, historyPageInfo]);

  // Imperative API so the in-page search can expand everything before scanning.
  // Returns the number of messages that were just revealed (0 when nothing
  // was collapsed). This lets the search panel surface "Expanded N earlier
  // messages" exactly once per panel-open, per the agreed design.
  useImperativeHandle(ref, (): MessageListRevealHandle => ({
    revealAll: () => {
      const previouslyHidden = collapsedCount;
      if (previouslyHidden === 0) return 0;
      setRevealedTurnCount(userTurnStartIndexes.length);
      return previouslyHidden;
    },
  }), [collapsedCount, userTurnStartIndexes.length]);

  // Notify parent of collapsed count changes (for anchor rail sync)
  useEffect(() => {
    onCollapsedCountChange?.(collapsedCount);
  }, [collapsedCount, onCollapsedCountChange]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<DetailedOutputEnabledChangedDetail>;
      if (custom.detail && typeof custom.detail.enabled === 'boolean') {
        setDetailedOutputEnabled(custom.detail.enabled);
      }
    };
    window.addEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
    return () => window.removeEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
  }, []);

  const visibleMessages = useMemo(
    () => (shouldCollapse ? messages.slice(collapsedCount) : messages),
    [messages, shouldCollapse, collapsedCount]
  );
  const rememberedMessageKeysRef = useRef<ReadonlyMap<string, string>>(new Map());
  const messageRenderKeySnapshot = useMemo(
    () => keepMessageRenderKeysSteady(messages, rememberedMessageKeysRef.current),
    [messages],
  );
  useLayoutEffect(() => {
    rememberedMessageKeysRef.current = messageRenderKeySnapshot.identityToKey;
  }, [messageRenderKeySnapshot]);

  return (
    <div onContextMenu={handleMessageContextMenu}>
      {ctxMenu.visible && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={ctxMenu.close}
          items={[
            { label: t('contextMenu.copy', 'Copy'), action: () => copySelection(ctxMenu.savedRange, ctxMenu.selectedText) },
          ]}
        />
      )}
      {(shouldCollapse || canLoadEarlierFromDisk) && (
        <div
          className="collapsed-messages-indicator"
          onClick={handleRevealMore}
        >
          {loadingEarlierHistory
            ? t('chat.loadingEarlierTurns')
            : shouldCollapse
              ? t('chat.showEarlierTurns', {
                count: nextTurnCount,
                remaining: hiddenTurnCount,
                total: historyPageInfo?.totalTurns,
              })
              : t('chat.loadEarlierTurns', {
                count: Math.min(HISTORY_DISK_PAGE_SIZE, historyPageInfo?.fromTurn ?? 0),
                remaining: historyPageInfo?.fromTurn ?? 0,
                total: historyPageInfo?.totalTurns ?? 0,
              })}
        </div>
      )}

      {visibleMessages.map((message, visibleIndex) => {
        const messageIndex = shouldCollapse ? visibleIndex + collapsedCount : visibleIndex;
        const messageKey = messageRenderKeySnapshot.keys[messageIndex];
        const toolResultSignature = getMessageToolResultSignature(message, messageIndex, getContentBlocks, findToolResult);

        return (
          <MessageItem
            key={messageKey}
            message={message}
            messageIndex={messageIndex}
            messageKey={messageKey}
            isLast={messageIndex === messages.length - 1}
            streamingActive={streamingActive}
            isThinking={isThinking}
            t={t}
            getMessageText={getMessageText}
            getContentBlocks={getContentBlocks}
            findToolResult={findToolResult}
            extractMarkdownContent={extractMarkdownContent}
            onNodeRef={onMessageNodeRef}
            onNavigateToProviderSettings={onNavigateToProviderSettings}
            onNavigateToDependencySettings={onNavigateToDependencySettings}
            toolResultSignature={toolResultSignature}
            currentProvider={currentProvider}
            onRollback={onRollbackUserMessage}
            isRollingBack={isRollingBack}
            detailedOutputEnabled={detailedOutputEnabled}
          />
        );
      })}

      {/* Loading indicator */}
      {loading && <WaitingIndicator startTime={loadingStartTime ?? undefined} />}
      <div ref={messagesEndRef} />
    </div>
  );
}));
