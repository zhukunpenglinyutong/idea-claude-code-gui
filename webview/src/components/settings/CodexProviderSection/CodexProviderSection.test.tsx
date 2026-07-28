import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodexProviderSection from './index';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';

const providerListStyles = readFileSync(
  'src/components/settings/ProviderList/style.module.less',
  'utf8'
);

const translations: Record<string, string> = {
  'settings.codexProvider.title': 'Codex Provider Management',
  'settings.codexProvider.description': 'Manage Codex providers',
  'settings.codexProvider.emptyProvider': 'No Codex providers configured',
  'settings.codexProvider.dialog.cliLoginProviderName': '使用本地配置信息',
  'settings.codexProvider.dialog.cliLoginProviderDescription': '显式授权读取：~/.codex/config.toml 和 auth.json',
  'settings.codexProvider.dialog.cliLoginAuthorizeTitle': 'Authorize Local Codex Config Access',
  'settings.codexProvider.dialog.cliLoginAuthorizeMessage': 'Read local Codex config files.',
  'settings.codexProvider.dialog.cliLoginAuthorizeDetail': 'Do not overwrite config.toml or auth.json.',
  'settings.codexProvider.dialog.cliLoginAuthorizeAction': 'Authorize Access',
  'settings.codexProvider.dialog.cliLoginDisableTitle': 'Revoke Local Codex Config Authorization',
  'settings.codexProvider.dialog.cliLoginDisableMessage': 'Stop reading local Codex config files.',
  'settings.provider.loading': 'Loading',
  'settings.provider.allProviders': 'All Providers',
  'settings.provider.authorizeAndEnable': 'Authorize and Enable',
  'settings.provider.revokeAuthorization': 'Revoke Authorization',
  'settings.provider.enable': 'Enable',
  'settings.provider.inUse': 'In Use',
  'settings.provider.dragToSort': 'Drag to sort',
  'common.add': 'Add',
  'common.cancel': 'Cancel',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const template = translations[key];
      if (!template) {
        return key;
      }
      if (!options) {
        return template;
      }
      return Object.entries(options).reduce(
        (result, [token, value]) => result.replace(`{{${token}}}`, value),
        template
      );
    },
  }),
}));

describe('CodexProviderSection', () => {
  const onAddCodexProvider = vi.fn();
  const onEditCodexProvider = vi.fn();
  const onDeleteCodexProvider = vi.fn();
  const onSwitchCodexProvider = vi.fn();
  const onAuthorizeCodexLocalConfig = vi.fn();
  const onRevokeCodexLocalConfigAuthorization = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders translated CLI login copy and confirms before enabling', () => {
    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN,
            name: 'Virtual CLI Login',
            isActive: false,
            localConfigAuthorized: false,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onAuthorizeCodexLocalConfig={onAuthorizeCodexLocalConfig}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    expect(screen.getByText('使用本地配置信息')).toBeTruthy();
    expect(screen.getByText('显式授权读取：~/.codex/config.toml 和 auth.json')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Authorize Access' })[0]);

    expect(screen.getByText('Authorize Local Codex Config Access')).toBeTruthy();

    const dialog = screen.getByText('Authorize Local Codex Config Access').closest('div')?.parentElement;
    const confirmButton = dialog?.querySelectorAll('button')[1];
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton as HTMLButtonElement);

    expect(onAuthorizeCodexLocalConfig).toHaveBeenCalledOnce();
    expect(onSwitchCodexProvider).not.toHaveBeenCalled();
  });

  it('does not show account info when CLI login is active', () => {
    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN,
            name: 'Virtual CLI Login',
            isActive: true,
            localConfigAuthorized: true,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onAuthorizeCodexLocalConfig={onAuthorizeCodexLocalConfig}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    expect(screen.queryByText('Logged in as: Nicole Fox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke Authorization' })).toBeTruthy();
  });

  it('revokes local authorization instead of switching directly when CLI login is active', () => {
    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN,
            name: 'Virtual CLI Login',
            isActive: true,
            localConfigAuthorized: true,
          },
          {
            id: 'provider-1',
            name: 'Provider 1',
            isActive: false,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onAuthorizeCodexLocalConfig={onAuthorizeCodexLocalConfig}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Authorization' }));

    const dialog = screen.getByText('Revoke Local Codex Config Authorization').closest('div')?.parentElement;
    const confirmButton = dialog?.querySelectorAll('button')[1];
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton as HTMLButtonElement);

    expect(onRevokeCodexLocalConfigAuthorization).toHaveBeenCalledWith('provider-1');
    expect(onSwitchCodexProvider).not.toHaveBeenCalled();
  });

  it('enables an authorized local config without requesting authorization again', () => {
    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN,
            name: 'Virtual CLI Login',
            isActive: false,
            localConfigAuthorized: true,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onAuthorizeCodexLocalConfig={onAuthorizeCodexLocalConfig}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    expect(onSwitchCodexProvider).toHaveBeenCalledWith(SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN);
    expect(onAuthorizeCodexLocalConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Revoke Authorization' })).toBeTruthy();
  });

  it('allows long remarks to truncate instead of squeezing the action area', () => {
    const longRemark =
      'https://api.example.com/providers/' + 'very-long-segment/'.repeat(8);

    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: 'provider-long-remark',
            name: 'xinghuapi',
            remark: longRemark,
            isActive: false,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onAuthorizeCodexLocalConfig={onAuthorizeCodexLocalConfig}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    expect(screen.getByText(longRemark)).toBeTruthy();
    expect(providerListStyles).toMatch(/\.cardInfo\s*\{[\s\S]*min-width:\s*0;/);
    expect(providerListStyles).toMatch(/\.cardActions\s*\{[\s\S]*flex-shrink:\s*0;/);
    expect(providerListStyles).toMatch(
      /\.website\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/
    );
  });
});
