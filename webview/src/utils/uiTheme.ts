export type UiThemeStyle =
  | 'default'
  | 'lightGlass'
  | 'antigravity'
  | 'codebuddy'
  | 'idea'
  | 'vscode'
  | 'qq'
  | 'wechat'
  | 'notion'
  | 'arcGlass'
  | 'warp'
  | 'vercel'
  | 'claudeWarm'
  | 'solarized'
  | 'custom';

export const UI_THEME_STORAGE_KEY = 'uiThemeStyle';

export const VALID_UI_THEME_STYLES: UiThemeStyle[] = [
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

/**
 * Get the saved UI theme style from localStorage, defaulting to 'default'.
 */
export function getSavedUiThemeStyle(): UiThemeStyle {
  try {
    const saved = localStorage.getItem(UI_THEME_STORAGE_KEY);
    if (saved && VALID_UI_THEME_STYLES.includes(saved as UiThemeStyle)) {
      return saved as UiThemeStyle;
    }
  } catch {
    // Ignore localStorage access errors
  }
  return 'default';
}

/**
 * Apply the UI theme style to document.documentElement.
 */
export function applyUiThemeStyle(style: UiThemeStyle): void {
  const targetStyle = VALID_UI_THEME_STYLES.includes(style) ? style : 'default';
  document.documentElement.setAttribute('data-ui-theme', targetStyle);
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, targetStyle);
  } catch {
    // Ignore localStorage access errors
  }
}
