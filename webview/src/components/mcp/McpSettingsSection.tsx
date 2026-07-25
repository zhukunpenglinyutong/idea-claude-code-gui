/**
 * MCP Server Settings Component
 * Supports both Claude and Codex modes
 */

import { useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer, McpPreset } from '../../types/mcp';
import { sendToJava } from '../../utils/bridge';
import { McpServerDialog } from './McpServerDialog';
import { McpPresetDialog } from './McpPresetDialog';
import { McpMarketplaceDialog } from './McpMarketplaceDialog';
import { McpImportDialog } from './McpImportDialog';
import { McpHelpDialog } from './McpHelpDialog';
import { McpConfirmDialog } from './McpConfirmDialog';
import { McpLogDialog } from './McpLogDialog';
import { ToastContainer, type ToastMessage } from '../Toast';
import { copyToClipboard } from '../../utils/copyUtils';

// Types and utility functions
import type { McpSettingsSectionProps, RefreshLog, McpTool } from './types';
import { getCacheKeys, getToolIcon } from './utils';

// Hooks
import { useServerData } from './hooks/useServerData';
import { useServerManagement } from './hooks/useServerManagement';
import { useToolsUpdate } from './hooks/useToolsUpdate';

// Sub-components
import { ServerCard } from './ServerCard';
import { getMcpMessagePrefix, resolveInitialMcpProvider, type McpProvider } from './providerSelection';

/**
 * MCP Server Settings Component
 */
export function McpSettingsSection({ currentProvider = 'claude' }: McpSettingsSectionProps) {
  const [selectedProvider, setSelectedProvider] = useState<McpProvider>(() => {
    let savedProvider: string | null = null;
    try {
      savedProvider = localStorage.getItem('mcp.selectedProvider');
    } catch {
      // Fall back to the active chat provider when storage is unavailable.
    }
    return resolveInitialMcpProvider(currentProvider, savedProvider);
  });

  const selectProvider = useCallback((provider: McpProvider) => {
    setSelectedProvider(provider);
    try {
      localStorage.setItem('mcp.selectedProvider', provider);
    } catch {
      // The selection remains valid for this settings session.
    }
  }, []);

  return (
    <div className="mcp-settings-shell">
      <div className="mcp-provider-tabs" role="tablist" aria-label="MCP provider">
        <button
          type="button"
          role="tab"
          aria-selected={selectedProvider === 'claude'}
          className={selectedProvider === 'claude' ? 'active' : ''}
          onClick={() => selectProvider('claude')}
        >
          <span className="codicon codicon-hubot" aria-hidden="true" />
          Claude
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={selectedProvider === 'codex'}
          className={selectedProvider === 'codex' ? 'active' : ''}
          onClick={() => selectProvider('codex')}
        >
          <span className="codicon codicon-terminal" aria-hidden="true" />
          Codex
        </button>
      </div>
      <McpProviderPanel key={selectedProvider} currentProvider={selectedProvider} />
    </div>
  );
}

function McpProviderPanel({ currentProvider }: { currentProvider: McpProvider }) {
  const { t } = useTranslation();
  const isCodexMode = currentProvider === 'codex';

  // Generate message type prefix based on provider
  const messagePrefix = useMemo(() => getMcpMessagePrefix(currentProvider), [currentProvider]);

  // Get provider-specific cache keys
  const cacheKeys = useMemo(() => getCacheKeys(isCodexMode ? 'codex' : 'claude'), [isCodexMode]);

  // Dropdown menu state
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Tool tooltip popup state
  const [hoveredTool, setHoveredTool] = useState<{ serverId: string; tool: McpTool; position: { x: number; y: number } } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Dialog state
  const [showServerDialog, setShowServerDialog] = useState(false);
  const [showPresetDialog, setShowPresetDialog] = useState(false);
  const [showMarketplaceDialog, setShowMarketplaceDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showLogDialog, setShowLogDialog] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [deletingServer, setDeletingServer] = useState<McpServer | null>(null);

  // Toast state management
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Refresh logs state
  const [refreshLogs, setRefreshLogs] = useState<RefreshLog[]>([]);

  // Toast helper functions
  const addToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Log helper functions
  const addLog = useCallback((
    message: string,
    type: RefreshLog['type'] = 'info',
    details?: string,
    serverName?: string,
    requestInfo?: string,
    errorReason?: string
  ) => {
    const id = `log-${Date.now()}-${Math.random()}`;
    const log: RefreshLog = {
      id,
      timestamp: new Date(),
      type,
      message,
      details,
      serverName,
      requestInfo,
      errorReason
    };
    setRefreshLogs((prev) => [...prev, log].slice(-100));
  }, []);

  const clearLogs = useCallback(() => {
    setRefreshLogs([]);
    addLog(t('mcp.logs.cleared'), 'info');
  }, [addLog, t]);

  // Use server data hook
  const {
    servers,
    serverStatus,
    loading,
    statusLoading,
    expandedServers,
    serverTools,
    setServerTools,
    setExpandedServers,
    loadServers,
    loadServerStatus,
    loadServerTools,
  } = useServerData({
    isCodexMode,
    messagePrefix,
    cacheKeys,
    t,
    onLog: addLog,
  });

  // Use server management hook
  const {
    serverRefreshStates,
    handleRefresh,
    handleRefreshSingleServer,
    handleToggleServer,
  } = useServerManagement({
    isCodexMode,
    messagePrefix,
    cacheKeys,
    setServerTools,
    loadServers,
    loadServerStatus,
    loadServerTools,
    onLog: addLog,
    onToast: addToast,
    t,
  });

  // Use tools list update hook
  useToolsUpdate({
    isCodexMode,
    cacheKeys,
    setServerTools,
    onLog: addLog,
  });

  // Toggle server expand/collapse
  const toggleExpand = useCallback((serverId: string) => {
    const server = servers.find(s => s.id === serverId);
    const isExpanding = !expandedServers.has(serverId);

    if (isExpanding) {
      setExpandedServers(new Set([serverId]));
      // Save last expanded server ID to cache
      try {
        localStorage.setItem(cacheKeys.LAST_SERVER_ID, serverId);
      } catch (e) {
        // ignore
      }

      // Automatically load tool list when expanded.
      if (server && !serverTools[serverId]) {
        loadServerTools(server, false);
      }
    } else {
      const newExpanded = new Set(expandedServers);
      newExpanded.delete(serverId);
      setExpandedServers(newExpanded);
    }
  }, [servers, expandedServers, serverTools, cacheKeys, setExpandedServers, loadServerTools]);

  // Edit server
  const handleEdit = useCallback((server: McpServer) => {
    setEditingServer(server);
    setShowServerDialog(true);
  }, []);

  // Delete server
  const handleDelete = useCallback((server: McpServer) => {
    setDeletingServer(server);
    setShowConfirmDialog(true);
  }, []);

  // Confirm deletion
  const confirmDelete = useCallback(() => {
    if (deletingServer) {
      sendToJava(`delete_${messagePrefix}mcp_server`, { id: deletingServer.id });
      addToast(`${t('mcp.deleted')} ${deletingServer.name || deletingServer.id}`, 'success');

      setTimeout(() => {
        loadServers();
      }, 100);
    }
    setShowConfirmDialog(false);
    setDeletingServer(null);
  }, [deletingServer, messagePrefix, addToast, t, loadServers]);

  // Cancel deletion
  const cancelDelete = useCallback(() => {
    setShowConfirmDialog(false);
    setDeletingServer(null);
  }, []);

  // Add server manually
  const handleAddManual = useCallback(() => {
    setShowDropdown(false);
    setEditingServer(null);
    setShowServerDialog(true);
  }, []);

  // Add server from marketplace
  const handleAddFromMarket = useCallback(() => {
    setShowDropdown(false);
    setShowMarketplaceDialog(true);
  }, []);

  // Import servers from a GitHub Copilot configuration
  const handleImportFromCopilot = useCallback(() => {
    setShowDropdown(false);
    setShowImportDialog(true);
  }, []);

  // Persist imported servers via the same save path as handleSaveServer
  const handleImportServers = useCallback((importedServers: McpServer[]) => {
    importedServers.forEach((server) => {
      sendToJava(`add_${messagePrefix}mcp_server`, server);
    });
    addToast(`${t('mcp.added')} ${importedServers.length}`, 'success');
    setTimeout(() => {
      loadServers();
    }, 100);
  }, [messagePrefix, addToast, t, loadServers]);

  // Save server
  const handleSaveServer = useCallback((server: McpServer) => {
    if (editingServer) {
      if (editingServer.id !== server.id) {
        sendToJava(`delete_${messagePrefix}mcp_server`, { id: editingServer.id });
        sendToJava(`add_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.updated')} ${server.name || server.id}`, 'success');
      } else {
        sendToJava(`update_${messagePrefix}mcp_server`, server);
        addToast(`${t('mcp.saved')} ${server.name || server.id}`, 'success');
      }
    } else {
      sendToJava(`add_${messagePrefix}mcp_server`, server);
      addToast(`${t('mcp.added')} ${server.name || server.id}`, 'success');
    }

    setTimeout(() => {
      loadServers();
    }, 100);

    setShowServerDialog(false);
    setEditingServer(null);
  }, [editingServer, messagePrefix, addToast, t, loadServers]);

  // Select preset
  const handleSelectPreset = useCallback((preset: McpPreset) => {
    const server: McpServer = {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      tags: preset.tags,
      server: { ...preset.server },
      apps: {
        claude: !isCodexMode,
        codex: isCodexMode,
        gemini: false,
      },
      homepage: preset.homepage,
      docs: preset.docs,
      enabled: true,
    };
    sendToJava(`add_${messagePrefix}mcp_server`, server);
    addToast(`${t('mcp.added')} ${preset.name}`, 'success');

    setTimeout(() => {
      loadServers();
    }, 100);

    setShowPresetDialog(false);
  }, [isCodexMode, messagePrefix, addToast, t, loadServers]);

  // Copy URL
  const handleCopyUrl = useCallback(async (url: string) => {
    const success = await copyToClipboard(url);
    if (success) {
      addToast(t('mcp.linkCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  }, [addToast, t]);

  // Copy server config (redact sensitive values in env/headers)
  const handleCopyConfig = useCallback(async (server: McpServer) => {
    const { env, headers, ...safeFields } = server.server;
    const serverConfig: Record<string, unknown> = { ...safeFields };
    if (env) {
      serverConfig.env = Object.fromEntries(
        Object.keys(env).map(k => [k, '***'])
      );
    }
    if (headers) {
      serverConfig.headers = Object.fromEntries(
        Object.keys(headers).map(k => [k, '***'])
      );
    }
    const config = {
      mcpServers: {
        [server.id]: serverConfig,
      },
    };
    const jsonContent = JSON.stringify(config, null, 2);
    const success = await copyToClipboard(jsonContent);
    if (success) {
      addToast(t('mcp.configCopied'), 'success');
    } else {
      addToast(t('mcp.copyFailed'), 'error');
    }
  }, [addToast, t]);

  // Tool hover handler
  const handleToolHover = useCallback((tool: McpTool | null, position?: { x: number; y: number }, serverId?: string) => {
    if (tool && position && serverId) {
      setHoveredTool({ serverId, tool, position });
    } else {
      setHoveredTool(null);
    }
  }, []);

  return (
    <div className="mcp-settings-section">
      {/* Header */}
      <div className="mcp-header">
        <div className="header-left">
          <span className="header-title">{t('mcp.title')}</span>
          <button
            className="help-btn"
            onClick={() => setShowHelpDialog(true)}
            title={t('mcp.whatIsMcp')}
          >
            <span className="codicon codicon-question"></span>
          </button>
        </div>
        <div className="header-right">
          <button
            className="log-btn"
            onClick={() => setShowLogDialog(true)}
            title={t('mcp.logs.title')}
          >
            <span className="codicon codicon-output"></span>
            {refreshLogs.length > 0 && (
              <span className="log-badge">{refreshLogs.length}</span>
            )}
          </button>
          <button
            className="refresh-btn"
            onClick={handleRefresh}
            disabled={loading || statusLoading}
            title={t('mcp.refreshStatus')}
          >
            <span className={`codicon codicon-sync ${loading || statusLoading ? 'spinning' : ''}`}></span>
          </button>
          <div className="add-dropdown" ref={dropdownRef}>
            <button className="add-btn" onClick={() => setShowDropdown(!showDropdown)}>
              <span className="codicon codicon-add"></span>
              {t('mcp.add')}
              <span className="codicon codicon-chevron-down"></span>
            </button>
            {showDropdown && (
              <div className="dropdown-menu">
                <div className="dropdown-item" onClick={handleAddManual}>
                  <span className="codicon codicon-json"></span>
                  {t('mcp.manualConfig')}
                </div>
                <div className="dropdown-item" onClick={handleAddFromMarket}>
                  <span className="codicon codicon-extensions"></span>
                  {t('mcp.addFromMarket')}
                </div>
                <div className="dropdown-item" onClick={handleImportFromCopilot}>
                  <span className="codicon codicon-github"></span>
                  {t('mcp.import.menuLabel')}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Vertical layout: server list | refresh logs */}
      <div className="mcp-panels-container">
        {/* Top panel: server list */}
        <div className="mcp-server-panel">
          {!loading || servers.length > 0 ? (
            <div className="server-list">
              {servers.map(server => (
                <ServerCard
                  key={server.id}
                  server={server}
                  isExpanded={expandedServers.has(server.id)}
                  isCodexMode={isCodexMode}
                  serverStatus={serverStatus}
                  refreshState={serverRefreshStates[server.id]}
                  toolsInfo={serverTools[server.id]}
                  t={t}
                  onToggleExpand={() => toggleExpand(server.id)}
                  onToggleServer={(enabled) => handleToggleServer(server, enabled)}
                  onEdit={() => handleEdit(server)}
                  onDelete={() => handleDelete(server)}
                  onCopy={() => handleCopyConfig(server)}
                  onRefresh={() => handleRefreshSingleServer(server)}
                  onLoadTools={(forceRefresh) => loadServerTools(server, forceRefresh)}
                  onCopyUrl={handleCopyUrl}
                  onToolHover={(tool, position) => handleToolHover(tool, position, server.id)}
                />
              ))}

              {/* Empty state */}
              {servers.length === 0 && !loading && (
                <div className="empty-state">
                  <span className="codicon codicon-server"></span>
                  <p>{t('mcp.noServers')}</p>
                  <p className="hint">{t('mcp.addServerHint')}</p>
                </div>
              )}
            </div>
          ) : null}

          {/* Loading state */}
          {loading && servers.length === 0 && (
            <div className="loading-state">
              <span className="codicon codicon-loading codicon-modifier-spin"></span>
              <p>{t('mcp.loading')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      {showServerDialog && (
        <McpServerDialog
          server={editingServer}
          existingIds={servers.map(s => s.id)}
          currentProvider={currentProvider}
          onClose={() => {
            setShowServerDialog(false);
            setEditingServer(null);
          }}
          onSave={handleSaveServer}
        />
      )}

      {showPresetDialog && (
        <McpPresetDialog
          onClose={() => setShowPresetDialog(false)}
          onSelect={handleSelectPreset}
        />
      )}

      {showMarketplaceDialog && (
        <McpMarketplaceDialog
          currentProvider={currentProvider}
          existingIds={servers.map(s => s.id)}
          onClose={() => setShowMarketplaceDialog(false)}
          onSelect={handleSaveServer}
        />
      )}

      {showImportDialog && (
        <McpImportDialog
          currentProvider={currentProvider}
          existingIds={servers.map(s => s.id)}
          onClose={() => setShowImportDialog(false)}
          onImport={handleImportServers}
        />
      )}

      {showHelpDialog && (
        <McpHelpDialog onClose={() => setShowHelpDialog(false)} />
      )}

      {showConfirmDialog && deletingServer && (
        <McpConfirmDialog
          title={t('mcp.deleteTitle')}
          message={t('mcp.deleteMessage', { name: deletingServer.name || deletingServer.id })}
          confirmText={t('mcp.deleteConfirm')}
          cancelText={t('mcp.cancel')}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}

      {showLogDialog && (
        <McpLogDialog
          logs={refreshLogs.map(log => ({
            id: log.id,
            timestamp: log.timestamp,
            serverName: log.serverName || '',
            level: log.type === 'warning' ? 'warn' : log.type,
            message: log.message
          }))}
          onClose={() => setShowLogDialog(false)}
          onClear={clearLogs}
        />
      )}

      {/* Toast notifications */}
      <ToastContainer messages={toasts} onDismiss={dismissToast} />

      {/* Tool tooltip popup */}
      {hoveredTool && (() => {
        const tooltipStyle: React.CSSProperties = {
          left: `${Math.min(hoveredTool.position.x, window.innerWidth - 420)}px`,
          top: `${hoveredTool.position.y}px`,
        };
        return (
        <div
          ref={tooltipRef}
          className="mcp-tool-tooltip"
          style={tooltipStyle}
        >
          <div className="tooltip-header">
            <span className="tooltip-icon">
              <span className={`codicon tool-icon ${getToolIcon(hoveredTool.tool.name)}`}></span>
            </span>
            <span className="tooltip-name">{hoveredTool.tool.name}</span>
          </div>
          {hoveredTool.tool.description && (
            <div className="tooltip-description">{hoveredTool.tool.description}</div>
          )}
          {hoveredTool.tool.inputSchema && (
            <div className="tooltip-params">
              {renderInputSchema(hoveredTool.tool.inputSchema, t)}
            </div>
          )}
        </div>
        );
      })()}
    </div>
  );
}

/**
 * Render inputSchema as a parameter list
 */
function renderInputSchema(
  schema: Record<string, unknown> | undefined,
  t: (key: string) => string
): React.ReactElement {
  if (!schema) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  const properties = schema.properties as Record<string, { type?: string; description?: string }> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties || Object.keys(properties).length === 0) {
    return <div className="tooltip-no-params">{t('mcp.noParams')}</div>;
  }

  return (
    <>
      {Object.entries(properties).map(([paramName, paramDef]) => {
        const isRequired = required.includes(paramName);
        const paramType = paramDef.type || 'unknown';
        const paramDesc = paramDef.description;

        return (
          <div key={paramName} className="tooltip-param">
            <div className="tooltip-param-name">{paramName}</div>
            {paramDesc && <div className="tooltip-param-desc">{paramDesc}</div>}
            <div className="tooltip-param-meta">
              <span className="tooltip-param-type">{paramType}</span>
              <span className={isRequired ? 'tooltip-param-required' : 'tooltip-param-optional'}>
                {isRequired ? t('mcp.required') : t('mcp.optional')}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}
