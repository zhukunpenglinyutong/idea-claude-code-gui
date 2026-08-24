import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexContextWindowSelect } from './CodexContextWindowSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; value?: string }) => {
      const fallback = options?.defaultValue ?? _key;
      return fallback.replace('{{value}}', options?.value ?? '');
    },
  }),
}));

describe('CodexContextWindowSelect', () => {
  it('shows exactly three presets and refreshes when opened', () => {
    const onChange = vi.fn();
    const onRefresh = vi.fn();
    render(
      <CodexContextWindowSelect
        value="default"
        contextWindowTokens={272_000}
        onChange={onChange}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getAllByText('Default 272K').length).toBeGreaterThan(0);
    expect(screen.getByText('500K')).toBeTruthy();
    expect(screen.getByText('1M')).toBeTruthy();

    fireEvent.click(screen.getByTestId('codex-context-option-500k'));
    expect(onChange).toHaveBeenCalledWith('500k');
  });

  it('shows a non-selectable custom value without adding a fourth option', () => {
    render(
      <CodexContextWindowSelect
        value="custom"
        contextWindowTokens={640_000}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Custom 640K')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('disables interaction while loading or saving', () => {
    const { rerender } = render(
      <CodexContextWindowSelect
        value="default"
        loading
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button')).toHaveProperty('disabled', true);

    rerender(
      <CodexContextWindowSelect
        value="1m"
        saving
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
  });
});
