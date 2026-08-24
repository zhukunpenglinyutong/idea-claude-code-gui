import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CliSection from './index';

const translations: Record<string, string> = {
  'settings.cli.listTitle': 'Local CLI tools',
  'settings.cli.summary': '{{installed}} / {{total}} installed',
  'settings.cli.moreComingSoon': 'More coming soon',
  'settings.cli.hint': 'hint',
  'settings.cli.refresh': 'Re-check',
  'settings.cli.retry': 'Retry',
  'settings.cli.loading': 'Loading',
  'settings.cli.loadFailed': 'Failed',
  'settings.cli.status.installed': 'Installed',
  'settings.cli.status.notInstalled': 'Not installed',
  'settings.cli.viewInstallGuide': 'Install guide',
  'settings.cli.howToInstall': 'Install guide',
  'settings.cli.copy': 'Copy',
  'settings.cli.copyPath': 'Copy path',
  'settings.cli.copied': 'Copied',
  'settings.cli.copyFailed': 'Copy failed',
  'settings.cli.tools.agy.name': 'Antigravity CLI',
  'settings.cli.tools.agy.description': 'AGY desc',
  'settings.cli.tools.grok.name': 'Grok CLI',
  'settings.cli.tools.grok.description': 'Grok desc',
  'settings.cli.tools.kimi.name': 'Kimi CLI',
  'settings.cli.tools.kimi.description': 'Kimi desc',
  'settings.cli.tools.opencode.name': 'OpenCode',
  'settings.cli.tools.opencode.description': 'OpenCode desc',
  'settings.cli.tools.pi.name': 'PI CLI',
  'settings.cli.tools.pi.description': 'PI desc',
  'settings.cli.tools.omp.name': 'OMP CLI',
  'settings.cli.tools.omp.description': 'OMP desc',
  'settings.cli.tools.dsh.name': 'DeepSeek Harness',
  'settings.cli.tools.dsh.description': 'DSH desc',
  'settings.cli.installDialog.title': 'Install {{name}}',
  'settings.cli.installDialog.lead': 'Lead {{name}} {{binary}}',
  'settings.cli.installDialog.stepOpenTerminal': 'Open terminal',
  'settings.cli.installDialog.stepRunCommand': 'Run command',
  'settings.cli.installDialog.stepVerify': 'Verify {{binary}}',
  'settings.cli.installDialog.stepReturn': 'Return',
  'settings.cli.installDialog.primaryCommand': 'Primary',
  'settings.cli.installDialog.windowsCommand': 'Windows',
  'settings.cli.installDialog.altCommand': 'Alt',
  'settings.cli.installDialog.openDocs': 'Docs',
  'common.close': 'Close',
  'common.gotIt': 'Got it',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const template = translations[key] ?? key;
      if (!options) return template;
      return Object.entries(options).reduce(
        (result, [token, value]) => result.replace(`{{${token}}}`, value),
        template,
      );
    },
  }),
}));

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => <span data-testid="provider-icon" />,
}));

vi.mock('./DshConnectionCard', () => ({
  default: () => <div data-testid="dsh-connection-card">DSH connection</div>,
}));

describe('CliSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
    window.updateCliStatus = undefined;
  });

  afterEach(() => {
    window.sendToJava = undefined;
    window.updateCliStatus = undefined;
  });

  it('requests CLI status on mount', async () => {
    render(<CliSection />);
    await waitFor(() => {
      expect(window.sendToJava).toHaveBeenCalledWith('get_cli_status:');
    });
  });

  it('renders installed and missing CLI tools from backend payload', async () => {
    render(<CliSection />);

    await act(async () => {
      window.updateCliStatus?.(JSON.stringify({
        grok: {
          id: 'grok',
          name: 'Grok CLI',
          binaryName: 'grok',
          installed: true,
          version: '1.2.3',
          path: '/Users/test/.grok/bin/grok',
        },
        kimi: {
          id: 'kimi',
          name: 'Kimi CLI',
          binaryName: 'kimi',
          installed: false,
        },
        opencode: {
          id: 'opencode',
          name: 'OpenCode',
          binaryName: 'opencode',
          installed: true,
          version: '0.9.0',
          path: '/usr/local/bin/opencode',
        },
        pi: {
          id: 'pi',
          name: 'PI CLI',
          binaryName: 'pi',
          installed: false,
        },
        omp: {
          id: 'omp',
          name: 'OMP CLI',
          binaryName: 'omp',
          installed: true,
          version: '17.2.14',
          path: '/home/test/.bun/bin/omp',
        },
        dsh: {
          id: 'dsh',
          name: 'DeepSeek Harness',
          binaryName: 'dsh',
          installed: true,
          version: '0.1',
          path: '/usr/local/bin/dsh',
        },
      }));
    });

    expect(screen.getByText('Grok CLI')).toBeTruthy();
    expect(screen.getByText('Kimi CLI')).toBeTruthy();
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('PI CLI')).toBeTruthy();
    expect(screen.getByText('OMP CLI')).toBeTruthy();
    expect(screen.getByText('DeepSeek Harness')).toBeTruthy();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    expect(screen.getByText('/Users/test/.grok/bin/grok')).toBeTruthy();
    expect(screen.getByText('More coming soon')).toBeTruthy();

    const harness = screen.getByText('DeepSeek Harness');
    const connection = screen.getByTestId('dsh-connection-card');
    expect(harness.compareDocumentPosition(connection) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('opens install guide dialog without auto-installing', async () => {
    render(<CliSection />);

    await act(async () => {
      window.updateCliStatus?.(JSON.stringify({
        agy: { id: 'agy', name: 'Antigravity CLI', binaryName: 'agy', installed: false },
        grok: { id: 'grok', name: 'Grok CLI', binaryName: 'grok', installed: false },
        kimi: { id: 'kimi', name: 'Kimi CLI', binaryName: 'kimi', installed: false },
        opencode: { id: 'opencode', name: 'OpenCode', binaryName: 'opencode', installed: false },
        pi: { id: 'pi', name: 'PI CLI', binaryName: 'pi', installed: false },
        omp: { id: 'omp', name: 'OMP CLI', binaryName: 'omp', installed: false },
      }));
    });

    const guideButtons = screen.getAllByText('Install guide');
    fireEvent.click(guideButtons[0]);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/curl -fsSL https:\/\/antigravity\.google\/docs\/cli\/install \| bash/)).toBeTruthy();
    // Never triggers install via Java bridge
    const calls = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.every((c) => !c.includes('install'))).toBe(true);
  });

  it('opens the install dialog docs link in the system browser via the bridge', async () => {
    render(<CliSection />);

    await act(async () => {
      window.updateCliStatus?.(JSON.stringify({
        grok: { id: 'grok', name: 'Grok CLI', binaryName: 'grok', installed: false },
      }));
    });

    // Scope to the Grok card — the catalog starts with the Antigravity (agy)
    // card, so positional [0] would open the agy guide instead.
    const grokCard = screen.getByText('Grok CLI').closest('div[class*="cliCard"]');
    expect(grokCard).toBeTruthy();
    fireEvent.click(within(grokCard as HTMLElement).getByText('Install guide'));
    expect(await screen.findByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByText('Docs'));
    expect(window.sendToJava).toHaveBeenCalledWith('open_browser:https://x.ai/cli');
  });
});
