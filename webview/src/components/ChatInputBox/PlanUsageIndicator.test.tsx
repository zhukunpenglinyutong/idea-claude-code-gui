import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanUsageIndicator } from './PlanUsageIndicator';

describe('PlanUsageIndicator', () => {
  it('shows Usage — when unavailable', () => {
    render(
      <PlanUsageIndicator
        status="unavailable"
        snapshot={{ present: false, message: 'down' }}
      />,
    );
    expect(screen.getByText(/Usage/)).toBeTruthy();
  });

  it('renders bar percent and short reset on happy path', () => {
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          capacityPct: 47,
          resetAt: '2026-07-28T00:00:00Z',
          periodType: '7d',
        }}
      />,
    );
    expect(screen.getByText('47%')).toBeTruthy();
    expect(container.querySelector('.plan-usage-bar')).toBeTruthy();
    expect(container.querySelector('.plan-usage-fill')).toBeTruthy();
  });

  it('applies pace color class from TP vs TT', () => {
    // end far future, start far past → TT high → TP low → green
    const far = new Date();
    far.setDate(far.getDate() + 3);
    const start = new Date();
    start.setDate(start.getDate() - 4);
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          capacityPct: 10,
          resetAt: far.toISOString(),
          periodStart: start.toISOString(),
        }}
      />,
    );
    expect(container.querySelector('.pace-green')).toBeTruthy();
  });

  it('returns null when idle', () => {
    const { container } = render(<PlanUsageIndicator status="idle" snapshot={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the balance amount instead of the bar for prepaid vendors', () => {
    const { container, getByText } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          source: 'deepseek',
          balance: { remaining: 42.5, total: null, used: null, unit: 'CNY' },
        }}
      />,
    );
    expect(getByText('Balance: ¥42.50')).toBeTruthy();
    expect(container.querySelector('.plan-usage-bar')).toBeNull();
    expect(container.querySelector('.plan-usage-balance')).toBeTruthy();
  });

  it('colors an exhausted balance red and shows totals in the tooltip', () => {
    // The test env has no i18n instance, so t() returns raw defaultValue
    // without {{…}} interpolation — assert on words, not interpolated values.
    const { container, getByText } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          source: 'openrouter',
          balance: { remaining: 0, total: 100, used: 100, unit: 'USD' },
        }}
      />,
    );
    expect(getByText('Balance: $0.00')).toBeTruthy();
    expect(container.querySelector('.pace-red')).toBeTruthy();
    const tooltip = container.querySelector('.plan-usage')?.getAttribute('data-tooltip') ?? '';
    expect(tooltip).toContain('Balance');
    expect(tooltip).toContain('Total');
    expect(tooltip).toContain('Used');
  });

  it('prefers windows over balance when both are present', () => {
    const { container } = render(
      <PlanUsageIndicator
        status="ready"
        snapshot={{
          present: true,
          capacityPct: 30,
          windows: [{ id: '5h', usedPct: 30 }],
          balance: { remaining: 5, unit: 'CNY' },
        }}
      />,
    );
    expect(container.querySelector('.plan-usage-bar')).toBeTruthy();
    expect(container.querySelector('.plan-usage-balance')).toBeNull();
  });
});
