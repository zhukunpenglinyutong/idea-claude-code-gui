import { useState, useCallback, memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock, CompactSummaryMetadata } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import CollapsibleTextBlock from '../CollapsibleTextBlock';
import {
  BashToolBlock,
  EditToolBlock,
  GenericToolBlock,
  TaskExecutionBlock,
} from '../toolBlocks';
import { EDIT_TOOL_NAMES, BASH_TOOL_NAMES, TASK_MANAGE_TOOL_NAMES, AGENT_TOOL_NAMES, isToolName, isTransientInternalToolName, normalizeToolName } from '../../utils/toolConstants';
import { TASK_STATUS_COLORS } from '../../utils/messageUtils';

const IMAGE_BLOCK_STYLE: React.CSSProperties = { cursor: 'pointer' };
const THINKING_VISIBLE_STYLE: React.CSSProperties = { display: 'block' };
const THINKING_HIDDEN_STYLE: React.CSSProperties = { display: 'none' };

function getImageStyle(isUser: boolean): React.CSSProperties {
  return {
    maxWidth: isUser ? '200px' : '100%',
    maxHeight: isUser ? '150px' : 'auto',
    borderRadius: '8px',
    objectFit: 'contain',
  };
}

/**
 * Get file icon class (consistent with AttachmentList)
 */
function getFileIcon(mediaType?: string): string {
  if (!mediaType) return 'codicon-file';
  if (mediaType.startsWith('text/')) return 'codicon-file-text';
  if (mediaType.includes('json')) return 'codicon-json';
  if (mediaType.includes('javascript') || mediaType.includes('typescript')) return 'codicon-file-code';
  if (mediaType.includes('pdf')) return 'codicon-file-pdf';
  return 'codicon-file';
}

/**
 * Get file extension
 */
function getExtension(fileName?: string): string {
  if (!fileName) return '';
  const parts = fileName.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
}

/** Format a token count for compact display (e.g., 524835 → "524.8K"). */
function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/**
 * Build the compaction-stats subtitle from compact_boundary metadata:
 * "manual · 524.8K → 14.6K · 110s". Returns null when no stats are present.
 */
function formatCompactionStats(meta: CompactSummaryMetadata): string | null {
  const parts: string[] = [];
  if (meta.trigger) parts.push(meta.trigger);
  if (typeof meta.preTokens === 'number') {
    const tokens = typeof meta.postTokens === 'number'
      ? `${formatCompactTokens(meta.preTokens)} → ${formatCompactTokens(meta.postTokens)}`
      : formatCompactTokens(meta.preTokens);
    parts.push(tokens);
  }
  if (typeof meta.durationMs === 'number') parts.push(`${Math.round(meta.durationMs / 1000)}s`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface CompactSummaryBlockProps {
  block: {
    type: 'compact_summary';
    title: string;
    content: string;
    metadata?: CompactSummaryMetadata;
  };
  t: TFunction;
}

/**
 * Compact summary block - collapsed by default, click/Enter/Space to expand.
 * Memoized to prevent state reset on parent re-renders during streaming.
 * `block.title` is an i18n key resolved via t() at render time.
 */
const CompactSummaryBlock = memo(function CompactSummaryBlock({ block, t }: CompactSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded(e => !e), []);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded(prev => !prev);
    }
  }, []);
  const meta = block.metadata;
  const hasCountMeta = meta && typeof meta.messagesSummarized === 'number';
  const compactionStats = meta ? formatCompactionStats(meta) : null;
  const hasMeta = hasCountMeta || compactionStats;
  const titleText = t(block.title);
  const toggleLabel = expanded ? t('chat.compactSummary.collapse') : t('chat.compactSummary.expand');

  return (
    <div className="compact-summary-block">
      <div
        className="compact-summary-title"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${titleText} — ${toggleLabel}`}
        onClick={toggleExpanded}
        onKeyDown={onKeyDown}
      >
        <span className="compact-summary-icon" aria-hidden="true">●</span>
        <span className="compact-summary-title-text">{titleText}</span>
        <span className="compact-summary-toggle" aria-hidden="true">{expanded ? '▼' : '▶'}</span>
      </div>
      {hasMeta && (
        <div className="compact-summary-metadata">
          {hasCountMeta && (
            <span className="compact-summary-meta-count">
              {t(
                meta.direction === 'from'
                  ? 'chat.compactSummary.messagesFrom'
                  : 'chat.compactSummary.messagesUpTo',
                { count: meta.messagesSummarized },
              )}
            </span>
          )}
          {compactionStats && (
            <span className="compact-summary-meta-count">{compactionStats}</span>
          )}
          {meta?.userContext && (
            <span className="compact-summary-meta-context">
              {t('chat.compactSummary.userContext', { context: meta.userContext })}
            </span>
          )}
        </div>
      )}
      {expanded && block.content && (
        <div className="compact-summary-content">
          <MarkdownBlock content={block.content} />
        </div>
      )}
    </div>
  );
});

export interface ContentBlockRendererProps {
  block: ClaudeContentBlock;
  messageIndex: number;
  messageType: string;
  isStreaming: boolean;
  isThinkingExpanded: boolean;
  isThinking: boolean;
  isLastMessage: boolean;
  isLastBlock?: boolean;
  t: TFunction;
  onToggleThinking: () => void;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

export function ContentBlockRenderer({
  block,
  messageIndex,
  messageType,
  isStreaming,
  isThinkingExpanded,
  isThinking,
  isLastMessage,
  isLastBlock = false,
  t,
  onToggleThinking,
  findToolResult,
}: ContentBlockRendererProps): React.ReactElement | null {
  if (block.type === 'text') {
    return messageType === 'user' ? (
      <CollapsibleTextBlock content={block.text ?? ''} />
    ) : (
      <MarkdownBlock
        content={block.text ?? ''}
        isStreaming={isStreaming}
      />
    );
  }

  if (block.type === 'image' && block.src) {
    const handleImagePreview = () => {
      const previewRoot = document.getElementById('image-preview-root');
      if (!previewRoot || !block.src) return;

      // Clear previous content safely
      previewRoot.innerHTML = '';

      // Create overlay container
      const overlay = document.createElement('div');
      overlay.className = 'image-preview-overlay';
      overlay.onclick = () => overlay.remove();

      // Create image element safely (prevents XSS)
      const img = document.createElement('img');
      img.src = block.src;
      img.alt = t('chat.imagePreview');
      img.className = 'image-preview-content';
      img.onclick = (e) => e.stopPropagation();

      // Create close button
      const closeBtn = document.createElement('div');
      closeBtn.className = 'image-preview-close';
      closeBtn.textContent = '×';
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        overlay.remove();
      };

      overlay.appendChild(img);
      overlay.appendChild(closeBtn);
      previewRoot.appendChild(overlay);
    };

    return (
      <div
        className={`message-image-block ${messageType === 'user' ? 'user-image' : ''}`}
        onClick={handleImagePreview}
        style={IMAGE_BLOCK_STYLE}
        title={t('chat.clickToPreview')}
      >
        <img
          src={block.src}
          alt={t('chat.userUploadedImage')}
          style={getImageStyle(messageType === 'user')}
        />
      </div>
    );
  }

  if (block.type === 'attachment') {
    const ext = getExtension(block.fileName);
    const displayName = block.fileName || t('chat.unknownFile');
    return (
      <div className="message-attachment-chip" title={displayName}>
        <span className={`message-attachment-chip-icon codicon ${getFileIcon(block.mediaType)}`} />
        {ext && <span className="message-attachment-chip-ext">{ext}</span>}
        <span className="message-attachment-chip-name">{displayName}</span>
      </div>
    );
  }

  if (block.type === 'thinking') {
    return (
      <div className="thinking-block">
        <div
          className="thinking-header"
          onClick={onToggleThinking}
        >
          <span className="thinking-title">
            {isThinking && isLastMessage && isLastBlock
              ? t('common.thinkingProcess')
              : t('common.thinking')}
          </span>
          <span className="thinking-icon">
            {isThinkingExpanded ? '▼' : '▶'}
          </span>
        </div>
        <div
          className="thinking-content"
          style={isThinkingExpanded ? THINKING_VISIBLE_STYLE : THINKING_HIDDEN_STYLE}
        >
          <MarkdownBlock
            content={block.thinking ?? block.text ?? t('chat.noThinkingContent')}
            isStreaming={isStreaming}
          />
        </div>
      </div>
    );
  }

  if (block.type === 'tool_use') {
    const toolName = normalizeToolName(block.name ?? '');

    if (toolName === 'todowrite' || toolName === 'update_plan' || TASK_MANAGE_TOOL_NAMES.has(toolName)) {
      return null;
    }

    if (!isStreaming && isTransientInternalToolName(block.name)) {
      return null;
    }

    if (AGENT_TOOL_NAMES.has(toolName)) {
      return (
        <TaskExecutionBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
          isStreaming={isStreaming}
        />
      );
    }

    if (isToolName(block.name, EDIT_TOOL_NAMES)) {
      return (
        <EditToolBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
        />
      );
    }

    if (isToolName(block.name, BASH_TOOL_NAMES)) {
      return (
        <BashToolBlock
          name={block.name}
          input={block.input}
          result={findToolResult(block.id, messageIndex)}
          toolId={block.id}
        />
      );
    }

    return (
      <GenericToolBlock
        name={block.name}
        input={block.input}
        result={findToolResult(block.id, messageIndex)}
        toolId={block.id}
      />
    );
  }

  // Compact notification block - renders as header + indented sub-items
  if (block.type === 'compact_notification') {
    return (
      <div className="compact-notification-block">
        <div className="compact-notification-header">
          {block.headerText}
        </div>
        {block.items.length > 0 && (
          <div className="compact-notification-items">
            {block.items.map((item, idx) => (
              <div key={idx} className="compact-notification-item">
                <span className="compact-notification-prefix">⎿</span>
                <span className="compact-notification-text">{item.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Compact summary block - collapsed by default, click to expand
  if (block.type === 'compact_summary') {
    return <CompactSummaryBlock block={block} t={t} />;
  }

  // Task notification block - renders as "● summary" with status color
  if (block.type === 'task_notification') {
    // TypeScript narrows block to { type: 'task_notification'; icon; summary; status; detail? }
    const statusColor = TASK_STATUS_COLORS[block.status] || 'text';
    const detail = block.detail;
    const truncatedDetail = detail && detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
    return (
      <div className={`task-notification-block task-notification-${statusColor}`}>
        <span className="task-notification-icon">{block.icon}</span>
        <span className="task-notification-summary">
          {block.summary}
          {truncatedDetail && (
            <span className="task-notification-detail" title={detail}>{truncatedDetail}</span>
          )}
        </span>
      </div>
    );
  }

  return null;
}
