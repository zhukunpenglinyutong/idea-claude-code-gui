import { STORAGE_KEYS } from '../types/provider';

/**
 * Claude model mapping configuration.
 */
export interface ClaudeModelMapping {
  main?: string;
  fable?: string;
  haiku?: string;
  sonnet?: string;
  opus?: string;
  [key: string]: string | undefined;
}

/**
 * Read the Claude model mapping.
 */
export function readClaudeModelMapping(): ClaudeModelMapping {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);
    if (!stored) {
      return {};
    }
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? parsed as ClaudeModelMapping : {};
  } catch {
    return {};
  }
}

/**
 * Check whether the mapping contains at least one valid model value.
 */
function hasMappingValue(mapping: ClaudeModelMapping): boolean {
  return Object.values(mapping).some(value => value && value.trim().length > 0);
}

/**
 * Write the Claude model mapping and proactively notify listeners in the same tab to refresh.
 */
export function writeClaudeModelMapping(mapping: ClaudeModelMapping): void {
  try {
    if (hasMappingValue(mapping)) {
      localStorage.setItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING, JSON.stringify(mapping));
    } else {
      localStorage.removeItem(STORAGE_KEYS.CLAUDE_MODEL_MAPPING);
    }

    // localStorage writes in the same tab do not trigger the native storage event, so dispatch one manually here.
    window.dispatchEvent(new CustomEvent('localStorageChange', {
      detail: { key: STORAGE_KEYS.CLAUDE_MODEL_MAPPING },
    }));
  } catch {
    // Gracefully degrade when localStorage is unavailable or the write fails
  }
}
