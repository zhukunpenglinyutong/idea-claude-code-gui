import { useState, useRef, useEffect, useMemo } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { DiffThemeMode } from '../../../utils/diffTheme';
import {
  DEFAULT_CUSTOM_UI_THEME,
  CUSTOM_THEME_PRESETS,
  exportCustomUiTheme,
  importCustomUiTheme,
  isCustomUiThemeColor,
  loadCustomUiTheme,
  normalizeCustomUiTheme,
  notifyCustomUiThemeChanged,
  saveCustomUiTheme,
  type CustomUiTheme,
} from '../../../utils/customUiTheme';
import type { UiFontConfig, CodeFontConfig } from '../hooks/useSettingsBasicActions';
import type { UiThemeStyle } from '../../../utils/uiTheme';

// Preset colors (module-level constants to avoid recreating on each render)
const DARK_PRESETS = [
  { color: '#1e1e1e', label: 'Default' },
  { color: '#1a1b26', label: 'Tokyo Night' },
  { color: '#282c34', label: 'One Dark' },
  { color: '#2b2d30', label: 'JetBrains' },
  { color: '#0d1117', label: 'GitHub Dark' },
  { color: '#171a21', label: 'QQ' },
  { color: '#262335', label: 'SynthWave' },
  { color: '#292d3e', label: 'Palenight' },
];

const LIGHT_PRESETS = [
  { color: '#ffffff', label: 'Default' },
  { color: '#fafafa', label: 'Soft White' },
  { color: '#f5f5f5', label: 'Light Gray' },
  { color: '#faf4ed', label: 'Rose Pine' },
  { color: '#f6f8fa', label: 'GitHub Light' },
  { color: '#fffbf0', label: 'Warm' },
  { color: '#f0f4f8', label: 'Cool Blue' },
  { color: '#f5f0eb', label: 'Solarized' },
];

const DEFAULT_DARK_BG = '#1e1e1e';
const DEFAULT_LIGHT_BG = '#ffffff';

// Shared chat header and status bar color presets
const CHAT_BAR_DARK_PRESETS = [
  { color: '#252526', label: 'Default' },
  { color: '#1e3a5f', label: 'Midnight Blue' },
  { color: '#263f36', label: 'Forest' },
  { color: '#3b3151', label: 'Purple' },
  { color: '#4a3428', label: 'Coffee' },
  { color: '#3f2b36', label: 'Rose' },
  { color: '#243b4a', label: 'Teal' },
  { color: '#3b3b3b', label: 'Graphite' },
];

const CHAT_BAR_LIGHT_PRESETS = [
  { color: '#f3f3f3', label: 'Default' },
  { color: '#e5f0fb', label: 'Sky' },
  { color: '#e5f2e9', label: 'Mint' },
  { color: '#eee8f7', label: 'Lavender' },
  { color: '#f6ebe3', label: 'Warm' },
  { color: '#f7e8ee', label: 'Rose' },
  { color: '#e4f1f3', label: 'Teal' },
  { color: '#e8e8e8', label: 'Graphite' },
];

const DEFAULT_DARK_CHAT_BAR = '#252526';
const DEFAULT_LIGHT_CHAT_BAR = '#f3f3f3';

// User message bubble color presets
const USER_MSG_DARK_PRESETS = [
  { color: '#005fb8', label: 'Default' },
  { color: '#1a7f37', label: 'Green' },
  { color: '#6e40c9', label: 'Purple' },
  { color: '#9a6700', label: 'Amber' },
  { color: '#cf222e', label: 'Red' },
  { color: '#0e6b8a', label: 'Teal' },
  { color: '#6b4c9a', label: 'Violet' },
  { color: '#4a5568', label: 'Gray' },
];

const USER_MSG_LIGHT_PRESETS = [
  { color: '#0078d4', label: 'Default' },
  { color: '#1a7f37', label: 'Green' },
  { color: '#8250df', label: 'Purple' },
  { color: '#bf8700', label: 'Amber' },
  { color: '#cf222e', label: 'Red' },
  { color: '#0e8a9a', label: 'Teal' },
  { color: '#7c5cbf', label: 'Violet' },
  { color: '#57606a', label: 'Gray' },
];

const DEFAULT_DARK_USER_MSG = '#005fb8';
const DEFAULT_LIGHT_USER_MSG = '#0078d4';
const UI_FONT_SELECT_ID = 'settings-ui-font-select';
const UI_FONT_CUSTOM_PATH_ID = 'settings-ui-font-custom-path';
const CODE_FONT_SELECT_ID = 'settings-code-font-select';
const CODE_FONT_CUSTOM_PATH_ID = 'settings-code-font-custom-path';
const FOLLOW_IDEA_LANGUAGE = '__follow_idea__';

const NODE_PATH_SECTION_STYLE: React.CSSProperties = { marginTop: 12 };

function getSwatchStyle(color: string): React.CSSProperties {
  return { backgroundColor: color };
}

const SunIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 17C14.7614 17 17 14.7614 17 12C17 9.23858 14.7614 7 12 7C9.23858 7 7 9.23858 7 12C7 14.7614 9.23858 17 12 17Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 1V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M12 21V23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.22 4.22L5.64 5.64" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18.36 18.36L19.78 19.78" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M1 12H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M21 12H23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M4.22 19.78L5.64 18.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M18.36 5.64L19.78 4.22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const SystemIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/>
    <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const UI_THEME_STYLE_OPTIONS: Array<{
  key: UiThemeStyle;
  icon: string;
}> = [
  { key: 'default', icon: 'codicon-layout' },
  { key: 'lightGlass', icon: 'codicon-circle-large' },
  { key: 'antigravity', icon: 'codicon-compass' },
  { key: 'codebuddy', icon: 'codicon-hubot' },
  { key: 'idea', icon: 'codicon-tools' },
  { key: 'vscode', icon: 'codicon-code' },
  { key: 'qq', icon: 'codicon-comment-discussion' },
  { key: 'wechat', icon: 'codicon-comment' },
  { key: 'notion', icon: 'codicon-book' },
  { key: 'arcGlass', icon: 'codicon-circle-large-filled' },
  { key: 'warp', icon: 'codicon-terminal' },
  { key: 'vercel', icon: 'codicon-cloud' },
  { key: 'claudeWarm', icon: 'codicon-heart-filled' },
  { key: 'solarized', icon: 'codicon-color-mode' },
  { key: 'custom', icon: 'codicon-edit' },
];

const CUSTOM_COLOR_FIELDS: Array<{
  key: keyof CustomUiTheme['colors'];
  labelKey: string;
}> = [
  { key: 'bgPrimary', labelKey: 'bgPrimary' },
  { key: 'bgSecondary', labelKey: 'bgSecondary' },
  { key: 'bgTertiary', labelKey: 'bgTertiary' },
  { key: 'bgElevated', labelKey: 'bgElevated' },
  { key: 'bgHover', labelKey: 'bgHover' },
  { key: 'textPrimary', labelKey: 'textPrimary' },
  { key: 'textSecondary', labelKey: 'textSecondary' },
  { key: 'borderPrimary', labelKey: 'borderPrimary' },
  { key: 'borderSecondary', labelKey: 'borderSecondary' },
  { key: 'accentPrimary', labelKey: 'accentPrimary' },
  { key: 'accentHover', labelKey: 'accentHover' },
  { key: 'userBubble', labelKey: 'userBubble' },
  { key: 'userText', labelKey: 'userText' },
];

export interface AppearanceTabProps {
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  uiThemeStyle?: UiThemeStyle;
  onUiThemeStyleChange?: (style: UiThemeStyle) => void;
  fontSizeLevel: number;
  onFontSizeLevelChange: (level: number) => void;
  editorFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
  };
  uiFontConfig?: UiFontConfig;
  codeFontConfig?: CodeFontConfig;
  onUiFontSelectionChange?: (selection: string) => void;
  onSaveUiFontCustomPath?: (path: string) => void;
  onBrowseUiFontFile?: () => void;
  onCodeFontSelectionChange?: (selection: string) => void;
  onSaveCodeFontCustomPath?: (path: string) => void;
  onBrowseCodeFontFile?: () => void;
  chatBgColor?: string;
  onChatBgColorChange?: (color: string) => void;
  userMsgColor?: string;
  onUserMsgColorChange?: (color: string) => void;
  chatBarColor?: string;
  onChatBarColorChange?: (color: string) => void;
  diffTheme?: DiffThemeMode;
  onDiffThemeChange?: (theme: DiffThemeMode) => void;
}

const AppearanceTab = ({
  theme,
  onThemeChange,
  uiThemeStyle = 'default',
  onUiThemeStyleChange = () => {},
  fontSizeLevel,
  onFontSizeLevelChange,
  editorFontConfig,
  uiFontConfig,
  codeFontConfig,
  onUiFontSelectionChange = () => {},
  onSaveUiFontCustomPath = () => {},
  onBrowseUiFontFile = () => {},
  onCodeFontSelectionChange = () => {},
  onSaveCodeFontCustomPath = () => {},
  onBrowseCodeFontFile = () => {},
  chatBgColor = '',
  onChatBgColorChange = () => {},
  userMsgColor = '',
  onUserMsgColorChange = () => {},
  chatBarColor = '',
  onChatBarColorChange = () => {},
  diffTheme = 'follow',
  onDiffThemeChange = () => {},
}: AppearanceTabProps) => {
  const { t, i18n } = useTranslation();
  const colorInputRef = useRef<HTMLInputElement>(null);
  const userMsgColorInputRef = useRef<HTMLInputElement>(null);
  const chatBarColorInputRef = useRef<HTMLInputElement>(null);
  const [hexInput, setHexInput] = useState(chatBgColor || '');
  const [userMsgHexInput, setUserMsgHexInput] = useState(userMsgColor || '');
  const [chatBarHexInput, setChatBarHexInput] = useState(chatBarColor || '');
  const [customTheme, setCustomTheme] = useState<CustomUiTheme>(() => loadCustomUiTheme());
  const [customColorDrafts, setCustomColorDrafts] = useState<Partial<Record<keyof CustomUiTheme['colors'], string>>>({});
  const [customJson, setCustomJson] = useState(() => exportCustomUiTheme(loadCustomUiTheme()));
  const [customJsonDirty, setCustomJsonDirty] = useState(false);
  const [customMessage, setCustomMessage] = useState('');
  const [selectedUiFontOption, setSelectedUiFontOption] = useState(() => {
    if (!uiFontConfig || uiFontConfig.mode === 'followEditor') return 'followEditor';
    return 'customFile';
  });
  const [customFontPathDraft, setCustomFontPathDraft] = useState(uiFontConfig?.customFontPath || '');
  const [selectedCodeFontOption, setSelectedCodeFontOption] = useState(() => {
    if (!codeFontConfig || codeFontConfig.mode === 'followEditor') return 'followEditor';
    return 'customFile';
  });
  const [customCodeFontPathDraft, setCustomCodeFontPathDraft] = useState(codeFontConfig?.customFontPath || '');
  const [languageSelection, setLanguageSelection] = useState(() => (
    localStorage.getItem('languageSelectionMode') === 'followIdea'
      ? FOLLOW_IDEA_LANGUAGE
      : (i18n.language || 'zh')
  ));

  useEffect(() => {
    setHexInput(chatBgColor || '');
  }, [chatBgColor]);

  useEffect(() => {
    setUserMsgHexInput(userMsgColor || '');
  }, [userMsgColor]);

  useEffect(() => {
    setChatBarHexInput(chatBarColor || '');
  }, [chatBarColor]);

  const updateCustomTheme = (updater: (current: CustomUiTheme) => CustomUiTheme) => {
    setCustomTheme((current) => {
      const next = normalizeCustomUiTheme(updater(current), current);
      saveCustomUiTheme(next);
      if (!customJsonDirty) {
        setCustomJson(exportCustomUiTheme(next));
      }
      notifyCustomUiThemeChanged();
      return next;
    });
  };

  useEffect(() => {
    if (!uiFontConfig || uiFontConfig.mode === 'followEditor') {
      setSelectedUiFontOption('followEditor');
    } else {
      setSelectedUiFontOption('customFile');
    }
    setCustomFontPathDraft(uiFontConfig?.customFontPath || '');
  }, [uiFontConfig]);

  useEffect(() => {
    if (!codeFontConfig || codeFontConfig.mode === 'followEditor') {
      setSelectedCodeFontOption('followEditor');
    } else {
      setSelectedCodeFontOption('customFile');
    }
    setCustomCodeFontPathDraft(codeFontConfig?.customFontPath || '');
  }, [codeFontConfig]);

  useEffect(() => {
    const resync = () => {
      setLanguageSelection(
        localStorage.getItem('languageSelectionMode') === 'followIdea'
          ? FOLLOW_IDEA_LANGUAGE
          : (i18n.language || 'zh')
      );
    };
    resync();
    window.addEventListener('language-config-applied', resync);
    return () => window.removeEventListener('language-config-applied', resync);
  }, [i18n.language]);

  const resolvedTheme = useMemo(() => {
    if (theme !== 'system') return theme;
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'dark';
  }, [theme]);

  const defaultBgColor = resolvedTheme === 'light' ? DEFAULT_LIGHT_BG : DEFAULT_DARK_BG;
  const presets = resolvedTheme === 'light' ? LIGHT_PRESETS : DARK_PRESETS;

  const defaultUserMsgColor = resolvedTheme === 'light' ? DEFAULT_LIGHT_USER_MSG : DEFAULT_DARK_USER_MSG;
  const userMsgPresets = resolvedTheme === 'light' ? USER_MSG_LIGHT_PRESETS : USER_MSG_DARK_PRESETS;

  const defaultChatBarColor = resolvedTheme === 'light' ? DEFAULT_LIGHT_CHAT_BAR : DEFAULT_DARK_CHAT_BAR;
  const chatBarPresets = resolvedTheme === 'light' ? CHAT_BAR_LIGHT_PRESETS : CHAT_BAR_DARK_PRESETS;

  const handlePresetClick = (color: string) => {
    if (color === defaultBgColor) {
      onChatBgColorChange('');
    } else {
      onChatBgColorChange(color);
    }
  };

  const handleColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChatBgColorChange(e.target.value);
  };

  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onChatBgColorChange(value);
    }
  };

  const handleResetBgColor = () => {
    onChatBgColorChange('');
  };

  const handleUserMsgPresetClick = (color: string) => {
    if (color === defaultUserMsgColor) {
      onUserMsgColorChange('');
    } else {
      onUserMsgColorChange(color);
    }
  };

  const handleUserMsgColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onUserMsgColorChange(e.target.value);
  };

  const handleUserMsgHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setUserMsgHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onUserMsgColorChange(value);
    }
  };

  const handleResetUserMsgColor = () => {
    onUserMsgColorChange('');
  };

  const handleChatBarPresetClick = (color: string) => {
    onChatBarColorChange(color === defaultChatBarColor ? '' : color);
  };

  const handleChatBarColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChatBarColorChange(e.target.value);
  };

  const handleChatBarHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setChatBarHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onChatBarColorChange(value);
    }
  };

  const handleResetChatBarColor = () => {
    onChatBarColorChange('');
  };

  const isUserMsgPresetActive = (presetColor: string) => {
    if (presetColor === defaultUserMsgColor && !userMsgColor) return true;
    return userMsgColor.toLowerCase() === presetColor.toLowerCase();
  };

  const isPresetActive = (presetColor: string) => {
    if (presetColor === defaultBgColor && !chatBgColor) return true;
    return chatBgColor.toLowerCase() === presetColor.toLowerCase();
  };

  const isChatBarPresetActive = (presetColor: string) => {
    if (presetColor === defaultChatBarColor && !chatBarColor) return true;
    return chatBarColor.toLowerCase() === presetColor.toLowerCase();
  };

  const hasSavedCustomFont = Boolean(uiFontConfig?.customFontPath);
  const isCustomUiFontSelected = selectedUiFontOption === 'customFile';
  const isCustomPathEmpty = customFontPathDraft.trim().length === 0;
  const currentUiFontDisplayName = uiFontConfig?.displayName || editorFontConfig?.fontFamily || '-';
  const customFontFileName = uiFontConfig?.customFontPath
    ? uiFontConfig.customFontPath.split(/[\\/]/).pop()
    : '';
  const localizedUiFontWarning = uiFontConfig?.warningCode === 'fontUnavailable'
      ? t('settings.basic.editorFont.warningUnavailable')
      : uiFontConfig?.warning;
  const uiFontHint = localizedUiFontWarning
    || (uiFontConfig?.effectiveMode === 'customFile'
      ? t('settings.basic.editorFont.statusCustom', { font: currentUiFontDisplayName })
      : t('settings.basic.editorFont.statusFollowEditor', {
        font: uiFontConfig?.fontFamily || currentUiFontDisplayName,
      }));

  const hasSavedCustomCodeFont = Boolean(codeFontConfig?.customFontPath);
  const isCustomCodeFontSelected = selectedCodeFontOption === 'customFile';
  const isCustomCodePathEmpty = customCodeFontPathDraft.trim().length === 0;
  const currentCodeFontDisplayName = codeFontConfig?.displayName || editorFontConfig?.fontFamily || '-';
  const customCodeFontFileName = codeFontConfig?.customFontPath
    ? codeFontConfig.customFontPath.split(/[\\/]/).pop()
    : '';
  const localizedCodeFontWarning = codeFontConfig?.warningCode === 'fontUnavailable'
    ? t('settings.basic.codeFont.warningUnavailable')
    : codeFontConfig?.warning;
  const codeFontHint = localizedCodeFontWarning
    || (codeFontConfig?.effectiveMode === 'customFile'
      ? t('settings.basic.codeFont.statusCustom', { font: currentCodeFontDisplayName })
      : t('settings.basic.codeFont.statusFollowEditor', {
        font: editorFontConfig?.fontFamily || currentCodeFontDisplayName,
      }));

  const diffThemeOptions: Array<{ value: DiffThemeMode; label: string; desc: string }> = [
    {
      value: 'follow',
      label: t('settings.basic.diffTheme.follow'),
      desc: t('settings.basic.diffTheme.followDesc'),
    },
    {
      value: 'editor',
      label: t('settings.basic.diffTheme.editor'),
      desc: t('settings.basic.diffTheme.editorDesc'),
    },
    {
      value: 'light',
      label: t('settings.basic.diffTheme.light'),
      desc: t('settings.basic.diffTheme.lightDesc'),
    },
    {
      value: 'soft-dark',
      label: t('settings.basic.diffTheme.softDark'),
      desc: t('settings.basic.diffTheme.softDarkDesc'),
    },
  ];

  const languageOptions = [
    { value: FOLLOW_IDEA_LANGUAGE, label: 'settings.basic.language.followIde' },
    { value: 'zh', label: 'settings.basic.language.simplifiedChinese' },
    { value: 'zh-TW', label: 'settings.basic.language.traditionalChinese' },
    { value: 'en', label: 'settings.basic.language.english' },
    { value: 'hi', label: 'settings.basic.language.hindi' },
    { value: 'es', label: 'settings.basic.language.spanish' },
    { value: 'fr', label: 'settings.basic.language.french' },
    { value: 'ja', label: 'settings.basic.language.japanese' },
    { value: 'ru', label: 'settings.basic.language.russian' },
    { value: 'ko', label: 'settings.basic.language.korean' },
    { value: 'pt-BR', label: 'settings.basic.language.portuguese' },
  ];

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const language = event.target.value;
    // Optimistic UI update. Java owns the persisted config and pushes the
    // authoritative state back via applyIdeaLanguageConfig, which is the
    // single writer for localStorage language keys.
    setLanguageSelection(language);

    if (language === FOLLOW_IDEA_LANGUAGE) {
      if (window.sendToJava) {
        window.sendToJava('clear_user_language:');
      }
      return;
    }

    i18n.changeLanguage(language);
    if (window.sendToJava) {
      window.sendToJava(`set_user_language:${JSON.stringify({ language })}`);
    }
  };

  const handleUiFontSelectionChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextSelection = event.target.value;
    setSelectedUiFontOption(nextSelection);

    if (nextSelection === 'customFile') {
      // Only notify backend when a custom font path was previously saved;
      // otherwise the user must first enter/browse a path and click Save.
      if (hasSavedCustomFont) {
        onUiFontSelectionChange(nextSelection);
      }
      return;
    }

    onUiFontSelectionChange(nextSelection);
  };

  const handleSaveCustomUiFontPath = () => {
    onSaveUiFontCustomPath(customFontPathDraft.trim());
  };

  return (
    <div className={styles.tabContent}>
      {/* UI Theme Style selector */}
      <div className={styles.themeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-paintcan" />
          <span className={styles.fieldLabel}>{t('settings.basic.uiStyle.label')}</span>
        </div>
        <select
          data-testid="settings-ui-style-select"
          className={styles.languageSelect}
          value={uiThemeStyle}
          onChange={(e) => {
            onUiThemeStyleChange(e.target.value as UiThemeStyle);
          }}
        >
          {UI_THEME_STYLE_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {t(`settings.basic.uiStyle.${opt.key}`)} {t(`settings.basic.uiStyle.${opt.key}Desc`, '') ? `(${t(`settings.basic.uiStyle.${opt.key}Desc`)})` : ''}
            </option>
          ))}
        </select>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t(`settings.basic.uiStyle.${uiThemeStyle}Desc`, '')}</span>
        </small>
      </div>

      {/* Custom theme editor */}
      {uiThemeStyle === 'custom' && (
        <div className={styles.themeSection}>
          <div className={styles.fieldHeader}>
            <span className="codicon codicon-edit" />
            <span className={styles.fieldLabel}>{t('settings.basic.customTheme.label')}</span>
          </div>

          {/* Quick Preset Templates */}
          <div className={styles.customPresetSection}>
            <span className={styles.customPresetLabel}>{t('settings.basic.customTheme.presetTemplates')}</span>
            <div className={styles.customPresetButtons}>
              {CUSTOM_THEME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`${styles.customPresetBtn} ${customTheme.name === preset.theme.name ? styles.active : ''}`}
                  onClick={() => {
                    setCustomTheme(preset.theme);
                    setCustomColorDrafts({});
                    setCustomJson(exportCustomUiTheme(preset.theme));
                    setCustomJsonDirty(false);
                    saveCustomUiTheme(preset.theme);
                    notifyCustomUiThemeChanged();
                    setCustomMessage(t('settings.basic.customTheme.presetApplied', { name: t(`settings.basic.customTheme.presets.${preset.nameKey}`) }));
                  }}
                  title={t(`settings.basic.customTheme.presets.${preset.nameKey}`)}
                >
                  <span
                    className={styles.customPresetDot}
                    style={{ backgroundColor: preset.theme.colors.accentPrimary }}
                  />
                  {t(`settings.basic.customTheme.presets.${preset.nameKey}`)}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.customThemeToolbar}>
            <input
              className={styles.languageSelect}
              value={customTheme.name}
              placeholder={t('settings.basic.customTheme.namePlaceholder')}
              onChange={(event) => updateCustomTheme(current => ({ ...current, name: event.target.value }))}
            />
            <select
              className={styles.languageSelect}
              value={customTheme.mode}
              onChange={(event) => updateCustomTheme(current => ({ ...current, mode: event.target.value as 'dark' | 'light' }))}
            >
              <option value="dark">{t('settings.basic.theme.dark')}</option>
              <option value="light">{t('settings.basic.theme.light')}</option>
            </select>
          </div>

          <div className={styles.customColorGrid}>
            {CUSTOM_COLOR_FIELDS.map(({ key, labelKey }) => (
              <div key={key} className={styles.customColorField}>
                <span className={styles.customColorFieldName}>{t(`settings.basic.customTheme.${labelKey}`)}</span>
                <div className={styles.customColorInputGroup}>
                  <label className={styles.colorPickerWrapper}>
                    <span
                      className={styles.colorPickerPreview}
                      style={{ backgroundColor: customTheme.colors[key] }}
                    />
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(customTheme.colors[key]) ? customTheme.colors[key] : '#000000'}
                      onChange={(event) => {
                        setCustomColorDrafts(current => {
                          const next = { ...current };
                          delete next[key];
                          return next;
                        });
                        updateCustomTheme(current => ({
                          ...current,
                          colors: { ...current.colors, [key]: event.target.value },
                        }));
                      }}
                    />
                  </label>
                  <input
                    type="text"
                    className={styles.customHexInput}
                    value={customColorDrafts[key] ?? customTheme.colors[key] ?? ''}
                    placeholder="#000000"
                    onChange={(event) => {
                      const val = event.target.value;
                      setCustomColorDrafts(current => ({ ...current, [key]: val }));
                      if (isCustomUiThemeColor(val)) {
                        setCustomMessage('');
                        updateCustomTheme(current => ({
                          ...current,
                          colors: { ...current.colors, [key]: val },
                        }));
                      }
                    }}
                    onBlur={(event) => {
                      const value = event.target.value;
                      if (!isCustomUiThemeColor(value)) {
                        setCustomMessage(t('settings.basic.customTheme.invalidColor'));
                      }
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className={styles.customSliderRow}>
            <label>{t('settings.basic.customTheme.radius')}</label>
            <input type="range" min="0" max="2" step="0.1" value={customTheme.radiusScale}
              onChange={(event) => updateCustomTheme(current => ({ ...current, radiusScale: Number(event.target.value) }))} />
            <span>{customTheme.radiusScale.toFixed(1)}×</span>
          </div>

          <div className={styles.customSliderRow}>
            <label>{t('settings.basic.customTheme.glass')}</label>
            <input type="range" min="0" max="100" step="5" value={customTheme.glassStrength}
              onChange={(event) => updateCustomTheme(current => ({ ...current, glassStrength: Number(event.target.value) }))} />
            <span>{customTheme.glassStrength}%</span>
          </div>

          <textarea
            className={`${styles.languageSelect} ${styles.customJsonEditor}`}
            value={customJson}
            onChange={(event) => {
              setCustomJson(event.target.value);
              setCustomJsonDirty(true);
            }}
            spellCheck={false}
          />

          <div className={styles.customThemeActions}>
            <button type="button" onClick={() => {
              try {
                const imported = importCustomUiTheme(customJson);
                saveCustomUiTheme(imported);
                setCustomTheme(imported);
                setCustomColorDrafts({});
                setCustomJsonDirty(false);
                notifyCustomUiThemeChanged();
                setCustomMessage(t('settings.basic.customTheme.imported'));
              } catch {
                setCustomMessage(t('settings.basic.customTheme.invalid'));
              }
            }}>{t('settings.basic.customTheme.import')}</button>
            <button type="button" onClick={() => {
              navigator.clipboard?.writeText(exportCustomUiTheme(customTheme));
              setCustomMessage(t('settings.basic.customTheme.exported'));
            }}>{t('settings.basic.customTheme.export')}</button>
            <button type="button" onClick={() => {
              saveCustomUiTheme(DEFAULT_CUSTOM_UI_THEME);
              setCustomTheme(DEFAULT_CUSTOM_UI_THEME);
              setCustomColorDrafts({});
              setCustomJson(exportCustomUiTheme(DEFAULT_CUSTOM_UI_THEME));
              setCustomJsonDirty(false);
              notifyCustomUiThemeChanged();
              setCustomMessage('');
            }}>{t('settings.basic.customTheme.reset')}</button>
          </div>
          {customMessage && <small className={styles.formHint}>{customMessage}</small>}
        </div>
      )}

      {/* Light / Dark Mode switcher */}
      <div className={styles.themeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-color" />
          <span className={styles.fieldLabel}>{t('settings.basic.theme.label')}</span>
        </div>

        <div className={styles.themeSelector}>
          <div
            className={`${styles.themeOption} ${theme === 'system' ? styles.active : ''}`}
            onClick={() => onThemeChange('system')}
          >
            <div className={styles.themeIconSystem}>
              <SystemIcon />
            </div>
            <span className={styles.themeOptionLabel}>{t('settings.basic.theme.system')}</span>
          </div>

          <div
            className={`${styles.themeOption} ${theme === 'light' ? styles.active : ''}`}
            onClick={() => onThemeChange('light')}
          >
            <div className={styles.themeIconLight}>
              <SunIcon />
            </div>
            <span className={styles.themeOptionLabel}>{t('settings.basic.theme.light')}</span>
          </div>

          <div
            className={`${styles.themeOption} ${theme === 'dark' ? styles.active : ''}`}
            onClick={() => onThemeChange('dark')}
          >
            <div className={styles.themeIconDark}>
              <MoonIcon />
            </div>
            <span className={styles.themeOptionLabel}>{t('settings.basic.theme.dark')}</span>
          </div>
        </div>
      </div>

      {/* Language switcher */}
      <div className={styles.languageSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-globe" />
          <span className={styles.fieldLabel}>{t('settings.basic.language.label')}</span>
        </div>
        <select
          data-testid="settings-language-select"
          className={styles.languageSelect}
          value={languageSelection}
          onChange={handleLanguageChange}
        >
          {languageOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </div>

      {/* Font size selector */}
      <div className={styles.fontSizeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-text-size" />
          <span className={styles.fieldLabel}>{t('settings.basic.fontSize.label')}</span>
        </div>
        <select
          className={styles.fontSizeSelect}
          value={fontSizeLevel}
          onChange={(e) => onFontSizeLevelChange(Number(e.target.value))}
        >
          <option value={1}>{t('settings.basic.fontSize.level1')}</option>
          <option value={2}>{t('settings.basic.fontSize.level2')}</option>
          <option value={3}>{t('settings.basic.fontSize.level3')}</option>
          <option value={4}>{t('settings.basic.fontSize.level4')}</option>
          <option value={5}>{t('settings.basic.fontSize.level5')}</option>
          <option value={6}>{t('settings.basic.fontSize.level6')}</option>
        </select>
      </div>

      {/* UI font selector */}
      <div className={styles.editorFontSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-text" />
          <label className={styles.fieldLabel} htmlFor={UI_FONT_SELECT_ID}>
            {t('settings.basic.editorFont.label')}
          </label>
        </div>
        <select
          id={UI_FONT_SELECT_ID}
          aria-label={t('settings.basic.editorFont.label')}
          className={styles.languageSelect}
          value={selectedUiFontOption}
          onChange={handleUiFontSelectionChange}
        >
          <option value="followEditor">
            {t('settings.basic.editorFont.followOption', { font: uiFontConfig?.fontFamily || '-' })}
          </option>
          <option value="customFile">
            {customFontFileName
              ? `${t('settings.basic.editorFont.customOption')} / ${customFontFileName}`
              : t('settings.basic.editorFont.customOption')}
          </option>
        </select>

        {isCustomUiFontSelected && (
          <div className={styles.nodePathSection} style={NODE_PATH_SECTION_STYLE}>
            <div className={styles.fieldHeader}>
              <span className="codicon codicon-file-media" />
              <label className={styles.fieldLabel} htmlFor={UI_FONT_CUSTOM_PATH_ID}>
                {t('settings.basic.editorFont.customPathLabel')}
              </label>
            </div>
            <div className={styles.nodePathInputWrapper}>
              <input
                id={UI_FONT_CUSTOM_PATH_ID}
                type="text"
                className={styles.nodePathInput}
                placeholder={t('settings.basic.editorFont.customPathPlaceholder')}
                value={customFontPathDraft}
                onChange={(event) => setCustomFontPathDraft(event.target.value)}
              />
              <button
                type="button"
                className={styles.saveBtn}
                onClick={onBrowseUiFontFile}
                aria-label={t('settings.basic.editorFont.browse')}
                title={t('settings.basic.editorFont.browse')}
              >
                <span className="codicon codicon-folder-opened" />
              </button>
              <button
                type="button"
                className={styles.saveBtn}
                onClick={handleSaveCustomUiFontPath}
                disabled={isCustomPathEmpty}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        )}

        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{uiFontHint}</span>
        </small>
      </div>

      {/* Code font selector */}
      <div className={styles.editorFontSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-code" />
          <label className={styles.fieldLabel} htmlFor={CODE_FONT_SELECT_ID}>
            {t('settings.basic.codeFont.label')}
          </label>
        </div>
        <select
          id={CODE_FONT_SELECT_ID}
          aria-label={t('settings.basic.codeFont.label')}
          className={styles.languageSelect}
          value={selectedCodeFontOption}
          onChange={(event) => {
            const nextSelection = event.target.value;
            setSelectedCodeFontOption(nextSelection);

            if (nextSelection === 'customFile' && hasSavedCustomCodeFont) {
              onCodeFontSelectionChange(nextSelection);
              return;
            }

            if (nextSelection === 'followEditor') {
              onCodeFontSelectionChange(nextSelection);
            }
          }}
        >
          <option value="followEditor">
            {t('settings.basic.codeFont.followOption', { font: editorFontConfig?.fontFamily || '-' })}
          </option>
          <option value="customFile">
            {customCodeFontFileName
              ? `${t('settings.basic.codeFont.customOption')} / ${customCodeFontFileName}`
              : t('settings.basic.codeFont.customOption')}
          </option>
        </select>

        {isCustomCodeFontSelected && (
          <div className={styles.nodePathSection} style={NODE_PATH_SECTION_STYLE}>
            <div className={styles.fieldHeader}>
              <span className="codicon codicon-file-media" />
              <label className={styles.fieldLabel} htmlFor={CODE_FONT_CUSTOM_PATH_ID}>
                {t('settings.basic.codeFont.customPathLabel')}
              </label>
            </div>
            <div className={styles.nodePathInputWrapper}>
              <input
                id={CODE_FONT_CUSTOM_PATH_ID}
                type="text"
                className={styles.nodePathInput}
                placeholder={t('settings.basic.codeFont.customPathPlaceholder')}
                value={customCodeFontPathDraft}
                onChange={(event) => setCustomCodeFontPathDraft(event.target.value)}
              />
              <button
                type="button"
                className={styles.saveBtn}
                onClick={onBrowseCodeFontFile}
                aria-label={t('settings.basic.codeFont.browse')}
                title={t('settings.basic.codeFont.browse')}
              >
                <span className="codicon codicon-folder-opened" />
              </button>
              <button
                type="button"
                className={styles.saveBtn}
                onClick={() => onSaveCodeFontCustomPath(customCodeFontPathDraft.trim())}
                disabled={isCustomCodePathEmpty}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        )}

        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{codeFontHint}</span>
        </small>
      </div>

      {/* Diff theme */}
      <div className={styles.themeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-diff" />
          <span className={styles.fieldLabel}>{t('settings.basic.diffTheme.label')}</span>
        </div>

        <select
          className={styles.languageSelect}
          value={diffTheme}
          onChange={(e) => onDiffThemeChange(e.target.value as DiffThemeMode)}
        >
          {diffThemeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} — {option.desc}
            </option>
          ))}
        </select>
      </div>

      {/* Standalone color overrides (only shown for preset themes) */}
      {uiThemeStyle !== 'custom' && (
        <>
          {/* Chat background color */}
          <div className={styles.bgColorSection}>
            <div className={styles.fieldHeader}>
              <span className="codicon codicon-paintcan" />
              <span className={styles.fieldLabel}>{t('settings.basic.chatBgColor.label')}</span>
            </div>

            <div className={styles.colorPresets}>
              {presets.map((preset) => (
                <div
                  key={preset.color}
                  className={`${styles.colorSwatch} ${isPresetActive(preset.color) ? styles.active : ''}`}
                  onClick={() => handlePresetClick(preset.color)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handlePresetClick(preset.color);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title={preset.label}
                  aria-label={preset.label}
                >
                  <div
                    className={styles.colorSwatchInner}
                    style={getSwatchStyle(preset.color)}
                  />
                </div>
              ))}
            </div>

            <div className={styles.customColorRow}>
              <span className={styles.customColorLabel}>{t('settings.basic.chatBgColor.custom')}</span>
              <div
                className={styles.colorPickerWrapper}
                onClick={() => colorInputRef.current?.click()}
              >
                <div
                  className={styles.colorPickerPreview}
                  style={getSwatchStyle(chatBgColor || '')}
                />
                <input
                  ref={colorInputRef}
                  type="color"
                  className={styles.colorPickerInput}
                  value={chatBgColor || '#ffffff'}
                  onChange={handleColorInputChange}
                />
              </div>
              <input
                type="text"
                className={styles.hexInput}
                value={hexInput}
                onChange={handleHexInputChange}
                placeholder="#000000"
                maxLength={7}
              />
              {chatBgColor && (
                <button
                  className={styles.resetBtn}
                  onClick={handleResetBgColor}
                  title={t('settings.basic.chatBgColor.reset')}
                >
                  <span className="codicon codicon-discard" />
                  {t('settings.basic.chatBgColor.reset')}
                </button>
              )}
            </div>

            <small className={styles.formHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.basic.chatBgColor.hint')}</span>
            </small>
          </div>

          {/* Shared chat header and status bar color */}
          <div className={styles.bgColorSection}>
            <div className={styles.fieldHeader}>
              <span className="codicon codicon-layout" />
              <span className={styles.fieldLabel}>{t('settings.basic.chatBarColor.label')}</span>
            </div>

            <div className={styles.colorPresets}>
              {chatBarPresets.map((preset) => (
                <div
                  key={preset.color}
                  className={`${styles.colorSwatch} ${isChatBarPresetActive(preset.color) ? styles.active : ''}`}
                  onClick={() => handleChatBarPresetClick(preset.color)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleChatBarPresetClick(preset.color);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title={preset.label}
                  aria-label={preset.label}
                >
                  <div
                    className={styles.colorSwatchInner}
                    style={getSwatchStyle(preset.color)}
                  />
                </div>
              ))}
            </div>

            <div className={styles.customColorRow}>
              <span className={styles.customColorLabel}>{t('settings.basic.chatBarColor.custom')}</span>
              <div
                className={styles.colorPickerWrapper}
                onClick={() => chatBarColorInputRef.current?.click()}
              >
                <div
                  className={styles.colorPickerPreview}
                  style={getSwatchStyle(chatBarColor || defaultChatBarColor)}
                />
                <input
                  ref={chatBarColorInputRef}
                  type="color"
                  className={styles.colorPickerInput}
                  value={chatBarColor || defaultChatBarColor}
                  onChange={handleChatBarColorInputChange}
                />
              </div>
              <input
                type="text"
                className={styles.hexInput}
                value={chatBarHexInput}
                onChange={handleChatBarHexInputChange}
                placeholder="#000000"
                maxLength={7}
              />
              {chatBarColor && (
                <button
                  className={styles.resetBtn}
                  onClick={handleResetChatBarColor}
                  title={t('settings.basic.chatBarColor.reset')}
                >
                  <span className="codicon codicon-discard" />
                  {t('settings.basic.chatBarColor.reset')}
                </button>
              )}
            </div>

            <small className={styles.formHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.basic.chatBarColor.hint')}</span>
            </small>
          </div>

          {/* User message bubble color */}
          <div className={styles.bgColorSection}>
            <div className={styles.fieldHeader}>
              <span className="codicon codicon-comment" />
              <span className={styles.fieldLabel}>{t('settings.basic.userMsgColor.label')}</span>
            </div>

            <div className={styles.colorPresets}>
              {userMsgPresets.map((preset) => (
                <div
                  key={preset.color}
                  className={`${styles.colorSwatch} ${isUserMsgPresetActive(preset.color) ? styles.active : ''}`}
                  onClick={() => handleUserMsgPresetClick(preset.color)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleUserMsgPresetClick(preset.color);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title={preset.label}
                  aria-label={preset.label}
                >
                  <div
                    className={styles.colorSwatchInner}
                    style={getSwatchStyle(preset.color)}
                  />
                </div>
              ))}
            </div>

            <div className={styles.customColorRow}>
              <span className={styles.customColorLabel}>{t('settings.basic.userMsgColor.custom')}</span>
              <div
                className={styles.colorPickerWrapper}
                onClick={() => userMsgColorInputRef.current?.click()}
              >
                <div
                  className={styles.colorPickerPreview}
                  style={getSwatchStyle(userMsgColor || defaultUserMsgColor)}
                />
                <input
                  ref={userMsgColorInputRef}
                  type="color"
                  className={styles.colorPickerInput}
                  value={userMsgColor || defaultUserMsgColor}
                  onChange={handleUserMsgColorInputChange}
                />
              </div>
              <input
                type="text"
                className={styles.hexInput}
                value={userMsgHexInput}
                onChange={handleUserMsgHexInputChange}
                placeholder="#000000"
                maxLength={7}
              />
              {userMsgColor && (
                <button
                  className={styles.resetBtn}
                  onClick={handleResetUserMsgColor}
                  title={t('settings.basic.userMsgColor.reset')}
                >
                  <span className="codicon codicon-discard" />
                  {t('settings.basic.userMsgColor.reset')}
                </button>
              )}
            </div>

            <small className={styles.formHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.basic.userMsgColor.hint')}</span>
            </small>
          </div>
        </>
      )}
    </div>
  );
};

export default AppearanceTab;
