import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_CUSTOM_UI_THEME,
  CUSTOM_THEME_PRESETS,
  loadCustomUiTheme,
  saveCustomUiTheme,
  normalizeCustomUiTheme,
  exportCustomUiTheme,
  importCustomUiTheme,
  applyCustomUiTheme,
  clearCustomUiThemeProperties,
} from './customUiTheme';

describe('customUiTheme', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('has valid default custom UI theme and curated presets', () => {
    expect(DEFAULT_CUSTOM_UI_THEME).toBeDefined();
    expect(DEFAULT_CUSTOM_UI_THEME.version).toBe(1);
    expect(DEFAULT_CUSTOM_UI_THEME.name).toBe('Nebula Glow');
    expect(DEFAULT_CUSTOM_UI_THEME.mode).toBe('dark');
    expect(DEFAULT_CUSTOM_UI_THEME.colors.bgPrimary).toBe('#12131a');
    expect(DEFAULT_CUSTOM_UI_THEME.colors.accentPrimary).toBe('#6366f1');

    expect(CUSTOM_THEME_PRESETS.length).toBeGreaterThanOrEqual(5);
    CUSTOM_THEME_PRESETS.forEach((preset) => {
      expect(preset.id).toBeTruthy();
      expect(preset.nameKey).toBeTruthy();
      expect(preset.theme.colors.bgPrimary).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(preset.theme.colors.accentPrimary).toMatch(/^#[0-9a-fA-F]{6}$/);
    });
  });

  it('loads default theme when storage is empty', () => {
    const theme = loadCustomUiTheme();
    expect(theme).toEqual(DEFAULT_CUSTOM_UI_THEME);
  });

  it('saves and loads custom theme from localStorage', () => {
    const custom = {
      ...DEFAULT_CUSTOM_UI_THEME,
      name: 'User Custom Theme',
      colors: {
        ...DEFAULT_CUSTOM_UI_THEME.colors,
        bgPrimary: '#000000',
        accentPrimary: '#ff0055',
      },
    };

    saveCustomUiTheme(custom);
    const loaded = loadCustomUiTheme();
    expect(loaded.name).toBe('User Custom Theme');
    expect(loaded.colors.bgPrimary).toBe('#000000');
    expect(loaded.colors.accentPrimary).toBe('#ff0055');
  });

  it('exports and imports theme via JSON correctly', () => {
    const preset = CUSTOM_THEME_PRESETS[1].theme; // Frosted Glass
    const json = exportCustomUiTheme(preset);
    const imported = importCustomUiTheme(json);

    expect(imported.name).toBe(preset.name);
    expect(imported.colors.bgPrimary).toBe(preset.colors.bgPrimary);
    expect(imported.colors.accentPrimary).toBe(preset.colors.accentPrimary);
    expect(imported.radiusScale).toBe(preset.radiusScale);
  });

  it('falls back to default colors on invalid input in normalizeCustomUiTheme', () => {
    const invalidInput = {
      name: 'Broken',
      colors: {
        bgPrimary: 'invalid-color',
      },
      radiusScale: 999, // Should clamp to max 2
    };

    const normalized = normalizeCustomUiTheme(invalidInput);
    expect(normalized.colors.bgPrimary).toBe(DEFAULT_CUSTOM_UI_THEME.colors.bgPrimary);
    expect(normalized.radiusScale).toBe(2);
  });

  it('applies CSS properties and data-theme to documentElement', () => {
    const theme = CUSTOM_THEME_PRESETS[0].theme;
    applyCustomUiTheme(theme);

    expect(document.documentElement.getAttribute('data-theme')).toBe(theme.mode);
    expect(document.documentElement.style.getPropertyValue('--bg-primary')).toBe(theme.colors.bgPrimary);
    expect(document.documentElement.style.getPropertyValue('--color-chat-bars-bg')).toBe(theme.colors.bgSecondary);

    clearCustomUiThemeProperties();
    expect(document.documentElement.style.getPropertyValue('--bg-primary')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--color-chat-bars-bg')).toBe('');
  });
});
