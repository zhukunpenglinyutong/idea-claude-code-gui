/**
 * Provider configuration type definitions
 */

// ============ Constants ============

/**
 * Special pseudo provider IDs (not stored in config.json providers list)
 * These represent special operational modes, not actual provider configurations.
 */
export const SPECIAL_PROVIDER_IDS = {
  /** Disabled state - no active provider */
  DISABLED: '__disabled__',
  /** Local ~/.claude/settings.json mode */
  LOCAL_SETTINGS: '__local_settings_json__',
  /** CLI login authentication mode */
  CLI_LOGIN: '__cli_login__',
  /** Codex CLI login authentication mode */
  CODEX_CLI_LOGIN: '__codex_cli_login__',
} as const;

/**
 * Check if a provider ID is a special pseudo provider
 * @param id - Provider ID to check
 * @returns Whether this is a special pseudo provider that cannot be updated via update_provider
 */
export function isSpecialProviderId(id: string): boolean {
  return (
    id === SPECIAL_PROVIDER_IDS.DISABLED ||
    id === SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS ||
    id === SPECIAL_PROVIDER_IDS.CLI_LOGIN ||
    id === SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN
  );
}

/**
 * localStorage keys for provider-related data
 */
export const STORAGE_KEYS = {
  /** Custom Codex model list */
  CODEX_CUSTOM_MODELS: 'codex-custom-models',
  /** Claude model mapping configuration */
  CLAUDE_MODEL_MAPPING: 'claude-model-mapping',
  /** Custom Claude model list */
  CLAUDE_CUSTOM_MODELS: 'claude-custom-models',
} as const;

/**
 * Claude provider env keys that affect runtime model resolution.
 */
export const CLAUDE_MODEL_MAPPING_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

/**
 * Model ID validation regular expression
 * Allowed: letters, numbers, hyphens, underscores, dots, slashes, colons
 * Used to validate user-input model ID format
 */
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9._\-/:]+$/;

// ============ Validation Helpers ============

/**
 * Validate whether a model ID format is valid.
 *
 * NOTE: Model ID format is intentionally NOT restricted by regex.
 * Third-party providers use diverse model ID formats that cannot be
 * predicted (e.g., slashes, brackets, CJK characters). Only basic
 * sanity checks (non-empty, length limit) are applied.
 * Do NOT re-add MODEL_ID_PATTERN validation here.
 *
 * @param id - Model ID
 * @returns Whether the ID is valid
 */
export function isValidModelId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  return true;
}

/**
 * Validate whether a CodexCustomModel object is valid
 * @param model - Object to validate
 * @returns Whether it is a valid CodexCustomModel
 */
export function isValidCodexCustomModel(model: unknown): model is CodexCustomModel {
  if (!model || typeof model !== 'object') return false;
  const obj = model as Record<string, unknown>;

  // id must be a valid model ID
  if (typeof obj.id !== 'string' || !isValidModelId(obj.id)) return false;

  // label must be a string
  if (typeof obj.label !== 'string' || obj.label.trim().length === 0) return false;

  // description is optional, but must be a string if present
  if (obj.description !== undefined && typeof obj.description !== 'string') return false;

  return true;
}

/**
 * Validate and filter a CodexCustomModel array
 * @param models - Array to validate
 * @returns Array of valid CodexCustomModel entries
 */
export function validateCodexCustomModels(models: unknown): CodexCustomModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter(isValidCodexCustomModel);
}

// ============ Types ============

/**
 * Provider configuration (simplified, adapted for current project)
 */
export interface ProviderConfig {
  id: string;
  name: string;
  remark?: string;
  websiteUrl?: string;
  category?: ProviderCategory;
  createdAt?: number;
  isActive?: boolean;
  source?: 'cc-switch' | string;
  isLocalProvider?: boolean;
  isCliLoginProvider?: boolean;
  /** Saved Claude CLI OAuth account backed by JetBrains PasswordSafe. */
  isCliAccountProvider?: boolean;
  /** Safe display-only account email. */
  emailAddress?: string;
  /** Whether PasswordSafe still contains credentials for this account. */
  isAuthenticated?: boolean;
  /** Custom model list (displayed before built-in models in the selector) */
  customModels?: CodexCustomModel[];
  settingsConfig?: {
    env?: {
      ANTHROPIC_AUTH_TOKEN?: string;
      ANTHROPIC_BASE_URL?: string;
      ANTHROPIC_MODEL?: string;
      ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
      ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
      ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
      [key: string]: any;
    };
    alwaysThinkingEnabled?: boolean;
    permissions?: {
      allow?: string[];
      deny?: string[];
    };
  };
}

/**
 * Provider category
 */
export type ProviderCategory =
  | 'official'      // Official
  | 'cn_official'   // Chinese official
  | 'aggregator'    // Aggregator service
  | 'third_party'   // Third-party
  | 'custom';       // Custom

/**
 * Codex custom model configuration
 */
export interface CodexCustomModel {
  /** Model ID (unique identifier) */
  id: string;
  /** Model display name */
  label: string;
  /** Model description */
  description?: string;
}

/**
 * Single environment variable entry
 */
export interface EnvVarEntry {
  /** Environment variable name */
  key: string;
  /** Environment variable value */
  value: string;
}

/**
 * Codex protected environment variable names that cannot be overridden by custom env vars.
 */
export const CODEX_PROTECTED_ENV_KEYS: ReadonlySet<string> = new Set([
  'CODEX_USE_STDIN',
  'CODEX_MODEL',
  'CODEX_SANDBOX_MODE',
  'CODEX_SANDBOX',
  'CODEX_APPROVAL_POLICY',
  'CODEX_CI',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_HOME',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PERMISSION_DIR',
  'HOME',
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'IDEA_PROJECT_PATH',
  'PROJECT_PATH',
  'CLAUDE_USE_STDIN',
]);

/**
 * Maximum length for env var values. Long values risk exceeding the OS
 * ARG_MAX limit when the child process is spawned.
 * Must stay in sync with MAX_ENV_VAR_VALUE_LENGTH in CodexSDKBridge.java.
 */
export const ENV_VAR_VALUE_MAX_LENGTH = 16 * 1024;

/**
 * Validate whether an env var key name is valid.
 * Must start with letter or underscore, followed by letters, digits, or underscores.
 */
export function isValidEnvVarKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

/**
 * Check if an env var key is a protected Codex built-in variable.
 *
 * NOTE: comparison is case-insensitive (key is uppercased before lookup).
 * On Linux/macOS env vars are case-sensitive, but we conservatively reject
 * any case-variant of a protected name to keep behavior consistent across
 * platforms (Windows env vars are case-insensitive).
 */
export function isProtectedEnvVarKey(key: string): boolean {
  return CODEX_PROTECTED_ENV_KEYS.has(key.toUpperCase());
}

export interface EnvVarValidationIssue {
  index: number;
  field: 'key' | 'value';
  reason: 'invalid' | 'protected' | 'duplicate' | 'value_too_long';
  key?: string;
}

/**
 * Validate a list of EnvVarEntry. Returns the first issue per row, if any.
 * Empty keys are skipped (will be filtered before saving).
 */
export function validateEnvVarEntries(entries: EnvVarEntry[]): EnvVarValidationIssue[] {
  const issues: EnvVarValidationIssue[] = [];
  const seenKeys = new Set<string>();

  entries.forEach((entry, index) => {
    if (entry.value.length > ENV_VAR_VALUE_MAX_LENGTH) {
      issues.push({ index, field: 'value', reason: 'value_too_long' });
    }

    const key = entry.key.trim();
    if (!key) return;

    if (!isValidEnvVarKey(key)) {
      issues.push({ index, field: 'key', reason: 'invalid', key });
      return;
    }

    if (isProtectedEnvVarKey(key)) {
      issues.push({ index, field: 'key', reason: 'protected', key });
      return;
    }

    const upperKey = key.toUpperCase();
    if (seenKeys.has(upperKey)) {
      issues.push({ index, field: 'key', reason: 'duplicate', key });
      return;
    }
    seenKeys.add(upperKey);
  });

  return issues;
}

/**
 * Codex provider configuration
 */
export interface CodexProviderConfig {
  /** Unique provider ID */
  id: string;
  /** Provider name */
  name: string;
  /** Remark */
  remark?: string;
  /** Creation timestamp (milliseconds) */
  createdAt?: number;
  /** Whether this is the currently active provider */
  isActive?: boolean;
  /** config.toml content (raw string) */
  configToml?: string;
  /** auth.json content (raw string) */
  authJson?: string;
  /** Custom model list */
  customModels?: CodexCustomModel[];
  /** Environment variables for sendMessage subprocess */
  messageEnvVars?: EnvVarEntry[];
  /** Environment variables for getMcpServerTools subprocess */
  mcpEnvVars?: EnvVarEntry[];
}

// ============ Provider Presets ============

/**
 * Provider preset configuration
 */
export interface ProviderPreset {
  /** Unique preset ID */
  id: string;
  /** i18n key for preset name, resolved at render time */
  nameKey: string;
  /** Environment variable configuration */
  env: Record<string, string>;
}

/**
 * Provider preset configuration list
 * Used for quick provider setup
 *
 * nameKey is resolved at render time via t() to the display name for the current language
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'custom',
    nameKey: 'settings.provider.presets.custom',
    env: {},
  },
  {
    id: 'zhipu',
    nameKey: 'settings.provider.presets.zhipu',
    env: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
    },
  },
  {
    id: 'kimi',
    nameKey: 'settings.provider.presets.kimi',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.5',
    },
  },
  {
    id: 'deepseek',
    nameKey: 'settings.provider.presets.deepseek',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    },
  },
  {
    id: 'minimax',
    nameKey: 'settings.provider.presets.minimax',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      // MiniMax models respond slowly; requires 50-minute timeout (3,000,000ms) to avoid truncating long reasoning requests
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.1',
    },
  },
  {
    id: 'xiaomi',
    nameKey: 'settings.provider.presets.xiaomi',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    },
  },
  {
    id: 'xiaomi-plan',
    nameKey: 'settings.provider.presets.xiaomiPlan',
    env: {
      ANTHROPIC_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    },
  },
  {
    id: 'qwen',
    nameKey: 'settings.provider.presets.qwen',
    env: {
      ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-max',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-max',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3-max',
    },
  },
  {
    id: 'openrouter',
    nameKey: 'settings.provider.presets.openrouter',
    env: {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-4.5',
    },
  },
];
