import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CodexProviderDialog from './CodexProviderDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.name ?? key,
  }),
}));

vi.mock('./shared/ProviderModelIcon', () => ({
  ProviderModelIcon: ({ providerId }: { providerId?: string }) => (
    <span data-provider-icon={providerId} />
  ),
}));

describe('CodexProviderDialog', () => {
  it('add mode defaults to OpenAI official direct setup', () => {
    render(
      <CodexProviderDialog
        isOpen
        provider={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    expect(screen.getByText('settings.provider.dialog.securityNotice')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.codexProvider.dialog.officialPreset' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.codexProvider.dialog.officialPreset' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText(/settings\.codexProvider\.dialog\.providerName/) as HTMLInputElement).value).toBe('OpenAI Official Direct');
    expect((screen.getByLabelText(/config.toml/) as HTMLTextAreaElement).value).toContain('base_url = "https://api.openai.com/v1"');
    expect((screen.getByLabelText(/auth.json/) as HTMLTextAreaElement).value).toContain('"OPENAI_API_KEY": ""');
  });

  it('add mode exposes the same third-party preset set as Claude providers', () => {
    render(
      <CodexProviderDialog
        isOpen
        provider={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: 'settings.provider.presets.custom' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.zhipu' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.kimi' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.kimiCoding' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.deepseek' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.minimax' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.xiaomi' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.xiaomiPlan' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.bailian' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.bailianCoding' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.longcat' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.opencodeGo' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'settings.provider.presets.openrouter' })).toBeTruthy();

    expect(screen.queryByRole('radio', { name: 'settings.provider.presets.qwen' })).toBeNull();
    expect(document.querySelector('[data-provider-icon="bailian-coding"]')).toBeTruthy();
    expect(document.querySelector('[data-provider-icon="opencode-go"]')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /PackyCode/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Gemini/i })).toBeNull();
  });

  it('applies a Codex preset into config.toml and auth.json', () => {
    render(
      <CodexProviderDialog
        isOpen
        provider={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'settings.provider.presets.deepseek' }));

    expect((screen.getByLabelText(/settings\.codexProvider\.dialog\.providerName/) as HTMLInputElement).value).toBe('DeepSeek');
    expect((screen.getByLabelText(/config.toml/) as HTMLTextAreaElement).value).toContain('base_url = "https://api.deepseek.com"');
    expect((screen.getByLabelText(/config.toml/) as HTMLTextAreaElement).value).toContain('model = "deepseek-v4-flash"');
    expect((screen.getByLabelText(/auth.json/) as HTMLTextAreaElement).value).toContain('"OPENAI_API_KEY": ""');
  });

  it('keeps format buttons compact in the config editors', () => {
    render(
      <CodexProviderDialog
        isOpen
        provider={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    const formatButtons = screen.getAllByTitle('settings.codexProvider.dialog.formatJson');
    expect(formatButtons).toHaveLength(2);
    for (const button of formatButtons) {
      expect(button.classList.contains('btn-small')).toBe(true);
      expect(button.classList.contains('btn-secondary')).toBe(false);
      expect((button as HTMLButtonElement).style.width).toBe('auto');
    }
  });
});
