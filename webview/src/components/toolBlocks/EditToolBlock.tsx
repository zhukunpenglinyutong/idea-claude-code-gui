import { useState, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { openFile, showDiff, refreshFile } from '../../utils/bridge';
import { getFileIcon } from '../../utils/fileIcons';
import { getToolLineInfo, getToolEditCount, resolveToolTarget } from '../../utils/toolPresentation';
import { normalizeToolInput } from '../../utils/toolInputNormalization';
import GenericToolBlock from './GenericToolBlock';

interface EditToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

type DiffLineType = 'unchanged' | 'deleted' | 'added';

interface DiffLine {
  type: DiffLineType;
  content: string;
}

interface DiffResult {
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

const ROOT_STYLE: React.CSSProperties = { margin: '12px 0' };

const TOP_BAR_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginBottom: '4px',
  paddingRight: '4px',
};

const TOP_BAR_INNER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const ACTION_BUTTON_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2px 6px',
  fontSize: '11px',
  fontFamily: 'inherit',
  color: 'var(--text-secondary)',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border-primary)',
  borderRadius: '4px',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
  whiteSpace: 'nowrap',
};

const DIFF_BUTTON_ICON_STYLE: React.CSSProperties = {
  marginRight: '4px',
  fontSize: '12px',
};

const REFRESH_BUTTON_ICON_STYLE: React.CSSProperties = {
  fontSize: '12px',
};

const TASK_CONTAINER_STYLE: React.CSSProperties = { margin: 0 };

const FILE_LINK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
};

const FILE_ICON_STYLE: React.CSSProperties = {
  marginRight: '4px',
  display: 'flex',
  alignItems: 'center',
  width: '16px',
  height: '16px',
};

const LINE_INFO_STYLE: React.CSSProperties = {
  marginLeft: '8px',
  fontSize: '12px',
};

const STATS_STYLE: React.CSSProperties = {
  marginLeft: '12px',
  fontSize: '12px',
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const ADDED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-added-accent)' };
const DELETED_TEXT_STYLE: React.CSSProperties = { color: 'var(--diff-deleted-accent)' };
const STATS_SPACER_STYLE: React.CSSProperties = { margin: '0 4px' };

const TASK_DETAILS_STYLE: React.CSSProperties = {
  padding: 0,
  borderTop: '1px solid var(--border-primary)',
};

const DIFF_CONTAINER_STYLE: React.CSSProperties = {
  // Use monospace font to ensure consistent tab and space widths
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontSize: '12px',
  lineHeight: 1.5,
  background: 'var(--diff-surface)',
  // Normalize tab width to prevent indentation shifts across environments
  tabSize: 4 as unknown as number,
  MozTabSize: 4 as unknown as number,
  // Preserve whitespace and line breaks without wrapping to prevent reflow during selection
  whiteSpace: 'pre' as const,
  // Horizontal scroll only to avoid jitter from simultaneous horizontal and vertical changes
  overflowX: 'auto' as const,
  overflowY: 'hidden' as const,
  // Hint the browser to promote this container to a compositing layer for better selection performance
  willChange: 'transform' as const,
  transform: 'translateZ(0)',
};

const INNER_WRAPPER_STYLE: React.CSSProperties = {
  display: 'inline-block',
  minWidth: '100%',
};

const DIFF_PRE_STYLE: React.CSSProperties = {
  // Preserve original whitespace with consistent tab width
  whiteSpace: 'pre',
  margin: 0,
  paddingLeft: '4px',
  flex: 1,
  // Re-declare tabSize in case highlight or wrapper layers override it
  tabSize: 4 as unknown as number,
  MozTabSize: 4 as unknown as number,
  // Disable arbitrary line breaks to keep selection and scrolling stable
  overflowWrap: 'normal' as const,
};

function getDiffLineStyle(isDeleted: boolean, isAdded: boolean): React.CSSProperties {
  return {
    display: 'flex',
    background: isDeleted
      ? 'var(--diff-deleted-bg)'
      : isAdded
        ? 'var(--diff-added-bg)'
        : 'transparent',
    color: 'var(--diff-text)',
    minWidth: '100%',
  };
}

function getDiffGlyphStyle(isDeleted: boolean, isAdded: boolean, isUnchanged: boolean): React.CSSProperties {
  return {
    width: '24px',
    textAlign: 'center',
    color: isDeleted ? 'var(--diff-deleted-accent)' : isAdded ? 'var(--diff-added-accent)' : 'var(--diff-muted-text)',
    userSelect: 'none',
    background: isDeleted
      ? 'var(--diff-deleted-glyph-bg)'
      : isAdded
        ? 'var(--diff-added-glyph-bg)'
        : 'transparent',
    opacity: isUnchanged ? 0.5 : 0.7,
    flex: '0 0 24px',
  };
}

// Compute actual diff using the LCS algorithm
function computeDiff(oldLines: string[], newLines: string[]): DiffResult {
  if (oldLines.length === 0 && newLines.length === 0) {
    return { lines: [], additions: 0, deletions: 0 };
  }
  if (oldLines.length === 0) {
    return {
      lines: newLines.map(content => ({ type: 'added' as const, content })),
      additions: newLines.length,
      deletions: 0,
    };
  }
  if (newLines.length === 0) {
    return {
      lines: oldLines.map(content => ({ type: 'deleted' as const, content })),
      additions: 0,
      deletions: oldLines.length,
    };
  }

  const m = oldLines.length;
  const n = newLines.length;

  // Build the LCS dynamic programming table
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

  // Backtrack to generate the diff
  const diffLines: DiffLine[] = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.unshift({ type: 'unchanged', content: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.unshift({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      diffLines.unshift({ type: 'deleted', content: oldLines[i - 1] });
      i--;
    }
  }

  const additions = diffLines.filter(l => l.type === 'added').length;
  const deletions = diffLines.filter(l => l.type === 'deleted').length;

  return { lines: diffLines, additions, deletions };
}

const EditToolBlock = ({ name, input, result, toolId }: EditToolBlockProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('diffExpandedByDefault') === 'true';
    } catch {
      return false;
    }
  });

  const isDenied = useIsToolDenied(toolId);

  const normalizedInput = input ? normalizeToolInput(name, input) : input;

  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true);

  const target = normalizedInput ? resolveToolTarget({
    ...normalizedInput,
    file_path: (typeof normalizedInput.file_path === 'string' ? normalizedInput.file_path : undefined) ??
      (typeof normalizedInput.filePath === 'string' ? normalizedInput.filePath : undefined),
    target_file: (typeof normalizedInput.target_file === 'string' ? normalizedInput.target_file : undefined) ??
      (typeof normalizedInput.targetFile === 'string' ? normalizedInput.targetFile : undefined),
  }, name) : undefined;
  const filePath = target?.openPath;
  const fileLinkTooltip = useResolvedFileLinkTooltip(
    filePath,
    target?.displayPath || filePath || undefined,
  );

  const oldString =
    (typeof normalizedInput?.old_string === 'string' ? normalizedInput.old_string : undefined) ??
    (typeof normalizedInput?.oldString === 'string' ? normalizedInput.oldString : undefined) ??
    '';
  const newString =
    (typeof normalizedInput?.new_string === 'string' ? normalizedInput.new_string : undefined) ??
    (typeof normalizedInput?.newString === 'string' ? normalizedInput.newString : undefined) ??
    '';

  const diff = useMemo(() => {
    const oldLines = oldString ? oldString.split('\n') : [];
    const newLines = newString ? newString.split('\n') : [];
    return computeDiff(oldLines, newLines);
  }, [oldString, newString]);

  // Auto-refresh file in IDEA when the tool call completes successfully
  const hasRefreshed = useRef(false);
  useEffect(() => {
    if (filePath && isCompleted && !isError && !hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshFile(filePath);
    }
  }, [filePath, isCompleted, isError]);

  if (!normalizedInput) {
    return null;
  }

  if (!oldString && !newString) {
    return <GenericToolBlock name={name} input={normalizedInput} result={result} toolId={toolId} />;
  }

  const lineInfo = normalizedInput && target ? getToolLineInfo(normalizedInput, target, result) : {};
  const editCount = normalizedInput ? getToolEditCount(normalizedInput) : 0;
  const extraEditCount = editCount > 1 ? editCount - 1 : 0;

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      openFile(filePath, lineInfo.start, lineInfo.end);
    }
  };

  const handleShowDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      showDiff(filePath, oldString, newString, t('tools.editPrefix', { fileName: target?.cleanFileName ?? filePath }));
    }
  };

  const handleRefreshInIdea = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) {
      refreshFile(filePath);
      window.addToast?.(t('tools.refreshFileInIdeaSuccess'), 'success');
    }
  };

  const getFileIconSvg = () => {
    if (!target) return '';
    const extension = target.cleanFileName.includes('.') ? target.cleanFileName.split('.').pop() : '';
    return getFileIcon(extension ?? '', target.cleanFileName);
  };

  return (
    <div style={ROOT_STYLE}>
      {/* Top Row: Buttons (Right aligned) */}
      <div style={TOP_BAR_STYLE}>
        <div style={TOP_BAR_INNER_STYLE}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleShowDiff(e);
            }}
            title={t('tools.showDiffInIdea')}
            style={ACTION_BUTTON_STYLE}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-tertiary)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <span className="codicon codicon-diff" style={DIFF_BUTTON_ICON_STYLE} />
            {t('tools.diffButton')}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRefreshInIdea(e);
            }}
            title={t('tools.refreshFileInIdea')}
            style={ACTION_BUTTON_STYLE}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
              e.currentTarget.style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-tertiary)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
          >
            <span className="codicon codicon-refresh" style={REFRESH_BUTTON_ICON_STYLE} />
          </button>
        </div>
      </div>

      <div className="task-container" style={TASK_CONTAINER_STYLE}>
        <div className="task-header" onClick={() => setExpanded((prev) => !prev)}>
          <div className="task-title-section">
            <span className="codicon codicon-edit tool-title-icon" />

            <span className="tool-title-text">
              {t('tools.editFileTitle')}
            </span>
            <span
              className="tool-title-summary clickable-file"
              onClick={handleFileClick}
              {...fileLinkTooltip}
              style={FILE_LINK_STYLE}
            >
              <span
                style={FILE_ICON_STYLE}
                dangerouslySetInnerHTML={{ __html: getFileIconSvg() }}
              />
              {target?.displayPath || filePath}
            </span>
            {lineInfo.start && (
              <span className="tool-title-summary" style={LINE_INFO_STYLE}>
                {lineInfo.end && lineInfo.end !== lineInfo.start
                  ? t('tools.lineRange', { start: lineInfo.start, end: lineInfo.end })
                  : t('tools.lineSingle', { line: lineInfo.start })}
                {extraEditCount > 0 ? ` +${extraEditCount}${t('tools.editLocationsSuffix')}` : ''}
              </span>
            )}
            {!lineInfo.start && extraEditCount > 0 && (
              <span className="tool-title-summary" style={LINE_INFO_STYLE}>
                +{extraEditCount}{t('tools.editLocationsSuffix')}
              </span>
            )}

            {(diff.additions > 0 || diff.deletions > 0) && (
              <span style={STATS_STYLE}>
                {diff.additions > 0 && <span style={ADDED_TEXT_STYLE}>+{diff.additions}</span>}
                {diff.additions > 0 && diff.deletions > 0 && <span style={STATS_SPACER_STYLE} />}
                {diff.deletions > 0 && <span style={DELETED_TEXT_STYLE}>-{diff.deletions}</span>}
              </span>
            )}
          </div>

          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
        </div>

        {expanded && (
        <div className="task-details" style={TASK_DETAILS_STYLE}>
          <div style={DIFF_CONTAINER_STYLE}>
            {/* Inner wrapper stretches to scrollWidth so row backgrounds fill the full width */}
            <div style={INNER_WRAPPER_STYLE}>
            {diff.lines.map((line, index) => {
              const isDeleted = line.type === 'deleted';
              const isAdded = line.type === 'added';
              const isUnchanged = line.type === 'unchanged';

              return (
                <div
                  key={index}
                  style={getDiffLineStyle(isDeleted, isAdded)}
                >
                  <div style={getDiffGlyphStyle(isDeleted, isAdded, isUnchanged)}>
                    {isDeleted ? '-' : isAdded ? '+' : ' '}
                  </div>
                  <pre style={DIFF_PRE_STYLE}>
                    {line.content}
                  </pre>
                </div>
              );
            })}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

export default EditToolBlock;
