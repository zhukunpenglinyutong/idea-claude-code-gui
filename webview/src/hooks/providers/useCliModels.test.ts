import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCliModelsCacheForTests, useCliModels, useOmpRoles } from './useCliModels';
import { KIMI_MODELS, OMP_ROLE_MODELS } from '../../components/ChatInputBox/types';
import { installRuntimeProviderDispatchers } from '../../utils/runtimeProviderCapabilities';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function emitCliModels(payload: unknown) {
  act(() => {
    window.setCliModels?.(JSON.stringify(payload));
  });
}

describe('useCliModels', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
    __resetCliModelsCacheForTests();
    installRuntimeProviderDispatchers();
  });

  afterEach(() => {
    delete window.setCliModels;
    __resetCliModelsCacheForTests();
    vi.useRealTimers();
  });

  it('fetches the kimi catalog when the kimi provider is active', () => {
    renderHook(() => useCliModels('kimi'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'kimi');
  });

  it('fetches the grok catalog when the grok provider is active', () => {
    renderHook(() => useCliModels('grok'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'grok');
  });

  it('does not fetch for claude', () => {
    renderHook(() => useCliModels('claude'));
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
  });

  it('gemini empty catalog answer stops the auto-fetch loop', () => {
    // Regression: gemini had no static fallback, so an answered-but-empty
    // payload left the cache empty and the auto-fetch effect refired
    // get_cli_models forever (endless dropdown spinner + a node/agy spawn
    // per cycle). The seed keeps cliModels non-empty after the answer.
    const { result } = renderHook(() => useCliModels('gemini'));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
    emitCliModels({ success: true, provider: 'gemini', models: [] });
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
    expect(result.current.cliModels.length).toBeGreaterThan(0);
    expect(result.current.cliCatalogHasEntries).toBe(false);
  });

  it('falls back to the static KIMI_MODELS list before the catalog arrives', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
    expect(result.current.cliModelsLoading).toBe(true);
  });

  it('stores the kimi catalog and defaultModel from the backend payload', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    emitCliModels({
      success: true,
      provider: 'kimi',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' }],
    });
    expect(result.current.cliModels).toEqual([
      { id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' },
    ]);
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBeNull();
  });

  it('falls back to KIMI_MODELS when the kimi payload has no models', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    emitCliModels({
      success: true,
      provider: 'kimi',
      models: [],
    });
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
  });

  it('records backend errors and supports manual retry for kimi', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    emitCliModels({ success: false, provider: 'kimi', error: 'node missing', models: [] });
    expect(result.current.cliModelsError).toBe('node missing');
    expect(result.current.cliModels).toEqual(KIMI_MODELS);

    sendBridgeEventMock.mockClear();
    act(() => {
      result.current.refreshCliModels('kimi');
    });
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'kimi');
  });

  it('times out into an error state and falls back to static models', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCliModels('kimi'));
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBe('timeout');
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
  });

  it('reuses the module cache on remount so history→chat does not re-fetch', () => {
    const first = renderHook(() => useCliModels('opencode'));
    emitCliModels({
      success: true,
      provider: 'opencode',
      defaultModel: 'openai/gpt-5',
      models: [
        { id: 'opencode-default', label: 'OpenCode Default' },
        { id: 'openai/gpt-5', label: 'gpt-5' },
      ],
    });
    expect(first.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    first.unmount();

    sendBridgeEventMock.mockClear();
    const second = renderHook(() => useCliModels('opencode'));
    // Cache already has entries — no bridge round-trip on remount.
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    expect(second.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    expect(second.result.current.cliCatalogHasEntries).toBe(true);
    expect(second.result.current.cliDefaultModel).toBe('openai/gpt-5');
    expect(second.result.current.cliModelsLoading).toBe(false);
  });

  it('reuses the module cache on remount so history→chat does not re-fetch', () => {
    const first = renderHook(() => useCliModels('opencode'));
    emitCliModels({
      success: true,
      provider: 'opencode',
      defaultModel: 'openai/gpt-5',
      models: [
        { id: 'opencode-default', label: 'OpenCode Default' },
        { id: 'openai/gpt-5', label: 'gpt-5' },
      ],
    });
    expect(first.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    first.unmount();

    sendBridgeEventMock.mockClear();
    const second = renderHook(() => useCliModels('opencode'));
    // Cache already has entries — no bridge round-trip on remount.
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    expect(second.result.current.cliModels.map((m) => m.id)).toEqual([
      'opencode-default',
      'openai/gpt-5',
    ]);
    expect(second.result.current.cliCatalogHasEntries).toBe(true);
    expect(second.result.current.cliDefaultModel).toBe('openai/gpt-5');
    expect(second.result.current.cliModelsLoading).toBe(false);
  });
});

describe('useOmpRoles', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
    __resetCliModelsCacheForTests();
    installRuntimeProviderDispatchers();
  });

  afterEach(() => {
    delete window.setCliModels;
    __resetCliModelsCacheForTests();
    vi.useRealTimers();
  });

  it('falls back to the static smol/slow/plan roles before any payload arrives', () => {
    const { result } = renderHook(() => {
      useCliModels('omp');
      return useOmpRoles();
    });
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });

  it('populates omp roles from the setCliModels payload', () => {
    const { result } = renderHook(() => {
      useCliModels('omp');
      return useOmpRoles();
    });
    emitCliModels({
      success: true,
      provider: 'omp',
      models: [{ id: 'openai/gpt-5', label: 'gpt-5' }],
      roles: [
        { id: 'smol', label: 'Smol', description: 'openai/gpt-5-mini' },
        { id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' },
      ],
    });
    expect(result.current).toEqual([
      { id: 'smol', label: 'Smol', description: 'openai/gpt-5-mini' },
      { id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' },
    ]);
  });

  it('keeps the static fallback when the payload carries no usable roles', () => {
    const { result } = renderHook(() => {
      useCliModels('omp');
      return useOmpRoles();
    });
    emitCliModels({
      success: true,
      provider: 'omp',
      models: [{ id: 'openai/gpt-5', label: 'gpt-5' }],
      roles: 'not-an-array',
    });
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });

  it('ignores roles payloads for other providers', () => {
    const { result } = renderHook(() => {
      useCliModels('kimi');
      return useOmpRoles();
    });
    emitCliModels({
      success: true,
      provider: 'kimi',
      models: [{ id: 'kimi-k3', label: 'kimi-k3' }],
      roles: [{ id: 'designer', label: 'Designer' }],
    });
    expect(result.current).toEqual(OMP_ROLE_MODELS);
  });
});
