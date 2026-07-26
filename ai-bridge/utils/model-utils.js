/**
 * Model utilities module.
 * Handles model ID mapping and environment variable configuration.
 */

/**
 * Map a full model ID to the short name expected by the Claude SDK.
 * @param {string} modelId - Full model ID (e.g. 'claude-sonnet-4-5')
 * @returns {string} SDK model name (e.g. 'sonnet')
 */
export function mapModelIdToSdkName(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return 'sonnet'; // Default to sonnet
  }

  const lowerModel = modelId.toLowerCase();

  // Mapping rules:
  // - Contains 'opus' -> 'opus'
  // - Contains 'haiku' -> 'haiku'
  // - Otherwise (contains 'sonnet' or unknown) -> 'sonnet'
  if (lowerModel.includes('opus')) {
    return 'opus';
  } else if (lowerModel.includes('haiku')) {
    return 'haiku';
  } else {
    return 'sonnet';
  }
}

/**
 * Resolve the actual model name for API calls from user's settings.json.
 * When the user configures a model mapping in their provider config (e.g. sonnet -> "MiniMax-M2.5"),
 * those values are written to ~/.claude/settings.json as ANTHROPIC_DEFAULT_*_MODEL env vars.
 * This function checks those settings and returns the mapped model name if configured.
 *
 * Priority: ANTHROPIC_DEFAULT_*_MODEL for the selected family > ANTHROPIC_MODEL fallback > original modelId
 *
 * IMPORTANT: The `[1m]` suffix is controlled by the input modelId from the
 * webview, not by stale settings.env mappings.
 * The 1M context window is selected by the Claude Code SDK based on whether the
 * model name ends with `[1m]` (it reads `process.env.ANTHROPIC_DEFAULT_*_MODEL`).
 * If the request enables 1M, preserve or append the suffix on the mapped model.
 * If the request disables 1M, strip any suffix from the mapped value so an old
 * settings.json env value cannot force the 1M context window back on.
 *
 * @param {string} modelId - Internal model ID from frontend (e.g. 'claude-sonnet-4-6' or 'claude-sonnet-4-6[1m]')
 * @param {object} userEnv - The env object from settings.json (settings.env)
 * @returns {string} The resolved model name for API calls, with the `[1m]` suffix preserved
 */
export function resolveModelFromSettings(modelId, userEnv) {
  if (!modelId || !userEnv) return modelId;

  const lowerModel = modelId.toLowerCase();
  const requestHas1M = /\[1m\]$/i.test(modelId);
  // The request owns 1M state. Settings mappings may provide the provider's base
  // model ID, but they must not force the context-window suffix.
  const applySuffix = (mapped) => {
    const base = String(mapped).trim().replace(/\[1m\]$/i, '');
    return requestHas1M ? `${base}[1m]` : base;
  };

  const readMapped = (key) => {
    const mapped = userEnv[key];
    return mapped && String(mapped).trim() ? applySuffix(String(mapped).trim()) : null;
  };

  // Check family-specific env vars first. A stale generic mapping must not
  // silently route a selected Haiku/Sonnet/Opus model to another family.
  if (lowerModel.includes('opus')) {
    return readMapped('ANTHROPIC_DEFAULT_OPUS_MODEL')
      || readMapped('ANTHROPIC_MODEL')
      || modelId;
  } else if (lowerModel.includes('haiku')) {
    return readMapped('ANTHROPIC_DEFAULT_HAIKU_MODEL')
      || readMapped('ANTHROPIC_MODEL')
      || modelId;
  } else if (lowerModel.includes('sonnet')) {
    // Only apply sonnet mapping when the model ID actually contains 'sonnet'.
    // Non-Anthropic model names (e.g. 'qwen3.5-plus', 'deepseek-v3') should NOT be
    // remapped to the sonnet setting, as they are already the intended model name.
    return readMapped('ANTHROPIC_DEFAULT_SONNET_MODEL')
      || readMapped('ANTHROPIC_MODEL')
      || modelId;
  }
  // For non-Anthropic model IDs that don't contain 'opus'/'haiku'/'sonnet',
  // skip mapping and use the original model ID as-is.

  // No mapping configured, use original model ID
  return modelId;
}

/**
 * Set SDK environment variables based on the model name.
 * The Claude SDK uses short names (opus/sonnet/haiku) as model selectors,
 * while the specific version is determined by ANTHROPIC_DEFAULT_*_MODEL environment variables.
 *
 * NOTE: This function mutates process.env as a side effect, which is required by the
 * Claude SDK's model resolution mechanism. This is safe in the current single-request
 * architecture but should be revisited if concurrent request handling is introduced.
 *
 * @param {string} modelId - The resolved model name to set as env var value (e.g. 'MiniMax-M2.5' or 'claude-opus-4-6')
 * @param {string} [baseModelId] - The original internal model ID used to determine which env var to set.
 *                                  Required when modelId is a custom name that doesn't contain 'opus'/'haiku'/'sonnet'.
 *                                  Falls back to modelId if not provided.
 */
export function setModelEnvironmentVariables(modelId, baseModelId) {
  if (!modelId || typeof modelId !== 'string') {
    return;
  }

  // Use baseModelId to determine model category (which env var to set).
  // This is necessary when modelId is a custom name like 'MiniMax-M2.5'
  // that doesn't contain 'opus'/'haiku'/'sonnet'.
  const lowerBase = (baseModelId || modelId).toLowerCase();

  process.env.ANTHROPIC_MODEL = modelId;

  // Set the corresponding environment variable based on model type
  // so the SDK knows which specific version to use
  if (lowerBase.includes('opus')) {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_OPUS_MODEL =', modelId);
  } else if (lowerBase.includes('haiku')) {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_HAIKU_MODEL =', modelId);
  } else {
    // Covers 'sonnet' and any non-Anthropic model names (e.g. 'qwen3.5-plus', 'deepseek-v3')
    // Since mapModelIdToSdkName() defaults to 'sonnet' for unknown models,
    // the SDK will look up ANTHROPIC_DEFAULT_SONNET_MODEL for the actual model name
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    console.log('[MODEL_ENV] Set ANTHROPIC_DEFAULT_SONNET_MODEL =', modelId);
  }
}

/**
 * Determine whether the model natively supports Anthropic vision content blocks.
 *
 * Different models have different vision input capabilities:
 * - Claude models (claude-*): Support Anthropic's standard vision format
 *   via {type: "image", source: {type: "base64", media_type, data}}.
 * - Third-party models (mimo, deepseek, qwen, glm, etc.): Many do not properly
 *   handle Anthropic vision content blocks, especially when routed through
 *   third-party Anthropic-compatible proxies. The image blocks may be silently
 *   dropped during proxy translation, causing the model to report "no image attached".
 *
 * For non-Claude models, the caller should fall back to saving images as temp
 * files and referencing them in the message text, mimicking Claude Code CLI
 * behavior which uses the Read tool to load images from disk.
 *
 * @param {string} modelId - The resolved model name actually sent to the API.
 *                            Examples: "claude-sonnet-4-5", "mimo-v2.5-pro", "MiniMax-M2.5"
 * @returns {boolean} True if the model natively supports Anthropic vision blocks.
 */
export function modelSupportsVision(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return true;
  }
  const lower = modelId.toLowerCase();
  // Anchor to the canonical "claude-" prefix to avoid matching third-party
  // model names that merely contain the substring "claude" (e.g.
  // "claude-compatible-proxy"), which historically yielded false positives
  // and dropped images for proxies that don't speak Anthropic vision blocks.
  return lower.startsWith('claude-');
}

// Note: getClaudeCliPath() has been removed.
// Now using the SDK's built-in cli.js (at node_modules/@anthropic-ai/claude-agent-sdk/cli.js).
// This avoids system CLI path issues on Windows (ENOENT errors) and keeps the version aligned with the SDK.
