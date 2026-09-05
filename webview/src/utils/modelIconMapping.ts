/**
 * Model ID to vendor icon mapping utility.
 *
 * Resolves a model ID string (e.g. "qwen3.5-plus", "deepseek-v3.2") to a
 * vendor key that can be used to select the appropriate icon from @lobehub/icons.
 */

/**
 * Vendor keys recognised by the icon system.
 * Each key maps to a named export from @lobehub/icons.
 */
export type ModelVendor =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'moonshot'
  | 'zhipu'
  | 'minimax'
  | 'xiaomi'
  | 'mimo'
  | 'bailian'
  | 'longcat'
  | 'opencode'
  | 'pi'
  | 'omp'
  | 'doubao'
  | 'spark'
  | 'hunyuan'
  | 'baichuan'
  | 'mistral'
  | 'meta'
  | 'cohere'
  | 'grok'
  | 'openrouter'
  | 'yi';

/**
 * Pattern rules for matching model IDs to vendors.
 * Order matters: first match wins. More specific patterns should come first.
 */
const MODEL_VENDOR_PATTERNS: ReadonlyArray<readonly [RegExp, ModelVendor]> = [
  // Chinese model vendors
  [/qwen/i, 'qwen'],
  [/deepseek/i, 'deepseek'],
  [/kimi/i, 'kimi'],
  [/moonshot/i, 'moonshot'],
  [/glm|chatglm/i, 'zhipu'],
  [/zhipu/i, 'zhipu'],
  [/minimax/i, 'minimax'],
  [/xiaomi|mimo/i, 'xiaomi'],
  [/longcat/i, 'longcat'],
  [/opencode/i, 'opencode'],
  [/doubao/i, 'doubao'],
  [/^spark(?:[-\s]|$)/i, 'spark'],
  [/hunyuan/i, 'hunyuan'],
  [/baichuan/i, 'baichuan'],
  [/yi-|^yi\b/i, 'yi'],

  // International model vendors
  [/claude|anthropic/i, 'claude'],
  [/gpt[-\s]|^gpt\d|^o[134]-|^o[134]\b|openai/i, 'openai'],
  [/gemini/i, 'gemini'],
  [/mistral|mixtral|codestral|pixtral/i, 'mistral'],
  [/llama|meta[-/]/i, 'meta'],
  [/cohere|command[-\s]?[ra]/i, 'cohere'],
  [/grok/i, 'grok'],
];

/**
 * ANTHROPIC_BASE_URL host to vendor mapping.
 *
 * The base URL is the most authoritative brand signal for a provider: it
 * correctly identifies endpoints that serve another vendor's models under
 * their own brand (e.g. OpenRouter routes `anthropic/claude-*` models,
 * OpenCode-Go serves `deepseek-*` models). Matching by substring
 * (case-insensitive) tolerates scheme/path variants.
 */
const BASE_URL_VENDOR_PATTERNS: ReadonlyArray<readonly [RegExp, ModelVendor]> = [
  [/bigmodel\.cn/i, 'zhipu'],
  [/moonshot\.(cn|ai)|kimi\.com/i, 'kimi'],
  [/deepseek\.com/i, 'deepseek'],
  [/minimaxi\.com|minimax\.(io|com)/i, 'minimax'],
  [/xiaomimimo\.com/i, 'xiaomi'],
  [/dashscope\.aliyuncs\.com/i, 'bailian'],
  [/longcat\.chat/i, 'longcat'],
  [/opencode\.ai/i, 'opencode'],
  [/openrouter\.ai/i, 'openrouter'],
  [/api\.anthropic\.com/i, 'claude'],
  [/googleapis\.com/i, 'gemini'],
  [/api\.openai\.com/i, 'openai'],
];

/**
 * Provider ID to vendor mapping.
 * Used when provider preset ID is known (e.g. from PROVIDER_PRESETS).
 */
const PROVIDER_TO_VENDOR: Record<string, ModelVendor> = {
  claude: 'claude',
  codex: 'openai',
  grok: 'grok',
  gemini: 'gemini',
  qwen: 'qwen',
  deepseek: 'deepseek',
  kimi: 'kimi',
  'kimi-coding': 'kimi',
  zhipu: 'zhipu',
  minimax: 'minimax',
  xiaomi: 'xiaomi',
  // MiMo Code CLI provider — shares the Xiaomi MiMo brand mark.
  mimo: 'xiaomi',
  'xiaomi-plan': 'xiaomi',
  bailian: 'bailian',
  'bailian-coding': 'bailian',
  longcat: 'longcat',
  // Runtime CLI provider id (ProviderSelect, BlinkingLogo — logo follows CLI only)
  opencode: 'opencode',
  // Managed Codex/Claude preset that uses OpenCode-Go endpoints
  'opencode-go': 'opencode',
  // Runtime CLI provider id (ProviderSelect, BlinkingLogo, CliSection)
  pi: 'pi',
  omp: 'omp',
  // DeepSeek Harness — brand follows DeepSeek.
  dsh: 'deepseek',
  openrouter: 'openrouter',
};

/**
 * Resolve a model ID to its vendor key by pattern matching.
 *
 * @param modelId - The model ID string (e.g. "qwen3.5-plus", "gpt-5.1-codex")
 * @returns The matched vendor key, or null if no match
 */
export function resolveModelVendor(modelId: string): ModelVendor | null {
  if (!modelId) return null;
  for (const [pattern, vendor] of MODEL_VENDOR_PATTERNS) {
    if (pattern.test(modelId)) return vendor;
  }
  return null;
}

/**
 * Resolve vendor from a provider ID.
 *
 * @param providerId - The provider preset ID (e.g. "claude", "qwen", "deepseek")
 * @returns The vendor key, or null if not a known provider
 */
export function resolveProviderVendor(providerId: string): ModelVendor | null {
  return PROVIDER_TO_VENDOR[providerId] ?? null;
}

/**
 * Resolve vendor from an ANTHROPIC_BASE_URL.
 *
 * @param baseUrl - The provider base URL (e.g. "https://open.bigmodel.cn/api/anthropic")
 * @returns The matched vendor key, or null if no host pattern matches
 */
export function resolveVendorFromBaseUrl(baseUrl?: string): ModelVendor | null {
  if (!baseUrl) return null;
  for (const [pattern, vendor] of BASE_URL_VENDOR_PATTERNS) {
    if (pattern.test(baseUrl)) return vendor;
  }
  return null;
}

/**
 * Resolve the best vendor for icon display.
 * Priority: baseUrl match > modelId match > providerId match > 'claude' default
 *
 * The base URL wins because it identifies the provider's brand regardless of
 * which model it currently serves (e.g. an OpenRouter endpoint serving a
 * claude model should still show the OpenRouter icon).
 *
 * @param providerId - The provider type (e.g. "claude", "codex")
 * @param modelId - Optional model ID for more specific matching
 * @param baseUrl - Optional provider base URL; the strongest brand signal when present
 * @returns The best-matched vendor key, or 'claude' as default
 */
export function resolveIconVendor(
  providerId?: string,
  modelId?: string,
  baseUrl?: string,
): ModelVendor {
  // Base URL is the most authoritative brand signal
  if (baseUrl) {
    const urlVendor = resolveVendorFromBaseUrl(baseUrl);
    if (urlVendor) return urlVendor;
  }
  // Try model ID next (most specific model-level signal)
  if (modelId) {
    const modelVendor = resolveModelVendor(modelId);
    if (modelVendor) return modelVendor;
  }
  // Fall back to provider ID
  if (providerId) {
    const providerVendor = resolveProviderVendor(providerId);
    if (providerVendor) return providerVendor;
  }
  // Default
  return 'claude';
}
