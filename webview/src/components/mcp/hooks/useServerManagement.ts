/**
 * Server Management Operations Hook
 * Handles server refresh, toggle, and other operations
 */

import { useState, useCallback } from 'react';
import type { McpServer, ServerToolsState, ServerRefreshState, RefreshLog, CacheKeys } from '../types';
import { sendToJava } from '../../../utils/bridge';
import { clearToolsCache, clearAllToolsCache } from '../utils';
import type { ToastMessage } from '../../Toast';

export interface UseServerManagementOptions {
  isCodexMode: boolean;
  messagePrefix: string;
  cacheKeys: CacheKeys;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  loadServers: () => void;
  loadServerStatus: () => void;
  loadServerTools: (server: McpServer, forceRefresh?: boolean) => void;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
  onToast: (message: string, type: ToastMessage['type']) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface UseServerManagementReturn {
  serverRefreshStates: ServerRefreshState;
  handleRefresh: () => void;
  handleRefreshSingleServer: (server: McpServer, forceRefreshTools?: boolean) => void;
  handleToggleServer: (server: McpServer, enabled: boolean) => void;
}

/**
 * Server Management Operations Hook
 */
export function useServerManagement({
  isCodexMode,
  messagePrefix,
  cacheKeys,
  setServerTools,
  loadServers,
  loadServerStatus,
  loadServerTools,
  onLog,
  onToast,
  t,
}: UseServerManagementOptions): UseServerManagementReturn {
  // Individual server refresh state
  const [serverRefreshStates, setServerRefreshStates] = useState<ServerRefreshState>({});

  // Set individual server refresh state
  const setServerRefreshing = useCallback((serverId: string, isRefreshing: boolean, step: string = '') => {
    setServerRefreshStates(prev => ({
      ...prev,
      [serverId]: { isRefreshing, step }
    }));
  }, []);

  // Refresh all servers
  const handleRefresh = useCallback(() => {
    onLog(t('mcp.logs.refreshingAll'), 'info');
    // Clear all tools cache
    clearAllToolsCache(cacheKeys);
    // Clear current tools state
    setServerTools({});
    loadServers();
    loadServerStatus();
  }, [cacheKeys, setServerTools, loadServers, loadServerStatus, t, onLog]);

  // Refresh a single server
  const handleRefreshSingleServer = useCallback((server: McpServer, forceRefreshTools: boolean = false) => {
    const serverName = server.name || server.id;
    setServerRefreshing(server.id, true, t('mcp.logs.startRefresh'));

    if (forceRefreshTools) {
      // Force refresh tools list
      clearToolsCache(server.id, cacheKeys);
      setServerTools(prev => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
      onLog(t('mcp.logs.forceRefreshingToolsServer', { name: serverName }), 'info', undefined, serverName);
      loadServerTools(server, true);
    } else {
      onLog(t('mcp.logs.startRefreshServer', { name: serverName }), 'info', undefined, serverName);
    }

    // Simulate refresh process (SDK doesn't support single server refresh)
    setTimeout(() => {
      setServerRefreshing(server.id, true, t('mcp.logs.checkingConnection'));
      onLog(t('mcp.logs.checkingConnectionServer', { name: serverName }), 'info', undefined, serverName);
    }, 300);

    setTimeout(() => {
      // Refresh all server statuses to get updates
      loadServerStatus();
      setServerRefreshing(server.id, false, '');
      onLog(t('mcp.logs.refreshComplete', { name: serverName }), 'success', undefined, serverName);
    }, 1500);
  }, [cacheKeys, setServerTools, loadServerStatus, loadServerTools, t, onLog, setServerRefreshing]);

  // Toggle server enabled state
  const handleToggleServer = useCallback((server: McpServer, enabled: boolean) => {
    // Set apps based on current provider mode
    const updatedServer: McpServer = {
      ...server,
      enabled,
      apps: {
        claude: isCodexMode ? (server.apps?.claude ?? false) : enabled,
        codex: isCodexMode ? enabled : (server.apps?.codex ?? false),
        gemini: server.apps?.gemini ?? false,
      }
    };

    sendToJava(`toggle_${messagePrefix}mcp_server`, updatedServer);

    // A toggle invalidates the previous tool result. This forces a fresh
    // tools/list request after the server becomes connected again.
    clearToolsCache(server.id, cacheKeys);
    setServerTools(prev => {
      const next = { ...prev };
      delete next[server.id];
      return next;
    });

    // Show toast notification
    onToast(
      enabled
        ? `${t('mcp.enabled')} ${server.name || server.id}`
        : `${t('mcp.disabled')} ${server.name || server.id}`,
      'success'
    );

    loadServers();
    loadServerStatus();
  }, [isCodexMode, messagePrefix, cacheKeys, setServerTools, onToast, t, loadServers, loadServerStatus]);

  return {
    serverRefreshStates,
    handleRefresh,
    handleRefreshSingleServer,
    handleToggleServer,
  };
}
