import { useState, useCallback, useMemo, memo, useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import { ProviderNotConfiguredCard, isProviderNotConfiguredError } from './ProviderNotConfiguredCard';
import { ErrorDiagnosticCard } from './ErrorDiagnosticCard';
import { matchErrorPattern } from '../../utils/errorMatcher';
import {
  EditToolBlock,
  EditToolGroupBlock,
  ReadToolBlock,
  ReadToolGroupBlock,
  BashToolBlock,
  BashToolGroupBlock,
  SearchToolGroupBlock,
  AgentGroupBlock,
} from '../toolBlocks';
import { ContentBlockRenderer } from './ContentBlockRenderer';
import { formatTime } from '../../utils/helpers';
import { copyToClipboard } from '../../utils/copyUtils';
import { READ_TOOL_NAMES, EDIT_TOOL_NAMES, BASH_TOOL_NAMES, SEARCH_TOOL_NAMES, AGENT_TOOL_NAMES, isToolName } from '../../utils/toolConstants';

export interface MessageItemProps {
  message: ClaudeMessage;
  messageIndex: number;
  messageKey: string;
  isLast: boolean;
  streamingActive: boolean;
  isThinking: boolean;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  extractMarkdownContent: (message: ClaudeMessage) => string;
  onNodeRef?: (id: string, node: HTMLDivElement | null) => void;
  onNavigateToProviderSettings?: () => void;
  onNavigateToDependencySettings?: () => void;
  toolResultSignature?: string;
  /** Current active provider id (e.g. 'claude', 'codex'); drives the streaming-connect label. */
  currentProvider?: string;
}

/** Map provider id to a human-readable label used in UI text. */
function getProviderDisplayName(providerId?: string): string {
  if (providerId === 'codex') return 'Codex';
  return 'Claude';
}

type GroupedBlock =
  | { type: 'single'; block: ClaudeContentBlock; originalIndex: number }
  | { type: 'read_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'edit_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'bash_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'search_group'; blocks: ClaudeContentBlock[]; startIndex: number }
  | { type: 'agent_group'; agentBlock: ClaudeContentBlock; followingBlocks: ClaudeContentBlock[]; startIndex: number };

/** Shared copy icon SVG used by both user and assistant message copy buttons */
const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fillOpacity="0.9"/>
    <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fillOpacity="0.6"/>
  </svg>
);

interface CopyButtonProps {
  className?: string;
  isCopied: boolean;
  onClick: () => void;
  copyLabel: string;
  copySuccessText: string;
}

const CopyButton = memo(function CopyButton({
  className,
  isCopied,
  onClick,
  copyLabel,
  copySuccessText,
}: CopyButtonProps) {
  return (
    <button
      type="button"
      className={`message-copy-btn${className ? ` ${className}` : ''} ${isCopied ? 'copied' : ''}`}
      onClick={onClick}
      title={copyLabel}
      aria-label={copyLabel}
    >
      <span className="copy-icon">
        <CopyIcon />
      </span>
      <span className="copy-tooltip">{copySuccessText}</span>
    </button>
  );
});

function formatDurationMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

interface TokenUsageInfo {
  /** Total input-side tokens for the turn (non-cache input + cache write + cache read). */
  inputTokens: number;
  outputTokens: number;
  nonCacheInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd?: number;
}

/**
 * Extract whole-turn token usage from a message's raw JSON.
 *
 * Reads the `turnUsage` field stamped by the backend when a turn completes
 * (ClaudeMessageHandler.handleResult / CodexMessageHandler.handleResultMessage).
 * It aggregates every API call in the turn, normalized to the Claude usage
 * schema (input_tokens excludes cache; cache fields are separate).
 *
 * Do NOT read `raw.message.usage` or `raw.usage` here: those carry per-API-call
 * and session-cumulative values that feed the context-usage status bar, and
 * would understate (Claude) or overstate (Codex) what this turn consumed.
 *
 * Returns null when no turn usage is available (aborted turns, history replay).
 */
function extractTokenUsage(raw: ClaudeMessage['raw']): TokenUsageInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const usageSrc = (raw as Record<string, unknown>).turnUsage;
  if (!usageSrc || typeof usageSrc !== 'object') return null;
  const usage = usageSrc as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const nonCacheInput = num(usage.input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const output = num(usage.output_tokens);
  const input = nonCacheInput + cacheCreation + cacheRead;
  if (input === 0 && output === 0) return null;
  const rawCost = (raw as Record<string, unknown>).turnCostUsd;
  const costUsd = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost > 0 ? rawCost : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    nonCacheInputTokens: nonCacheInput,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** Format a token count for compact display (e.g., 1234 → "1.2K"). */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatUsdCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return '<$0.0001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function formatCacheHitRatio(tokenInfo: TokenUsageInfo): string | null {
  if (tokenInfo.cacheReadTokens <= 0 || tokenInfo.inputTokens <= 0) return null;
  const ratio = Math.round((tokenInfo.cacheReadTokens / tokenInfo.inputTokens) * 100);
  return `${Math.min(100, Math.max(0, ratio))}%`;
}

function isToolBlockOfType(block: ClaudeContentBlock, toolNames: Set<string>): boolean {
  return block.type === 'tool_use' && isToolName(block.name, toolNames);
}

// Groups consecutive content blocks for rendering. Agent groups absorb the
// tool_use blocks that follow them using a purely structural rule (see the
// forEach below), so live streaming and history reload yield identical groups.
// Exported for unit testing.
export function groupBlocks(blocks: ClaudeContentBlock[]): GroupedBlock[] {
  const groupedBlocks: GroupedBlock[] = [];
  let currentReadGroup: ClaudeContentBlock[] = [];
  let readGroupStartIndex = -1;
  let currentEditGroup: ClaudeContentBlock[] = [];
  let editGroupStartIndex = -1;
  let currentBashGroup: ClaudeContentBlock[] = [];
  let bashGroupStartIndex = -1;
  let currentSearchGroup: ClaudeContentBlock[] = [];
  let searchGroupStartIndex = -1;
  let currentAgentBlock: ClaudeContentBlock | null = null;
  let agentFollowingText: ClaudeContentBlock[] = [];
  let agentGroupStartIndex = -1;

  const flushReadGroup = () => {
    if (currentReadGroup.length > 0) {
      groupedBlocks.push({
        type: 'read_group',
        blocks: [...currentReadGroup],
        startIndex: readGroupStartIndex,
      });
      currentReadGroup = [];
      readGroupStartIndex = -1;
    }
  };

  const flushEditGroup = () => {
    if (currentEditGroup.length > 0) {
      groupedBlocks.push({
        type: 'edit_group',
        blocks: [...currentEditGroup],
        startIndex: editGroupStartIndex,
      });
      currentEditGroup = [];
      editGroupStartIndex = -1;
    }
  };

  const flushBashGroup = () => {
    if (currentBashGroup.length > 0) {
      groupedBlocks.push({
        type: 'bash_group',
        blocks: [...currentBashGroup],
        startIndex: bashGroupStartIndex,
      });
      currentBashGroup = [];
      bashGroupStartIndex = -1;
    }
  };

  const flushSearchGroup = () => {
    if (currentSearchGroup.length > 0) {
      groupedBlocks.push({
        type: 'search_group',
        blocks: [...currentSearchGroup],
        startIndex: searchGroupStartIndex,
      });
      currentSearchGroup = [];
      searchGroupStartIndex = -1;
    }
  };

  const flushAgentGroup = () => {
    if (currentAgentBlock) {
      groupedBlocks.push({
        type: 'agent_group',
        agentBlock: currentAgentBlock,
        followingBlocks: [...agentFollowingText],
        startIndex: agentGroupStartIndex,
      });
      currentAgentBlock = null;
      agentFollowingText = [];
      agentGroupStartIndex = -1;
    }
  };

  blocks.forEach((block, idx) => {
    // While inside an agent group, absorb subsequent tool_use blocks until a
    // structural boundary: the next agent tool, a non-tool block (text/thinking),
    // or the end of the message. Keeping this purely structural guarantees that
    // live streaming and history reload produce identical groups — the previous
    // streaming-only "frozen count" could not be reconstructed from a snapshot,
    // so reloaded agent groups dropped all their absorbed children.
    if (currentAgentBlock) {
      if (isToolBlockOfType(block, AGENT_TOOL_NAMES)) {
        // Next agent tool — close this group and open a new one below.
        flushAgentGroup();
      } else if (block.type === 'tool_use') {
        // Absorb the following tool_use into the running agent group.
        agentFollowingText.push(block);
        return;
      } else {
        // Non-tool block (text/thinking/...) ends the group; process it normally.
        flushAgentGroup();
      }
    }

    if (isToolBlockOfType(block, AGENT_TOOL_NAMES)) {
      flushReadGroup();
      flushEditGroup();
      flushBashGroup();
      flushSearchGroup();
      currentAgentBlock = block;
      agentGroupStartIndex = idx;
    } else if (isToolBlockOfType(block, READ_TOOL_NAMES)) {
      flushEditGroup();
      flushBashGroup();
      flushSearchGroup();
      if (currentReadGroup.length === 0) {
        readGroupStartIndex = idx;
      }
      currentReadGroup.push(block);
    } else if (isToolBlockOfType(block, EDIT_TOOL_NAMES)) {
      flushReadGroup();
      flushBashGroup();
      flushSearchGroup();
      if (currentEditGroup.length === 0) {
        editGroupStartIndex = idx;
      }
      currentEditGroup.push(block);
    } else if (isToolBlockOfType(block, BASH_TOOL_NAMES)) {
      flushReadGroup();
      flushEditGroup();
      flushSearchGroup();
      if (currentBashGroup.length === 0) {
        bashGroupStartIndex = idx;
      }
      currentBashGroup.push(block);
    } else if (isToolBlockOfType(block, SEARCH_TOOL_NAMES)) {
      flushReadGroup();
      flushEditGroup();
      flushBashGroup();
      if (currentSearchGroup.length === 0) {
        searchGroupStartIndex = idx;
      }
      currentSearchGroup.push(block);
    } else {
      flushReadGroup();
      flushEditGroup();
      flushBashGroup();
      flushSearchGroup();
      groupedBlocks.push({ type: 'single', block, originalIndex: idx });
    }
  });

  flushAgentGroup();
  flushReadGroup();
  flushEditGroup();
  flushBashGroup();
  flushSearchGroup();

  return groupedBlocks;
}

export const MessageItem = memo(function MessageItem({
  message,
  messageIndex,
  messageKey,
  isLast,
  streamingActive,
  isThinking,
  t,
  getMessageText,
  getContentBlocks,
  findToolResult,
  extractMarkdownContent,
  onNodeRef,
  onNavigateToProviderSettings,
  onNavigateToDependencySettings,
  toolResultSignature: _toolResultSignature,
  currentProvider,
}: MessageItemProps): React.ReactElement {
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [showStreamingConnectHint, setShowStreamingConnectHint] = useState(false);

  // Track timeout to properly cleanup on unmount
  const copyTimeoutRef = useRef<number | null>(null);

  // Manage thinking expansion state locally to avoid prop drilling and unnecessary re-renders
  const [expandedThinking, setExpandedThinking] = useState<Record<number, boolean>>({});
  // Track which thinking blocks were manually expanded by the user
  const [manuallyExpandedThinking, setManuallyExpandedThinking] = useState<Record<number, boolean>>({});

  const toggleThinking = useCallback((blockIndex: number) => {
    setExpandedThinking((prev) => {
      const newExpanded = !prev[blockIndex];
      // Mark this block as manually toggled by the user
      setManuallyExpandedThinking((manualPrev) => ({
        ...manualPrev,
        [blockIndex]: newExpanded,
      }));
      return {
        ...prev,
        [blockIndex]: newExpanded,
      };
    });
  }, []);

  const isThinkingExpanded = useCallback(
    (blockIndex: number) => Boolean(expandedThinking[blockIndex]),
    [expandedThinking]
  );

  const isLastAssistantMessage = message.type === 'assistant' && isLast;
  const isMessageStreaming = streamingActive && isLastAssistantMessage;

  // Cache markdown content extraction for better performance
  const markdownContent = useMemo(() => {
    // Only extract for user and assistant messages that need copy functionality
    if (message.type === 'user' || message.type === 'assistant') {
      return extractMarkdownContent(message);
    }
    return '';
  }, [message, extractMarkdownContent]);
  const hasCopyableText = markdownContent.trim().length > 0;

  const handleCopyMessage = useCallback(async () => {
    // Prevent copying if message is empty or already in "copied" state
    if (!hasCopyableText || copiedMessageIndex === messageIndex) return;

    const success = await copyToClipboard(markdownContent);
    if (success) {
      setCopiedMessageIndex(messageIndex);

      // Clear any existing timeout before setting new one
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }

      // Set new timeout and store ID for cleanup
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedMessageIndex(null);
        copyTimeoutRef.current = null;
      }, 1500);
    }
  }, [hasCopyableText, markdownContent, messageIndex, copiedMessageIndex]);

  // Cleanup timeout on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  // Memoize blocks and grouped blocks to avoid recalculation on every render
  const blocks = useMemo(() => getContentBlocks(message), [message, getContentBlocks]);
  const isEmptyStreamingPlaceholder =
    message.type === 'assistant' &&
    isMessageStreaming &&
    blocks.length === 0 &&
    !(message.content && message.content.trim().length > 0);

  useEffect(() => {
    if (!isEmptyStreamingPlaceholder) {
      setShowStreamingConnectHint(false);
      return;
    }
    const timer = window.setTimeout(() => setShowStreamingConnectHint(true), 350);
    return () => window.clearTimeout(timer);
  }, [isEmptyStreamingPlaceholder]);

  // Ref to track the last auto-expanded thinking block index to avoid overriding user interaction
  const lastAutoExpandedIndexRef = useRef<number>(-1);

  // Auto-expand the latest thinking block during streaming
  useEffect(() => {
    if (!isMessageStreaming) return;

    const thinkingIndices = blocks
      .map((block, index) => (block.type === 'thinking' ? index : -1))
      .filter((index) => index !== -1);

    if (thinkingIndices.length === 0) return;

    const lastThinkingIndex = thinkingIndices[thinkingIndices.length - 1];

    if (lastThinkingIndex !== lastAutoExpandedIndexRef.current) {
      setExpandedThinking((prev) => {
        const newState = { ...prev };
        // Only collapse thinking blocks that were NOT manually expanded by the user
        thinkingIndices.forEach((idx) => {
          // Preserve manually expanded state
          if (!manuallyExpandedThinking[idx]) {
            newState[idx] = false;
          }
        });
        // Auto-expand the latest one (unless user manually collapsed it)
        if (!manuallyExpandedThinking[lastThinkingIndex] || prev[lastThinkingIndex] === undefined) {
          newState[lastThinkingIndex] = true;
        }
        return newState;
      });
      lastAutoExpandedIndexRef.current = lastThinkingIndex;
    }
  }, [blocks, isMessageStreaming, manuallyExpandedThinking]);

  const groupedBlocks = useMemo(() => groupBlocks(blocks), [blocks]);

  // Register user message DOM node for anchor navigation
  // Must be called before any early returns to satisfy React hooks rules
  const anchorRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (message.type === 'user' && onNodeRef) {
      onNodeRef(messageKey, node);
    }
  }, [message.type, messageKey, onNodeRef]);

  const isProviderNotConfigured = message.type === 'error' && isProviderNotConfiguredError(getMessageText(message));
  const errorDiagnosticPattern = useMemo(
    () => (message.type === 'error' && !isProviderNotConfigured
      ? matchErrorPattern(getMessageText(message))
      : null),
    [message, isProviderNotConfigured, getMessageText]
  );

  const renderGroupedBlocks = () => {
    if (message.type === 'error') {
      if (isProviderNotConfigured) {
        return (
          <ProviderNotConfiguredCard
            t={t}
            onNavigateToSettings={onNavigateToProviderSettings}
          />
        );
      }
      return (
        <>
          <MarkdownBlock content={getMessageText(message)} />
          {errorDiagnosticPattern && (
            <ErrorDiagnosticCard
              t={t}
              pattern={errorDiagnosticPattern}
              onNavigateToDependencySettings={onNavigateToDependencySettings}
            />
          )}
        </>
      );
    }

    if (isEmptyStreamingPlaceholder) {
      return (
        <div className="streaming-connect-status">
          <span className="streaming-connect-text">
            {t('chat.streamingConnected', { provider: getProviderDisplayName(currentProvider) })}
          </span>
        </div>
      );
    }

    return groupedBlocks.map((grouped) => {
      if (grouped.type === 'read_group') {
        const readItems = grouped.blocks.map((b) => {
          const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
          return {
            name: block.name,
            input: block.input,
            result: findToolResult(block.id, messageIndex),
            toolId: block.id,
          };
        });

        if (readItems.length === 1) {
          return (
            <div key={`${messageIndex}-readgroup-${grouped.startIndex}`} className="content-block">
              <ReadToolBlock
                input={readItems[0].input}
                result={readItems[0].result}
                toolId={readItems[0].toolId}
              />
            </div>
          );
        }

        return (
          <div key={`${messageIndex}-readgroup-${grouped.startIndex}`} className="content-block">
            <ReadToolGroupBlock items={readItems} />
          </div>
        );
      }

      if (grouped.type === 'edit_group') {
        const editItems = grouped.blocks.map((b) => {
          const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
          return {
            name: block.name,
            input: block.input,
            result: findToolResult(block.id, messageIndex),
          };
        });

        if (editItems.length === 1) {
          return (
            <div key={`${messageIndex}-editgroup-${grouped.startIndex}`} className="content-block">
              <EditToolBlock
                name={editItems[0].name}
                input={editItems[0].input}
                result={editItems[0].result}
              />
            </div>
          );
        }

        return (
          <div key={`${messageIndex}-editgroup-${grouped.startIndex}`} className="content-block">
            <EditToolGroupBlock items={editItems} />
          </div>
        );
      }

      if (grouped.type === 'bash_group') {
        const bashItems = grouped.blocks.map((b) => {
          const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
          return {
            name: block.name,
            input: block.input,
            result: findToolResult(block.id, messageIndex),
            toolId: block.id,
          };
        });

        if (bashItems.length === 1) {
          return (
            <div key={`${messageIndex}-bashgroup-${grouped.startIndex}`} className="content-block">
              <BashToolBlock
                name={bashItems[0].name}
                input={bashItems[0].input}
                result={bashItems[0].result}
                toolId={bashItems[0].toolId}
              />
            </div>
          );
        }

        return (
          <div key={`${messageIndex}-bashgroup-${grouped.startIndex}`} className="content-block">
            <BashToolGroupBlock items={bashItems} deniedToolIds={window.__deniedToolIds} />
          </div>
        );
      }

      if (grouped.type === 'search_group') {
        const searchItems = grouped.blocks.map((b) => {
          const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
          return {
            name: block.name,
            input: block.input,
            result: findToolResult(block.id, messageIndex),
          };
        });

        if (searchItems.length === 1) {
          return (
            <div key={`${messageIndex}-searchgroup-${grouped.startIndex}`} className="content-block">
              <ContentBlockRenderer
                block={grouped.blocks[0]}
                messageIndex={messageIndex}
                messageType={message.type}
                isStreaming={isMessageStreaming}
                isThinkingExpanded={false}
                isThinking={isThinking}
                isLastMessage={isLast}
                isLastBlock={grouped.startIndex === blocks.length - 1}
                t={t}
                onToggleThinking={() => {}}
                findToolResult={findToolResult}
              />
            </div>
          );
        }

        return (
          <div key={`${messageIndex}-searchgroup-${grouped.startIndex}`} className="content-block">
            <SearchToolGroupBlock items={searchItems} />
          </div>
        );
      }

      if (grouped.type === 'agent_group') {
        const agentToolId = grouped.agentBlock.type === 'tool_use' ? grouped.agentBlock.id : undefined;
        return (
          <div key={`agentgroup-${agentToolId ?? grouped.startIndex}`} className="content-block">
            <AgentGroupBlock
              agentBlock={grouped.agentBlock}
              followingBlocks={grouped.followingBlocks}
              messageIndex={messageIndex}
              isStreaming={isMessageStreaming}
              isLastMessage={isLast}
              isThinking={isThinking}
              findToolResult={findToolResult}
            />
          </div>
        );
      }

      const { block, originalIndex: blockIndex } = grouped;

      return (
        <div key={`${messageIndex}-${blockIndex}`} className="content-block">
          <ContentBlockRenderer
            block={block}
            messageIndex={messageIndex}
            messageType={message.type}
            isStreaming={isMessageStreaming}
            isThinkingExpanded={isThinkingExpanded(blockIndex)}
            isThinking={isThinking}
            isLastMessage={isLast}
            isLastBlock={blockIndex === blocks.length - 1}
            t={t}
            onToggleThinking={() => toggleThinking(blockIndex)}
            findToolResult={findToolResult}
          />
        </div>
      );
    });
  };

  if (isEmptyStreamingPlaceholder && !showStreamingConnectHint) {
    return <></>;
  }

  return (
    <div
      className={`message ${message.type}${isLast ? ' is-last-message' : ''}${isProviderNotConfigured ? ' provider-not-configured' : ''}`}
      ref={anchorRefCallback}
      data-message-anchor-id={message.type === 'user' ? messageKey : undefined}
    >
      {/* Timestamp and copy button for user messages */}
      {message.type === 'user' && message.timestamp && (
        <div className="message-header-row">
          <div className="message-timestamp-header">
            {formatTime(message.timestamp)}
          </div>
          {hasCopyableText && (
            <CopyButton
              className="message-copy-btn-inline"
              isCopied={copiedMessageIndex === messageIndex}
              onClick={handleCopyMessage}
              copyLabel={t('markdown.copyMessage')}
              copySuccessText={t('markdown.copySuccess')}
            />
          )}
        </div>
      )}

      {/* Copy button for assistant messages only */}
      {message.type === 'assistant' && !isMessageStreaming && hasCopyableText && (
        <CopyButton
          isCopied={copiedMessageIndex === messageIndex}
          onClick={handleCopyMessage}
          copyLabel={t('markdown.copyMessage')}
          copySuccessText={t('markdown.copySuccess')}
        />
      )}

      {/* Role label for non-user/assistant messages — hidden for notification types */}
      {message.type !== 'assistant' && message.type !== 'user'
        && message.type !== 'notification' && message.type !== 'task_notification' && (
        <div className="message-role-label">
          {message.type}
        </div>
      )}

      <div className="message-content">
        {renderGroupedBlocks()}
      </div>

      {/* Duration and token display after last assistant message */}
      {message.type === 'assistant' && !isMessageStreaming && typeof message.durationMs === 'number' && (
        <div className="message-duration">
          <span className="message-duration-inner">
            <span className="message-duration-flag codicon codicon-clock"></span>
            <span className="message-duration-cost">{t('chat.totalDuration')}</span>
            <span className="message-duration-value">{formatDurationMs(message.durationMs)}</span>
            {(() => {
              const tokenInfo = extractTokenUsage(message.raw);
              if (!tokenInfo) return null;
              const cacheHitRatio = formatCacheHitRatio(tokenInfo);
              return (
                <>
                  <span className="message-duration-separator">·</span>
                  <span
                    className="message-duration-tokens"
                    title={t('chat.tokenUsageDetail', {
                      input: formatTokenCount(tokenInfo.nonCacheInputTokens),
                      cacheWrite: formatTokenCount(tokenInfo.cacheCreationTokens),
                      cacheRead: formatTokenCount(tokenInfo.cacheReadTokens),
                      output: formatTokenCount(tokenInfo.outputTokens),
                    })}
                  >
                    {t('chat.tokenUsage', {
                      input: formatTokenCount(tokenInfo.inputTokens),
                      output: formatTokenCount(tokenInfo.outputTokens),
                    })}
                    {tokenInfo.costUsd !== undefined ? ` / ${formatUsdCost(tokenInfo.costUsd)}` : ''}
                  </span>
                  {cacheHitRatio && (
                    <>
                      <span className="message-duration-separator">·</span>
                      <span className="message-duration-tokens">
                        {t('chat.cacheHitsWithRatio', {
                          tokens: formatTokenCount(tokenInfo.cacheReadTokens),
                          ratio: cacheHitRatio,
                        })}
                      </span>
                    </>
                  )}
                </>
              );
            })()}
          </span>
        </div>
      )}
    </div>
  );
});
