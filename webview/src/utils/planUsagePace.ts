/**
 * Plan-usage pace coloring for the ContextBar usage bar.
 * TP = actual usage %, TT = linear time budget through the reset window.
 */

export type PaceColor = 'green' | 'yellow' | 'red' | 'neutral';

/** One rate/billing window from a capacity payload windows[]. */
export interface CapacityWindow {
  id: string;
  usedPct: number;
  resetAt?: string | null;
  periodType?: string | null;
}

export interface PlanUsageBalance {
  /** Remaining money (vendor currency). */
  remaining: number;
  /** Denominator when the vendor reports one (OpenRouter credits). */
  total?: number | null;
  used?: number | null;
  /** ISO-4217 code, "CNY" | "USD" | … */
  unit: string;
}

export interface PlanUsageSnapshot {
  present: boolean;
  /** Usage percent 0–100 (TP) — binding/worst-case at top level. */
  capacityPct?: number;
  /** Period end / next reset (ISO or parseable date string). */
  resetAt?: string | null;
  /** Period start when known. */
  periodStart?: string | null;
  /** 5h | 7d | … */
  periodType?: string | null;
  /** All known windows (e.g. 5h/7d). */
  windows?: CapacityWindow[];
  /**
   * Prepaid-account balance (DeepSeek/Moonshot/OpenRouter/… balance vendors).
   * Present only — balance vendors have no percentage denominator, so the
   * indicator renders the amount instead of the bar.
   */
  balance?: PlanUsageBalance;
  /** Provider from capacity payload (claude | …). */
  provider?: string;
  source?: string;
  message?: string;
  /** Plan tier, e.g. z.ai {@code level} ("max"). */
  level?: string;
  /** True when the payload is a cached copy served after a failed refresh probe. */
  stale?: boolean;
}

export const PLAN_USAGE_WINDOW_STORAGE_KEY = 'ccgui.planUsage.windowId';

const YELLOW_BAND = 5;

/** Clamp number to [0, 100]. */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Derive period start from end + period_type when start is missing.
 * 5H → end − 5h; 7D/WEEKLY → end − 7d; MONTHLY → end − 30d.
 */
export function derivePeriodStart(
  resetAt: Date,
  periodType?: string | null,
): Date | null {
  // Accept raw enums too, e.g. USAGE_PERIOD_TYPE_WEEKLY from xAI billing.
  const t = (periodType || '').toUpperCase();
  if (t === '5H' || t === '5HR' || t.includes('5H')) {
    return new Date(resetAt.getTime() - 5 * 60 * 60 * 1000);
  }
  if (t === '7D' || t === '7DAY' || (t.includes('7D') && !t.includes('WEEK'))) {
    return new Date(resetAt.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (t === 'WEEKLY' || t === 'WEEK' || t.includes('WEEK')) {
    return new Date(resetAt.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (t === 'MONTHLY' || t === 'MONTH' || t.includes('MONTH')) {
    return new Date(resetAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return null;
}

export function parseDate(value?: string | null): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * TT = linear time progress through [start, end], 0–100.
 * Returns null when window cannot be determined.
 */
export function computeTimeBudgetPercent(
  now: Date,
  periodStart?: Date | null,
  periodEnd?: Date | null,
): number | null {
  if (!periodStart || !periodEnd) return null;
  const start = periodStart.getTime();
  const end = periodEnd.getTime();
  if (!(end > start)) return null;
  const t = now.getTime();
  return clampPercent(((t - start) / (end - start)) * 100);
}

/**
 * Resolve TT from snapshot fields (explicit start or period_type).
 */
export function resolveTimeBudget(
  snapshot: Pick<PlanUsageSnapshot, 'resetAt' | 'periodStart' | 'periodType'>,
  now: Date = new Date(),
): number | null {
  const end = parseDate(snapshot.resetAt ?? null);
  if (!end) return null;
  let start = parseDate(snapshot.periodStart ?? null);
  if (!start) {
    start = derivePeriodStart(end, snapshot.periodType);
  }
  return computeTimeBudgetPercent(now, start, end);
}

/**
 * Pace color: TP < TT green; TT ≤ TP ≤ TT+5 yellow; TP > TT+5 red; no TT → neutral.
 */
export function paceColor(tp: number, tt: number | null): PaceColor {
  if (tt === null || !Number.isFinite(tt)) return 'neutral';
  const usage = clampPercent(tp);
  const budget = clampPercent(tt);
  if (usage < budget) return 'green';
  if (usage <= budget + YELLOW_BAND) return 'yellow';
  return 'red';
}

const PACE_RANK: Record<PaceColor, number> = {
  neutral: 0,
  green: 1,
  yellow: 2,
  red: 3,
};

/** Worse of two pace colors (red > yellow > green > neutral). */
export function worsePace(a: PaceColor, b: PaceColor): PaceColor {
  return PACE_RANK[a] >= PACE_RANK[b] ? a : b;
}

/**
 * Worst pace across all windows (or single top-level snapshot when no windows[]).
 * Used for the leading status dot so a green selected window cannot hide a red other.
 */
export function worstPaceColor(
  snapshot: PlanUsageSnapshot,
  now: Date = new Date(),
): PaceColor {
  if (!snapshot.present) return 'neutral';
  const windows = snapshot.windows ?? [];
  if (windows.length === 0) {
    const tt = resolveTimeBudget(snapshot, now);
    return paceColor(snapshot.capacityPct ?? 0, tt);
  }
  let worst: PaceColor = 'neutral';
  for (const w of windows) {
    const tt = resolveTimeBudget(
      {
        resetAt: w.resetAt,
        periodStart: snapshot.periodStart,
        periodType: w.periodType ?? w.id,
      },
      now,
    );
    worst = worsePace(worst, paceColor(w.usedPct, tt));
  }
  return worst;
}

/**
 * Compact reset label for the bar: day + short month + 24h time in local TZ.
 * Example (Europe/Moscow): "1 Aug 03:00".
 */
export function formatShortReset(resetAt?: string | null, locale?: string): string {
  const d = parseDate(resetAt ?? null);
  if (!d) return '';
  try {
    const datePart = d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    const timePart = d.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    // Some locales still emit 24h with a trailing day-period; strip common noise.
    const time = timePart.replace(/\u202f/g, ' ').trim();
    // Drop locale abbreviations' trailing dots (e.g. "июл.") — no period after reset.
    const date = datePart.replace(/\./g, '').trim();
    return `${date} ${time} `;
  } catch {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getDate()} ${d.getMonth() + 1} ${hh}:${mm} `;
  }
}

/** Full datetime for tooltip. */
export function formatFullReset(resetAt?: string | null, locale?: string): string {
  const d = parseDate(resetAt ?? null);
  if (!d) return '';
  try {
    return d.toLocaleString(locale);
  } catch {
    return d.toISOString();
  }
}

function parseWindows(raw: unknown): CapacityWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: CapacityWindow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    const id = typeof w.id === 'string' ? w.id.trim() : '';
    if (!id) continue;
    const pctRaw = w.used_pct ?? w.usedPct ?? w.capacity_pct ?? w.capacityPct;
    const pct = typeof pctRaw === 'number' ? pctRaw : Number(pctRaw);
    if (!Number.isFinite(pct)) continue;
    out.push({
      id,
      usedPct: clampPercent(pct),
      resetAt:
        typeof w.reset_at === 'string'
          ? w.reset_at
          : typeof w.resetAt === 'string'
            ? w.resetAt
            : null,
      periodType:
        typeof w.period_type === 'string'
          ? w.period_type
          : typeof w.periodType === 'string'
            ? w.periodType
            : id,
    });
  }
  return out;
}

/**
 * Numeric coercion for payload fields: numbers and numeric strings pass, but
 * null/blank/other shapes are rejected — Number() would coerce them to 0,
 * turning a missing amount into an "exhausted" ¥0.00.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse a balance object ({@code remaining}, optional total/used, unit). */
function parseBalance(raw: unknown): PlanUsageBalance | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const remaining = toFiniteNumber(b.remaining);
  if (remaining === null) return null;
  const unit = typeof b.unit === 'string' && b.unit.trim() ? b.unit.trim() : 'CNY';
  return {
    remaining,
    total: toFiniteNumber(b.total),
    used: toFiniteNumber(b.used),
    unit,
  };
}

/** Normalize a capacity JSON payload (snake_case or camelCase) into a snapshot. */
export function parseCapacityPayload(data: unknown): PlanUsageSnapshot {
  if (!data || typeof data !== 'object') {
    return { present: false, message: 'invalid capacity payload' };
  }
  const o = data as Record<string, unknown>;
  if (o.present === false || o.unavailable === true) {
    return {
      present: false,
      message: typeof o.message === 'string' ? o.message : 'capacity unavailable',
      source: typeof o.source === 'string' ? o.source : undefined,
    };
  }
  const windows = parseWindows(o.windows);
  const balance = parseBalance(o.balance);
  const pctRaw = o.capacity_pct ?? o.used_pct ?? o.capacityPct;
  const pct = typeof pctRaw === 'number' ? pctRaw : Number(pctRaw);
  // Balance-only payloads (prepaid vendors) carry no percentage denominator.
  if (!Number.isFinite(pct) && windows.length === 0 && !balance) {
    return {
      present: false,
      message: 'capacity missing capacity_pct',
      source: typeof o.source === 'string' ? o.source : undefined,
    };
  }
  const topPct = Number.isFinite(pct)
    ? clampPercent(pct)
    : windows[0]?.usedPct;
  return {
    present: true,
    capacityPct: topPct,
    resetAt: typeof o.reset_at === 'string' ? o.reset_at : typeof o.resetAt === 'string' ? o.resetAt : null,
    periodType: typeof o.period_type === 'string' ? o.period_type : typeof o.periodType === 'string' ? o.periodType : null,
    periodStart: typeof o.period_start === 'string' ? o.period_start : null,
    windows: windows.length > 0 ? windows : undefined,
    balance: balance ?? undefined,
    provider: typeof o.provider === 'string' ? o.provider : undefined,
    source: typeof o.source === 'string' ? o.source : 'gateway',
    level: typeof o.level === 'string' ? o.level : undefined,
    stale: o.stale === true ? true : undefined,
  };
}

/**
 * Compact amount label for the balance indicator: "¥42.50" / "$12.34".
 * Unknown units fall back to the CNY sign (every current balance vendor
 * bills in CNY or USD); negatives keep their sign.
 */
export function formatBalance(amount: number, unit?: string | null): string {
  if (!Number.isFinite(amount)) return '—';
  const u = (unit || 'CNY').toUpperCase();
  const prefix = u === 'USD' ? '$' : '¥';
  const abs = Math.abs(amount).toFixed(2);
  return amount < 0 ? `-${prefix}${abs}` : `${prefix}${abs}`;
}

/** Prefer stored window id if present; else binding top-level; else first window. */
export function resolveDisplayWindow(
  snapshot: PlanUsageSnapshot,
  preferredWindowId?: string | null,
): {
  windowId: string | null;
  capacityPct: number;
  resetAt: string | null | undefined;
  periodType: string | null | undefined;
} {
  const windows = snapshot.windows ?? [];
  const preferred = (preferredWindowId || '').trim();
  const hit = preferred ? windows.find((w) => w.id === preferred) : undefined;
  if (hit) {
    return {
      windowId: hit.id,
      capacityPct: hit.usedPct,
      resetAt: hit.resetAt ?? snapshot.resetAt,
      periodType: hit.periodType ?? hit.id,
    };
  }
  // No preferred match: keep binding top-level fields when present
  if (typeof snapshot.capacityPct === 'number') {
    const bindingId =
      windows.find(
        (w) =>
          Math.abs(w.usedPct - snapshot.capacityPct!) < 0.05
          && (w.resetAt === snapshot.resetAt || !snapshot.resetAt),
      )?.id
      ?? (snapshot.periodType
        ? windows.find((w) =>
          (w.periodType || w.id).toLowerCase().includes(String(snapshot.periodType).toLowerCase())
          || String(snapshot.periodType).toLowerCase().includes((w.periodType || w.id).toLowerCase()),
        )?.id
        : null)
      ?? null;
    return {
      windowId: bindingId,
      capacityPct: snapshot.capacityPct,
      resetAt: snapshot.resetAt,
      periodType: snapshot.periodType,
    };
  }
  if (windows[0]) {
    return {
      windowId: windows[0].id,
      capacityPct: windows[0].usedPct,
      resetAt: windows[0].resetAt,
      periodType: windows[0].periodType ?? windows[0].id,
    };
  }
  // Balance-only snapshots have no pct/windows; the numeric 0 keeps the
  // indicator's `present` gate true so its balance branch can render.
  return { windowId: null, capacityPct: 0, resetAt: null, periodType: null };
}

/** Compact label for window switcher: weekly→7d, monthly→mo, 5h, 7d. */
export function windowShortLabel(idOrType?: string | null): string {
  const t = (idOrType || '').toLowerCase();
  if (!t) return '·';
  if (t === '5h' || t.includes('5h')) return '5h';
  if (t === '7d' || t === '7day' || t.includes('7d')) return '7d';
  if (t.includes('week')) return '7d';
  if (t.includes('month')) return 'mo';
  return t.length > 4 ? t.slice(0, 4) : t;
}

export function readStoredWindowId(): string | null {
  try {
    const v = localStorage.getItem(PLAN_USAGE_WINDOW_STORAGE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function writeStoredWindowId(id: string): void {
  try {
    localStorage.setItem(PLAN_USAGE_WINDOW_STORAGE_KEY, id);
  } catch {
    // ignore quota / private mode
  }
}

/** Next window id in list (cycle). If preferred missing, start from first. */
export function nextWindowId(
  windows: CapacityWindow[],
  currentId?: string | null,
): string | null {
  if (windows.length === 0) return null;
  if (windows.length === 1) return windows[0].id;
  const idx = windows.findIndex((w) => w.id === currentId);
  const next = idx < 0 ? 0 : (idx + 1) % windows.length;
  return windows[next].id;
}
