import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGeminiPlanUsage } from './useGeminiPlanUsage';

const w = window as unknown as {
  sendToJava?: (cmd: string) => void;
  updateGeminiPlanUsage?: (json: string) => void;
};

const unavailablePayload = {
  present: false,
  unavailable: true,
  message: 'agy not logged in',
};

const presentPayload = {
  ok: true,
  present: true,
  provider: 'gemini',
  source: 'agy-usage-probe',
  capacity_pct: 30,
  reset_at: '2026-08-23T03:00:00Z',
  period_type: '5h',
  default_family: 'gemini',
  windows: [
    { id: '5h', used_pct: 30, reset_at: '2026-08-23T03:00:00Z', period_type: '5h' },
    { id: '7d', used_pct: 12, reset_at: '2026-08-27T23:00:00Z', period_type: '7d' },
  ],
  families: {
    gemini: {
      capacity_pct: 30,
      windows: [
        { id: '5h', used_pct: 30, reset_at: '2026-08-23T03:00:00Z', period_type: '5h' },
        { id: '7d', used_pct: 12, reset_at: '2026-08-27T23:00:00Z', period_type: '7d' },
      ],
    },
    third_party: {
      capacity_pct: 80,
      windows: [
        { id: '5h', used_pct: 80, reset_at: '2026-08-23T03:40:00Z', period_type: '5h' },
      ],
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  delete w.sendToJava;
  delete w.updateGeminiPlanUsage;
});

describe('useGeminiPlanUsage', () => {
  it('stays hidden (idle) while no present payload has ever arrived', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGeminiPlanUsage('gemini'));
    expect(w.sendToJava).toHaveBeenCalledWith('get_gemini_plan_usage:');

    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
  });

  it('becomes ready on the first present payload, then keeps data visible', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGeminiPlanUsage('gemini'));

    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify(presentPayload));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.snapshot?.capacityPct).toBe(30);
    expect(Object.keys(result.current.snapshot?.families ?? {})).toEqual(
      expect.arrayContaining(['gemini', 'third_party']),
    );

    // Later unavailable probe after data was seen → dash, not hidden.
    act(() => {
      w.updateGeminiPlanUsage?.(JSON.stringify(unavailablePayload));
    });
    expect(result.current.status).toBe('unavailable');
    expect(result.current.snapshot?.present).toBe(false);
  });

  it('is empty for non-gemini providers and never polls', () => {
    w.sendToJava = vi.fn();
    const { result } = renderHook(() => useGeminiPlanUsage('claude'));
    expect(result.current.status).toBe('idle');
    expect(result.current.snapshot).toBeNull();
    expect(w.sendToJava).not.toHaveBeenCalled();
  });
});
