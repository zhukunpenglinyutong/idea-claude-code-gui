import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCliModelsCacheForTests, useCliModels, useOmpRoles } from './useCliModels';
import { CODEX_MODELS, KIMI_MODELS, OMP_ROLE_MODELS } from '../../components/ChatInputBox/types';
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

  it('fetches the codex catalog when the codex provider is active', () => {
    renderHook(() => useCliModels('codex'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'codex');
  });

  it('fetches the grok catalog when the grok provider is active', () => {
    renderHook(() => useCliModels('grok'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'grok');
  });

  it('fetches the CodeBuddy SDK catalog when CodeBuddy is active', () => {
    const { result } = renderHook(() => useCliModels('codebuddy'));
    expect(result.current.cliModels).toEqual([]);
    expect(result.current.cliModelsLoading).toBe(true);
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'codebuddy');
  });

  it('does not fetch for claude', () => {
    renderHook(() => useCliModels('claude'));
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
  });

  it('falls back to the static CODEX_MODELS list before the catalog arrives', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    expect(result.current.cliModels).toEqual(CODEX_MODELS);
    expect(result.current.cliModelsLoading).toBe(true);
  });

  it('stores the codex catalog and defaultModel from the backend payload', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' }],
    });
    expect(result.current.cliModels).toEqual([
      { id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' },
    ]);
    expect(result.current.cliDefaultModel).toBe('kimi-k3');
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBeNull();
  });

  it('falls back to CODEX_MODELS when the codex payload has no models (official provider)', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'gpt-5.6-sol',
      models: [],
    });
    expect(result.current.cliModels).toEqual(CODEX_MODELS);
    expect(result.current.cliDefaultModel).toBe('gpt-5.6-sol');
  });

  it('keeps kimi fallback behavior intact', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'kimi');
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
  });

  it('records backend errors and supports manual retry for codex', () => {
    const { result } = renderHook(() => useCliModels('codex'));
    emitCliModels({ success: false, provider: 'codex', error: 'node missing', models: [] });
    expect(result.current.cliModelsError).toBe('node missing');
    expect(result.current.cliModels).toEqual(CODEX_MODELS);

    sendBridgeEventMock.mockClear();
    act(() => {
      result.current.refreshCliModels('codex');
    });
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'codex');
  });

  it('does not re-send get_cli_models while a request is already in flight', () => {
    renderHook(() => useCliModels('codebuddy'));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);

    // A payload for another provider updates modelsByProvider, which re-runs
    // the fetch effect — the in-flight guard must swallow the duplicate.
    emitCliModels({ success: true, provider: 'codex', models: [{ id: 'x', label: 'x' }] });

    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);
  });

  it('refetches codebuddy on models-config change even while a request is in flight', () => {
    renderHook(() => useCliModels('codebuddy'));
    expect(sendBridgeEventMock).toHaveBeenCalledTimes(1);

    // The invalidation path clears the pending request before refetching, so
    // the forced refetch is never swallowed by the in-flight guard.
    act(() => {
      window.dispatchEvent(new Event('codebuddy-models-config-changed'));
    });

    expect(sendBridgeEventMock).toHaveBeenCalledTimes(2);
  });

  it('refetches the codex catalog when the active codex provider changes', () => {
    const { result, rerender } = renderHook(
      ({ provider }) => useCliModels(provider),
      { initialProps: { provider: 'codex' } },
    );
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3' }],
    });
    expect(result.current.modelsByProvider.codex?.length).toBe(1);

    sendBridgeEventMock.mockClear();
    act(() => {
      window.updateActiveCodexProvider?.(JSON.stringify({ id: 'other-provider' }));
    });
    // Cache cleared; effect refetches because the current provider is codex.
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'codex');
    rerender({ provider: 'codex' });
    expect(result.current.modelsByProvider.codex).toBeUndefined();
  });

  it('clears the codex cache without refetching when another provider is active', () => {
    const { result } = renderHook(() => useCliModels('claude'));
    emitCliModels({
      success: true,
      provider: 'codex',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3' }],
    });
    expect(result.current.modelsByProvider.codex?.length).toBe(1);

    sendBridgeEventMock.mockClear();
    act(() => {
      window.updateActiveCodexProvider?.(JSON.stringify({ id: 'other-provider' }));
    });
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
    expect(result.current.modelsByProvider.codex).toBeUndefined();
  });

  it('times out into an error state and falls back to static models', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCliModels('codex'));
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBe('timeout');
    expect(result.current.cliModels).toEqual(CODEX_MODELS);
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
