const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const CHAT_BACKGROUND_PROPERTIES = [
  '--bg-chat',
  '--codriver-canvas',
  '--codriver-chat-surface',
  '--codriver-shell-bg',
  '--codriver-transcript-bg',
] as const;

const USER_MESSAGE_PROPERTIES = [
  '--color-message-user-bg',
  '--codriver-user',
  '--codriver-user-message-bg',
] as const;

function setOrRemoveProperties(root: HTMLElement, names: readonly string[], value: string): void {
  for (const name of names) {
    if (value) {
      root.style.setProperty(name, value);
    } else {
      root.style.removeProperty(name);
    }
  }
}

export function isValidHexColor(value: string | null): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value);
}

export function normalizeHexColor(value: string | null): string {
  return isValidHexColor(value) ? value : '';
}

export function applyChatBackgroundColor(value: string): void {
  setOrRemoveProperties(document.documentElement, CHAT_BACKGROUND_PROPERTIES, normalizeHexColor(value));
}

export function applyUserMessageColor(value: string): void {
  setOrRemoveProperties(document.documentElement, USER_MESSAGE_PROPERTIES, normalizeHexColor(value));
}
