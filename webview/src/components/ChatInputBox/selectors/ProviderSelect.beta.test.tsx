// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BETA_PROVIDER_NOTICE_KEY } from '../../../utils/betaProviderNotice';
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
        'providers.grok.label': 'Grok CLI',
        'providers.kimi.label': 'Kimi CLI',
        'providers.opencode.label': 'OpenCode',
        'providers.pi.label': 'PI CLI',
        'providers.omp.label': 'OMP CLI',
        'providers.dsh.label': 'DeepSeek Harness',
        'providers.beta.badge': 'Beta',
        'providers.beta.title': 'Beta Feature',
        'providers.beta.message':
          'This feature is still in Beta. If you encounter any bugs, please report them to the author promptly.',
        'common.gotIt': 'Got it',
        'settings.provider.featureComingSoon': 'Coming soon',
        'config.switchProvider': 'Switch provider',
      };
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      return map[key] ?? (defaultValue || key);
    },
  }),
}));

describe('ProviderSelect Beta badge and first-click notice', () => {
  beforeEach(() => {
    localStorage.removeItem(BETA_PROVIDER_NOTICE_KEY);
    window.sendToJava = vi.fn();
    window.updateCodexSubscriptionQuota = undefined;
  });

  it('renders Beta badges on Gemini, Grok, Kimi, OpenCode, PI, OMP and DSH', () => {
    render(<ProviderSelect value="claude" />);
    fireEvent.click(screen.getByRole('button'));

    const badges = screen.getAllByText('Beta');
    expect(badges).toHaveLength(7);

    for (const id of ['gemini', 'grok', 'kimi', 'opencode', 'pi', 'omp', 'dsh']) {
      const row = document.querySelector(`[data-provider-id="${id}"]`);
      expect(row?.querySelector('.provider-beta-badge')).toBeTruthy();
    }
    expect(document.querySelector('[data-provider-id="claude"] .provider-beta-badge')).toBeNull();
    expect(document.querySelector('[data-provider-id="codex"] .provider-beta-badge')).toBeNull();
  });

  it('shows beta notice on first click and switches after Got it', () => {
    const onChange = vi.fn();
    render(<ProviderSelect value="claude" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Grok CLI'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Beta Feature')).toBeTruthy();
    expect(
      screen.getByText(
        'This feature is still in Beta. If you encounter any bugs, please report them to the author promptly.'
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByText('Got it'));

    expect(onChange).toHaveBeenCalledWith('grok');
    expect(localStorage.getItem(BETA_PROVIDER_NOTICE_KEY)).toBe('true');
  });

  it('does not show the notice again after it was acknowledged', () => {
    localStorage.setItem(BETA_PROVIDER_NOTICE_KEY, 'true');
    const onChange = vi.fn();
    render(<ProviderSelect value="claude" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Kimi CLI'));

    expect(onChange).toHaveBeenCalledWith('kimi');
    expect(screen.queryByText('Beta Feature')).toBeNull();
  });
});
