import React, { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  clampPercent,
  formatBalance,
  formatFullReset,
  formatShortReset,
  nextWindowId,
  paceColor,
  readStoredWindowId,
  resolveDisplayWindow,
  resolveTimeBudget,
  windowShortLabel,
  worstPaceColor,
  writeStoredWindowId,
  type PlanUsageSnapshot,
} from '../../utils/planUsagePace';

export interface PlanUsageIndicatorProps {
  snapshot: PlanUsageSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
}

/**
 * Layout D: mini progress bar + % + window switcher + short reset.
 * Click the window chip (5h / 7d) to cycle between windows.
 */
export const PlanUsageIndicator: React.FC<PlanUsageIndicatorProps> = memo(({
  snapshot,
  status,
}) => {
  const { t, i18n } = useTranslation();
  const [windowId, setWindowId] = useState<string | null>(() => readStoredWindowId());

  const display = useMemo(() => {
    if (!snapshot?.present) return null;
    return resolveDisplayWindow(snapshot, windowId);
  }, [snapshot, windowId]);

  const windows = snapshot?.windows ?? [];
  const canSwitch = windows.length > 1;

  const onCycleWindow = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSwitch) return;
    const next = nextWindowId(windows, display?.windowId ?? windowId);
    if (!next) return;
    setWindowId(next);
    writeStoredWindowId(next);
  }, [canSwitch, windows, display?.windowId, windowId]);

  const present = !!display && typeof display.capacityPct === 'number' && !!snapshot?.present;
  const tp = present ? clampPercent(display!.capacityPct) : 0;
  const tt = present
    ? resolveTimeBudget({
      resetAt: display!.resetAt,
      periodStart: snapshot?.periodStart,
      periodType: display!.periodType,
    })
    : null;
  // Bar/% = selected window; trailing dot = worst across all windows.
  const color = present ? paceColor(tp, tt) : 'neutral';
  const worstColor = present && snapshot ? worstPaceColor(snapshot) : 'neutral';
  const shortReset = present ? formatShortReset(display!.resetAt, i18n.language) : '';
  const fullReset = present ? formatFullReset(display!.resetAt, i18n.language) : '';
  const winLabel = windowShortLabel(display?.windowId || display?.periodType);

  const tooltip = useMemo(() => {
    if (!present) {
      return snapshot?.message
        || t('chat.planUsage.unavailable', { defaultValue: 'Usage unavailable' });
    }
    const pct = Math.round(tp);
    const period = display?.periodType || display?.windowId || 'limit';
    const lines: string[] = [];
    if (snapshot?.level) {
      lines.push(snapshot.level.toUpperCase());
    }
    if (fullReset) {
      lines.push(
        t('chat.planUsage.tooltipWindowWithReset', {
          period,
          percent: pct,
          value: fullReset,
          defaultValue: '{{period}} {{percent}}% · Resets {{value}}',
        }),
      );
    } else {
      lines.push(
        t('chat.planUsage.tooltipWindow', {
          period,
          percent: pct,
          defaultValue: '{{period}} {{percent}}%',
        }),
      );
    }
    if (windows.length > 1) {
      const others = windows
        .map((w) => `${w.id} ${Math.round(w.usedPct)}%`)
        .join(' · ');
      lines.push(others);
      if (worstColor !== color && worstColor !== 'neutral' && worstColor !== 'green') {
        lines.push(
          t('chat.planUsage.worstHint', {
            color: worstColor,
            defaultValue: 'Dot shows worst window ({{color}})',
          }),
        );
      }
      lines.push(
        t('chat.planUsage.clickToSwitch', {
          defaultValue: 'Click period label to switch window',
        }),
      );
    }
    if (snapshot?.stale) {
      lines.push(
        t('chat.planUsage.stale', {
          defaultValue: 'Data may be outdated (refresh failed)',
        }),
      );
    }
    return lines.join('\n');
  }, [present, snapshot?.message, snapshot?.level, snapshot?.stale, tp, fullReset, display, windows, worstColor, color, t]);

  if (status === 'idle') return null;

  if (!present && status === 'loading') {
    return (
      <div
        className="plan-usage loading has-tooltip"
        data-tooltip={t('chat.planUsage.loading', { defaultValue: 'Loading usage…' })}
        aria-label={t('chat.planUsage.loading', { defaultValue: 'Loading usage…' })}
      >
        <span className="plan-usage-label">…</span>
      </div>
    );
  }

  if (!present) {
    return (
      <div
        className="plan-usage unavailable has-tooltip"
        data-tooltip={tooltip}
        aria-label={tooltip}
      >
        <span className="plan-usage-label">
          {t('chat.planUsage.dash', { defaultValue: 'Usage —' })}
        </span>
      </div>
    );
  }

  // Prepaid balance vendors (DeepSeek/Moonshot/OpenRouter/…): no percentage
  // denominator, so show the labeled amount instead of the bar — the label
  // follows the UI language (chat.planUsage.balanceLabel); tooltip carries
  // the total/used detail when the vendor reports it (OpenRouter).
  // Reaching here relies on resolveDisplayWindow's fallback returning
  // capacityPct 0 for balance-only snapshots — that keeps `present` true
  // past the !present return above.
  const balance = snapshot?.balance;
  if (balance && windows.length === 0) {
    const amount = formatBalance(balance.remaining, balance.unit);
    const balanceColor = balance.remaining <= 0 ? 'red' : 'neutral';
    const tipLines = [
      t('chat.planUsage.balanceRemaining', {
        value: amount,
        defaultValue: 'Balance: {{value}}',
      }),
    ];
    if (balance.total != null || balance.used != null) {
      tipLines.push(
        t('chat.planUsage.balanceDetail', {
          total: balance.total != null ? formatBalance(balance.total, balance.unit) : '—',
          used: balance.used != null ? formatBalance(balance.used, balance.unit) : '—',
          defaultValue: 'Total {{total}} · Used {{used}}',
        }),
      );
    }
    if (snapshot?.stale) {
      tipLines.push(
        t('chat.planUsage.stale', {
          defaultValue: 'Data may be outdated (refresh failed)',
        }),
      );
    }
    const balanceTooltip = tipLines.join('\n');
    return (
      <div
        className={`plan-usage pace-${balanceColor} has-tooltip`}
        data-tooltip={balanceTooltip}
        aria-label={balanceTooltip}
      >
        <span className="plan-usage-balance">
          {t('chat.planUsage.balanceLabel', { defaultValue: 'Balance: ' })}
          {amount}
        </span>
      </div>
    );
  }

  const fillWidth = `${tp}%`;
  const rounded = Math.round(tp);
  const labelPct = tp > 0 && rounded === 0 ? '<1%' : `${rounded}%`;

  return (
    <div
      className={`plan-usage pace-${color} has-tooltip`}
      data-tooltip={tooltip}
      aria-label={tooltip}
    >
      <div className="plan-usage-bar" aria-hidden>
        <div className="plan-usage-fill" style={{ width: fillWidth }} />
      </div>
      <span className="plan-usage-pct">{labelPct}</span>
      {canSwitch || winLabel !== '·' ? (
        <button
          type="button"
          className={`plan-usage-window${canSwitch ? ' switchable' : ''}`}
          onClick={onCycleWindow}
          disabled={!canSwitch}
          title={
            canSwitch
              ? t('chat.planUsage.clickToSwitch', {
                defaultValue: 'Click to switch between windows',
              })
              : undefined
          }
        >
          {winLabel}
        </button>
      ) : null}
      {shortReset ? (
        <span className="plan-usage-reset">{shortReset}</span>
      ) : null}
      {/* Worst pace across all windows — after reset date */}
      <span
        className={`plan-usage-worst-dot pace-${worstColor}`}
        aria-hidden
        title={
          worstColor !== 'neutral'
            ? t('chat.planUsage.worstDot', {
              color: worstColor,
              defaultValue: 'Worst window: {{color}}',
            })
            : undefined
        }
      />
    </div>
  );
});

PlanUsageIndicator.displayName = 'PlanUsageIndicator';
