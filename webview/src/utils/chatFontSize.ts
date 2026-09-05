/**
 * Chat content font size.
 *
 * The value is persisted on the Java side (application-level PropertiesComponent)
 * and pushed to the webview via `window.updateChatFontSize`, so every project
 * window shares one setting instead of racing on per-webview localStorage.
 *
 * "followEditor" keeps the legacy behavior: chat text uses the IDEA editor font
 * size (`--idea-editor-font-size`). A numeric value overrides the base size of
 * the chat content with an absolute px value via `--cc-gui-chat-font-size`.
 */
export const CHAT_FONT_SIZE_FOLLOW_EDITOR = 'followEditor';
export const CHAT_FONT_SIZE_CSS_VARIABLE = '--cc-gui-chat-font-size';

export const CHAT_FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18, 20] as const;

export type ChatFontSizeValue = typeof CHAT_FONT_SIZE_FOLLOW_EDITOR | `${(typeof CHAT_FONT_SIZE_OPTIONS)[number]}`;

export function isValidChatFontSize(value: string): value is ChatFontSizeValue {
  if (value === CHAT_FONT_SIZE_FOLLOW_EDITOR) {
    return true;
  }
  return CHAT_FONT_SIZE_OPTIONS.some((option) => String(option) === value);
}

/**
 * Apply a `window.updateChatFontSize` payload (`{"chatFontSize":"followEditor"}`
 * or `{"chatFontSize":"13"}`) to the document root. Returns the normalized
 * value, or null when the payload is invalid/missing.
 */
export function applyChatFontSizeJson(json: string | undefined | null): ChatFontSizeValue | null {
  if (!json) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as { chatFontSize?: unknown } | null;
  } catch (error) {
    console.error('[ChatFontSize] Failed to parse chat font size config:', error, json);
    return null;
  }
  const raw = typeof value === 'object' && value !== null ? (value as { chatFontSize?: unknown }).chatFontSize : value;
  if (typeof raw !== 'string' || !isValidChatFontSize(raw)) {
    return null;
  }
  applyChatFontSize(raw);
  return raw;
}

export function applyChatFontSize(size: ChatFontSizeValue): void {
  const root = document.documentElement;
  if (size === CHAT_FONT_SIZE_FOLLOW_EDITOR) {
    root.style.removeProperty(CHAT_FONT_SIZE_CSS_VARIABLE);
    return;
  }
  root.style.setProperty(CHAT_FONT_SIZE_CSS_VARIABLE, `${size}px`);
}
