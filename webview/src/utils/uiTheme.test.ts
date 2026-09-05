import { describe, it, expect, beforeEach } from 'vitest';
import {
  VALID_UI_THEME_STYLES,
  getSavedUiThemeStyle,
  applyUiThemeStyle,
  UI_THEME_STORAGE_KEY,
  type UiThemeStyle,
} from './uiTheme';

describe('uiTheme utility', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
  });

  it('contains all 15 valid theme styles', () => {
    expect(VALID_UI_THEME_STYLES).toEqual([
      'default',
      'lightGlass',
      'antigravity',
      'codebuddy',
      'idea',
      'vscode',
      'qq',
      'wechat',
      'notion',
      'arcGlass',
      'warp',
      'vercel',
      'claudeWarm',
      'solarized',
      'custom',
    ]);
  });

  it('defaults to default when no style is saved', () => {
    expect(getSavedUiThemeStyle()).toBe('default');
  });

  it('retrieves valid saved styles from localStorage', () => {
    const themes: UiThemeStyle[] = [
      'default',
      'lightGlass',
      'antigravity',
      'codebuddy',
      'idea',
      'vscode',
      'qq',
      'wechat',
      'notion',
      'arcGlass',
      'warp',
      'vercel',
      'claudeWarm',
      'solarized',
      'custom',
    ];
    for (const theme of themes) {
      localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
      expect(getSavedUiThemeStyle()).toBe(theme);
    }
  });

  it('falls back to default for invalid saved values', () => {
    localStorage.setItem(UI_THEME_STORAGE_KEY, 'invalid-theme');
    expect(getSavedUiThemeStyle()).toBe('default');
  });

  it('applies theme style to document element and saves to localStorage', () => {
    applyUiThemeStyle('idea');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('idea');
    expect(localStorage.getItem(UI_THEME_STORAGE_KEY)).toBe('idea');

    applyUiThemeStyle('vscode');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('vscode');
    expect(localStorage.getItem(UI_THEME_STORAGE_KEY)).toBe('vscode');

    applyUiThemeStyle('qq');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('qq');
    expect(localStorage.getItem(UI_THEME_STORAGE_KEY)).toBe('qq');

    applyUiThemeStyle('wechat');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('wechat');
    expect(localStorage.getItem(UI_THEME_STORAGE_KEY)).toBe('wechat');
  });

  it('falls back to default when applying invalid style', () => {
    applyUiThemeStyle('unknown' as UiThemeStyle);
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('default');
    expect(localStorage.getItem(UI_THEME_STORAGE_KEY)).toBe('default');
  });
});
