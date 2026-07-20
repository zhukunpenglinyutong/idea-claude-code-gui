import { useEffect, useRef, useMemo, useCallback, useId, memo } from 'react';
import { useTranslation } from 'react-i18next';
import './ContextUsageDialog.css';
import { clampUsagePercentage } from '../utils/usagePercentage';

export interface ContextUsageData {
  categories: Array<{
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }>;
  gridRows: Array<Array<{
    color: string;
    isFilled: boolean;
    categoryName: string;
    tokens: number;
    percentage: number;
    squareFullness: number;
  }>>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{ name: string; serverName: string; tokens: number }>;
  agents: Array<{ agentType: string; source: string; tokens: number }>;
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>;
  };
  isAutoCompactEnabled: boolean;
  autoCompactThreshold?: number;
}

interface ContextUsageDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  data: ContextUsageData | null;
  onClose: () => void;
}

const COLOR_MAP: Record<string, string> = {
  promptBorder: '#7c6ff7',
  inactive: '#6b7280',
  cyanForSubagents: '#22d3ee',
  permission: '#10b981',
  claude: '#d97706',
  warning: '#f59e0b',
  purpleForSubagents: '#a78bfa',
  text: '#e5e7eb',
  success: '#22c55e',
  error: '#ef4444',
};

function resolveColor(key: string): string {
  if (COLOR_MAP[key]) return COLOR_MAP[key];
  if (key.startsWith('#')) return key;
  return '#6b7280';
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

interface DetailsTableProps<T> {
  summary: string;
  headers: readonly [string, string, string];
  rows: readonly T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => readonly [React.ReactNode, React.ReactNode, React.ReactNode];
}

function DetailsTable<T>({ summary, headers, rows, rowKey, renderRow }: DetailsTableProps<T>) {
  return (
    <details className="context-usage-detail-section">
      <summary>{summary}</summary>
      <table className="context-usage-table">
        <thead>
          <tr>
            <th>{headers[0]}</th>
            <th>{headers[1]}</th>
            <th>{headers[2]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cells = renderRow(row);
            return (
              <tr key={rowKey(row)}>
                <td>{cells[0]}</td>
                <td>{cells[1]}</td>
                <td>{cells[2]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

const ContextUsageDialog = memo(function ContextUsageDialog({
  isOpen,
  isLoading,
  data,
  onClose,
}: ContextUsageDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const translateCategoryName = useCallback((name: string) => {
    const keyMap: Record<string, string> = {
      'System prompt': 'contextUsage.categories.systemPrompt',
      'System tools': 'contextUsage.categories.systemTools',
      'MCP tools': 'contextUsage.categories.mcpTools',
      'Custom agents': 'contextUsage.categories.customAgents',
      'Memory files': 'contextUsage.categories.memoryFiles',
      'Skills': 'contextUsage.categories.skills',
      'Messages': 'contextUsage.categories.messages',
      'Autocompact buffer': 'contextUsage.categories.autoCompactBuffer',
      'Free space': 'contextUsage.categories.freeSpace',
    };

    const translationKey = keyMap[name];
    if (!translationKey) {
      return name;
    }

    return t(translationKey, { defaultValue: name });
  }, [t]);

  const closeDialog = useCallback(() => {
    onClose();
  }, [onClose]);

  // Use mousedown instead of click for close buttons to ensure reliable
  // event handling in JCEF environments where React synthetic onClick
  // may not fire consistently.
  // Unified mousedown handler for closing - used by both the overlay
  // (click outside) and close button. Uses mousedown for reliability in JCEF.
  const handleCloseMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeDialog();
  }, [closeDialog]);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closeDialog();
  }, [closeDialog]);

  // Prevent overlay mousedown from reaching the dialog content
  const handleDialogMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Compute derived values before any early returns to satisfy hooks rules
  const { visibleCategories, freeSpace, autoCompactBuffer } = useMemo(() => {
    if (!data?.categories) {
      return { visibleCategories: [], freeSpace: undefined, autoCompactBuffer: undefined };
    }
    const visible: typeof data.categories = [];
    let free: typeof data.categories[0] | undefined;
    let buffer: typeof data.categories[0] | undefined;

    for (const cat of data.categories) {
      if (cat.name === 'Free space') {
        free = cat;
      } else if (cat.name === 'Autocompact buffer') {
        buffer = cat;
      } else if (cat.tokens > 0) {
        visible.push(cat);
      }
    }

    return { visibleCategories: visible, freeSpace: free, autoCompactBuffer: buffer };
  }, [data?.categories]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, closeDialog]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    lastFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const rafId = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      lastFocusedElementRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // Loading state
  if (isLoading || !data) {
    return (
      <div className="context-usage-overlay" onMouseDown={handleCloseMouseDown}>
        <div
          className="context-usage-dialog context-usage-loading"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          tabIndex={-1}
          onMouseDown={handleDialogMouseDown}
        >
          <div className="context-usage-header">
            <h3 id={titleId} className="context-usage-title">
              {t('contextUsage.title', { defaultValue: 'Context Usage' })}
            </h3>
            <button
              ref={closeButtonRef}
              type="button"
              className="context-usage-close"
              onMouseDown={handleCloseMouseDown}
              onClick={handleCloseClick}
              title={t('common.close', { defaultValue: 'Close' })}
              aria-label={t('common.close', { defaultValue: 'Close' })}
            >
              ×
            </button>
          </div>
          <div className="context-usage-loading-body">
            <div className="context-usage-spinner" />
            <span id={descriptionId} className="context-usage-loading-text">
              {t('contextUsage.loading', { defaultValue: 'Loading context usage...' })}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const {
    gridRows = [],
    totalTokens = 0,
    rawMaxTokens = data.maxTokens ?? 0,
    percentage = 0,
    model = '',
    memoryFiles = [],
    mcpTools = [],
    agents = [],
    skills,
    isAutoCompactEnabled = false,
    autoCompactThreshold,
  } = data;
  const safePercentage = clampUsagePercentage(percentage);

  return (
    <div className="context-usage-overlay" onMouseDown={handleCloseMouseDown}>
      <div
        className="context-usage-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onMouseDown={handleDialogMouseDown}
      >
        {/* Header */}
        <div className="context-usage-header">
          <h3 id={titleId} className="context-usage-title">
            {t('contextUsage.title', { defaultValue: 'Context Usage' })}
          </h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="context-usage-close"
            onMouseDown={handleCloseMouseDown}
            onClick={handleCloseClick}
            title={t('common.close', { defaultValue: 'Close' })}
            aria-label={t('common.close', { defaultValue: 'Close' })}
          >
            ×
          </button>
        </div>

        {/* Summary */}
        <div id={descriptionId} className="context-usage-summary">
          <span className="context-usage-model">{model}</span>
          <span className="context-usage-tokens">
            {formatTokens(totalTokens)} / {formatTokens(rawMaxTokens)} ({safePercentage}%)
          </span>
          {isAutoCompactEnabled && (
            <span className="context-usage-autocompact">
              {autoCompactThreshold && rawMaxTokens > 0
                ? t('contextUsage.autoCompactEnabledWithThreshold', {
                    threshold: Math.round(clampUsagePercentage((autoCompactThreshold / rawMaxTokens) * 100)),
                    defaultValue: 'Auto-compact: enabled ({{threshold}}%)',
                  })
                : t('contextUsage.autoCompactEnabled', {
                    defaultValue: 'Auto-compact: enabled',
                  })}
            </span>
          )}
        </div>

        {/* Colored grid */}
        {gridRows && gridRows.length > 0 && (
          <div className="context-usage-grid">
            {gridRows.map((row, ri) => (
              <div key={`row-${ri}`} className="context-usage-grid-row">
                {row.map((sq, ci) => {
                  const squareKey = `${sq.categoryName}-${ri}-${ci}`;
                  if (sq.categoryName === 'Free space') {
                    return (
                      <div
                        key={squareKey}
                        className="context-usage-grid-cell free-space"
                        title={`${translateCategoryName(sq.categoryName)}: ${formatTokens(sq.tokens)}`}
                      />
                    );
                  }
                  if (sq.categoryName === 'Autocompact buffer') {
                    return (
                      <div
                        key={squareKey}
                        className="context-usage-grid-cell"
                        style={{ backgroundColor: resolveColor(sq.color), opacity: 0.5 }}
                        title={`${translateCategoryName(sq.categoryName)}: ${formatTokens(sq.tokens)}`}
                      />
                    );
                  }
                  const safeFullness = Number.isFinite(sq.squareFullness)
                    ? Math.max(0, Math.min(1, sq.squareFullness))
                    : 0;
                  const filled = safeFullness >= 0.7;
                  return (
                    <div
                      key={squareKey}
                      className={`context-usage-grid-cell ${filled ? 'filled' : 'partial'}`}
                      style={{
                        backgroundColor: resolveColor(sq.color),
                        ...(filled ? {} : { opacity: 0.5 + safeFullness * 0.5 }),
                      }}
                      title={`${translateCategoryName(sq.categoryName)}: ${formatTokens(sq.tokens)} (${clampUsagePercentage(sq.percentage).toFixed(1)}%)`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Legend */}
        <div className="context-usage-legend">
          {visibleCategories.map((cat) => {
            const translatedName = translateCategoryName(cat.name);
            return (
            <div key={`${cat.name}-${cat.color}`} className="context-usage-legend-item" title={`${translatedName}: ${formatTokens(cat.tokens)}`}>
              <span
                className="context-usage-legend-dot"
                style={{ backgroundColor: resolveColor(cat.color) }}
              />
              <span className="context-usage-legend-name">{translatedName}</span>
              <span className="context-usage-legend-tokens">
                {cat.isDeferred
                  ? t('contextUsage.notAvailable', { defaultValue: 'N/A' })
                  : formatTokens(cat.tokens)}
              </span>
            </div>
            );
          })}
          {autoCompactBuffer && autoCompactBuffer.tokens > 0 && (
            <div
              className="context-usage-legend-item"
              title={`${t('contextUsage.categories.autoCompactBuffer', { defaultValue: 'Autocompact buffer' })}: ${formatTokens(autoCompactBuffer.tokens)}`}
            >
              <span
                className="context-usage-legend-dot"
                style={{ backgroundColor: resolveColor(autoCompactBuffer.color), opacity: 0.5 }}
              />
              <span className="context-usage-legend-name">
                {t('contextUsage.categories.autoCompactBuffer', { defaultValue: 'Autocompact buffer' })}
              </span>
              <span className="context-usage-legend-tokens">{formatTokens(autoCompactBuffer.tokens)}</span>
            </div>
          )}
          {freeSpace && freeSpace.tokens > 0 && (
            <div
              className="context-usage-legend-item free-space-legend"
              title={`${t('contextUsage.categories.freeSpace', { defaultValue: 'Free space' })}: ${formatTokens(freeSpace.tokens)}`}
            >
              <span className="context-usage-legend-dot free-space-dot" />
              <span className="context-usage-legend-name">
                {t('contextUsage.categories.freeSpace', { defaultValue: 'Free space' })}
              </span>
              <span className="context-usage-legend-tokens">{formatTokens(freeSpace.tokens)}</span>
            </div>
          )}
        </div>

        {/* Details tables */}
        <div className="context-usage-details">
          {mcpTools.length > 0 && (
            <DetailsTable
              summary={t('contextUsage.sections.mcpTools', { count: mcpTools.length, defaultValue: 'MCP Tools ({{count}})' })}
              headers={[
                t('contextUsage.table.tool', { defaultValue: 'Tool' }),
                t('contextUsage.table.server', { defaultValue: 'Server' }),
                t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
              ]}
              rows={mcpTools}
              rowKey={(tool) => `${tool.serverName}-${tool.name}`}
              renderRow={(tool) => [tool.name, tool.serverName, formatTokens(tool.tokens)]}
            />
          )}

          {agents.length > 0 && (
            <DetailsTable
              summary={t('contextUsage.sections.agents', { count: agents.length, defaultValue: 'Agents ({{count}})' })}
              headers={[
                t('contextUsage.table.agent', { defaultValue: 'Agent' }),
                t('contextUsage.table.source', { defaultValue: 'Source' }),
                t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
              ]}
              rows={agents}
              rowKey={(agent) => `${agent.source}-${agent.agentType}`}
              renderRow={(agent) => [agent.agentType, agent.source, formatTokens(agent.tokens)]}
            />
          )}

          {memoryFiles.length > 0 && (
            <DetailsTable
              summary={t('contextUsage.sections.memoryFiles', { count: memoryFiles.length, defaultValue: 'Memory Files ({{count}})' })}
              headers={[
                t('contextUsage.table.type', { defaultValue: 'Type' }),
                t('contextUsage.table.path', { defaultValue: 'Path' }),
                t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
              ]}
              rows={memoryFiles}
              rowKey={(file) => `${file.type}-${file.path}`}
              renderRow={(file) => {
                const shortPath = file.path.length > 60 ? '...' + file.path.slice(-57) : file.path;
                return [file.type, <span title={file.path}>{shortPath}</span>, formatTokens(file.tokens)];
              }}
            />
          )}

          {skills && skills.skillFrontmatter?.length > 0 && (
            <DetailsTable
              summary={t('contextUsage.sections.skills', {
                included: skills.includedSkills ?? 0,
                total: skills.totalSkills ?? 0,
                defaultValue: 'Skills ({{included}}/{{total}})',
              })}
              headers={[
                t('contextUsage.table.skill', { defaultValue: 'Skill' }),
                t('contextUsage.table.source', { defaultValue: 'Source' }),
                t('contextUsage.table.tokens', { defaultValue: 'Tokens' }),
              ]}
              rows={skills.skillFrontmatter}
              rowKey={(skill) => `${skill.source}-${skill.name}`}
              renderRow={(skill) => [skill.name, skill.source, formatTokens(skill.tokens)]}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export default ContextUsageDialog;
