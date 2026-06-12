import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { openFile } from '../../utils/bridge';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
import { getToolLineInfo, resolveToolTarget } from '../../utils/toolPresentation';

interface FileItem {
  filePath: string;
  displayPath: string;
  cleanFileName: string;
  openPath: string;
  isDirectory: boolean;
  lineInfo?: string;
  lineStart?: number;
  lineEnd?: number;
  isCompleted: boolean;
  isError: boolean;
}

interface ReadToolGroupBlockProps {
  items: Array<{
    name?: string;
    input?: ToolInput;
    result?: ToolResultBlock | null;
  }>;
}

/** Max visible items before scroll */
const MAX_VISIBLE_ITEMS = 3;
/** Height per item in pixels */
const ITEM_HEIGHT = 28;

const TITLE_SECTION_STYLE: React.CSSProperties = { overflow: 'hidden' };

const TITLE_TEXT_STYLE: React.CSSProperties = { flexShrink: 0 };

const TITLE_SUMMARY_STYLE: React.CSSProperties = {
  color: 'var(--text-secondary)',
  marginLeft: '4px',
  flexShrink: 0,
};

const FILE_ICON_STYLE: React.CSSProperties = {
  marginRight: '8px',
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
};

const LINE_INFO_STYLE: React.CSSProperties = {
  marginLeft: '8px',
  fontSize: '11px',
  color: 'var(--text-tertiary, var(--text-secondary))',
  flexShrink: 0,
  opacity: 0.8,
};

const STATUS_INDICATOR_STYLE: React.CSSProperties = { marginLeft: '8px' };

function getFileListItemStyle(isDirectory: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 8px',
    borderRadius: '4px',
    cursor: isDirectory ? 'default' : 'pointer',
    transition: 'background-color 0.15s ease',
    minHeight: `${ITEM_HEIGHT}px`,
    flexShrink: 0,
  };
}

/**
 * Parse item to FileItem
 */
const parseFileItem = (item: { input?: ToolInput; result?: ToolResultBlock | null }): FileItem | null => {
  const input = item.input;
  if (!input) return null;

  const target = resolveToolTarget(input, 'read');
  if (!target) return null;

  const lineInfoValue = getToolLineInfo(input, target);
  const lineInfo = lineInfoValue.start
    ? (lineInfoValue.end && lineInfoValue.end !== lineInfoValue.start
      ? `L${lineInfoValue.start}-${lineInfoValue.end}`
      : `L${lineInfoValue.start}`)
    : '';

  // Determine completion status
  const isCompleted = item.result !== undefined && item.result !== null;
  const isError = isCompleted && item.result?.is_error === true;

  return {
    filePath: target.rawPath,
    displayPath: target.displayPath,
    cleanFileName: target.cleanFileName,
    openPath: target.openPath,
    isDirectory: target.isDirectory,
    lineInfo,
    lineStart: lineInfoValue.start,
    lineEnd: lineInfoValue.end,
    isCompleted,
    isError,
  };
};

/**
 * Get file icon SVG by file name (with extension).
 */
const getFileIconSvg = (fileName: string, isDirectory: boolean) => {
  if (isDirectory) {
    return getFolderIcon(fileName.replace(/\/$/, ''));
  }
  const cleanName = fileName.replace(/:\d+(-\d+)?$/, '');
  const extension = cleanName.includes('.') ? cleanName.split('.').pop() : '';
  return getFileIcon(extension ?? '', cleanName);
};

interface FileListItemProps {
  item: FileItem;
  onFileClick: (openPath: string, isDirectory: boolean, e: React.MouseEvent, lineStart?: number, lineEnd?: number) => void;
}

const FileListItem = ({ item, onFileClick }: FileListItemProps) => {
  const fileLinkTooltip = useResolvedFileLinkTooltip(
    !item.isDirectory ? item.filePath : undefined,
    item.displayPath,
  );

  return (
    <div
      className={`file-list-item ${!item.isDirectory ? 'clickable-file' : ''}`}
      onClick={(e) => onFileClick(item.openPath, item.isDirectory, e, item.lineStart, item.lineEnd)}
      style={getFileListItemStyle(item.isDirectory)}
      {...fileLinkTooltip}
    >
      <span
        style={FILE_ICON_STYLE}
        dangerouslySetInnerHTML={{ __html: getFileIconSvg(item.cleanFileName, item.isDirectory) }}
      />
      <span style={FILE_NAME_STYLE}>
        {item.displayPath}
      </span>
      {item.lineInfo && (
        <span style={LINE_INFO_STYLE}>
          {item.lineInfo}
        </span>
      )}
      <div
        className={`tool-status-indicator ${item.isError ? 'error' : item.isCompleted ? 'completed' : 'pending'}`}
        style={STATUS_INDICATOR_STYLE}
      />
    </div>
  );
};

const ReadToolGroupBlock = ({ items }: ReadToolGroupBlockProps) => {
  // Default to expanded
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);

  // Parse all items to file items
  const fileItems = useMemo(() => {
    return items
      .map(item => parseFileItem(item))
      .filter((item): item is FileItem => item !== null);
  }, [items]);

  // Auto-scroll to bottom when new items are added (streaming)
  useEffect(() => {
    if (listRef.current && fileItems.length > prevItemCountRef.current) {
      // New item added, scroll to bottom
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevItemCountRef.current = fileItems.length;
  }, [fileItems.length]);

  if (fileItems.length === 0) {
    return null;
  }

  // Calculate list height: show up to MAX_VISIBLE_ITEMS, scroll for more
  const needsScroll = fileItems.length > MAX_VISIBLE_ITEMS;
  const listHeight = needsScroll
    ? MAX_VISIBLE_ITEMS * ITEM_HEIGHT
    : fileItems.length * ITEM_HEIGHT;

  const headerStyle: React.CSSProperties = {
    borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
  };

  const detailsStyle: React.CSSProperties = {
    padding: '6px 8px',
    border: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
    maxHeight: `${listHeight + 12}px`, // +12 for padding
    overflowY: needsScroll ? 'auto' : 'hidden',
    overflowX: 'hidden',
  };

  const handleFileClick = (openPath: string, isDirectory: boolean, e: React.MouseEvent, lineStart?: number, lineEnd?: number) => {
    e.stopPropagation();
    if (!isDirectory) {
      openFile(openPath, lineStart, lineEnd);
    }
  };

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={headerStyle}
      >
        <div className="task-title-section" style={TITLE_SECTION_STYLE}>
          <span className="codicon codicon-file-code tool-title-icon" />
          <span className="tool-title-text" style={TITLE_TEXT_STYLE}>
            {t('permission.tools.ReadBatch')}
          </span>
          <span className="tool-title-summary" style={TITLE_SUMMARY_STYLE}>
            ({fileItems.length})
          </span>
        </div>
      </div>

      {expanded && (
        <div
          ref={listRef}
          className="task-details file-list-container"
          style={detailsStyle}
        >
          {fileItems.map((item, index) => (
            <FileListItem
              key={index}
              item={item}
              onFileClick={handleFileClick}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ReadToolGroupBlock;
