import { act, cleanup, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelProviderState } from './useModelProviderState';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));

const options = { addToast: vi.fn(), t: ((key: string) => key) as TFunction };

describe('Codex native auto review availability', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('waits for explicit SDK support and follows later dependency changes', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(false);
    act(() => result.current.setSdkStatus({ 'codex-sdk': { installed: true } }));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(false);
    act(() => result.current.setSdkStatus({ 'codex-sdk': { installed: true, meetsMinimumVersion: true } }));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(true);
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('auto'));
    expect(result.current.permissionMode).toBe('auto');
    expect(sendBridgeEvent).toHaveBeenLastCalledWith('set_mode', 'auto');
    act(() => result.current.setSdkStatus({ 'codex-sdk': { installed: true, meetsMinimumVersion: false } }));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(false);
    expect(result.current.permissionMode).toBe('default');
    expect(result.current.codexPermissionMode).toBe('default');
    expect(sendBridgeEvent).toHaveBeenLastCalledWith('set_mode', 'default');
  });

  it('preserves a saved auto mode while SDK support is unknown', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex', codexPermissionMode: 'auto',
    }));
    const { result } = renderHook(() => useModelProviderState(options));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(false);
    expect(result.current.codexPermissionMode).toBe('auto');
    act(() => result.current.setSdkStatus({ 'codex-sdk': { meetsMinimumVersion: true } }));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(true);
    expect(result.current.codexPermissionMode).toBe('auto');
  });
});
