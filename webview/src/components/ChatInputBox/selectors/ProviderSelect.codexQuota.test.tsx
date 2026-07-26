// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSelect } from './ProviderSelect';

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      const map: Record<string, string> = {
        'providers.claude.label': 'Claude Code',
        'providers.codex.label': 'Codex',
        'settings.provider.featureComingSoon': 'Coming soon',
      };
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      const interpolated = defaultValue.replace(/\{\{(\w+)\}\}/g, (_, token: string) => {
        const value = options && typeof options === 'object' ? (options as Record<string, unknown>)[token] : undefined;
        return value == null ? '' : String(value);
      });
      return map[key] ?? (interpolated || key);
    },
  }),
}));

describe('ProviderSelect Codex quota submenu', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.updateCodexSubscriptionQuota = undefined;
  });

  it('shows a submenu for Codex with quota details', async () => {
    render(<ProviderSelect value="claude" />);

    fireEvent.click(screen.getByRole('button'));
    const providerDropdown = document.querySelector('.selector-dropdown') as HTMLElement;
    // The quota panel is positioned above this dropdown. Setting overflow-x to
    // hidden also clips vertical overflow, so the panel becomes invisible.
    expect(providerDropdown.style.overflowX).toBe('');
    const codexRow = screen.getByText('Codex').closest('.selector-option')!;
    expect(codexRow.querySelector('.codicon-chevron-right')).toBeTruthy();

    fireEvent.mouseEnter(codexRow);
    expect(window.sendToJava).toHaveBeenCalledWith('get_codex_subscription_quota:');

    act(() => {
      window.updateCodexSubscriptionQuota?.(JSON.stringify({
        status: 'ok',
        fetchedAt: 1710000000000,
        source: 'local_history',
        windows: {
          fiveHour: {
            windowLabel: '5h',
            windowHours: 5,
            usedPercent: 80,
            remainingPercent: 20,
            resetsAt: 1748676960000,
            usedTokens: 0,
            limitTokens: null,
            remainingTokens: null,
            usedCost: 1.2,
            sessionCount: 3,
            lastUpdated: 1710000000000,
            source: 'local_history',
          },
          weekly: {
            windowLabel: 'weekly',
            windowHours: 168,
            usedPercent: 68,
            remainingPercent: 32,
            resetsAt: 1748763360000,
            usedTokens: 0,
            limitTokens: null,
            remainingTokens: null,
            usedCost: 3.4,
            sessionCount: 9,
            lastUpdated: 1710000000000,
            source: 'local_history',
          },
        },
      }));
    });

    const submenu = await screen.findByText('Codex quota');
    expect(submenu).toBeTruthy();
    const codexRowElement = codexRow as HTMLElement;
    expect(within(codexRowElement).getByText('5h usage')).toBeTruthy();
    expect(within(codexRowElement).getByText(/20% remaining \u00b7 Resets /)).toBeTruthy();
    expect(within(codexRowElement).getByText('Weekly usage')).toBeTruthy();
    expect(within(codexRowElement).getByText(/32% remaining \u00b7 Resets /)).toBeTruthy();
    expect(screen.queryByText(/Source:/)).toBeNull();
    expect(screen.queryByText(/Balance refreshed at/)).toBeNull();
  });

  it('shows unavailable rows when quota windows have no values', async () => {
    render(<ProviderSelect value="claude" />);

    fireEvent.click(screen.getByRole('button'));
    const codexRow = screen.getByText('Codex').closest('.selector-option')!;
    fireEvent.mouseEnter(codexRow);

    act(() => {
      window.updateCodexSubscriptionQuota?.(JSON.stringify({
        status: 'unavailable',
        fetchedAt: 1710000000000,
        windows: {
          fiveHour: {
            windowLabel: '5h',
            windowHours: 5,
            usedPercent: null,
            remainingPercent: null,
            resetsAt: null,
            usedTokens: 0,
            limitTokens: null,
            remainingTokens: null,
          },
          weekly: {
            windowLabel: 'weekly',
            windowHours: 168,
            usedPercent: null,
            remainingPercent: null,
            resetsAt: null,
            usedTokens: 0,
            limitTokens: null,
            remainingTokens: null,
          },
        },
      }));
    });

    const codexRowElement = codexRow as HTMLElement;
    expect(await within(codexRowElement).findByText('Codex quota')).toBeTruthy();
    expect(within(codexRowElement).getAllByText('Unavailable')).toHaveLength(3);
    expect(screen.queryByText('0 used')).toBeNull();
    expect(screen.queryByText(/Resets /)).toBeNull();
  });

  it('shows a dedicated message and hides window rows in API key mode', async () => {
    render(<ProviderSelect value="claude" />);

    fireEvent.click(screen.getByRole('button'));
    const codexRow = screen.getByText('Codex').closest('.selector-option')!;
    fireEvent.mouseEnter(codexRow);

    act(() => {
      window.updateCodexSubscriptionQuota?.(JSON.stringify({
        status: 'unavailable',
        fetchedAt: 1710000000000,
        source: 'none',
        reasonCode: 'api_key_mode',
        error: 'API key mode has no subscription quota',
        windows: {
          fiveHour: {
            windowLabel: '5h',
            windowHours: 5,
            usedPercent: null,
            remainingPercent: null,
            resetsAt: null,
            usedTokens: 0,
            limitTokens: null,
            remainingTokens: null,
          },
          weekly: {
            windowLabel: 'weekly',
            windowHours: 168,
            usedPercent: null,
            remainingPercent: null,
            resetsAt: null,
            usedTokens: 0,
            limitTokens: null,
            remainingTokens: null,
          },
        },
      }));
    });

    const codexRowElement = codexRow as HTMLElement;
    expect(await within(codexRowElement).findByText('Codex quota')).toBeTruthy();
    expect(within(codexRowElement).getByText('API key mode has no subscription quota')).toBeTruthy();
    expect(within(codexRowElement).queryByText('5h usage')).toBeNull();
    expect(within(codexRowElement).queryByText('Weekly usage')).toBeNull();
    expect(within(codexRowElement).queryByText('Unavailable')).toBeNull();
  });
});
