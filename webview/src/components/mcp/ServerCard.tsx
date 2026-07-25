/**
 * Server Card Component
 * Displays information, status, and actions for a single MCP server
 */

import type { McpServer, McpServerStatusInfo } from '../../types/mcp';
import type { ServerRefreshState, ServerToolsState, McpTool } from './types';
import { getServerStatusInfo, getStatusIcon, getStatusColor, getStatusText, getIconColor, getServerInitial, isServerEnabled } from './utils';
import { isEmptyToolsResult, ServerToolsPanel } from './ServerToolsPanel';

export interface ServerCardProps {
  server: McpServer;
  isExpanded: boolean;
  isCodexMode: boolean;
  serverStatus: Map<string, McpServerStatusInfo>;
  refreshState?: ServerRefreshState[string];
  toolsInfo?: ServerToolsState[string];
  t: (key: string, options?: Record<string, unknown>) => string;
  onToggleExpand: () => void;
  onToggleServer: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onRefresh: () => void;
  onLoadTools: (forceRefresh: boolean) => void;
  onCopyUrl: (url: string) => void;
  onToolHover: (tool: McpTool | null, position?: { x: number; y: number }) => void;
}

/**
 * Server Card Component
 */
export function ServerCard({
  server,
  isExpanded,
  isCodexMode,
  serverStatus,
  toolsInfo,
  t,
  onToggleExpand,
  onToggleServer,
  onEdit,
  onDelete,
  onCopy,
  onLoadTools,
  onCopyUrl,
  onToolHover,
}: ServerCardProps) {
  const statusInfo = getServerStatusInfo(server, serverStatus);
  const status = statusInfo?.status;
  const effectiveStatus: McpServerStatusInfo['status'] | undefined =
    status === 'pending' && (toolsInfo?.tools?.length ?? 0) > 0
      ? 'connected'
      : status;
  const enabled = isServerEnabled(server, isCodexMode);
  const isConnected = effectiveStatus === 'connected';
  const emptyToolsWarning = hasEmptyToolsWarning(effectiveStatus, toolsInfo, enabled);

  const iconStyle: React.CSSProperties = { background: getIconColor(server.id) };
  const statusColorStyle: React.CSSProperties = {
    color: emptyToolsWarning ? 'var(--color-warning)' : getStatusColor(server, effectiveStatus, isCodexMode),
  };

  return (
    <div
      className={`server-card ${isExpanded ? 'expanded' : ''} ${!enabled ? 'disabled' : ''}`}
    >
      {/* Card header */}
      <div className="card-header" onClick={onToggleExpand}>
        <div className="header-left-section">
          <span className={`expand-icon codicon ${isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></span>
          <div className="server-icon" style={iconStyle}>
            {getServerInitial(server)}
          </div>
          <span className="server-name">{server.name || server.id}</span>
          {/* Connection status indicator */}
          <span
            className="status-indicator"
            style={statusColorStyle}
            title={emptyToolsWarning
              ? `${getStatusText(server, effectiveStatus, isCodexMode, t)}: ${t('mcp.noTools')}`
              : getStatusText(server, effectiveStatus, isCodexMode, t)}
          >
            <span className={`codicon ${emptyToolsWarning
              ? 'codicon-warning'
              : getStatusIcon(server, effectiveStatus, isCodexMode)}`}></span>
          </span>
        </div>
        <div className="header-right-section" onClick={(e) => e.stopPropagation()}>
          {/* Edit button */}
          <button
            className="icon-btn edit-btn"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            title={t('chat.editConfig')}
          >
            <span className="codicon codicon-edit"></span>
          </button>
          {/* Copy button */}
          <button
            className="icon-btn copy-btn"
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
            }}
            title={t('chat.copyConfig')}
          >
            <span className="codicon codicon-copy"></span>
          </button>
          {/* Delete button */}
          <button
            className="icon-btn delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title={t('chat.deleteServer')}
          >
            <span className="codicon codicon-trash"></span>
          </button>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onToggleServer(e.target.checked)}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="card-content">
          {/* Connection status info */}
          <div className="status-section">
            <div className="info-row">
              <span className="info-label">{t('mcp.connectionStatus')}:</span>
              <span
                className="info-value status-value"
                style={statusColorStyle}
              >
                <span className={`codicon ${getStatusIcon(server, effectiveStatus, isCodexMode)}`}></span>
                {' '}{getStatusText(server, effectiveStatus, isCodexMode, t)}
              </span>
            </div>
            {statusInfo?.serverInfo && (
              <div className="info-row">
                <span className="info-label">{t('mcp.serverVersion')}:</span>
                <span className="info-value">
                  {statusInfo.serverInfo.name} v{statusInfo.serverInfo.version}
                </span>
              </div>
            )}
          </div>

          {/* Server info */}
          <div className="info-section">
            {server.description && (
              <div className="info-row">
                <span className="info-label">{t('mcp.description')}:</span>
                <span className="info-value">{server.description}</span>
              </div>
            )}
            {server.server.command && (
              <div className="info-row">
                <span className="info-label">{t('mcp.command')}:</span>
                <code className="info-value command">
                  {server.server.command} {(server.server.args || []).join(' ')}
                </code>
              </div>
            )}
            {server.server.url && (
              <div className="info-row">
                <span className="info-label">{t('mcp.url')}:</span>
                <code className="info-value command">{server.server.url}</code>
              </div>
            )}
          </div>

          {/* Tools list panel */}
          <ServerToolsPanel
            toolsInfo={toolsInfo}
            isConnected={isConnected}
            isCodexMode={isCodexMode}
            t={t}
            onLoadTools={onLoadTools}
            onToolHover={onToolHover}
          />

          {/* Tags */}
          {server.tags && server.tags.length > 0 && (
            <div className="tags-section">
              {server.tags.map(tag => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="actions-section">
            {server.homepage && (
              <button
                className="action-btn"
                onClick={() => onCopyUrl(server.homepage!)}
                title={t('chat.copyHomepageLink')}
              >
                <span className="codicon codicon-home"></span>
                {t('mcp.homepage')}
              </button>
            )}
            {server.docs && (
              <button
                className="action-btn"
                onClick={() => onCopyUrl(server.docs!)}
                title={t('chat.copyDocsLink')}
              >
                <span className="codicon codicon-book"></span>
                {t('mcp.docs')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function hasEmptyToolsWarning(
  status: McpServerStatusInfo['status'] | undefined,
  toolsInfo: ServerToolsState[string] | undefined,
  enabled: boolean,
): boolean {
  return enabled && status === 'connected' && isEmptyToolsResult(toolsInfo);
}
