import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile, showDiff, refreshFile } from '../../utils/bridge';
import { getFileIcon } from '../../utils/fileIcons';
import { resolveToolTarget, getToolLineInfo } from '../../utils/toolPresentation';
import { normalizeToolInput } from '../../utils/toolInputNormalization';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';

interface EditItem {
  filePath: string;
  openPath: string;
  displayPath: string;
  fileName: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  lineStart?: number;
  lineEnd?: number;
  isCompleted: boolean;
  isError: boolean;
}

interface EditToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
  }>;
}

/** Max visible items before scroll */
const MAX_VISIBLE_ITEMS = 3;
/** Height per item in pixels */
const ITEM_HEIGHT = 32;

const CONTAINER_STYLE: React.CSSProperties = { margin: '12px 0' };

const TITLE_SECTION_STYLE: React.CSSProperties = { overflow: 'hidden' };

const TITLE_TEXT_STYLE: React.CSSProperties = { flexShrink: 0 };

const TITLE_SUMMARY_STYLE: React.CSSProperties = {
  color: 'var(--text-secondary)',
  marginLeft: '4px',
  flexShrink: 0,
};

const TOTAL_STATS_STYLE: React.CSSProperties = {
  marginLeft: '12px',
  fontSize: '12px',
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const ADDED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-added-accent)' };
const DELETED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-deleted-accent)' };
const STATS_SPACER_STYLE: React.CSSProperties = { margin: '0 4px' };

const FILE_ICON_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '16px',
  height: '16px',
  flexShrink: 0,
};

const FILE_NAME_STYLE: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
  cursor: 'pointer',
};

const ITEM_STATS_STYLE: React.CSSProperties = {
  fontSize: '11px',
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
};

const LINE_INFO_STYLE: React.CSSProperties = { color: 'var(--text-secondary)' };

const ITEM_STATS_SPACER_STYLE: React.CSSProperties = { margin: '0 2px' };

const ACTIONS_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  flexShrink: 0,
};

const ACTION_ICON_STYLE: React.CSSProperties = { fontSize: '12px' };

const STATUS_INDICATOR_STYLE: React.CSSProperties = { marginLeft: '4px' };

const FILE_LIST_ITEM_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '4px 8px',
  borderRadius: '4px',
  minHeight: `${ITEM_HEIGHT}px`,
  flexShrink: 0,
  gap: '8px',
};

/**
 * Compute diff statistics (additions and deletions count)
 */
function computeDiffStats(oldString: string, newString: string): { additions: number; deletions: number } {
  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];

  if (oldLines.length === 0 && newLines.length === 0) {
    return { additions: 0, deletions: 0 };
  }
  if (oldLines.length === 0) {
    return { additions: newLines.length, deletions: 0 };
  }
  if (newLines.length === 0) {
    return { additions: 0, deletions: oldLines.length };
  }

  // Simple LCS-based diff count
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let additions = 0;
  let deletions = 0;
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      additions++;
      j--;
    } else {
      deletions++;
      i--;
    }
  }

  return { additions, deletions };
}

/**
 * Parse item to EditItem
 */
function parseEditItem(item: { name?: string; input?: ToolInput; result?: ToolResultBlock | null }): EditItem | null {
  const result = item.result;
  const input = item.input ? normalizeToolInput(item.name, item.input) : item.input;
  if (!input) return null;

  const target = resolveToolTarget({
    ...input,
    file_path: (typeof input.file_path === 'string' ? input.file_path : undefined) ??
      (typeof input.filePath === 'string' ? input.filePath : undefined),
    target_file: (typeof input.target_file === 'string' ? input.target_file : undefined) ??
      (typeof input.targetFile === 'string' ? input.targetFile : undefined),
  }, item.name);

  if (!target) return null;

  const oldString =
    (typeof input.old_string === 'string' ? input.old_string : undefined) ??
    (typeof input.oldString === 'string' ? input.oldString : undefined) ??
    '';
  const newString =
    (typeof input.new_string === 'string' ? input.new_string : undefined) ??
    (typeof input.newString === 'string' ? input.newString : undefined) ??
    '';

  const { additions, deletions } = computeDiffStats(oldString, newString);
  const lineInfo = getToolLineInfo(input, target, result);
  const isCompleted = result !== undefined && result !== null;
  const isError = isCompleted && result?.is_error === true;

  return {
    filePath: target.rawPath,
    openPath: target.openPath,
    displayPath: target.displayPath,
    fileName: target.cleanFileName,
    oldString,
    newString,
    additions,
    deletions,
    lineStart: lineInfo.start,
    lineEnd: lineInfo.end,
    isCompleted,
    isError,
  };
}

/**
 * Get file icon SVG by file name (with extension).
 */
function getFileIconSvg(fileName: string): string {
  const extension = fileName.includes('.') ? fileName.split('.').pop() : '';
  return getFileIcon(extension ?? '', fileName);
}

interface EditFileItemProps {
  item: EditItem;
  onFileClick: (item: EditItem, e: React.MouseEvent) => void;
  onShowDiff: (item: EditItem, e: React.MouseEvent) => void;
  onRefresh: (filePath: string, e: React.MouseEvent) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

const EditFileItem = ({ item, onFileClick, onShowDiff, onRefresh, t }: EditFileItemProps) => {
  const fileLinkTooltip = useResolvedFileLinkTooltip(item.filePath, item.displayPath);

  return (
    <div className="file-list-item" style={FILE_LIST_ITEM_STYLE}>
      <span
        style={FILE_ICON_STYLE}
        dangerouslySetInnerHTML={{ __html: getFileIconSvg(item.fileName) }}
      />
      <span
        className="clickable-file"
        onClick={(e) => onFileClick(item, e)}
        style={FILE_NAME_STYLE}
        {...fileLinkTooltip}
      >
        {item.displayPath}
      </span>

      {(item.lineStart || item.additions > 0 || item.deletions > 0) && (
        <span style={ITEM_STATS_STYLE}>
          {item.lineStart && (
            <span style={LINE_INFO_STYLE}>
              {item.lineEnd && item.lineEnd !== item.lineStart
                ? t('tools.lineRange', { start: item.lineStart, end: item.lineEnd })
                : t('tools.lineSingle', { line: item.lineStart })}
            </span>
          )}
          {item.additions > 0 && <span style={ADDED_TEXT_STYLE}>+{item.additions}</span>}
          {item.additions > 0 && item.deletions > 0 && <span style={ITEM_STATS_SPACER_STYLE} />}
          {item.deletions > 0 && <span style={DELETED_TEXT_STYLE}>-{item.deletions}</span>}
        </span>
      )}

      <div style={ACTIONS_STYLE}>
        <button
          onClick={(e) => onShowDiff(item, e)}
          title={t('tools.showDiffInIdea')}
          className="edit-group-action-btn"
        >
          <span className="codicon codicon-diff" style={ACTION_ICON_STYLE} />
        </button>
        <button
          onClick={(e) => onRefresh(item.openPath, e)}
          title={t('tools.refreshFileInIdea')}
          className="edit-group-action-btn"
        >
          <span className="codicon codicon-refresh" style={ACTION_ICON_STYLE} />
        </button>
      </div>

      <div
        className={`tool-status-indicator ${item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'}`}
        style={STATUS_INDICATOR_STYLE}
      />
    </div>
  );
};

const EditToolGroupBlock = ({ items }: EditToolGroupBlockProps) => {
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);
  const refreshedFilesRef = useRef<Set<string>>(new Set());

  // Parse all items
  const editItems = useMemo(() => {
    return items
      .map(item => parseEditItem(item))
      .filter((item): item is EditItem => item !== null);
  }, [items]);

  // Auto-refresh completed files in IDEA
  useEffect(() => {
    editItems.forEach(item => {
      if (item.isCompleted && !item.isError && !refreshedFilesRef.current.has(item.filePath)) {
        refreshedFilesRef.current.add(item.filePath);
        refreshFile(item.openPath);
      }
    });
  }, [editItems]);

  // Auto-scroll to bottom when new items are added
  useEffect(() => {
    if (listRef.current && editItems.length > prevItemCountRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = editItems.length;
  }, [editItems.length]);

  if (editItems.length === 0) {
    return null;
  }

  // Calculate totals
  const totalAdditions = editItems.reduce((sum, item) => sum + item.additions, 0);
  const totalDeletions = editItems.reduce((sum, item) => sum + item.deletions, 0);

  // Calculate list height
  const needsScroll = editItems.length > MAX_VISIBLE_ITEMS;
  const listHeight = needsScroll
    ? MAX_VISIBLE_ITEMS * ITEM_HEIGHT
    : editItems.length * ITEM_HEIGHT;

  const headerStyle: React.CSSProperties = {
    borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
  };

  const detailsStyle: React.CSSProperties = {
    padding: '6px 8px',
    border: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    maxHeight: `${listHeight + 12}px`,
    overflowY: needsScroll ? 'auto' : 'hidden',
    overflowX: 'hidden',
  };

  const handleFileClick = (item: EditItem, e: React.MouseEvent) => {
    e.stopPropagation();
    openFile(item.openPath, item.lineStart, item.lineEnd);
  };

  const handleShowDiff = (item: EditItem, e: React.MouseEvent) => {
    e.stopPropagation();
    showDiff(item.openPath, item.oldString, item.newString, t('tools.editPrefix', { fileName: item.fileName }));
  };

  const handleRefresh = (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    refreshFile(filePath);
    window.addToast?.(t('tools.refreshFileInIdeaSuccess'), 'success');
  };

  return (
    <div className="task-container" style={CONTAINER_STYLE}>
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={headerStyle}
      >
        <div className="task-title-section" style={TITLE_SECTION_STYLE}>
          <span className="codicon codicon-edit tool-title-icon" />
          <span className="tool-title-text" style={TITLE_TEXT_STYLE}>
            {t('tools.editBatchTitle')}
          </span>
          <span className="tool-title-summary" style={TITLE_SUMMARY_STYLE}>
            ({editItems.length})
          </span>

          {(totalAdditions > 0 || totalDeletions > 0) && (
            <span style={TOTAL_STATS_STYLE}>
              {totalAdditions > 0 && <span style={ADDED_TEXT_STYLE}>+{totalAdditions}</span>}
              {totalAdditions > 0 && totalDeletions > 0 && <span style={STATS_SPACER_STYLE} />}
              {totalDeletions > 0 && <span style={DELETED_TEXT_STYLE}>-{totalDeletions}</span>}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="task-details file-list-container"
          style={detailsStyle}
        >
          {editItems.map((item, index) => (
            <EditFileItem
              key={index}
              item={item}
              onFileClick={handleFileClick}
              onShowDiff={handleShowDiff}
              onRefresh={handleRefresh}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default EditToolGroupBlock;
