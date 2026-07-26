/**
 * Codex utility functions.
 * Logging, environment config, SDK initialization, reconnect helpers, and error handling.
 */

import { loadCodexSdk, isCodexSdkAvailable } from '../../utils/sdk-loader.js';
import { CodexPermissionMapper } from '../../utils/permission-mapper.js';

// SDK cache
let codexSdk = null;

// ========== Debug Logging Configuration ==========
// Log levels: 0 = off, 1 = errors only, 2 = warnings, 3 = info, 4 = debug, 5 = verbose
export const DEBUG_LEVEL = process.env.CODEX_DEBUG_LEVEL ? parseInt(process.env.CODEX_DEBUG_LEVEL, 10) : 3;

/**
 * Conditional logging utility based on DEBUG_LEVEL
 * @param {number} level - Log level (1-5)
 * @param {string} tag - Log tag
 * @param  {...any} args - Log arguments
 */
export function debugLog(level, tag, ...args) {
  if (DEBUG_LEVEL >= level) {
    console.error(`[${tag}]`, ...args);
  }
}

// Convenience functions for different log levels
export const logWarn = (tag, ...args) => debugLog(2, tag, ...args);
export const logInfo = (tag, ...args) => debugLog(3, tag, ...args);
export const logDebug = (tag, ...args) => debugLog(4, tag, ...args);
export const VALID_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
export const VALID_APPROVAL_POLICIES = new Set(['never', 'on-request', 'on-failure', 'untrusted']);
export const CODEX_CLI_ENV_BLOCKLIST = new Set([
  'CODEX_APPROVAL_POLICY',
  'CODEX_SANDBOX_MODE',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_CI'
]);

/**
 * Reads sandbox mode override from environment variables.
 * Returns an empty string when no override should be applied.
 */
export function resolveSandboxModeOverride() {
  const value = (process.env.CODEX_SANDBOX_MODE || '').trim();
  if (!value) {
    return '';
  }
  if (!VALID_SANDBOX_MODES.has(value)) {
    logWarn('PERM_DEBUG', `Ignore invalid CODEX_SANDBOX_MODE: ${value}`);
    return '';
  }
  return value;
}

/**
 * Reads approval policy override from environment variables.
 * Returns an empty string when no override should be applied.
 */
export function resolveApprovalPolicyOverride() {
  const value = (process.env.CODEX_APPROVAL_POLICY || '').trim();
  if (!value) {
    return '';
  }
  if (!VALID_APPROVAL_POLICIES.has(value)) {
    logWarn('PERM_DEBUG', `Ignore invalid CODEX_APPROVAL_POLICY: ${value}`);
    return '';
  }
  return value;
}

/**
 * Builds a sanitized environment map for Codex CLI to avoid inherited
 * polluted variables that can break approval policy behavior.
 */
export function buildCodexCliEnvironment(baseEnv) {
  const cliEnv = {};
  const removedKeys = [];

  if (!baseEnv || typeof baseEnv !== 'object') {
    return { cliEnv, removedKeys };
  }

  for (const [key, rawValue] of Object.entries(baseEnv)) {
    if (typeof rawValue !== 'string' || rawValue.length === 0) {
      continue;
    }
    if (CODEX_CLI_ENV_BLOCKLIST.has(key)) {
      removedKeys.push(key);
      continue;
    }
    cliEnv[key] = rawValue;
  }

  return { cliEnv, removedKeys };
}

export function normalizeCodexPermissionMode(mode) {
  if (typeof mode !== 'string') {
    return 'default';
  }
  const trimmed = mode.trim();
  if (!trimmed) {
    return 'default';
  }
  if (trimmed === 'autoEdit') {
    return 'acceptEdits';
  }
  return trimmed;
}

export function isAutoEditPermissionMode(mode) {
  const normalized = normalizeCodexPermissionMode(mode);
  return normalized === 'acceptEdits';
}

export const isReconnectNotice = (message) =>
  typeof message === 'string' && /Reconnecting\.\.\./i.test(message);

export const extractReconnectStatus = (message) => {
  if (typeof message !== 'string') return '';
  const match = message.match(/Reconnecting\.\.\.\s*\d+\/\d+/i);
  return match ? match[0] : message;
};

export const emitStatusMessage = (emitMessage, message) => {
  const status = extractReconnectStatus(message);
  if (!status) return;
  emitMessage({ type: 'status', message: status });
};

/**
 * Ensure Codex SDK is loaded.
 */
export async function ensureCodexSdk() {
  if (!codexSdk) {
    if (!isCodexSdkAvailable()) {
      const error = new Error('Codex SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      error.provider = 'codex';
      throw error;
    }
    codexSdk = await loadCodexSdk();
  }
  return codexSdk;
}

export const MAX_TOOL_RESULT_CHARS = 20000;
export const RAW_EVENT_LOG_MAX_CHARS = 12000;

// AGENTS.md max read size in bytes (32KB, consistent with Codex CLI)
export const MAX_AGENTS_MD_BYTES = 32 * 1024;

// AGENTS.md filename search order
export const AGENTS_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'];
export const SESSION_PATCH_SCAN_MAX_LINES = 2000;
export const SESSION_PATCH_SCAN_MAX_FILES = 5000;
export const SESSION_CONTEXT_SCAN_MAX_LINES = 1200;

/**
 * Build error response with helpful diagnostics
 *
 * @param {Error} error - The error object
 * @returns {object} Structured error payload
 */
export function buildErrorPayload(error) {
  const rawError = error?.message || String(error);
  const errorName = error?.name || 'Error';

  // Detect common error types
  const isAuthError = rawError.includes('API key') ||
                      rawError.includes('authentication') ||
                      rawError.includes('unauthorized') ||
                      rawError.includes('401') ||
                      rawError.includes('Missing environment variable') ||
                      rawError.includes('CODEX_API_KEY');

  const isNetworkError = rawError.includes('ECONNREFUSED') ||
                         rawError.includes('ETIMEDOUT') ||
                         rawError.includes('network') ||
                         rawError.includes('fetch failed');

  let userMessage;

  if (isAuthError) {
    userMessage = [
      'Codex authentication error:',
      `- Error message: ${rawError}`,
      '',
      'Please check the following:',
      '1. Is the Codex API Key in plugin settings correct',
      '2. Does the API Key have sufficient permissions',
      '3. If using a custom Base URL, please confirm the address is correct',
      '',
      'Tip: Codex requires a valid OpenAI API Key'
    ].join('\n');
  } else if (isNetworkError) {
    userMessage = [
      'Codex network error:',
      `- Error message: ${rawError}`,
      '',
      'Please check:',
      '1. Is the network connection working',
      '2. If using a proxy, please confirm proxy configuration',
      '3. Is the firewall blocking the connection'
    ].join('\n');
  } else {
    userMessage = [
      'Codex error:',
      `- Error message: ${rawError}`,
      '',
      'Please check network connection and Codex configuration'
    ].join('\n');
  }

  return {
    success: false,
    error: userMessage,
    details: {
      rawError,
      errorName,
      isAuthError,
      isNetworkError
    }
  };
}
