import { useState, useRef, useEffect, useMemo } from 'react';
import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { DiffThemeMode } from '../../../utils/diffTheme';
import type { UiThemeMode } from '../../../types/uiThemeMode';
import type { UiFontConfig, CodeFontConfig } from '../hooks/useSettingsBasicActions';

// Preset colors (module-level constants to avoid recreating on each render)
const DARK_PRESETS = [
  { color: '#1e1e1e', label: 'Default' },
  { color: '#1a1b26', label: 'Tokyo Night' },
  { color: '#282c34', label: 'One Dark' },
  { color: '#2b2d30', label: 'JetBrains' },
  { color: '#0d1117', label: 'GitHub Dark' },
  { color: '#1e1f29', label: 'Dracula' },
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
const DEFAULT_CODRIVER_DARK_BG = '#191a1c';
const DEFAULT_CODRIVER_LIGHT_BG = '#ffffff';

const CODRIVER_DARK_PRESETS = [
  { color: DEFAULT_CODRIVER_DARK_BG, label: 'CoDriver Default' },
  { color: '#202123', label: 'JetBrains Panel' },
  { color: '#1f1f1f', label: 'IDE Surface' },
  { color: '#242628', label: 'Soft Dark' },
  { color: '#0d1117', label: 'GitHub Dark' },
  { color: '#22272e', label: 'GitHub Dimmed' },
  { color: '#2b2d30', label: 'Raised Panel' },
  { color: '#111827', label: 'Deep Neutral' },
];

const CODRIVER_LIGHT_PRESETS = [
  { color: DEFAULT_CODRIVER_LIGHT_BG, label: 'CoDriver Default' },
  { color: '#f7f8fa', label: 'Soft White' },
  { color: '#f6f8fa', label: 'GitHub Light' },
  { color: '#f3f4f6', label: 'IDE Panel' },
  { color: '#eef2f7', label: 'Cool Gray' },
  { color: '#fffaf0', label: 'Warm White' },
  { color: '#f5f7fb', label: 'Blue White' },
  { color: '#fbfbfc', label: 'Quiet White' },
];

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
const DEFAULT_CODRIVER_DARK_USER_MSG = '#264f78';
const DEFAULT_CODRIVER_LIGHT_USER_MSG = '#d4e2ff';

const CODRIVER_USER_MSG_DARK_PRESETS = [
  { color: DEFAULT_CODRIVER_DARK_USER_MSG, label: 'CoDriver Default' },
  { color: '#2f5f8f', label: 'Softer Blue' },
  { color: '#1f6feb', label: 'GitHub Blue' },
  { color: '#2563a6', label: 'Workbench Blue' },
  { color: '#1a7f37', label: 'Context Green' },
  { color: '#6e40c9', label: 'Agent Purple' },
  { color: '#4a5568', label: 'Neutral' },
  { color: '#0e6b8a', label: 'Teal' },
];

const CODRIVER_USER_MSG_LIGHT_PRESETS = [
  { color: DEFAULT_CODRIVER_LIGHT_USER_MSG, label: 'CoDriver Default' },
  { color: '#cfe1ff', label: 'Soft Blue' },
  { color: '#e8f1ff', label: 'Very Light Blue' },
  { color: '#dbeafe', label: 'Workbench Blue' },
  { color: '#dafbe1', label: 'Context Green' },
  { color: '#efe7ff', label: 'Agent Purple' },
  { color: '#f2f4f8', label: 'Neutral' },
  { color: '#e0f2fe', label: 'Teal' },
];

const DEFAULT_CODRIVER_DARK_LINK = '#4daafc';
const DEFAULT_CODRIVER_LIGHT_LINK = '#196bc5';
const CODRIVER_LINK_DARK_PRESETS = [
  { color: DEFAULT_CODRIVER_DARK_LINK, label: 'CoDriver Default' },
  { color: '#526cab', label: 'Muted VS Code' },
  { color: '#58a6ff', label: 'GitHub Blue' },
  { color: '#79c0ff', label: 'Bright Blue' },
  { color: '#2f81f7', label: 'Accent Blue' },
  { color: '#4ea1ff', label: 'IDE Link' },
  { color: '#6cb6ff', label: 'Soft Link' },
  { color: '#94c2ff', label: 'Subtle Link' },
];
const CODRIVER_LINK_LIGHT_PRESETS = [
  { color: DEFAULT_CODRIVER_LIGHT_LINK, label: 'CoDriver Default' },
  { color: '#0969da', label: 'GitHub Blue' },
  { color: '#0550ae', label: 'VS Code Blue' },
  { color: '#0a66c2', label: 'IDE Link' },
  { color: '#2563eb', label: 'Accent Blue' },
  { color: '#0366d6', label: 'Classic Blue' },
  { color: '#1d4ed8', label: 'Deep Blue' },
  { color: '#3b82f6', label: 'Soft Blue' },
];

const DEFAULT_CODRIVER_DARK_CODE = '#d7ba7d';
const DEFAULT_CODRIVER_LIGHT_CODE = '#cf222e';
const CODRIVER_CODE_DARK_PRESETS = [
  { color: DEFAULT_CODRIVER_DARK_CODE, label: 'CoDriver Default' },
  { color: '#d6b975', label: 'Muted Amber' },
  { color: '#e3c16f', label: 'Warm Amber' },
  { color: '#f0c674', label: 'Classic Yellow' },
  { color: '#c9a86a', label: 'Subtle Gold' },
  { color: '#ffd166', label: 'Bright Gold' },
  { color: '#f2cc60', label: 'VS Code Yellow' },
  { color: '#e5c07b', label: 'One Dark' },
];
const CODRIVER_CODE_LIGHT_PRESETS = [
  { color: DEFAULT_CODRIVER_LIGHT_CODE, label: 'CoDriver Default' },
  { color: '#a31515', label: 'JetBrains Red' },
  { color: '#b31d28', label: 'GitHub Red' },
  { color: '#c2410c', label: 'Orange Red' },
  { color: '#953800', label: 'Brown' },
  { color: '#8250df', label: 'Purple' },
  { color: '#0550ae', label: 'Blue' },
  { color: '#116329', label: 'Green' },
];
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

const CoDriverIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 3.75C7.44 3.75 3.75 7.44 3.75 12S7.44 20.25 12 20.25 20.25 16.56 20.25 12 16.56 3.75 12 3.75Z" stroke="currentColor" strokeWidth="1.8"/>
    <path d="M8.2 12.1c.7-1.35 1.95-2.15 3.8-2.15s3.1.8 3.8 2.15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    <path d="M7.7 13.9c.95 1.25 2.38 1.9 4.3 1.9s3.35-.65 4.3-1.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
);

export interface AppearanceTabProps {
  theme: UiThemeMode;
  onThemeChange: (theme: UiThemeMode) => void;
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
  linkColor?: string;
  onLinkColorChange?: (color: string) => void;
  codeColor?: string;
  onCodeColorChange?: (color: string) => void;
  diffTheme?: DiffThemeMode;
  onDiffThemeChange?: (theme: DiffThemeMode) => void;
  coDriverToolIconEnabled?: boolean;
  onCoDriverToolIconEnabledChange?: (enabled: boolean) => void;
}

const AppearanceTab = ({
  theme,
  onThemeChange,
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
  linkColor = '',
  onLinkColorChange = () => {},
  codeColor = '',
  onCodeColorChange = () => {},
  diffTheme = 'follow',
  onDiffThemeChange = () => {},
  coDriverToolIconEnabled = true,
  onCoDriverToolIconEnabledChange = () => {},
}: AppearanceTabProps) => {
  const { t, i18n } = useTranslation();
  const colorInputRef = useRef<HTMLInputElement>(null);
  const userMsgColorInputRef = useRef<HTMLInputElement>(null);
  const linkColorInputRef = useRef<HTMLInputElement>(null);
  const codeColorInputRef = useRef<HTMLInputElement>(null);
  const [hexInput, setHexInput] = useState(chatBgColor || '');
  const [userMsgHexInput, setUserMsgHexInput] = useState(userMsgColor || '');
  const [linkHexInput, setLinkHexInput] = useState(linkColor || '');
  const [codeHexInput, setCodeHexInput] = useState(codeColor || '');
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
    setLinkHexInput(linkColor || '');
  }, [linkColor]);

  useEffect(() => {
    setCodeHexInput(codeColor || '');
  }, [codeColor]);

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
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark' | 'codriver') || 'dark';
  }, [theme]);
  const isCoDriverTheme = resolvedTheme === 'codriver';
  const coDriverPaletteTheme = (document.documentElement.getAttribute('data-ide-theme') === 'light')
    ? 'light'
    : 'dark';
  const paletteTheme = isCoDriverTheme ? coDriverPaletteTheme : resolvedTheme;

  const defaultBgColor = isCoDriverTheme
    ? (coDriverPaletteTheme === 'light' ? DEFAULT_CODRIVER_LIGHT_BG : DEFAULT_CODRIVER_DARK_BG)
    : (paletteTheme === 'light' ? DEFAULT_LIGHT_BG : DEFAULT_DARK_BG);
  const presets = isCoDriverTheme
    ? (coDriverPaletteTheme === 'light' ? CODRIVER_LIGHT_PRESETS : CODRIVER_DARK_PRESETS)
    : (paletteTheme === 'light' ? LIGHT_PRESETS : DARK_PRESETS);

  const defaultUserMsgColor = isCoDriverTheme
    ? (coDriverPaletteTheme === 'light' ? DEFAULT_CODRIVER_LIGHT_USER_MSG : DEFAULT_CODRIVER_DARK_USER_MSG)
    : (paletteTheme === 'light' ? DEFAULT_LIGHT_USER_MSG : DEFAULT_DARK_USER_MSG);
  const userMsgPresets = isCoDriverTheme
    ? (coDriverPaletteTheme === 'light' ? CODRIVER_USER_MSG_LIGHT_PRESETS : CODRIVER_USER_MSG_DARK_PRESETS)
    : (paletteTheme === 'light' ? USER_MSG_LIGHT_PRESETS : USER_MSG_DARK_PRESETS);

  const defaultLinkColor = coDriverPaletteTheme === 'light' ? DEFAULT_CODRIVER_LIGHT_LINK : DEFAULT_CODRIVER_DARK_LINK;
  const linkPresets = coDriverPaletteTheme === 'light' ? CODRIVER_LINK_LIGHT_PRESETS : CODRIVER_LINK_DARK_PRESETS;
  const defaultCodeColor = coDriverPaletteTheme === 'light' ? DEFAULT_CODRIVER_LIGHT_CODE : DEFAULT_CODRIVER_DARK_CODE;
  const codePresets = coDriverPaletteTheme === 'light' ? CODRIVER_CODE_LIGHT_PRESETS : CODRIVER_CODE_DARK_PRESETS;

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

  const handleLinkPresetClick = (color: string) => {
    if (color === defaultLinkColor) {
      onLinkColorChange('');
    } else {
      onLinkColorChange(color);
    }
  };

  const handleLinkColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onLinkColorChange(e.target.value);
  };

  const handleLinkHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setLinkHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onLinkColorChange(value);
    }
  };

  const handleResetLinkColor = () => {
    onLinkColorChange('');
  };

  const handleCodePresetClick = (color: string) => {
    if (color === defaultCodeColor) {
      onCodeColorChange('');
    } else {
      onCodeColorChange(color);
    }
  };

  const handleCodeColorInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onCodeColorChange(e.target.value);
  };

  const handleCodeHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCodeHexInput(value);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onCodeColorChange(value);
    }
  };

  const handleResetCodeColor = () => {
    onCodeColorChange('');
  };

  const isUserMsgPresetActive = (presetColor: string) => {
    if (presetColor === defaultUserMsgColor && !userMsgColor) return true;
    return userMsgColor.toLowerCase() === presetColor.toLowerCase();
  };

  const isPresetActive = (presetColor: string) => {
    if (presetColor === defaultBgColor && !chatBgColor) return true;
    return chatBgColor.toLowerCase() === presetColor.toLowerCase();
  };

  const isLinkPresetActive = (presetColor: string) => {
    if (presetColor === defaultLinkColor && !linkColor) return true;
    return linkColor.toLowerCase() === presetColor.toLowerCase();
  };

  const isCodePresetActive = (presetColor: string) => {
    if (presetColor === defaultCodeColor && !codeColor) return true;
    return codeColor.toLowerCase() === presetColor.toLowerCase();
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

  const renderCoDriverColorChooser = ({
    icon,
    label,
    customLabel,
    hint,
    presets: colorPresets,
    isActive,
    onPresetClick,
    inputRef,
    color,
    defaultColor,
    onColorInputChange,
    hexValue,
    onHexInputChange,
    onReset,
  }: {
    icon: string;
    label: string;
    customLabel: string;
    hint: string;
    presets: Array<{ color: string; label: string }>;
    isActive: (color: string) => boolean;
    onPresetClick: (color: string) => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
    color: string;
    defaultColor: string;
    onColorInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    hexValue: string;
    onHexInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onReset: () => void;
  }) => (
    <div className={styles.bgColorSection}>
      <div className={styles.fieldHeader}>
        <span className={`codicon ${icon}`} />
        <span className={styles.fieldLabel}>{label}</span>
      </div>

      <div className={styles.colorPresets}>
        {colorPresets.map((preset) => (
          <div
            key={preset.color}
            className={`${styles.colorSwatch} ${isActive(preset.color) ? styles.active : ''}`}
            onClick={() => onPresetClick(preset.color)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPresetClick(preset.color);
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
        <span className={styles.customColorLabel}>{customLabel}</span>
        <div
          className={styles.colorPickerWrapper}
          onClick={() => inputRef.current?.click()}
        >
          <div
            className={styles.colorPickerPreview}
            style={getSwatchStyle(color || defaultColor)}
          />
          <input
            ref={inputRef}
            type="color"
            className={styles.colorPickerInput}
            value={color || defaultColor}
            onChange={onColorInputChange}
          />
        </div>
        <input
          type="text"
          className={styles.hexInput}
          value={hexValue}
          onChange={onHexInputChange}
          placeholder="#000000"
          maxLength={7}
        />
        {color && (
          <button
            className={styles.resetBtn}
            onClick={onReset}
            title={t('common.reset', 'Reset')}
          >
            <span className="codicon codicon-discard" />
            {t('common.reset', 'Reset')}
          </button>
        )}
      </div>

      <small className={styles.formHint}>
        <span className="codicon codicon-info" />
        <span>{hint}</span>
      </small>
    </div>
  );

  return (
    <div className={styles.tabContent}>
      {/* Theme switcher */}
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
            className={`${styles.themeOption} ${theme === 'codriver' ? styles.active : ''}`}
            onClick={() => onThemeChange('codriver')}
          >
            <div className={styles.themeIconSystem}>
              <CoDriverIcon />
            </div>
            <span className={styles.themeOptionLabel}>{t('settings.basic.theme.codriver', 'CoDriver')}</span>
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

        {theme === 'codriver' && (
          <div className={styles.coDriverToolIconSection}>
            <label className={styles.toggleWrapper}>
              <input
                type="checkbox"
                className={styles.toggleInput}
                checked={coDriverToolIconEnabled}
                onChange={(event) => onCoDriverToolIconEnabledChange(event.target.checked)}
              />
              <span className={styles.toggleSlider} />
              <span className={styles.toggleLabel}>
                {coDriverToolIconEnabled
                  ? t('settings.basic.coDriverToolIcon.enabled', 'Use monochrome CoDriver tool icon')
                  : t('settings.basic.coDriverToolIcon.disabled', 'Use original orange tool icon')}
              </span>
            </label>
            <small className={styles.formHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.basic.coDriverToolIcon.hint', 'Switches the IntelliJ tool-window stripe icon between the original orange icon and the monochrome CoDriver icon.')}</span>
            </small>
          </div>
        )}
      </div>

      {/* Language switcher */}
      <div className={styles.languageSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-globe" />
          <span className={styles.fieldLabel}>{t('settings.basic.language.label')}</span>
        </div>
        <select
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

        {isCoDriverTheme && renderCoDriverColorChooser({
          icon: 'codicon-link',
          label: t('settings.basic.linkColor.label', 'Link Color'),
          customLabel: t('settings.basic.linkColor.custom', 'Custom'),
          hint: t('settings.basic.linkColor.hint', 'Customize CoDriver file, directory, and markdown link color. Leave empty to use the CoDriver default.'),
          presets: linkPresets,
          isActive: isLinkPresetActive,
          onPresetClick: handleLinkPresetClick,
          inputRef: linkColorInputRef,
          color: linkColor,
          defaultColor: defaultLinkColor,
          onColorInputChange: handleLinkColorInputChange,
          hexValue: linkHexInput,
          onHexInputChange: handleLinkHexInputChange,
          onReset: handleResetLinkColor,
        })}
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

        {isCoDriverTheme && renderCoDriverColorChooser({
          icon: 'codicon-code',
          label: t('settings.basic.codeColor.label', 'Code Font Color'),
          customLabel: t('settings.basic.codeColor.custom', 'Custom'),
          hint: t('settings.basic.codeColor.hint', 'Customize CoDriver inline-code color. Dark mode defaults to amber; light mode defaults to red.'),
          presets: codePresets,
          isActive: isCodePresetActive,
          onPresetClick: handleCodePresetClick,
          inputRef: codeColorInputRef,
          color: codeColor,
          defaultColor: defaultCodeColor,
          onColorInputChange: handleCodeColorInputChange,
          hexValue: codeHexInput,
          onHexInputChange: handleCodeHexInputChange,
          onReset: handleResetCodeColor,
        })}
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
              style={getSwatchStyle(chatBgColor || defaultBgColor)}
            />
            <input
              ref={colorInputRef}
              type="color"
              className={styles.colorPickerInput}
              value={chatBgColor || defaultBgColor}
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
    </div>
  );
};

export default AppearanceTab;
