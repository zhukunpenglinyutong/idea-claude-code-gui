export interface CustomUiThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgElevated: string;
  bgHover: string;
  textPrimary: string;
  textSecondary: string;
  borderPrimary: string;
  borderSecondary: string;
  accentPrimary: string;
  accentHover: string;
  userBubble: string;
  userText: string;
}

export interface CustomUiTheme {
  version: 1;
  name: string;
  mode: 'dark' | 'light';
  colors: CustomUiThemeColors;
  radiusScale: number;
  glassStrength: number;
}

export const CUSTOM_UI_THEME_STORAGE_KEY = 'customUiTheme';
export const CUSTOM_UI_THEME_CHANGED_EVENT = 'custom-ui-theme-changed';

const CUSTOM_UI_THEME_CSS_PROPERTIES = [
  '--bg-primary',
  '--bg-chat',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-elevated',
  '--bg-hover',
  '--text-primary',
  '--text-secondary',
  '--border-primary',
  '--border-secondary',
  '--accent-primary',
  '--accent-primary-hover',
  '--color-message-user-bg',
  '--color-message-user-text',
  '--color-chat-bars-bg',
  '--color-chat-bars-hover-bg',
  '--color-chat-bars-active-bg',
  '--color-chat-bars-border',
  '--color-chat-bars-text',
  '--color-chat-bars-muted-text',
  '--custom-radius-scale',
  '--custom-glass-strength',
] as const;

const COLOR_PATTERN = /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{6})|rgba?\(\s*(?:\d{1,3}\s*,\s*){2,3}\d*(?:\.\d+)?\s*\)|hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+)\s*)?\))$/i;

export interface CustomUiThemePreset {
  id: string;
  nameKey: string;
  theme: CustomUiTheme;
}

export const CUSTOM_THEME_PRESETS: CustomUiThemePreset[] = [
  {
    id: 'nebula-glow',
    nameKey: 'nebulaGlow',
    theme: {
      version: 1,
      name: 'Nebula Glow',
      mode: 'dark',
      colors: {
        bgPrimary: '#12131a',
        bgSecondary: '#1a1c26',
        bgTertiary: '#232634',
        bgElevated: '#202330',
        bgHover: '#2d3142',
        textPrimary: '#f0f2f8',
        textSecondary: '#9ca3b8',
        borderPrimary: '#2a2e3d',
        borderSecondary: '#383d52',
        accentPrimary: '#6366f1',
        accentHover: '#818cf8',
        userBubble: '#4f46e5',
        userText: '#ffffff',
      },
      radiusScale: 1.1,
      glassStrength: 35,
    },
  },
  {
    id: 'frosted-glass',
    nameKey: 'frostedGlass',
    theme: {
      version: 1,
      name: 'Frosted Glass',
      mode: 'dark',
      colors: {
        bgPrimary: '#141721',
        bgSecondary: '#1c202e',
        bgTertiary: '#252a3d',
        bgElevated: '#212638',
        bgHover: '#2d334a',
        textPrimary: '#f0f4fc',
        textSecondary: '#94a3b8',
        borderPrimary: '#2d344b',
        borderSecondary: '#3d4766',
        accentPrimary: '#38bdf8',
        accentHover: '#7dd3fc',
        userBubble: '#0284c7',
        userText: '#ffffff',
      },
      radiusScale: 1.2,
      glassStrength: 60,
    },
  },
  {
    id: 'deep-ocean',
    nameKey: 'deepOcean',
    theme: {
      version: 1,
      name: 'Deep Ocean',
      mode: 'dark',
      colors: {
        bgPrimary: '#0b1320',
        bgSecondary: '#111c2e',
        bgTertiary: '#192841',
        bgElevated: '#152238',
        bgHover: '#203352',
        textPrimary: '#e6f1ff',
        textSecondary: '#8892b0',
        borderPrimary: '#1f3354',
        borderSecondary: '#2b446e',
        accentPrimary: '#00b4d8',
        accentHover: '#48cae4',
        userBubble: '#0077b6',
        userText: '#ffffff',
      },
      radiusScale: 1.0,
      glassStrength: 30,
    },
  },
  {
    id: 'sunset-amber',
    nameKey: 'sunsetAmber',
    theme: {
      version: 1,
      name: 'Sunset Amber',
      mode: 'dark',
      colors: {
        bgPrimary: '#1a1512',
        bgSecondary: '#241e1a',
        bgTertiary: '#302823',
        bgElevated: '#2b231e',
        bgHover: '#3d342d',
        textPrimary: '#f8ede3',
        textSecondary: '#b8a99a',
        borderPrimary: '#3d322b',
        borderSecondary: '#52433a',
        accentPrimary: '#f97316',
        accentHover: '#fb923c',
        userBubble: '#ea580c',
        userText: '#ffffff',
      },
      radiusScale: 1.1,
      glassStrength: 35,
    },
  },
  {
    id: 'forest-emerald',
    nameKey: 'forestEmerald',
    theme: {
      version: 1,
      name: 'Forest Emerald',
      mode: 'dark',
      colors: {
        bgPrimary: '#0d1612',
        bgSecondary: '#14201b',
        bgTertiary: '#1c2d26',
        bgElevated: '#172721',
        bgHover: '#233830',
        textPrimary: '#e8f5e9',
        textSecondary: '#81c784',
        borderPrimary: '#22382e',
        borderSecondary: '#2e4c3e',
        accentPrimary: '#10b981',
        accentHover: '#34d399',
        userBubble: '#059669',
        userText: '#ffffff',
      },
      radiusScale: 1.0,
      glassStrength: 25,
    },
  },
  {
    id: 'porcelain-light',
    nameKey: 'porcelainLight',
    theme: {
      version: 1,
      name: 'Porcelain Light',
      mode: 'light',
      colors: {
        bgPrimary: '#f8fafc',
        bgSecondary: '#ffffff',
        bgTertiary: '#f1f5f9',
        bgElevated: '#ffffff',
        bgHover: '#e2e8f0',
        textPrimary: '#0f172a',
        textSecondary: '#475569',
        borderPrimary: '#e2e8f0',
        borderSecondary: '#cbd5e1',
        accentPrimary: '#2563eb',
        accentHover: '#1d4ed8',
        userBubble: '#2563eb',
        userText: '#ffffff',
      },
      radiusScale: 1.0,
      glassStrength: 20,
    },
  },
];

export const DEFAULT_CUSTOM_UI_THEME: CustomUiTheme = CUSTOM_THEME_PRESETS[0].theme;

export function isCustomUiThemeColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_PATTERN.test(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function normalizeCustomUiTheme(
  input: unknown,
  fallbackTheme: CustomUiTheme = DEFAULT_CUSTOM_UI_THEME,
): CustomUiTheme {
  const source = input && typeof input === 'object' ? input as Partial<CustomUiTheme> : {};
  const rawColors = source.colors && typeof source.colors === 'object' ? source.colors as Partial<CustomUiThemeColors> : {};
  const fallback = fallbackTheme.colors;
  const color = (value: unknown, key: keyof CustomUiThemeColors): string => (
    isCustomUiThemeColor(value) ? value : fallback[key]
  );

  return {
    version: 1,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 40) : fallbackTheme.name,
    mode: source.mode === 'light' ? 'light' : 'dark',
    colors: {
      bgPrimary: color(rawColors.bgPrimary, 'bgPrimary'),
      bgSecondary: color(rawColors.bgSecondary, 'bgSecondary'),
      bgTertiary: color(rawColors.bgTertiary, 'bgTertiary'),
      bgElevated: color(rawColors.bgElevated, 'bgElevated'),
      bgHover: color(rawColors.bgHover, 'bgHover'),
      textPrimary: color(rawColors.textPrimary, 'textPrimary'),
      textSecondary: color(rawColors.textSecondary, 'textSecondary'),
      borderPrimary: color(rawColors.borderPrimary, 'borderPrimary'),
      borderSecondary: color(rawColors.borderSecondary, 'borderSecondary'),
      accentPrimary: color(rawColors.accentPrimary, 'accentPrimary'),
      accentHover: color(rawColors.accentHover, 'accentHover'),
      userBubble: color(rawColors.userBubble, 'userBubble'),
      userText: color(rawColors.userText, 'userText'),
    },
    radiusScale: clampNumber(source.radiusScale, 0, 2, fallbackTheme.radiusScale),
    glassStrength: clampNumber(source.glassStrength, 0, 100, fallbackTheme.glassStrength),
  };
}

export function loadCustomUiTheme(): CustomUiTheme {
  try {
    const saved = localStorage.getItem(CUSTOM_UI_THEME_STORAGE_KEY);
    return saved ? normalizeCustomUiTheme(JSON.parse(saved)) : DEFAULT_CUSTOM_UI_THEME;
  } catch {
    return DEFAULT_CUSTOM_UI_THEME;
  }
}

export function saveCustomUiTheme(theme: CustomUiTheme): void {
  try {
    localStorage.setItem(CUSTOM_UI_THEME_STORAGE_KEY, JSON.stringify(normalizeCustomUiTheme(theme)));
  } catch {
    // Ignore storage failures.
  }
}

export function notifyCustomUiThemeChanged(): void {
  window.dispatchEvent(new Event(CUSTOM_UI_THEME_CHANGED_EVENT));
}

export function exportCustomUiTheme(theme: CustomUiTheme): string {
  return JSON.stringify(normalizeCustomUiTheme(theme), null, 2);
}

export function importCustomUiTheme(json: string): CustomUiTheme {
  return normalizeCustomUiTheme(JSON.parse(json));
}

export function applyCustomUiTheme(theme: CustomUiTheme): void {
  const root = document.documentElement;
  const normalized = normalizeCustomUiTheme(theme);
  root.setAttribute('data-theme', normalized.mode);

  const properties: Array<[string, string]> = [
    ['--bg-primary', normalized.colors.bgPrimary],
    ['--bg-chat', normalized.colors.bgPrimary],
    ['--bg-secondary', normalized.colors.bgSecondary],
    ['--bg-tertiary', normalized.colors.bgTertiary],
    ['--bg-elevated', normalized.colors.bgElevated],
    ['--bg-hover', normalized.colors.bgHover],
    ['--text-primary', normalized.colors.textPrimary],
    ['--text-secondary', normalized.colors.textSecondary],
    ['--border-primary', normalized.colors.borderPrimary],
    ['--border-secondary', normalized.colors.borderSecondary],
    ['--accent-primary', normalized.colors.accentPrimary],
    ['--accent-primary-hover', normalized.colors.accentHover],
    ['--color-message-user-bg', normalized.colors.userBubble],
    ['--color-message-user-text', normalized.colors.userText],
    ['--color-chat-bars-bg', normalized.colors.bgSecondary],
    ['--color-chat-bars-hover-bg', normalized.colors.bgHover],
    ['--color-chat-bars-active-bg', normalized.colors.bgTertiary],
    ['--color-chat-bars-border', normalized.colors.borderPrimary],
    ['--color-chat-bars-text', normalized.colors.textPrimary],
    ['--color-chat-bars-muted-text', normalized.colors.textSecondary],
    ['--custom-radius-scale', String(normalized.radiusScale)],
    ['--custom-glass-strength', String(normalized.glassStrength / 100)],
  ];
  properties.forEach(([name, value]) => root.style.setProperty(name, value));
}

export function clearCustomUiThemeProperties(): void {
  const root = document.documentElement;
  CUSTOM_UI_THEME_CSS_PROPERTIES.forEach(name => root.style.removeProperty(name));
  const savedTheme = localStorage.getItem('theme') || 'system';
  if (savedTheme === 'system') {
    const ideTheme = (typeof window !== 'undefined' && window.__INITIAL_IDE_THEME__) || 'dark';
    root.setAttribute('data-theme', ideTheme);
  } else {
    root.setAttribute('data-theme', savedTheme);
  }
}
