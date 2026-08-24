import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexProvider } from './useCodexProvider';

const sendBridgeEventMock = vi.hoisted(() => vi.fn(
  (_event: string, _content?: string) => true,
));

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (event: string, content?: string) => sendBridgeEventMock(event, content),
}));

const t = ((_key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? _key) as unknown as TFunction;

describe('useCodexProvider context-window config', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendBridgeEventMock.mockClear();
    sendBridgeEventMock.mockReturnValue(true);
    delete window.updateCodexContextWindowConfig;
    delete window.__pendingCodexContextWindowConfig;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.updateCodexContextWindowConfig;
    delete window.__pendingCodexContextWindowConfig;
  });

  it('loads the authoritative 1m config and refreshes when Codex is active', () => {
    const { result } = renderHook(() => useCodexProvider({
      currentProvider: 'codex',
      addToast: vi.fn(),
      t,
    }));

    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_codex_context_window', undefined);
    act(() => {
      window.updateCodexContextWindowConfig?.(JSON.stringify({
        success: true,
        preset: '1m',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        custom: false,
      }));
    });

    expect(result.current.codexContextWindow).toBe('1m');
    expect(result.current.codexContextWindowTokens).toBe(1_000_000);
    expect(result.current.codexAutoCompactTokenLimit).toBe(900_000);
    expect(result.current.codexContextWindowLoading).toBe(false);
  });

  it('saves a preset optimistically and settles from the broadcast snapshot', () => {
    const addToast = vi.fn();
    const { result } = renderHook(() => useCodexProvider({
      currentProvider: 'codex',
      addToast,
      t,
    }));

    act(() => result.current.handleCodexContextWindowChange('500k'));
    expect(result.current.codexContextWindow).toBe('500k');
    expect(result.current.codexContextWindowSaving).toBe(true);
    expect(sendBridgeEventMock).toHaveBeenCalledWith(
      'set_codex_context_window',
      JSON.stringify({ preset: '500k' }),
    );

    act(() => {
      window.updateCodexContextWindowConfig?.({
        success: true,
        preset: '500k',
        contextWindow: 500_000,
        autoCompactTokenLimit: 450_000,
        custom: false,
      });
    });

    expect(result.current.codexContextWindowSaving).toBe(false);
    expect(result.current.codexContextWindowTokens).toBe(500_000);
    expect(addToast).toHaveBeenCalledWith(
      'Codex context window updated; the next message will use it',
      'success',
    );
  });

  it('rolls back to the authoritative config after a write failure', () => {
    const addToast = vi.fn();
    const { result } = renderHook(() => useCodexProvider({
      currentProvider: 'codex',
      addToast,
      t,
    }));

    act(() => {
      window.updateCodexContextWindowConfig?.({
        success: true,
        preset: '1m',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
      });
    });
    act(() => result.current.handleCodexContextWindowChange('default'));
    act(() => {
      window.updateCodexContextWindowConfig?.({
        success: false,
        preset: '1m',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        error: 'config.toml is read-only',
      });
    });

    expect(result.current.codexContextWindow).toBe('1m');
    expect(result.current.codexContextWindowSaving).toBe(false);
    expect(addToast).toHaveBeenCalledWith('config.toml is read-only', 'error');
  });

  it('unblocks submission and refreshes after a missing save callback times out', () => {
    const addToast = vi.fn();
    const { result } = renderHook(() => useCodexProvider({
      currentProvider: 'codex',
      addToast,
      t,
    }));

    act(() => result.current.handleCodexContextWindowChange('1m'));
    expect(result.current.codexContextWindowSaving).toBe(true);

    act(() => vi.advanceTimersByTime(10_000));

    expect(result.current.codexContextWindow).toBe('default');
    expect(result.current.codexContextWindowSaving).toBe(false);
    expect(addToast).toHaveBeenCalledWith(
      'Timed out while saving the Codex context setting',
      'error',
    );
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_codex_context_window', undefined);
  });

  it('drains an early custom config and unregisters its callback on unmount', () => {
    window.__pendingCodexContextWindowConfig = JSON.stringify({
      success: true,
      preset: 'custom',
      contextWindow: 640_000,
      autoCompactTokenLimit: 500_000,
      custom: true,
    });

    const { result, unmount } = renderHook(() => useCodexProvider({
      currentProvider: 'claude',
      addToast: vi.fn(),
      t,
    }));

    expect(result.current.codexContextWindow).toBe('custom');
    expect(result.current.codexContextWindowTokens).toBe(640_000);
    expect(window.__pendingCodexContextWindowConfig).toBeUndefined();

    unmount();
    expect(window.updateCodexContextWindowConfig).toBeUndefined();
  });
});
