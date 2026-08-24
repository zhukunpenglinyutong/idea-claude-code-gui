import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ButtonArea } from './ButtonArea';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
    }),
  };
});

describe('ButtonArea Codex context-window placement', () => {
  it('shows the context selector immediately after speed only for Codex', () => {
    const props = {
      selectedModel: 'gpt-5.6-sol',
      currentProvider: 'codex',
      onModelSelect: vi.fn(),
      onProviderSelect: vi.fn(),
      onCodexContextWindowChange: vi.fn(),
      onCodexContextWindowRefresh: vi.fn(),
    } as const;
    const { rerender } = render(<ButtonArea {...props} />);

    const speedButton = screen.getByTitle('Select Codex speed mode');
    const contextSelector = screen.getByTestId('codex-context-window-select');
    expect(speedButton.parentElement?.nextElementSibling).toBe(contextSelector);

    rerender(<ButtonArea {...props} currentProvider="claude" />);
    expect(screen.queryByTestId('codex-context-window-select')).toBeNull();
  });
});
