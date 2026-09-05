// hooks/useSettingsThemeSync.ts
import { useState, useEffect, useRef } from 'react';
import { applyDiffTheme, getStoredDiffTheme, type DiffThemeMode } from '../../../utils/diffTheme';
import {
  applyChatBarThemeColor,
  CHAT_BAR_COLOR_STORAGE_KEY,
  isValidHexColor,
} from '../../../utils/chatBarTheme';
import {
  applyUiThemeStyle,
  getSavedUiThemeStyle,
  type UiThemeStyle,
} from '../../../utils/uiTheme';
import {
  applyCustomUiTheme,
  clearCustomUiThemeProperties,
  CUSTOM_UI_THEME_CHANGED_EVENT,
  loadCustomUiTheme,
} from '../../../utils/customUiTheme';

// Extend window type for IDE theme injection
declare global {
  interface Window {
    __INITIAL_IDE_THEME__?: 'light' | 'dark';
  }
}

export interface UseSettingsThemeSyncReturn {
  themePreference: 'light' | 'dark' | 'system';
  setThemePreference: (theme: 'light' | 'dark' | 'system') => void;
  uiThemeStyle: UiThemeStyle;
  setUiThemeStyle: (style: UiThemeStyle) => void;
  ideTheme: 'light' | 'dark' | null;
  setIdeTheme: (theme: 'light' | 'dark' | null) => void;
  fontSizeLevel: number;
  setFontSizeLevel: (level: number) => void;
  chatBgColor: string;
  setChatBgColor: (color: string) => void;
  userMsgColor: string;
  setUserMsgColor: (color: string) => void;
  chatBarColor: string;
  setChatBarColor: (color: string) => void;
  diffTheme: DiffThemeMode;
  setDiffTheme: (theme: DiffThemeMode) => void;
}

export function useSettingsThemeSync(): UseSettingsThemeSyncReturn {
  const [themePreference, setThemePreference] = useState<'light' | 'dark' | 'system'>(() => {
    // Read theme preference from localStorage
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
      return savedTheme;
    }
    return 'system'; // Default: follow IDE
  });

  // IDE theme state (prefer Java-injected initial theme, used to handle dynamic changes)
  const [ideTheme, setIdeTheme] = useState<'light' | 'dark' | null>(() => {
    // Check if Java has injected the initial theme
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

  // Shared chat header and status bar color configuration
  const [chatBarColor, setChatBarColor] = useState<string>(() => {
    const saved = localStorage.getItem(CHAT_BAR_COLOR_STORAGE_KEY);
    return saved && isValidHexColor(saved) ? saved : '';
  });

  // Diff theme configuration
  const [diffTheme, setDiffTheme] = useState<DiffThemeMode>(() => getStoredDiffTheme());

  // UI theme style (default / lightGlass / antigravity / codebuddy / etc.)
  const [uiThemeStyle, setUiThemeStyle] = useState<UiThemeStyle>(() => getSavedUiThemeStyle());

  const [customUiTheme, setCustomUiTheme] = useState(() => loadCustomUiTheme());
  const previousUiThemeStyle = useRef<UiThemeStyle | null>(null);

  useEffect(() => {
    const handleCustomUiThemeChanged = () => {
      setCustomUiTheme(loadCustomUiTheme());
    };

    window.addEventListener(CUSTOM_UI_THEME_CHANGED_EVENT, handleCustomUiThemeChanged);
    return () => window.removeEventListener(CUSTOM_UI_THEME_CHANGED_EVENT, handleCustomUiThemeChanged);
  }, []);

  // UI Theme Style handler
  useEffect(() => {
    applyUiThemeStyle(uiThemeStyle);
    if (uiThemeStyle === 'custom') {
      // applyCustomUiTheme already overwrites all six --color-chat-bars-* vars,
      // so no chat bar color clear is needed here.
      applyCustomUiTheme(customUiTheme);
    } else {
      if (previousUiThemeStyle.current === 'custom') {
        clearCustomUiThemeProperties();
      }

      // The default style is intentionally inert: its stylesheet and the
      // user's existing color preferences remain the source of truth.
      if (uiThemeStyle !== 'default') {
        if (chatBgColor) {
          document.documentElement.style.setProperty('--bg-chat', chatBgColor);
        } else {
          document.documentElement.style.removeProperty('--bg-chat');
        }
        if (userMsgColor) {
          document.documentElement.style.setProperty('--color-message-user-bg', userMsgColor);
        } else {
          document.documentElement.style.removeProperty('--color-message-user-bg');
        }
        applyChatBarThemeColor(chatBarColor);
      }
    }
    previousUiThemeStyle.current = uiThemeStyle;
  }, [uiThemeStyle, customUiTheme, chatBgColor, userMsgColor, chatBarColor]);

  // Theme switching handler (supports following IDE theme)
  useEffect(() => {
    const applyTheme = (preference: 'light' | 'dark' | 'system') => {
      if (uiThemeStyle === 'custom') {
        return;
      }
      if (preference === 'system') {
        // If following IDE, need to wait for IDE theme to load
        if (ideTheme === null) {
          return; // Wait for ideTheme to load
        }
        document.documentElement.setAttribute('data-theme', ideTheme);
      } else {
        // Explicit light/dark selection, apply immediately
        document.documentElement.setAttribute('data-theme', preference);
      }
    };

    applyTheme(themePreference);
    // Save to localStorage
    localStorage.setItem('theme', themePreference);
  }, [themePreference, ideTheme, uiThemeStyle]);

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

  // Chat background color handler.
  useEffect(() => {
    if (chatBgColor) {
      if (uiThemeStyle !== 'custom') {
        document.documentElement.style.setProperty('--bg-chat', chatBgColor);
      }
      localStorage.setItem('chatBgColor', chatBgColor);
    } else {
      if (uiThemeStyle !== 'custom') {
        document.documentElement.style.removeProperty('--bg-chat');
      }
      localStorage.removeItem('chatBgColor');
    }
  }, [chatBgColor, uiThemeStyle]);

  // User message bubble color handler
  useEffect(() => {
    if (userMsgColor) {
      if (uiThemeStyle !== 'custom') {
        document.documentElement.style.setProperty('--color-message-user-bg', userMsgColor);
      }
      localStorage.setItem('userMsgColor', userMsgColor);
    } else {
      if (uiThemeStyle !== 'custom') {
        document.documentElement.style.removeProperty('--color-message-user-bg');
      }
      localStorage.removeItem('userMsgColor');
    }
  }, [userMsgColor, uiThemeStyle]);

  // Shared chat header and status bar color handler
  useEffect(() => {
    if (uiThemeStyle !== 'custom') {
      applyChatBarThemeColor(chatBarColor);
    }
    if (isValidHexColor(chatBarColor)) {
      localStorage.setItem(CHAT_BAR_COLOR_STORAGE_KEY, chatBarColor);
    } else {
      localStorage.removeItem(CHAT_BAR_COLOR_STORAGE_KEY);
    }
  }, [chatBarColor, uiThemeStyle]);

  // Diff theme handler
  useEffect(() => {
    applyDiffTheme(diffTheme, ideTheme);
  }, [diffTheme, ideTheme, themePreference]);

  return {
    themePreference,
    setThemePreference,
    uiThemeStyle,
    setUiThemeStyle,
    ideTheme,
    setIdeTheme,
    fontSizeLevel,
    setFontSizeLevel,
    chatBgColor,
    setChatBgColor,
    userMsgColor,
    setUserMsgColor,
    chatBarColor,
    setChatBarColor,
    diffTheme,
    setDiffTheme,
  };
}
