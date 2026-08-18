import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TokenIndicator } from './TokenIndicator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { percentage?: string }) => options?.percentage ?? key,
  }),
}));

describe('TokenIndicator', () => {
  it('renders normal percentages as a percentage string', () => {
    render(<TokenIndicator percentage={45} usedTokens={900} maxTokens={2000} />);
    expect(screen.getByText('45%')).toBeTruthy();
  });

  it('shows 100% (no plus) when percentage is exactly 100', () => {
    render(<TokenIndicator percentage={100} usedTokens={2000} maxTokens={2000} />);
    expect(screen.getByText('100%')).toBeTruthy();
  });

  // ★ KEY REGRESSION TEST: shows "+" suffix when percentage exceeds 100
  it('shows 100%+ when percentage exceeds 100', () => {
    render(<TokenIndicator percentage={145} usedTokens={2900} maxTokens={2000} />);
    expect(screen.getByText('100%+')).toBeTruthy();
  });

  it('clamps the ring fill geometry but preserves raw used tokens', () => {
    const { container } = render(
      <TokenIndicator percentage={145} usedTokens={2900} maxTokens={2000} />
    );
    const progressCircle = container.querySelector('.token-indicator-fill');
    expect(progressCircle?.getAttribute('stroke-dashoffset')).toBe('0');
    // Real values preserved on tooltip — front end must not lose overflow info
    expect(screen.getByText(/2.9k \/ 2k/)).toBeTruthy();
  });

  it('shows the bug scenario from the issue: 100.0% + 2043.6k/1050k', () => {
    const { container } = render(
      <TokenIndicator percentage={194.6} usedTokens={2043600} maxTokens={1050000} />
    );
    expect(screen.getByText('100%+')).toBeTruthy();
    expect(screen.getByText(/2.0M \/ 1.0M/)).toBeTruthy();
  });
});
