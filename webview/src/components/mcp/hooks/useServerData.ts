/**
 * Server Data Loading and Initialization Hook
 * Manages loading of server list, status, and cache
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { McpServer, McpServerStatusInfo, ServerToolsState, RefreshLog, CacheKeys } from '../types';
import { sendToJava } from '../../../utils/bridge';
import { clearToolsCache, readCache, readToolsCache, writeCache } from '../utils';

const TERMINAL_DISCONNECT_STATUSES = new Set<McpServerStatusInfo['status']>([
  'failed',
  'needs-auth',
  'disabled',
]);

function normalizeServerKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function getTerminalStatusNames(statusList: McpServerStatusInfo[]): Set<string> {
  return new Set(
    statusList
      .filter((status) => TERMINAL_DISCONNECT_STATUSES.has(status.status))
      .map((status) => normalizeServerKey(status.name))
      .filter(Boolean),
  );
}

function getTerminalServerIds(servers: McpServer[], terminalStatusNames: Set<string>): string[] {
  if (terminalStatusNames.size === 0) {
    return [];
  }

  return servers
    .filter((server) => terminalStatusNames.has(normalizeServerKey(server.id))
      || terminalStatusNames.has(normalizeServerKey(server.name)))
    .map((server) => server.id);
}

export interface UseServerDataOptions {
  isCodexMode: boolean;
  messagePrefix: string;
  cacheKeys: CacheKeys;
  t: (key: string, options?: Record<string, unknown>) => string;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
}

export interface UseServerDataReturn {
  // State
  servers: McpServer[];
  serverStatus: Map<string, McpServerStatusInfo>;
  loading: boolean;
  statusLoading: boolean;
  serverTools: ServerToolsState;
  expandedServers: Set<string>;

  // State update functions
  setServers: React.Dispatch<React.SetStateAction<McpServer[]>>;
  setServerStatus: React.Dispatch<React.SetStateAction<Map<string, McpServerStatusInfo>>>;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  setExpandedServers: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Data loading functions
  loadServers: () => void;
  loadServerStatus: () => void;
  loadServerTools: (server: McpServer, forceRefresh?: boolean) => void;
}

/**
 * Server Data Loading and Initialization Hook
 */
export function useServerData({
  isCodexMode,
  messagePrefix,
  cacheKeys,
  t,
  onLog
}: UseServerDataOptions): UseServerDataReturn {
  // State
  const [servers, setServersState] = useState<McpServer[]>([]);
  const [serverStatus, setServerStatus] = useState<Map<string, McpServerStatusInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [serverTools, setServerTools] = useState<ServerToolsState>({});
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  // Refs
  const refreshTimersRef = useRef<number[]>([]);
  const serversRef = useRef<McpServer[]>([]);
  const terminalStatusNamesRef = useRef<Set<string>>(new Set());

  const setServers = useCallback((value: React.SetStateAction<McpServer[]>) => {
    if (typeof value !== 'function') {
      serversRef.current = value;
      setServersState(value);
      return;
    }

    setServersState((previous) => {
      const next = value(previous);
      serversRef.current = next;
      return next;
    });
  }, []);

  const clearToolsForTerminalStatuses = useCallback((
    currentServers: McpServer[],
    terminalStatusNames: Set<string>,
  ) => {
    const terminalServerIds = getTerminalServerIds(currentServers, terminalStatusNames);
    if (terminalServerIds.length === 0) {
      return;
    }

    terminalServerIds.forEach((serverId) => clearToolsCache(serverId, cacheKeys));
    setServerTools((previous) => {
      const next = { ...previous };
      terminalServerIds.forEach((serverId) => {
        delete next[serverId];
      });
      return next;
    });
  }, [cacheKeys]);

  // Load server list
  const loadServers = useCallback(() => {
    setLoading(true);
    onLog(
      t('mcp.logs.loadingServers'),
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_servers request to backend`
    );
    sendToJava(`get_${messagePrefix}mcp_servers`, {});
  }, [messagePrefix, t, onLog]);

  // Load server status
  const loadServerStatus = useCallback(() => {
    setStatusLoading(true);
    onLog(
      t('mcp.logs.refreshingStatus'),
      'info',
      undefined,
      undefined,
      `get_${messagePrefix}mcp_server_status request to backend`,
      `Querying MCP server connection status via ${isCodexMode ? 'Codex' : 'Claude'} SDK`
    );
    sendToJava(`get_${messagePrefix}mcp_server_status`, {});
  }, [messagePrefix, isCodexMode, t, onLog]);

  // Load server tools list
  const loadServerTools = useCallback((server: McpServer, forceRefresh = false) => {
    // Check cache (unless force refresh)
    if (!forceRefresh) {
      const cachedTools = readToolsCache(server.id, cacheKeys);
      if (cachedTools && cachedTools.length > 0) {
        setServerTools(prev => ({
          ...prev,
          [server.id]: {
            tools: cachedTools,
            loading: false,
            error: undefined
          }
        }));
        onLog(
          t('mcp.logs.loadedToolsFromCache', { name: server.name || server.id, count: cachedTools.length }),
          'info',
          undefined,
          server.name || server.id
        );
        return;
      }
    }

    // Set loading state
    setServerTools(prev => ({
      ...prev,
      [server.id]: {
        tools: [],
        loading: true,
        error: undefined
      }
    }));

    onLog(
      forceRefresh
        ? t('mcp.logs.forceRefreshingTools', { name: server.name || server.id })
        : t('mcp.logs.loadingTools', { name: server.name || server.id }),
      'info',
      undefined,
      server.name || server.id,
      `get_${messagePrefix}mcp_server_tools request to backend`
    );

    sendToJava(`get_${messagePrefix}mcp_server_tools`, { serverId: server.id, forceRefresh });
  }, [cacheKeys, messagePrefix, t, onLog]);

  // Initialization and data loading
  useEffect(() => {
    const clearRefreshTimers = () => {
      refreshTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      refreshTimersRef.current = [];
    };

    // Load data from cache
    const loadFromCache = (): boolean => {
      terminalStatusNamesRef.current = new Set();
      const cachedServers = readCache<McpServer[]>(cacheKeys.SERVERS, cacheKeys);
      const hasValidCache = !!cachedServers && cachedServers.length > 0;

      if (hasValidCache) {
        setServers(cachedServers);
        setLoading(false);
        const cacheAge = Date.now() - (JSON.parse(localStorage.getItem(cacheKeys.SERVERS) || '{}').timestamp || 0);
        if (cacheAge < 60000) {
          onLog(t('mcp.logs.fastLoadCache', { count: cachedServers.length, seconds: Math.round(cacheAge/1000) }), 'info');
        }
      }

      if (!isCodexMode) {
        const cachedStatus = readCache<McpServerStatusInfo[]>(cacheKeys.STATUS, cacheKeys);
        if (cachedStatus && cachedStatus.length > 0) {
          const terminalStatusNames = getTerminalStatusNames(cachedStatus);
          terminalStatusNamesRef.current = terminalStatusNames;
          clearToolsForTerminalStatuses(cachedServers || [], terminalStatusNames);
          const statusMap = new Map<string, McpServerStatusInfo>();
          cachedStatus.forEach((status) => {
            statusMap.set(status.name, status);
          });
          setServerStatus(statusMap);
          setStatusLoading(false);
        }
      }

      // Restore last expanded server
      if (hasValidCache) {
        try {
          const lastServerId = localStorage.getItem(cacheKeys.LAST_SERVER_ID);
          if (lastServerId) {
            const serverExists = cachedServers.some(s => s.id === lastServerId);
            if (serverExists) {
              setExpandedServers(new Set([lastServerId]));
              const cachedTools = readToolsCache(lastServerId, cacheKeys);
              if (cachedTools && cachedTools.length > 0) {
                setServerTools(prev => ({
                  ...prev,
                  [lastServerId]: {
                    tools: cachedTools,
                    loading: false,
                    error: undefined
                  }
                }));
                onLog(t('mcp.logs.loadedToolsFromCacheSimple', { count: cachedTools.length }), 'info', undefined, lastServerId);
              }
            }
          }
        } catch (e) {
          console.warn('[MCP] Failed to restore last expanded server:', e);
        }
      }

      return hasValidCache;
    };

    // Try loading data from cache first
    const hasCache = loadFromCache();

    if (hasCache) {
      onLog(t('mcp.logs.usingCacheStrategy'), 'info');
    } else {
      onLog(t('mcp.logs.firstLoad'), 'info');
      loadServers();
      loadServerStatus();
    }

    return () => {
      clearRefreshTimers();
    };
  }, [cacheKeys, isCodexMode, loadServers, loadServerStatus, t, onLog, clearToolsForTerminalStatuses]);

  // Register server list update callback
  useEffect(() => {
    const handleServerListUpdate = (jsonStr: string) => {
      try {
        const serverList: McpServer[] = JSON.parse(jsonStr);
        setServers(serverList);
        clearToolsForTerminalStatuses(serverList, terminalStatusNamesRef.current);
        setLoading(false);
        // Persist to cache so subsequent mounts can load instantly
        writeCache(cacheKeys.SERVERS, serverList);
        onLog(t('mcp.logs.loadedServersSuccess', { count: serverList.length }), 'success');
      } catch (error) {
        console.error('[McpSettings] Failed to parse servers:', error);
        setLoading(false);
        onLog(t('mcp.logs.loadedServersFailed', { error: String(error) }), 'error');
      }
    };

    const handleServerStatusUpdate = (jsonStr: string) => {
      try {
        const statusList: McpServerStatusInfo[] = JSON.parse(jsonStr);
        const statusMap = new Map<string, McpServerStatusInfo>();
        statusList.forEach((status) => {
          statusMap.set(status.name, status);
        });
        setServerStatus(statusMap);
        const terminalStatusNames = getTerminalStatusNames(statusList);
        terminalStatusNamesRef.current = terminalStatusNames;
        clearToolsForTerminalStatuses(serversRef.current, terminalStatusNames);
        setStatusLoading(false);
        // Persist status to cache
        writeCache(cacheKeys.STATUS, statusList);

        const statusCount = {
          connected: statusList.filter(s => s.status === 'connected').length,
          failed: statusList.filter(s => s.status === 'failed').length,
          pending: statusList.filter(s => s.status === 'pending').length,
          needsAuth: statusList.filter(s => s.status === 'needs-auth').length
        };

        onLog(
          t('mcp.logs.statusUpdateComplete', {
            total: statusList.length,
            connected: statusCount.connected,
            failed: statusCount.failed,
            pending: statusCount.pending,
            needsAuth: statusCount.needsAuth
          }),
          statusCount.failed > 0 ? 'warning' : 'success'
        );
      } catch (error) {
        console.error('[McpSettings] Failed to parse server status:', error);
        setStatusLoading(false);
        onLog(t('mcp.logs.loadedStatusFailed', { error: String(error) }), 'error');
      }
    };

    // Register callbacks
    if (isCodexMode) {
      window.updateCodexMcpServers = handleServerListUpdate;
      window.updateCodexMcpServerStatus = handleServerStatusUpdate;
    } else {
      window.updateMcpServers = handleServerListUpdate;
      window.updateMcpServerStatus = handleServerStatusUpdate;
    }

    return () => {
      if (isCodexMode) {
        window.updateCodexMcpServers = undefined;
        window.updateCodexMcpServerStatus = undefined;
      } else {
        window.updateMcpServers = undefined;
        window.updateMcpServerStatus = undefined;
      }
    };
  }, [isCodexMode, t, onLog, clearToolsForTerminalStatuses, setServers]);

  return {
    // State
    servers,
    serverStatus,
    loading,
    statusLoading,
    serverTools,
    expandedServers,

    // State update functions
    setServers,
    setServerStatus,
    setServerTools,
    setExpandedServers,

    // Data loading functions
    loadServers,
    loadServerStatus,
    loadServerTools,
  };
}
