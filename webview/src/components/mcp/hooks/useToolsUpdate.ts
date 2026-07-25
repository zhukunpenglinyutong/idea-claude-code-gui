/**
 * Tools List Update Hook
 * Listens for tools list update events and handles state updates
 */

import { useEffect } from 'react';
import type { ServerToolsState, McpTool, RefreshLog, CacheKeys } from '../types';
import { writeToolsCache } from '../utils';

export interface UseToolsUpdateOptions {
  isCodexMode: boolean;
  cacheKeys: CacheKeys;
  setServerTools: React.Dispatch<React.SetStateAction<ServerToolsState>>;
  onLog: (message: string, type: RefreshLog['type'], details?: string, serverName?: string, requestInfo?: string, errorReason?: string) => void;
}

/**
 * Tools List Update Hook
 * Registers the provider-specific MCP tools callback.
 */
export function useToolsUpdate({
  isCodexMode,
  cacheKeys,
  setServerTools,
  onLog,
}: UseToolsUpdateOptions): void {
  useEffect(() => {
    // Register tools list update callback
    const handleToolsUpdate = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        const { serverId, serverName, tools, error } = result;

        if (!serverId) {
          console.warn('[MCP] Tools update missing serverId');
          return;
        }

        const toolList: McpTool[] = tools || [];

        // When tools are available, treat as (partial) success even if error exists
        if (toolList.length > 0) {
          setServerTools(prev => ({
            ...prev,
            [serverId]: {
              tools: toolList,
              loading: false,
              error: error || undefined
            }
          }));

          writeToolsCache(serverId, toolList, cacheKeys);

          onLog(
            `Tools loaded: ${toolList.length} tool(s)`,
            error ? 'warning' : 'success',
            `Tools: ${toolList.slice(0, 5).map(t => t.name).join(', ')}${toolList.length > 5 ? '...' : ''}`,
            serverName || serverId
          );
          return;
        }

        // No tools and has error — full failure
        if (error) {
          setServerTools(prev => ({
            ...prev,
            [serverId]: {
              tools: prev[serverId]?.tools || [],
              loading: false,
              error: error
            }
          }));
          onLog(
            `获取工具列表失败: ${error}`,
            'error',
            error,
            serverName || serverId
          );
          return;
        }

        // No tools, no error — empty result
        setServerTools(prev => ({
          ...prev,
          [serverId]: {
            tools: [],
            loading: false,
            error: undefined
          }
        }));

        onLog(
          `工具列表为空，服务器已连接但没有可用工具`,
          'warning',
          undefined,
          serverName || serverId
        );
      } catch (e) {
        console.error('[MCP] Failed to parse tools update:', e);
        onLog(
          `解析工具列表失败: ${e}`,
          'error'
        );
      }
    };

    if (isCodexMode) {
      window.updateCodexMcpServerTools = handleToolsUpdate;
    } else {
      window.updateMcpServerTools = handleToolsUpdate;
    }

    return () => {
      if (isCodexMode && window.updateCodexMcpServerTools === handleToolsUpdate) {
        window.updateCodexMcpServerTools = undefined;
      } else if (!isCodexMode && window.updateMcpServerTools === handleToolsUpdate) {
        window.updateMcpServerTools = undefined;
      }
    };
  }, [isCodexMode, cacheKeys, setServerTools, onLog]);
}
