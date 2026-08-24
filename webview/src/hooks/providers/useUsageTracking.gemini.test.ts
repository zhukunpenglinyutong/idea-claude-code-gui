import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUsageTracking } from './useUsageTracking';

describe('useUsageTracking gemini mapping', () => {
  it('treats gemini as installed when gemini-cli status is installed', () => {
    const { result } = renderHook(() => useUsageTracking());

    act(() => {
      result.current.setSdkStatus({
        'gemini-cli': { status: 'installed', installed: true },
        'claude-sdk': { status: 'not_installed', installed: false },
      });
      result.current.setSdkStatusLoaded(true);
    });

    expect(result.current.isSdkInstalled('gemini')).toBe(true);
    expect(result.current.isSdkInstalled('claude')).toBe(false);
  });

  it('returns false for gemini when status is unknown and not loaded', () => {
    const { result } = renderHook(() => useUsageTracking());
    act(() => {
      result.current.setSdkStatus({});
      result.current.setSdkStatusLoaded(false);
    });
    expect(result.current.isSdkInstalled('gemini')).toBe(false);
    expect(result.current.isSdkStatusKnown('gemini')).toBe(false);
  });

  it('maps gemini provider id to gemini-cli for isSdkStatusKnown', () => {
    const { result } = renderHook(() => useUsageTracking());
    act(() => {
      result.current.setSdkStatus({
        'gemini-cli': { status: 'not_installed', installed: false },
      });
      result.current.setSdkStatusLoaded(true);
    });
    expect(result.current.isSdkStatusKnown('gemini')).toBe(true);
    expect(result.current.isSdkInstalled('gemini')).toBe(false);
  });
});
