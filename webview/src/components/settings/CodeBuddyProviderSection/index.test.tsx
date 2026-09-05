import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CodeBuddyProviderSection from './index';

const sendToJavaMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: (() => {
    const t = (key: string) => key;
    return () => ({ t });
  })(),
}));

vi.mock('../../../utils/bridge', () => ({
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}));

vi.mock('../../shared/ProviderModelIcon', () => ({
  ProviderModelIcon: () => null,
}));

describe('CodeBuddyProviderSection', () => {
  beforeEach(() => {
    sendToJavaMock.mockClear();
    delete window.updateCodeBuddyLocalConfigStatus;
  });

  afterEach(() => {
    delete window.updateCodeBuddyLocalConfigStatus;
  });

  it('requests status, authorizes, refreshes models, and supports revocation', () => {
    const addToast = vi.fn();
    const onModelsRefresh = vi.fn();
    window.addEventListener('codebuddy-models-config-refresh', onModelsRefresh);

    const { unmount } = render(
      <CodeBuddyProviderSection addToast={addToast} />,
    );

    expect(sendToJavaMock).toHaveBeenCalledWith('get_codebuddy_local_config_status');

    act(() => {
      window.updateCodeBuddyLocalConfigStatus?.(JSON.stringify({
        authorized: false,
        authenticated: false,
        configAvailable: true,
        errorCode: 'CODEBUDDY_LOGIN_REQUIRED',
      }));
    });

    expect(screen.getByRole('button', { name: 'settings.provider.authorizeAndEnable' })).toBeTruthy();
    expect(addToast).toHaveBeenCalledWith('settings.codebuddyProvider.loginRequired', 'warning');

    fireEvent.click(screen.getByRole('button', { name: 'settings.provider.authorizeAndEnable' }));
    expect(sendToJavaMock).toHaveBeenLastCalledWith('authorize_codebuddy_local_config');

    act(() => {
      window.updateCodeBuddyLocalConfigStatus?.(JSON.stringify({
        authorized: true,
        authenticated: true,
        configAvailable: true,
      }));
    });

    expect(screen.getByText('settings.codebuddyProvider.authorized')).toBeTruthy();
    expect(onModelsRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'settings.provider.revokeAuthorization' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings.provider.revokeAuthorization' }));
    expect(sendToJavaMock).toHaveBeenLastCalledWith('revoke_codebuddy_local_config');

    window.removeEventListener('codebuddy-models-config-refresh', onModelsRefresh);
    unmount();
  });
});
