import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheKeys, McpServer, ServerToolsState } from '../types';
import { readToolsCache, writeToolsCache } from '../utils';
import { useServerManagement } from './useServerManagement';

const sendToJavaMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/bridge', () => ({
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}));

const cacheKeys: CacheKeys = {
  SERVERS: 'test.mcp.servers',
  STATUS: 'test.mcp.status',
  TOOLS: 'test.mcp.tools',
  LAST_SERVER_ID: 'test.mcp.last-server',
};

const server: McpServer = {
  id: 'server-a',
  name: 'Primary Server',
  server: { command: 'node' },
};

beforeEach(() => {
  localStorage.clear();
  sendToJavaMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useServerManagement tool cache invalidation', () => {
  it('clears persisted tools whenever a server is toggled', () => {
    const setServerTools = vi.fn() as unknown as React.Dispatch<React.SetStateAction<ServerToolsState>>;
    const hook = renderHook(() => useServerManagement({
      isCodexMode: false,
      messagePrefix: '',
      cacheKeys,
      setServerTools,
      loadServers: vi.fn(),
      loadServerStatus: vi.fn(),
      loadServerTools: vi.fn(),
      onLog: vi.fn(),
      onToast: vi.fn(),
      t: (key) => key,
    }));

    writeToolsCache(server.id, [{ name: 'stale-tool' }], cacheKeys);

    act(() => {
      hook.result.current.handleToggleServer(server, false);
    });

    expect(readToolsCache(server.id, cacheKeys)).toBeNull();
    expect(setServerTools).toHaveBeenCalledTimes(1);
    expect(sendToJavaMock).toHaveBeenCalledWith('toggle_mcp_server', expect.objectContaining({
      id: server.id,
      enabled: false,
    }));
  });
});
