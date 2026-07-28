import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { stripAnsi } from '../../utils/stripAnsi';

interface BashItem {
  command: string;
  description: string;
  output: string;
  isCompleted: boolean;
  isError: boolean;
  toolId?: string;
}

interface BashToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
    toolId?: string;
  }>;
  /** Denied tool IDs set, passed from parent instead of global window */
  deniedToolIds?: Set<string>;
}

/** Max visible items before scroll (3.5 items) */
const MAX_VISIBLE_ITEMS = 3.5;
/** Height per item in pixels */
const ITEM_HEIGHT = 32;
/** Max height when an item is expanded */
const EXPANDED_MAX_HEIGHT = 400;

const PROGRESS_ICON_STYLE: React.CSSProperties = { fontSize: '12px', marginRight: '4px' };
const ERROR_ICON_STYLE: React.CSSProperties = { fontSize: '14px', marginTop: '1px' };

/**
 * Parse item to BashItem
 */
function parseBashItem(
  item: {
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
    toolId?: string;
  },
  deniedToolIds?: Set<string>
): BashItem | null {
  const { input, result, toolId } = item;
  if (!input) return null;

  const command = typeof input.command === 'string' ? input.command : '';
  const description = typeof input.description === 'string' ? input.description : '';

  let output = '';
  if (result) {
    const content = result.content;
    if (typeof content === 'string') {
      output = content;
    } else if (Array.isArray(content)) {
      output = content.map((block) => block.text ?? '').join('\n');
    }
    output = stripAnsi(output);
  }

  const isDenied = toolId ? (deniedToolIds?.has(toolId) ?? false) : false;
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  const isError = isDenied || (isCompleted && result?.is_error === true);

  return {
    command,
    description,
    output,
    isCompleted,
    isError,
    toolId,
  };
}

/**
 * Truncate command for display
 */
function truncateCommand(command: string, maxLength = 60): string {
  if (command.length <= maxLength) return command;
  return command.slice(0, maxLength) + '...';
}

const BashToolGroupBlock = ({ items, deniedToolIds }: BashToolGroupBlockProps) => {
  // Default to expanded
  const [expanded, setExpanded] = useState(true);
  // Track which item detail is expanded
  const [expandedItemIndex, setExpandedItemIndex] = useState<number | null>(null);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);

  // Parse all items
  const bashItems = useMemo(() => {
    return items
      .map((item) => parseBashItem(item, deniedToolIds))
      .filter((item): item is BashItem => item !== null);
  }, [items, deniedToolIds]);

  // Auto-scroll to bottom when new items are added
  useEffect(() => {
    if (listRef.current && bashItems.length > prevItemCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = bashItems.length;
  }, [bashItems.length]);

  // Calculate progress
  const completedCount = bashItems.filter((item) => item.isCompleted).length;
  const errorCount = bashItems.filter((item) => item.isError).length;
  const totalCount = bashItems.length;

  // Handle item click to toggle detail
  const handleItemClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedItemIndex((prev) => (prev === index ? null : index));
  }, []);

  if (bashItems.length === 0) {
    return null;
  }

  // Calculate list height for 3.5 visible items
  const needsScroll = bashItems.length > MAX_VISIBLE_ITEMS;
  
  // Base height for collapsed state
  const baseHeight = needsScroll
    ? MAX_VISIBLE_ITEMS * ITEM_HEIGHT
    : bashItems.length * ITEM_HEIGHT;

  // When an item is expanded, increase max-height to allow viewing details
  // otherwise use the compact base height
  const listHeight = expandedItemIndex !== null
    ? EXPANDED_MAX_HEIGHT
    : baseHeight;

  // Enable scrolling if there are many items OR if an item is expanded (content might overflow)
  const overflowY = (needsScroll || expandedItemIndex !== null) ? 'auto' : 'hidden';

  // Progress summary text
  const getProgressSummary = () => {
    if (errorCount > 0) {
      return (
        <span className="bash-group-progress error">
          <span className="codicon codicon-warning" style={PROGRESS_ICON_STYLE} />
          {errorCount} {t('tools.bashGroupFailed')}
        </span>
      );
    }
    if (completedCount === totalCount) {
      return (
        <span className="bash-group-progress completed">
          <span className="codicon codicon-check" style={PROGRESS_ICON_STYLE} />
          {t('tools.bashGroupAllCompleted')}
        </span>
      );
    }
    return (
      <span className="bash-group-progress">
        {completedCount}/{totalCount} {t('tools.bashGroupCompleted')}
      </span>
    );
  };

  const timelineStyle: React.CSSProperties = {
    maxHeight: `${listHeight + 16}px`,
    overflowY: overflowY,
  };

  return (
    <div className="task-container bash-group-container">
      {/* Header - always visible */}
      <div
        className="task-header bash-group-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="task-title-section">
          <span className="tool-title-text">
            {t('tools.bashGroupBatchRun')} ({totalCount})
          </span>
        </div>
        <div className="bash-group-summary">{getProgressSummary()}</div>
      </div>

      {/* Timeline list - visible when expanded */}
      {expanded && (
        <div
          ref={listRef}
          className="bash-group-timeline"
          style={timelineStyle}
        >
          {bashItems.map((item, index) => {
            const isLast = index === bashItems.length - 1;
            const isItemExpanded = expandedItemIndex === index;

            return (
              <div key={item.toolId || `bash-item-${index}`} className="bash-timeline-item">
                {/* Timeline connector - fixed gray */}
                <div className="bash-timeline-connector">
                  <div className={`bash-timeline-line ${isLast ? 'last' : ''}`} />
                  <div className="bash-timeline-node" />
                </div>

                {/* Item content */}
                <div
                  className={`bash-timeline-content ${isItemExpanded ? 'expanded' : ''}`}
                  onClick={(e) => handleItemClick(index, e)}
                >
                  <div className="bash-timeline-row">
                    <span className={`bash-timeline-description ${item.description ? '' : 'bash-timeline-description-command'}`}>
                      {item.description || truncateCommand(item.command)}
                    </span>
                    <div
                      className={`tool-status-indicator ${
                        item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'
                      }`}
                    />
                  </div>

                  {/* Expanded detail */}
                  {isItemExpanded && (
                    <div className="bash-timeline-detail">
                      <div className="bash-command-block">{item.command}</div>
                      {item.output && (
                        <div className={`bash-output-block ${item.isError ? 'error' : 'normal'}`}>
                          {item.isError && (
                            <span
                              className="codicon codicon-error"
                              style={ERROR_ICON_STYLE}
                            />
                          )}
                          <span className="bash-output-text">{item.output}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default BashToolGroupBlock;
