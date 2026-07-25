/**
 * Server Tools List Panel Component
 * Displays the server's tools list with hover-to-view tool details
 */

import type { ServerToolsState, McpTool } from './types';
import { getToolIcon } from './utils';

const WARNING_HEADER_STYLE: React.CSSProperties = { color: 'var(--color-warning)' };

export interface ServerToolsPanelProps {
  toolsInfo?: ServerToolsState[string];
  isConnected: boolean;
  isCodexMode: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLoadTools: (forceRefresh: boolean) => void;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Server Tools List Panel
 */
export function ServerToolsPanel({
  toolsInfo,
  isConnected,
  t,
  onLoadTools,
  onToolHover,
}: ServerToolsPanelProps) {
  // Tool results are only meaningful while the server is connected. Keeping a
  // stale empty result visible after a disconnect makes the panel report
  // "no tools" instead of the actual connection state.
  const visibleToolsInfo = isConnected ? toolsInfo : undefined;
  const emptyToolsResult = isEmptyToolsResult(visibleToolsInfo);

  return (
    <div className="server-detail-panel">
      {/* Tools list */}
      <div className="server-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">{t('mcp.tools')}</span>
          <div className="sidebar-actions">
            {isConnected && !toolsInfo && (
              <button
                className="sidebar-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onLoadTools(false);
                }}
                title={t('mcp.loadTools')}
              >
                <span className="codicon codicon-refresh"></span>
              </button>
            )}
            {visibleToolsInfo && !visibleToolsInfo.loading && (
              <button
                className="sidebar-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onLoadTools(true);
                }}
                title={t('mcp.logs.forceRefreshTools')}
              >
                <span className="codicon codicon-sync"></span>
              </button>
            )}
            {visibleToolsInfo?.loading && (
              <span className="sidebar-icon-btn">
                <span className="codicon codicon-loading codicon-modifier-spin"></span>
              </span>
            )}
          </div>
        </div>

        <div className="sidebar-content">
          {!isConnected && !visibleToolsInfo && (
            <div className="sidebar-section-header">{t('mcp.notConnected')}</div>
          )}

          {visibleToolsInfo?.error && (
            <>
              <div className="sidebar-section-header" style={WARNING_HEADER_STYLE}>
                {t('mcp.loadFailed')}
              </div>
              <div className="mcp-load-error-detail">{visibleToolsInfo.error}</div>
            </>
          )}

          {emptyToolsResult && (
            <div
              className="sidebar-section-header"
              style={isConnected ? WARNING_HEADER_STYLE : undefined}
            >
              {t('mcp.noTools')}
            </div>
          )}

          {visibleToolsInfo?.tools && visibleToolsInfo.tools.length > 0 && (
            <>
              <div className="sidebar-section-header">
                {t('mcp.tools')} ({visibleToolsInfo.tools.length})
              </div>
              <div className="sidebar-tool-list">
                {visibleToolsInfo.tools.map((tool, index) => (
                  <div
                    key={index}
                    className="sidebar-tool-item"
                    title={tool.description || tool.name}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      onToolHover(tool, {
                        x: rect.right + 8,
                        y: rect.top
                      });
                    }}
                    onMouseLeave={() => {
                      onToolHover(null);
                    }}
                  >
                    <span className={`codicon tool-icon ${getToolIcon(tool.name)}`}></span>
                    <div className="tool-info">
                      <span className="tool-name-text">{tool.name}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {isConnected && !toolsInfo && (
            <div className="sidebar-section-header">{t('mcp.clickToLoad')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function isEmptyToolsResult(toolsInfo: ServerToolsState[string] | undefined): boolean {
  return toolsInfo != null
    && !toolsInfo.loading
    && !toolsInfo.error
    && toolsInfo.tools.length === 0;
}
