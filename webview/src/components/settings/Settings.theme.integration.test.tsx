import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'zh',
      changeLanguage: vi.fn(),
    },
  }),
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
}));

describe('Settings -> BasicConfigSection -> AppearanceTab Theme Integration', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
  });

  it('updates uiThemeStyle and sets data-ui-theme attribute on documentElement when switching style dropdown', () => {
    render(
      <Settings
        onClose={vi.fn()}
        initialTab="basic"
        currentProvider="claude"
      />
    );

    const select = screen.getByTestId('settings-ui-style-select') as HTMLSelectElement;
    expect(select.value).toBe('default');

    // Change to 'lightGlass' (Frosted Glass)
    fireEvent.change(select, { target: { value: 'lightGlass' } });
    expect(select.value).toBe('lightGlass');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('lightGlass');
    expect(localStorage.getItem('uiThemeStyle')).toBe('lightGlass');

    // Change to 'codebuddy' (Clean Card)
    fireEvent.change(select, { target: { value: 'codebuddy' } });
    expect(select.value).toBe('codebuddy');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('codebuddy');
    expect(localStorage.getItem('uiThemeStyle')).toBe('codebuddy');
  });

  it('shows custom theme editor when custom style is selected', () => {
    render(
      <Settings
        onClose={vi.fn()}
        initialTab="basic"
        currentProvider="claude"
      />
    );

    const select = screen.getByTestId('settings-ui-style-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'custom' } });

    expect(select.value).toBe('custom');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('custom');
    expect(screen.getByText('settings.basic.customTheme.presetTemplates')).toBeDefined();
  });
});
