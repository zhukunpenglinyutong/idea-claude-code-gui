// hooks/useSettingsThemeSync.ts
import { useState, useEffect } from 'react';
import { applyDiffTheme, getStoredDiffTheme, type DiffThemeMode } from '../../../utils/diffTheme';
import {
  isUiThemeMode,
  resolveThemeAttribute,
  type IdeThemeMode,
  type UiThemeMode,
} from '../../../types/uiThemeMode';

// Extend window type for IDE theme injection
declare global {
  interface Window {
    __INITIAL_IDE_THEME__?: IdeThemeMode;
  }
}

export interface UseSettingsThemeSyncReturn {
  themePreference: UiThemeMode;
  setThemePreference: (theme: UiThemeMode) => void;
  ideTheme: IdeThemeMode | null;
  setIdeTheme: (theme: IdeThemeMode | null) => void;
  fontSizeLevel: number;
  setFontSizeLevel: (level: number) => void;
  chatBgColor: string;
  setChatBgColor: (color: string) => void;
  userMsgColor: string;
  setUserMsgColor: (color: string) => void;
  linkColor: string;
  setLinkColor: (color: string) => void;
  codeColor: string;
  setCodeColor: (color: string) => void;
  diffTheme: DiffThemeMode;
  setDiffTheme: (theme: DiffThemeMode) => void;
}

export function useSettingsThemeSync(): UseSettingsThemeSyncReturn {
  const [themePreference, setThemePreference] = useState<UiThemeMode>(() => {
    // Read theme preference from localStorage
    const savedTheme = localStorage.getItem('theme');
    if (isUiThemeMode(savedTheme)) {
      return savedTheme;
    }
    return 'system'; // Default: follow IDE
  });

  // IDE theme state. Prefer the live `data-ide-theme` already on <html>: the chat
  // view (useThemeInit) keeps it in sync with the *current* IDE theme via
  // get_ide_theme. window.__INITIAL_IDE_THEME__ is only a load-time snapshot and
  // can be stale; reading it on Settings mount previously clobbered data-ide-theme
  // and flipped CoDriver to light. Fall back to the injected snapshot only when the
  // attribute is not present yet.
  const [ideTheme, setIdeTheme] = useState<IdeThemeMode | null>(() => {
    if (typeof document !== 'undefined') {
      const domIdeTheme = document.documentElement.getAttribute('data-ide-theme');
      if (domIdeTheme === 'light' || domIdeTheme === 'dark') {
        return domIdeTheme;
      }
    }
    const injectedTheme = window.__INITIAL_IDE_THEME__;
    if (injectedTheme === 'light' || injectedTheme === 'dark') {
      return injectedTheme;
    }
    return null;
  });

  // Font size level state (1-6, default is 2, i.e. 90%)
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(() => {
    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 2;
    return level >= 1 && level <= 6 ? level : 2;
  });

  // Chat background color configuration
  const [chatBgColor, setChatBgColor] = useState<string>(() => {
    const saved = localStorage.getItem('chatBgColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // User message bubble color configuration
  const [userMsgColor, setUserMsgColor] = useState<string>(() => {
    const saved = localStorage.getItem('userMsgColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // CoDriver link color configuration
  const [linkColor, setLinkColor] = useState<string>(() => {
    const saved = localStorage.getItem('codriverLinkColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // CoDriver inline code color configuration
  const [codeColor, setCodeColor] = useState<string>(() => {
    const saved = localStorage.getItem('codriverCodeColor');
    if (saved && /^#[0-9a-fA-F]{6}$/.test(saved)) {
      return saved;
    }
    return '';
  });

  // Diff theme configuration
  const [diffTheme, setDiffTheme] = useState<DiffThemeMode>(() => getStoredDiffTheme());

  // Theme switching handler (supports following IDE theme).
  // Writes are idempotent: merely opening Settings must not re-initialize or
  // overwrite the active theme — only an actual change (user toggle or a live IDE
  // theme change) is written back. This prevents the Settings mount from flipping
  // CoDriver away from the current IDE light/dark state.
  useEffect(() => {
    const root = document.documentElement;

    if (ideTheme !== null && root.getAttribute('data-ide-theme') !== ideTheme) {
      root.setAttribute('data-ide-theme', ideTheme);
    }

    const resolvedTheme = resolveThemeAttribute(themePreference, ideTheme);
    if (resolvedTheme !== null && root.getAttribute('data-theme') !== resolvedTheme) {
      root.setAttribute('data-theme', resolvedTheme);
    }

    if (localStorage.getItem('theme') !== themePreference) {
      localStorage.setItem('theme', themePreference);
    }
  }, [themePreference, ideTheme]);

  // Report whether the CoDriver chat theme is active so the plugin (tool window / action)
  // icon can follow it: switching away from CoDriver restores the original icon. The theme
  // preference is the source of truth (only an explicit `codriver` choice counts; system,
  // light and dark never resolve to CoDriver).
  useEffect(() => {
    if (window.sendToJava) {
      const active = themePreference === 'codriver';
      window.sendToJava(`set_codriver_theme_active:${JSON.stringify({ active })}`);
    }
  }, [themePreference]);

  // Font size scaling handler
  useEffect(() => {
    // Map level to scale ratio
    const fontSizeMap: Record<number, number> = {
      1: 0.8,   // 80%
      2: 0.9,   // 90% (default)
      3: 1.0,   // 100%
      4: 1.1,   // 110%
      5: 1.2,   // 120%
      6: 1.4,   // 140%
    };
    const scale = fontSizeMap[fontSizeLevel] || 1.0;

    // Apply to root element
    document.documentElement.style.setProperty('--font-scale', scale.toString());

    // Save to localStorage
    localStorage.setItem('fontSizeLevel', fontSizeLevel.toString());
  }, [fontSizeLevel]);

  // Chat background color handler
  useEffect(() => {
    if (chatBgColor) {
      document.documentElement.style.setProperty('--bg-chat', chatBgColor);
      localStorage.setItem('chatBgColor', chatBgColor);
    } else {
      document.documentElement.style.removeProperty('--bg-chat');
      localStorage.removeItem('chatBgColor');
    }
  }, [chatBgColor]);

  // User message bubble color handler
  useEffect(() => {
    if (userMsgColor) {
      document.documentElement.style.setProperty('--color-message-user-bg', userMsgColor);
      localStorage.setItem('userMsgColor', userMsgColor);
    } else {
      document.documentElement.style.removeProperty('--color-message-user-bg');
      localStorage.removeItem('userMsgColor');
    }
  }, [userMsgColor]);

  // CoDriver link color handler. Keep this CoDriver-specific so light/dark/system
  // keep their existing color settings and variables untouched.
  useEffect(() => {
    if (linkColor) {
      document.documentElement.style.setProperty('--codriver-custom-link-color', linkColor);
      localStorage.setItem('codriverLinkColor', linkColor);
    } else {
      document.documentElement.style.removeProperty('--codriver-custom-link-color');
      localStorage.removeItem('codriverLinkColor');
    }
  }, [linkColor]);

  // CoDriver inline-code color handler. This intentionally does not write
  // --color-code-inline-* because that would affect non-CoDriver themes.
  useEffect(() => {
    if (codeColor) {
      document.documentElement.style.setProperty('--codriver-custom-code-color', codeColor);
      localStorage.setItem('codriverCodeColor', codeColor);
    } else {
      document.documentElement.style.removeProperty('--codriver-custom-code-color');
      localStorage.removeItem('codriverCodeColor');
    }
  }, [codeColor]);

  // Diff theme handler
  useEffect(() => {
    applyDiffTheme(diffTheme, ideTheme);
  }, [diffTheme, ideTheme, themePreference]);

  return {
    themePreference,
    setThemePreference,
    ideTheme,
    setIdeTheme,
    fontSizeLevel,
    setFontSizeLevel,
    chatBgColor,
    setChatBgColor,
    userMsgColor,
    setUserMsgColor,
    linkColor,
    setLinkColor,
    codeColor,
    setCodeColor,
    diffTheme,
    setDiffTheme,
  };
}
