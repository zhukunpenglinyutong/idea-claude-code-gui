import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useCodexProviderManagement } from './useCodexProviderManagement';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('useCodexProviderManagement', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('authorizes local Codex config without switching providers', () => {
    const { result } = renderHook(() => useCodexProviderManagement());

    act(() => {
      result.current.handleAuthorizeCodexLocalConfig();
    });

    expect(window.sendToJava).toHaveBeenCalledWith('authorize_codex_local_config:');
    expect(window.sendToJava).not.toHaveBeenCalledWith(
      expect.stringContaining('switch_codex_provider:')
    );
    expect(result.current.codexLoading).toBe(true);
  });

  it('sends a revoke message when local Codex authorization is canceled', () => {
    const { result } = renderHook(() => useCodexProviderManagement());

    act(() => {
      result.current.handleRevokeCodexLocalConfigAuthorization('provider-1');
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'revoke_codex_local_config_authorization:{"fallbackProviderId":"provider-1"}'
    );
    expect(result.current.codexLoading).toBe(true);
  });
});
