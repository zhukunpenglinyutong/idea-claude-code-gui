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
 * Maps built-in Claude model ids to their mapping key. Models not listed here
 * (e.g. Fable) fall back to `mapping.main`.
 */
const MODEL_KEY_MAP: Record<string, keyof ClaudeModelMapping> = {
  'claude-fable-5-1': 'fable',
  'claude-fable-5': 'fable',
  'claude-sonnet-5': 'sonnet',
  'claude-sonnet-4-7': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-5': 'opus',
  'claude-opus-4-8': 'opus',
  'claude-haiku-4-5': 'haiku',
};

/**
 * Apply the Claude model mapping to a built-in model entry: keeps its id
 * (unique key — the CLI resolves it to the real model via settings), but
 * rewrites the label to the user's configured real model name (e.g. GLM-5.2).
 * Mirrors ButtonArea's applyModelMapping, extracted for reuse by the Commit AI
 * settings panel so both surfaces show the same model list.
 */
export function applyClaudeModelMapping<T extends { id: string; label: string }>(
  model: T,
  mapping: ClaudeModelMapping,
): T {
  const key = MODEL_KEY_MAP[model.id];
  const resolvedMapping = (key ? mapping[key] : undefined) || mapping.main;
  if (resolvedMapping) {
    const actualModel = String(resolvedMapping).trim();
    if (actualModel.length > 0) {
      // Keep the original id as the unique identifier; only change the label.
      return { ...model, label: actualModel };
    }
  }
  return model;
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
