import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useSettingsThemeSync } from './useSettingsThemeSync';

function setAttr(name: string, value: string | null): void {
  if (value === null) {
    document.documentElement.removeAttribute(name);
  } else {
    document.documentElement.setAttribute(name, value);
  }
}

beforeEach(() => {
  localStorage.clear();
  setAttr('data-theme', null);
  setAttr('data-ide-theme', null);
  delete (window as unknown as { __INITIAL_IDE_THEME__?: string }).__INITIAL_IDE_THEME__;
  delete (window as unknown as { sendToJava?: unknown }).sendToJava;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { sendToJava?: unknown }).sendToJava;
});

describe('useSettingsThemeSync theme state', () => {
  it('does not flip CoDriver to light on mount when __INITIAL_IDE_THEME__ is stale', () => {
    // Live chat state: CoDriver active in a dark IDE.
    setAttr('data-theme', 'codriver');
    setAttr('data-ide-theme', 'dark');
    localStorage.setItem('theme', 'codriver');
    // Stale load-time snapshot disagrees with the live attribute.
    (window as unknown as { __INITIAL_IDE_THEME__?: string }).__INITIAL_IDE_THEME__ = 'light';

    const { result } = renderHook(() => useSettingsThemeSync());

    // Mounting Settings must not clobber the live dark state.
    expect(document.documentElement.getAttribute('data-ide-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('codriver');
    expect(result.current.ideTheme).toBe('dark');
    expect(result.current.themePreference).toBe('codriver');
  });

  it('keeps CoDriver light when the IDE is light', () => {
    setAttr('data-theme', 'codriver');
    setAttr('data-ide-theme', 'light');
    localStorage.setItem('theme', 'codriver');

    const { result } = renderHook(() => useSettingsThemeSync());

    expect(document.documentElement.getAttribute('data-ide-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('codriver');
    expect(result.current.ideTheme).toBe('light');
  });

  it('does not write a theme value on mount when nothing changed', () => {
    setAttr('data-theme', 'codriver');
    setAttr('data-ide-theme', 'dark');
    localStorage.setItem('theme', 'codriver');
    (window as unknown as { __INITIAL_IDE_THEME__?: string }).__INITIAL_IDE_THEME__ = 'light';

    renderHook(() => useSettingsThemeSync());

    // localStorage theme is untouched (no light/default written back).
    expect(localStorage.getItem('theme')).toBe('codriver');
  });

  it('Follow IDE resolves data-theme to the live IDE theme', () => {
    setAttr('data-ide-theme', 'dark');
    setAttr('data-theme', 'dark');
    localStorage.setItem('theme', 'system');

    const { result } = renderHook(() => useSettingsThemeSync());

    expect(result.current.ideTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to the injected snapshot when data-ide-theme is absent', () => {
    (window as unknown as { __INITIAL_IDE_THEME__?: string }).__INITIAL_IDE_THEME__ = 'dark';
    localStorage.setItem('theme', 'system');

    const { result } = renderHook(() => useSettingsThemeSync());

    expect(result.current.ideTheme).toBe('dark');
  });

  it('applies an explicit user theme change', () => {
    setAttr('data-theme', 'codriver');
    setAttr('data-ide-theme', 'dark');
    localStorage.setItem('theme', 'codriver');

    const { result } = renderHook(() => useSettingsThemeSync());

    act(() => result.current.setThemePreference('light'));

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');

    act(() => result.current.setThemePreference('dark'));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });
});

describe('useSettingsThemeSync reports active theme to Java for the plugin icon', () => {
  it('reports active=true while CoDriver is the preference and active=false after switching away', () => {
    const sendToJava = vi.fn();
    (window as unknown as { sendToJava: (m: string) => void }).sendToJava = sendToJava;

    setAttr('data-theme', 'codriver');
    setAttr('data-ide-theme', 'dark');
    localStorage.setItem('theme', 'codriver');

    const { result } = renderHook(() => useSettingsThemeSync());

    // On mount it reports the current CoDriver theme as active.
    expect(sendToJava).toHaveBeenCalledWith('set_codriver_theme_active:{"active":true}');

    sendToJava.mockClear();
    act(() => result.current.setThemePreference('dark'));

    // Switching to a non-CoDriver theme reports inactive so the icon reverts.
    expect(sendToJava).toHaveBeenCalledWith('set_codriver_theme_active:{"active":false}');
  });

  it('reports active=false for non-CoDriver themes', () => {
    const sendToJava = vi.fn();
    (window as unknown as { sendToJava: (m: string) => void }).sendToJava = sendToJava;

    setAttr('data-ide-theme', 'dark');
    localStorage.setItem('theme', 'light');

    renderHook(() => useSettingsThemeSync());

    expect(sendToJava).toHaveBeenCalledWith('set_codriver_theme_active:{"active":false}');
  });
});
