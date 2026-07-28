/**
 * Message utility functions.
 * SDK initialization, retry logic, session file helpers, content truncation, and error payloads.
 */

import { isClaudeSdkAvailable, loadAnthropicSdk, loadBedrockSdk, loadClaudeSdk } from '../../utils/sdk-loader.js';
import { existsSync } from 'fs';
import { getClaudeProjectSessionFilePath as resolveClaudeProjectSessionFilePath } from '../../utils/path-utils.js';
import { loadClaudeSettings } from '../../config/api-config.js';

// SDK cache (module-internal, accessed via ensure* functions)
let claudeSdk = null;
let anthropicSdk = null;
let bedrockSdk = null;

/**
 * Ensure Claude SDK is loaded
 */
export async function ensureClaudeSdk() {
  if (!claudeSdk) {
    if (!isClaudeSdkAvailable()) {
      const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      error.provider = 'claude';
      throw error;
    }
    claudeSdk = await loadClaudeSdk();
  }
  return claudeSdk;
}

/**
 * Ensure Anthropic SDK is loaded
 */
export async function ensureAnthropicSdk() {
  if (!anthropicSdk) {
    anthropicSdk = await loadAnthropicSdk();
  }
  return anthropicSdk;
}

/**
 * Ensure Bedrock SDK is loaded
 */
export async function ensureBedrockSdk() {
  if (!bedrockSdk) {
    bedrockSdk = await loadBedrockSdk();
  }
  return bedrockSdk;
}

// ========== Auto-retry configuration for transient API errors ==========
export const AUTO_RETRY_CONFIG = {
  maxRetries: 2,           // Maximum retry attempts
  retryDelayMs: 1500,      // Delay between retries (ms)
  maxMessagesForRetry: 3   // Only retry if fewer messages were processed (early failure)
};

/**
 * Determine if an error is retryable (transient network/API issues)
 * @param {Error|string} error - The error to check
 * @returns {boolean} - True if the error is likely transient and retryable
 */
export function isRetryableError(error) {
  const msg = error?.message || String(error);
  const retryablePatterns = [
    'API request failed',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'network',
    'fetch failed',
    'socket hang up',
    'getaddrinfo',
    'connect EHOSTUNREACH',
    'No conversation found with session ID',
    'conversation not found'
  ];
  return retryablePatterns.some(pattern => msg.toLowerCase().includes(pattern.toLowerCase()));
}

export function isNoConversationFoundError(error) {
  const msg = error?.message || String(error);
  return msg.includes('No conversation found with session ID');
}

/**
 * Sleep utility for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getRetryDelayMs(error) {
  if (isNoConversationFoundError(error)) return 250;
  return AUTO_RETRY_CONFIG.retryDelayMs;
}

export function getClaudeProjectSessionFilePath(sessionId, cwd) {
  return resolveClaudeProjectSessionFilePath(sessionId, cwd);
}

export function hasClaudeProjectSessionFile(sessionId, cwd) {
  try {
    if (!sessionId || typeof sessionId !== 'string') return false;
    if (sessionId.includes('/') || sessionId.includes('\\')) return false;
    const sessionFile = getClaudeProjectSessionFilePath(sessionId, cwd);
    return existsSync(sessionFile);
  } catch {
    return false;
  }
}

export async function waitForClaudeProjectSessionFile(sessionId, cwd, timeoutMs = 1500, intervalMs = 100) {
  if (hasClaudeProjectSessionFile(sessionId, cwd)) return true;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(intervalMs);
    if (hasClaudeProjectSessionFile(sessionId, cwd)) return true;
  }
  return false;
}

/**
 * Truncate a string to a maximum length, appending a suffix if truncated.
 * @param {string} str - The string to truncate
 * @param {number} maxLen - Maximum allowed length (default 1000)
 * @returns {string} The original or truncated string
 */
export function truncateString(str, maxLen = 1000) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... [truncated, total ${str.length} chars]`;
}

/**
 * Error prefixes that indicate the content is an error message from SDK or API.
 * When content starts with one of these prefixes and exceeds maxLen, it will be truncated.
 */
export const ERROR_CONTENT_PREFIXES = [
  'API Error',
  'API error',
  'Error:',
  'Error ',
];

/**
 * Truncate content only if it looks like an error message (starts with known error prefixes).
 * Normal assistant responses are never truncated.
 * @param {string} content - The content to check and possibly truncate
 * @param {number} maxLen - Maximum allowed length (default 1000)
 * @returns {string} The original or truncated content
 */
export function truncateErrorContent(content, maxLen = 1000) {
  if (!content || content.length <= maxLen) return content;
  const isError = ERROR_CONTENT_PREFIXES.some(prefix => content.startsWith(prefix));
  if (!isError) return content;
  return content.substring(0, maxLen) + `... [truncated, total ${content.length} chars]`;
}

/**
 * Emit [USAGE] tag for Java-side token tracking.
 * NOTE: Uses process.stdout.write for consistent buffering with other IPC messages.
 * The Java backend parses stdout lines starting with "[USAGE]" to extract token metrics.
 */
export function emitUsageTag(msg) {
  if (msg.type === 'assistant' && msg.message?.usage) {
    const {
      input_tokens = 0, output_tokens = 0,
      cache_creation_input_tokens = 0, cache_read_input_tokens = 0
    } = msg.message.usage;
    // Intentional stdout IPC — parsed by Java backend (see ClaudeMessageHandler.parseUsageTag)
    process.stdout.write('[USAGE] ' + JSON.stringify({
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
    }) + '\n');
  }
}

export const MAX_TOOL_RESULT_CONTENT_CHARS = 20000;

/**
 * Truncate tool_result block content for IPC transport.
 * Preserves all fields but limits the content string to avoid large payloads through stdout.
 * @param {object} block - The tool_result block
 * @returns {object} A block with truncated content (or the original if small enough)
 */
export function truncateToolResultBlock(block) {
  if (!block || !block.content) return block;
  const content = block.content;
  if (typeof content === 'string' && content.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
    const head = Math.floor(MAX_TOOL_RESULT_CONTENT_CHARS * 0.65);
    const tail = MAX_TOOL_RESULT_CONTENT_CHARS - head;
    return {
      ...block,
      content: content.substring(0, head) +
        `\n...\n(truncated, original length: ${content.length} chars)\n...\n` +
        content.substring(content.length - tail)
    };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const truncated = content.map(item => {
      if (item && item.type === 'text' && typeof item.text === 'string' && item.text.length > MAX_TOOL_RESULT_CONTENT_CHARS) {
        changed = true;
        const head = Math.floor(MAX_TOOL_RESULT_CONTENT_CHARS * 0.65);
        const tail = MAX_TOOL_RESULT_CONTENT_CHARS - head;
        return {
          ...item,
          text: item.text.substring(0, head) +
            `\n...\n(truncated, original length: ${item.text.length} chars)\n...\n` +
            item.text.substring(item.text.length - tail)
        };
      }
      return item;
    });
    return changed ? { ...block, content: truncated } : block;
  }
  return block;
}

/**
 * Build error payload for configuration errors
 * @param {Error} error - The error object to build payload from
 * @returns {Object} Error payload with error message and details
 */
export function buildConfigErrorPayload(error) {
  try {
    const rawError = error?.message || String(error);
    const errorName = error?.name || 'Error';
    const errorStack = error?.stack || null;

    // Previously this handled AbortError / "Claude Code process aborted by user" with a timeout-specific message.
    // Now we use unified error handling, but still record whether it's a timeout/abort error in details for debugging.
    const isAbortError =
      errorName === 'AbortError' ||
      rawError.includes('Claude Code process aborted by user') ||
      rawError.includes('The operation was aborted');

    const settings = loadClaudeSettings();
    const env = settings?.env || {};

    const settingsApiKey =
      env.ANTHROPIC_AUTH_TOKEN !== undefined && env.ANTHROPIC_AUTH_TOKEN !== null
        ? env.ANTHROPIC_AUTH_TOKEN
        : env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== null
          ? env.ANTHROPIC_API_KEY
          : null;

    const settingsBaseUrl =
      env.ANTHROPIC_BASE_URL !== undefined && env.ANTHROPIC_BASE_URL !== null
        ? env.ANTHROPIC_BASE_URL
        : null;

    // Note: Configuration is only read from settings.json; shell environment variables are no longer checked
    let keySource = 'Not configured';
    let rawKey = null;

    if (settingsApiKey !== null) {
      rawKey = String(settingsApiKey);
      if (env.ANTHROPIC_AUTH_TOKEN !== undefined && env.ANTHROPIC_AUTH_TOKEN !== null) {
        keySource = '~/.claude/settings.json: ANTHROPIC_AUTH_TOKEN';
      } else if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== null) {
        keySource = '~/.claude/settings.json: ANTHROPIC_API_KEY';
      } else {
        keySource = '~/.claude/settings.json';
      }
    }

    const keyPreview = rawKey && rawKey.length > 0
      ? `${rawKey.substring(0, 4)}...${rawKey.slice(-4)} (length: ${rawKey.length} chars)`
      : 'Not configured (value is empty or missing)';

    let baseUrl = settingsBaseUrl || 'https://api.anthropic.com';
    let baseUrlSource;
    if (settingsBaseUrl) {
      baseUrlSource = '~/.claude/settings.json: ANTHROPIC_BASE_URL';
    } else {
      baseUrlSource = 'Default (https://api.anthropic.com)';
    }

    const heading = isAbortError
      ? 'Claude Code was interrupted (possibly response timeout or user cancellation):'
      : 'Claude Code error:';

    const userMessage = [
      heading,
      `- Error message: ${truncateString(rawError)}`,
      `- Current API Key source: ${keySource}`,
      `- Current API Key preview: ${keyPreview}`,
      `- Current Base URL: ${baseUrl} (source: ${baseUrlSource})`,
      `- Tip: CLI can read from environment variables or settings.json; this plugin only supports reading from settings.json to avoid issues. You can configure it in the plugin's top-right Settings > Provider Management`,
      ''
    ].join('\n');

    return {
      success: false,
      error: userMessage,
      details: {
        rawError,
        errorName,
        errorStack,
        isAbortError,
        keySource,
        keyPreview,
        baseUrl,
        baseUrlSource
      }
    };
  } catch (innerError) {
    const rawError = error?.message || String(error);
    return {
      success: false,
      error: truncateString(rawError),
      details: {
        rawError,
        buildErrorFailed: String(innerError)
      }
    };
  }
}
