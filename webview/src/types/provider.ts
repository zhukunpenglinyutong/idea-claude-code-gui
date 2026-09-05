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
  /** Pricing for Claude models configured by provider/settings.json, not shown as custom models */
  CLAUDE_CONFIGURED_MODEL_PRICING: 'claude-configured-model-pricing',
} as const;

/**
 * Claude provider env keys that affect runtime model resolution.
 */
export const CLAUDE_MODEL_MAPPING_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
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

  // contextWindowTokens is optional, but must fit the Java int-based usage pipeline
  if (obj.contextWindowTokens !== undefined) {
    if (
      typeof obj.contextWindowTokens !== 'number'
      || !Number.isSafeInteger(obj.contextWindowTokens)
      || obj.contextWindowTokens < 1_000
      || obj.contextWindowTokens % 1_000 !== 0
      || obj.contextWindowTokens > 2_147_483_647
    ) return false;
  }

  // pricing is optional; when present every provided field must be a non-negative number
  if (obj.pricing !== undefined) {
    if (!isValidModelPricing(obj.pricing)) return false;
  }

  const stringFields = ['vendor', 'apiKey', 'url'] as const;
  for (const field of stringFields) {
    if (obj[field] !== undefined && typeof obj[field] !== 'string') return false;
  }
  const tokenFields = ['maxInputTokens', 'maxOutputTokens'] as const;
  for (const field of tokenFields) {
    if (obj[field] !== undefined && (
      typeof obj[field] !== 'number'
      || !Number.isSafeInteger(obj[field])
      || obj[field] < 1
    )) return false;
  }
  if (obj.temperature !== undefined && (
    typeof obj.temperature !== 'number'
    || !Number.isFinite(obj.temperature)
    || obj.temperature < 0
    || obj.temperature > 2
  )) return false;
  const booleanFields = ['supportsToolCall', 'supportsImages', 'supportsReasoning'] as const;
  for (const field of booleanFields) {
    if (obj[field] !== undefined && typeof obj[field] !== 'boolean') return false;
  }
  if (obj.relatedModels !== undefined) {
    if (!obj.relatedModels || typeof obj.relatedModels !== 'object' || Array.isArray(obj.relatedModels)) return false;
    if (!Object.values(obj.relatedModels as Record<string, unknown>)
      .every((value) => typeof value === 'string' && value.trim().length > 0)) return false;
  }
  if (obj.__ccguiScope !== undefined && obj.__ccguiScope !== 'user' && obj.__ccguiScope !== 'project') {
    return false;
  }

  return true;
}

/**
 * Validate whether a ModelPricing object is valid.
 * Every field is optional, but if present must be a finite number >= 0.
 */
export function isValidModelPricing(pricing: unknown): boolean {
  if (!pricing || typeof pricing !== 'object') return false;
  const p = pricing as Record<string, unknown>;
  const fields: (keyof ModelPricing)[] = [
    'inputCostPer1M',
    'outputCostPer1M',
    'cacheWriteCostPer1M',
    'cacheReadCostPer1M',
  ];
  for (const f of fields) {
    const v = p[f];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  }
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
  /** Custom model list (displayed before built-in models in the selector) */
  customModels?: CodexCustomModel[];
  settingsConfig?: {
    env?: {
      ANTHROPIC_AUTH_TOKEN?: string;
      ANTHROPIC_BASE_URL?: string;
      ANTHROPIC_MODEL?: string;
      ANTHROPIC_DEFAULT_FABLE_MODEL?: string;
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
 * Per-million-token pricing for a custom model.
 *
 * All fields are optional: a missing field means "fall back to the default
 * pricing for that token kind" in the backend cost calculation. Units are
 * USD per 1,000,000 tokens, consistent with the backend `*CostPer1M` fields.
 *
 * cacheWrite is only meaningful for Claude-family models (Codex sessions do
 * not track cache-write tokens).
 */
export interface ModelPricing {
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  cacheWriteCostPer1M?: number;
  cacheReadCostPer1M?: number;
}

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
  /** Optional context window size in tokens for plugin usage display */
  contextWindowTokens?: number;
  /** Optional per-million-token pricing for cost calculation */
  pricing?: ModelPricing;
  /** CodeBuddy models.json source file for provider-managed models. */
  __ccguiScope?: 'user' | 'project';
  /** CodeBuddy LanguageModel fields. */
  vendor?: string;
  apiKey?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  url?: string;
  temperature?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  relatedModels?: Record<string, string>;
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

export interface CodexProviderPreset {
  id: string;
  name: string;
  nameKey: string;
  configToml: string;
  authJson: string;
}

const tomlString = (value: string): string => JSON.stringify(value);

export function buildCodexProviderConfigToml(
  providerName: string,
  baseUrl: string,
  model: string,
  wireApi: 'responses' | 'chat' = 'responses',
  providerId = 'custom',
): string {
  return `disable_response_storage = true
model = ${tomlString(model)}
model_reasoning_effort = "high"
model_provider = ${tomlString(providerId)}

[model_providers.${providerId}]
base_url = ${tomlString(baseUrl)}
name = ${tomlString(providerName)}
requires_openai_auth = true
wire_api = ${tomlString(wireApi)}`;
}

export const DEFAULT_CODEX_AUTH_JSON = `{
  "OPENAI_API_KEY": ""
}`;

export const DEFAULT_CODEX_CONFIG_TOML = buildCodexProviderConfigToml(
  'crs',
  'https://api.example.com/v1',
  'gpt-5.1-codex',
  'responses',
  'crs',
);

export const OFFICIAL_CODEX_PROVIDER_NAME = 'OpenAI Official Direct';
export const OFFICIAL_CODEX_BASE_URL = 'https://api.openai.com/v1';
export const OFFICIAL_CODEX_CONFIG_TOML = buildCodexProviderConfigToml(
  'openai',
  OFFICIAL_CODEX_BASE_URL,
  'gpt-5.1-codex',
  'responses',
  'openai',
);

export const CODEX_PROVIDER_PRESETS: CodexProviderPreset[] = [
  {
    id: 'custom',
    name: '',
    nameKey: 'settings.provider.presets.custom',
    configToml: DEFAULT_CODEX_CONFIG_TOML,
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    nameKey: 'settings.provider.presets.zhipu',
    configToml: buildCodexProviderConfigToml('zhipu_glm', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.2', 'chat'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'kimi',
    name: 'Kimi',
    nameKey: 'settings.provider.presets.kimi',
    configToml: buildCodexProviderConfigToml('kimi', 'https://api.moonshot.cn/v1', 'kimi-k3', 'chat'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'kimi-coding',
    name: 'Kimi Coding',
    nameKey: 'settings.provider.presets.kimiCoding',
    configToml: buildCodexProviderConfigToml('kimi_coding', 'https://api.kimi.com/coding/v1', 'kimi-k3', 'chat'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameKey: 'settings.provider.presets.deepseek',
    configToml: buildCodexProviderConfigToml('deepseek', 'https://api.deepseek.com', 'deepseek-v4-flash', 'chat'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    nameKey: 'settings.provider.presets.minimax',
    configToml: buildCodexProviderConfigToml('minimax', 'https://api.minimaxi.com/v1', 'MiniMax-M3'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    nameKey: 'settings.provider.presets.xiaomi',
    configToml: buildCodexProviderConfigToml('xiaomi_mimo', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-pro'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'xiaomi-plan',
    name: 'Xiaomi MiMo Plan',
    nameKey: 'settings.provider.presets.xiaomiPlan',
    configToml: buildCodexProviderConfigToml('xiaomi_mimo_token_plan', 'https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.5-pro'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'bailian',
    name: 'Bailian',
    nameKey: 'settings.provider.presets.bailian',
    configToml: buildCodexProviderConfigToml('bailian', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-coder-plus'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'bailian-coding',
    name: 'Bailian Coding',
    nameKey: 'settings.provider.presets.bailianCoding',
    configToml: buildCodexProviderConfigToml('bailian_coding', 'https://coding.dashscope.aliyuncs.com/v1', 'qwen3-coder-plus'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'longcat',
    name: 'LongCat',
    nameKey: 'settings.provider.presets.longcat',
    configToml: buildCodexProviderConfigToml('longcat', 'https://api.longcat.chat/openai/v1', 'LongCat-2.0'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    nameKey: 'settings.provider.presets.opencodeGo',
    configToml: buildCodexProviderConfigToml('opencode_go', 'https://opencode.ai/zen/go/v1', 'glm-5.2', 'chat'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameKey: 'settings.provider.presets.openrouter',
    configToml: buildCodexProviderConfigToml('openrouter', 'https://openrouter.ai/api/v1', 'gpt-5.6-sol'),
    authJson: DEFAULT_CODEX_AUTH_JSON,
  },
];

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
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
    },
  },
  {
    id: 'kimi',
    nameKey: 'settings.provider.presets.kimi',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3',
    },
  },
  {
    id: 'kimi-coding',
    nameKey: 'settings.provider.presets.kimiCoding',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
    },
  },
  {
    id: 'deepseek',
    nameKey: 'settings.provider.presets.deepseek',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro[1m]',
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
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'MiniMax-M2.1',
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
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'mimo-v2.5-pro',
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
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    },
  },
  {
    id: 'bailian',
    nameKey: 'settings.provider.presets.bailian',
    env: {
      ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
    },
  },
  {
    id: 'bailian-coding',
    nameKey: 'settings.provider.presets.bailianCoding',
    env: {
      ANTHROPIC_BASE_URL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
    },
  },
  {
    id: 'longcat',
    nameKey: 'settings.provider.presets.longcat',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.longcat.chat/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'LongCat-2.0',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'LongCat-2.0',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'LongCat-2.0',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'LongCat-2.0',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '131072',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  },
  {
    id: 'opencode-go',
    nameKey: 'settings.provider.presets.opencodeGo',
    env: {
      ANTHROPIC_BASE_URL: 'https://opencode.ai/zen/go',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
    },
  },
  {
    id: 'openrouter',
    nameKey: 'settings.provider.presets.openrouter',
    env: {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'anthropic/claude-fable-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-4.5',
    },
  },
];
