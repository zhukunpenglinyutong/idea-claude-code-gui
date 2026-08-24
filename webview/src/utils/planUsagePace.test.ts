import { describe, expect, it } from 'vitest';
import {
  formatShortReset,
  nextWindowId,
  paceColor,
  parseCapacityPayload,
  resolveGeminiQuotaFamily,
  selectGeminiPlanFamily,
  resolveDisplayWindow,
  windowShortLabel,
  worstPaceColor,
} from './planUsagePace';

const claudePayload = {
  ok: true,
  present: true,
  provider: 'claude',
  source: 'sdk-rate-limit',
  capacity_pct: 92,
  reset_at: '2026-08-23T03:00:00Z',
  period_type: '5h',
  windows: [
    { id: '5h', used_pct: 92, reset_at: '2026-08-23T03:00:00Z', period_type: '5h' },
    { id: '7d', used_pct: 21, reset_at: '2026-08-25T00:00:00Z', period_type: '7d' },
  ],
};

describe('parseCapacityPayload', () => {
  it('normalizes snake_case windows into a snapshot', () => {
    const snap = parseCapacityPayload(claudePayload);
    expect(snap.present).toBe(true);
    expect(snap.capacityPct).toBe(92);
    expect(snap.provider).toBe('claude');
    expect(snap.windows?.map((w) => w.id)).toEqual(['5h', '7d']);
    expect(snap.windows?.[1].usedPct).toBe(21);
  });

  it('marks unavailable payloads not present', () => {
    const snap = parseCapacityPayload({ present: false, unavailable: true, message: 'no data' });
    expect(snap.present).toBe(false);
    expect(snap.message).toBe('no data');
  });

  it('falls back to the first window when top-level pct is missing', () => {
    const snap = parseCapacityPayload({
      windows: [{ id: '5h', used_pct: 42, reset_at: '2026-08-23T03:00:00Z' }],
    });
    expect(snap.present).toBe(true);
    expect(snap.capacityPct).toBe(42);
    expect(snap.periodType).toBeNull();
  });
});

describe('paceColor', () => {
  it('green below budget, yellow within +5, red past it, neutral without budget', () => {
    expect(paceColor(30, 50)).toBe('green');
    expect(paceColor(52, 50)).toBe('yellow');
    expect(paceColor(56, 50)).toBe('red');
    expect(paceColor(30, null)).toBe('neutral');
  });
});

describe('worstPaceColor', () => {
  it('takes the worst window, not the selected one', () => {
    // now chosen so 5h is far past its time budget (red) while 7d is far under (green)
    const now = new Date('2026-08-22T22:30:00Z');
    const snap = parseCapacityPayload(claudePayload);
    expect(worstPaceColor(snap, now)).toBe('red');
  });
});

describe('window switching', () => {
  const snap = parseCapacityPayload(claudePayload);
  const windows = snap.windows ?? [];

  it('cycles 5h → 7d → 5h', () => {
    expect(nextWindowId(windows, '5h')).toBe('7d');
    expect(nextWindowId(windows, '7d')).toBe('5h');
  });

  it('prefers the stored window id and falls back to top-level binding', () => {
    expect(resolveDisplayWindow(snap, '7d')).toMatchObject({ windowId: '7d', capacityPct: 21 });
    expect(resolveDisplayWindow(snap, null).capacityPct).toBe(92);
  });

  it('labels raw ids compactly', () => {
    expect(windowShortLabel('5h')).toBe('5h');
    expect(windowShortLabel('7d')).toBe('7d');
    expect(windowShortLabel('WEEKLY')).toBe('7d');
    expect(windowShortLabel(null)).toBe('·');
  });
});

describe('formatShortReset', () => {
  it('emits day + short month + 24h time with no trailing period', () => {
    const label = formatShortReset('2026-08-23T03:00:00Z', 'en-GB');
    expect(label).not.toMatch(/\.$/);
    // timezone-agnostic structure: "23 Aug 03:00" (locale day/time vary by TZ)
    expect(label.trim()).toMatch(/^\d{1,2} [A-Za-z]{3,4} \d{2}:\d{2}$/);
  });

  it('returns empty string for missing dates', () => {
    expect(formatShortReset(null)).toBe('');
  });
});

const dualFamilyPayload = {
  ok: true,
  present: true,
  provider: 'gemini',
  source: 'agy-usage-probe',
  default_family: 'gemini',
  capacity_pct: 25,
  reset_at: '2026-08-05T18:15:50Z',
  period_type: '5h',
  windows: [
    { id: '5h', used_pct: 25, reset_at: '2026-08-05T18:15:50Z', period_type: '5h' },
    { id: '7d', used_pct: 10, reset_at: '2026-08-11T23:37:11Z', period_type: '7d' },
  ],
  families: {
    gemini: {
      capacity_pct: 25,
      reset_at: '2026-08-05T18:15:50Z',
      period_type: '5h',
      windows: [
        { id: '5h', used_pct: 25, reset_at: '2026-08-05T18:15:50Z', period_type: '5h' },
        { id: '7d', used_pct: 10, reset_at: '2026-08-11T23:37:11Z', period_type: '7d' },
      ],
    },
    third_party: {
      capacity_pct: 75,
      reset_at: '2026-08-05T18:55:52Z',
      period_type: '5h',
      windows: [
        { id: '5h', used_pct: 75, reset_at: '2026-08-05T18:55:52Z', period_type: '5h' },
        { id: '7d', used_pct: 50, reset_at: '2026-08-06T02:22:27Z', period_type: '7d' },
      ],
    },
  },
};

describe('gemini quota families', () => {
  it('maps gemini slugs to gemini family, claude/gpt to third_party', () => {
    expect(resolveGeminiQuotaFamily('gemini-3.5-flash-medium')).toBe('gemini');
    expect(resolveGeminiQuotaFamily('gemini-3.1-pro-high')).toBe('gemini');
    expect(resolveGeminiQuotaFamily('claude-sonnet-4-6')).toBe('third_party');
    expect(resolveGeminiQuotaFamily('claude-opus-4-6-thinking')).toBe('third_party');
    expect(resolveGeminiQuotaFamily('gpt-oss-120b-medium')).toBe('third_party');
  });

  it('binds gemini family for gemini models — only 5h/7d windows', () => {
    const snap = parseCapacityPayload(dualFamilyPayload);
    const bound = selectGeminiPlanFamily(snap, 'gemini-3.6-flash-high');
    expect(bound?.present).toBe(true);
    expect(bound?.capacityPct).toBe(25);
    expect(bound?.windows?.map((w) => w.id)).toEqual(['5h', '7d']);
    expect(bound?.windows?.[0].usedPct).toBe(25);
  });

  it('binds third_party family for claude/gpt models', () => {
    const snap = parseCapacityPayload(dualFamilyPayload);
    const bound = selectGeminiPlanFamily(snap, 'claude-sonnet-4-6');
    expect(bound?.capacityPct).toBe(75);
    expect(bound?.windows?.[0].usedPct).toBe(75);
    expect(bound?.windows?.[1].usedPct).toBe(50);
  });
});
