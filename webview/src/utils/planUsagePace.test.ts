import { describe, expect, it } from 'vitest';
import {
  formatBalance,
  formatShortReset,
  nextWindowId,
  paceColor,
  parseCapacityPayload,
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

  it('accepts balance-only payloads (prepaid vendors)', () => {
    const snap = parseCapacityPayload({
      ok: true,
      present: true,
      provider: 'claude',
      source: 'deepseek',
      balance: { remaining: '42.50', unit: 'CNY' },
    });
    expect(snap.present).toBe(true);
    expect(snap.balance?.remaining).toBe(42.5);
    expect(snap.balance?.unit).toBe('CNY');
    expect(snap.balance?.total).toBeNull();
    expect(snap.capacityPct).toBeUndefined();
    expect(snap.windows).toBeUndefined();
  });

  it('parses total/used alongside remaining (OpenRouter)', () => {
    const snap = parseCapacityPayload({
      balance: { remaining: 42.5, total: 100, used: 57.5, unit: 'USD' },
    });
    expect(snap.present).toBe(true);
    expect(snap.balance).toEqual({ remaining: 42.5, total: 100, used: 57.5, unit: 'USD' });
  });

  it('still rejects payloads with neither pct, windows nor balance', () => {
    const snap = parseCapacityPayload({ ok: true, present: true, source: 'x' });
    expect(snap.present).toBe(false);
    expect(snap.balance).toBeUndefined();
  });

  it('rejects null or blank remaining instead of coercing it to 0', () => {
    expect(parseCapacityPayload({ balance: { remaining: null } }).present).toBe(false);
    expect(parseCapacityPayload({ balance: { remaining: '' } }).present).toBe(false);
    // A real zero (exhausted balance) must still count as present
    expect(parseCapacityPayload({ balance: { remaining: 0 } }).present).toBe(true);
  });
});

describe('formatBalance', () => {
  it('prefixes CNY and USD with the matching sign, two decimals', () => {
    expect(formatBalance(42.5, 'CNY')).toBe('¥42.50');
    expect(formatBalance(12.345, 'USD')).toBe('$12.35');
  });

  it('defaults to CNY for missing units, keeps negative sign', () => {
    expect(formatBalance(42.5)).toBe('¥42.50');
    expect(formatBalance(-1.2, 'USD')).toBe('-$1.20');
  });

  it('renders a dash for non-finite amounts', () => {
    expect(formatBalance(Number.NaN, 'USD')).toBe('—');
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
