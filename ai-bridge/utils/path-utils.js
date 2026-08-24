/**
 * Path utilities module
 * Handles path normalization, temporary directory detection, and working directory selection
 */

import fs from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir, platform } from 'os';

// Cache the resolved home directory path to avoid redundant computation
let cachedRealHomeDir = null;

/**
 * Get the real (physical) home directory path.
 * Resolves issues on Windows where the home directory may have been moved
 * or accessed via symlinks/junctions.
 * Uses fs.realpathSync to obtain the physical path, ensuring consistency
 * with the actual filesystem.
 * @returns {string} The resolved physical home directory path
 */
export function getRealHomeDir() {
  if (cachedRealHomeDir) {
    return cachedRealHomeDir;
  }

  const rawHome = homedir();
  try {
    // Use realpathSync to get the real physical path, resolving symlinks/junctions
    cachedRealHomeDir = fs.realpathSync(rawHome);
  } catch {
    // If realpath fails, fall back to the raw path
    console.warn('[path-utils] Failed to resolve real home path, using raw path:', rawHome);
    cachedRealHomeDir = rawHome;
  }

  return cachedRealHomeDir;
}

/**
 * Get the .codemoss configuration directory path.
 * @returns {string} The ~/.codemoss directory path
 */
export function getCodemossDir() {
  return join(getRealHomeDir(), '.codemoss');
}

/**
 * Get the .claude configuration directory path.
 * @returns {string} The ~/.claude directory path
 */
export function getClaudeDir() {
  return join(getRealHomeDir(), '.claude');
}

const CLAUDE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Convert a project path into the directory key used under ~/.claude/projects.
 * Claude Code replaces every non-alphanumeric character with a hyphen and does
 * not truncate long keys.
 * @param {string} projectPath
 * @returns {string}
 */
export function getClaudeProjectKey(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    return '';
  }
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve a validated Claude Code JSONL session file path.
 * @param {string} sessionId
 * @param {string|null} cwd
 * @returns {string}
 */
export function getClaudeProjectSessionFilePath(sessionId, cwd = null) {
  if (typeof sessionId !== 'string' || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid session ID');
  }
  const projectsDir = join(getClaudeDir(), 'projects');
  const projectKey = getClaudeProjectKey(cwd || process.cwd());
  return join(projectsDir, projectKey, `${sessionId}.jsonl`);
}

/**
 * Get the platform-specific path for Claude Code managed settings.
 * Managed settings are typically configured by enterprise IT administrators.
 * - macOS: /Library/Application Support/ClaudeCode/managed-settings.json
 * - Linux: /etc/claude-code/managed-settings.json
 * - Windows: C:\Program Files\ClaudeCode\managed-settings.json
 * @returns {string} The managed-settings.json file path
 */
export function getManagedSettingsPath() {
  const currentPlatform = platform();
  if (currentPlatform === 'win32') {
    return join('C:', 'Program Files', 'ClaudeCode', 'managed-settings.json');
  } else if (currentPlatform === 'darwin') {
    return join('/Library', 'Application Support', 'ClaudeCode', 'managed-settings.json');
  } else {
    return join('/etc', 'claude-code', 'managed-settings.json');
  }
}

/**
 * Get the list of system temporary directory prefixes
 * Supports Windows, macOS, and Linux
 */
export function getTempPathPrefixes() {
  const prefixes = [];

  // 1. Get the system temp directory via os.tmpdir()
  const systemTempDir = tmpdir();
  if (systemTempDir) {
    prefixes.push(normalizePathForComparison(systemTempDir));
  }

  // 2. Windows-specific environment variables
  if (process.platform === 'win32') {
    const winTempVars = ['TEMP', 'TMP', 'LOCALAPPDATA'];
    for (const varName of winTempVars) {
      const value = process.env[varName];
      if (value) {
        prefixes.push(normalizePathForComparison(value));
        // Windows Temp is typically at LOCALAPPDATA\Temp
        if (varName === 'LOCALAPPDATA') {
          prefixes.push(normalizePathForComparison(join(value, 'Temp')));
        }
      }
    }
    // Default Windows temp paths
    prefixes.push('c:\\windows\\temp');
    prefixes.push('c:\\temp');
  } else {
    // Unix/macOS temp path prefixes
    prefixes.push('/tmp');
    prefixes.push('/var/tmp');
    prefixes.push('/private/tmp');

    // Environment variables
    if (process.env.TMPDIR) {
      prefixes.push(normalizePathForComparison(process.env.TMPDIR));
    }
  }

  // Deduplicate
  return [...new Set(prefixes)];
}

/**
 * Normalize a path for comparison purposes.
 * On Windows: converts to lowercase and uses forward slashes.
 * @param {string} pathValue
 * @param {string} [platformId] injectable platform for cross-platform unit
 *   tests (defaults to process.platform) — same convention as cli-path's
 *   forceWindows flag, so darwin/win32 behavior is testable on linux CI.
 * @internal Exposed for unit testing; not part of the public API.
 */
export function normalizePathForComparison(pathValue, platformId = process.platform) {
  if (!pathValue) return '';
  let normalized = pathValue.replace(/\\/g, '/');
  // Windows is case-insensitive by design, and macOS filesystems are
  // case-insensitive by default — "/application support/…" must match
  // "/Application Support/…" or the guards below never fire on macOS.
  if (platformId === 'win32' || platformId === 'darwin') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Sanitize a path candidate.
 * @param {string} candidate - The candidate path
 * @returns {string|null} The normalized path, or null if invalid
 */
export function sanitizePath(candidate) {
  if (!candidate || typeof candidate !== 'string' || candidate.trim() === '') {
    return null;
  }
  try {
    return resolve(candidate.trim());
  } catch {
    return null;
  }
}

/**
 * Check whether a path is inside a temporary directory.
 * @param {string} pathValue - The path to check
 * @returns {boolean}
 */
export function isTempDirectory(pathValue) {
  if (!pathValue) return false;

  const normalizedPath = normalizePathForComparison(pathValue);
  const tempPrefixes = getTempPathPrefixes();

  return tempPrefixes.some(tempPath => {
    if (!tempPath) return false;
    return normalizedPath.startsWith(tempPath) ||
           normalizedPath === tempPath;
  });
}

// Cache the resolved ai-bridge install directory path.
let cachedBridgeDir = null;

/**
 * Resolve the ai-bridge install directory from this module's own location.
 * This file lives at <bridge>/utils/path-utils.js, so the bridge root is one
 * level up from its directory. Deriving it from import.meta.url is reliable
 * regardless of process.cwd(), which the daemon mutates via process.chdir()
 * between turns.
 * @returns {string} The resolved physical ai-bridge directory path
 */
function getBridgeDir() {
  if (cachedBridgeDir) {
    return cachedBridgeDir;
  }
  const bridgeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    // Match getRealHomeDir(): resolve symlinks/junctions so comparisons against
    // a possibly-realpath'd process.cwd() stay consistent.
    cachedBridgeDir = fs.realpathSync(bridgeDir);
  } catch (err) {
    console.warn('[WARN] getBridgeDir: realpathSync failed, using unresolved path:', err.message);
    cachedBridgeDir = bridgeDir;
  }
  return cachedBridgeDir;
}

/**
 * Paths that must never become agy workspaceDirs / process cwd.
 * Plugin install trees, ai-bridge, and ~/.gemini were observed as wrong
 * workspace roots and inflate tool context with unrelated trees.
 *
 * Note: darwin/win32 fold case (normalizePathForComparison), so the
 * lowercase literals match there. Linux does not fold — and must not
 * blanket-fold, case-sensitive Linux filesystems legitimately distinguish
 * `jetbrains` from `JetBrains` — so both the folded (darwin) and the
 * real-case (Linux) spellings are listed. On case-sensitive APFS volumes
 * the darwin folding can over-match; that is accepted — these guards
 * reject known unsafe trees, never auto-select one.
 * @param {string} pathValue
 * @returns {boolean}
 */
export function isUnsafeWorkingDirectory(pathValue, platformId = process.platform) {
  if (!pathValue || typeof pathValue !== 'string') return true;
  const trimmed = pathValue.trim();
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return true;

  const n = normalizePathForComparison(trimmed, platformId);
  if (!n) return true;

  // Inside the actual ai-bridge install tree — anchored to this module's own
  // root (getBridgeDir). The old generic name check rejected ANY project
  // merely living in a directory named "ai-bridge", silently redirecting
  // its cwd for all providers.
  const bridgeDir = normalizePathForComparison(getBridgeDir(), platformId);
  if (bridgeDir && (n === bridgeDir || n.startsWith(`${bridgeDir}/`))) return true;

  // JetBrains plugin / config trees (embedded ai-bridge). Both spellings:
  // folded for darwin/win32, real-case for case-sensitive Linux.
  if (n.includes('/application support/jetbrains/') || n.includes('/Application Support/JetBrains/')) return true;
  if (n.includes('/plugins/idea-claude-code-gui')) return true;
  if (n.includes('/.local/share/jetbrains/') || n.includes('/.local/share/JetBrains/')) return true;
  // Windows JetBrains roots — win32 normalization folds case and slashes, so
  // one lowercase spelling each covers Roaming and Local.
  if (n.includes('/appdata/roaming/jetbrains/') || n.includes('/appdata/local/jetbrains/')) return true;
  // Linux config root — both spellings, like .local/share above.
  if (n.includes('/.config/jetbrains/') || n.includes('/.config/JetBrains/')) return true;

  // Antigravity CLI home — wrong workspaceDirs=[~/.gemini] in production logs.
  if (n.endsWith('/.gemini') || n.includes('/.gemini/')) return true;
  if (n.endsWith('/.gemini/antigravity-cli') || n.includes('/.gemini/antigravity-cli/')) {
    return true;
  }

  return false;
}

/**
 * Intelligently select the working directory.
 * @param {string} requestedCwd - The requested working directory
 * @returns {string} The selected working directory
 */
export function selectWorkingDirectory(requestedCwd) {
  const candidates = [];

  const envProjectPath = process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH;

  if (requestedCwd && requestedCwd !== 'undefined' && requestedCwd !== 'null') {
    candidates.push(requestedCwd);
  }
  if (envProjectPath) {
    candidates.push(envProjectPath);
  }

  candidates.push(process.cwd());
  candidates.push(getRealHomeDir());

  console.log('[DEBUG] selectWorkingDirectory candidates:', JSON.stringify(candidates));

  for (const candidate of candidates) {
    const normalized = sanitizePath(candidate);
    if (!normalized) continue;

    // Never resolve the working directory to the ai-bridge install dir itself
    // (issue #1343). The daemon launches with process.cwd() === the bridge dir,
    // so an empty requestedCwd + missing IDEA_PROJECT_PATH would otherwise land
    // here and make the SDK persist sessions under
    // ~/.claude/projects/<sanitized-bridge-dir>/, hiding every project's history.
    // Also reject JetBrains plugin trees and ~/.gemini (agy workspaceDirs bugs).
    if (isUnsafeWorkingDirectory(normalized)) {
      console.log('[DEBUG] Skipping unsafe working-directory candidate:', normalized);
      continue;
    }

    if (isTempDirectory(normalized) && envProjectPath) {
      console.log('[DEBUG] Skipping temp directory candidate:', normalized);
      continue;
    }

    try {
      const stats = fs.statSync(normalized);
      if (stats.isDirectory()) {
        console.log('[DEBUG] selectWorkingDirectory resolved:', normalized);
        return normalized;
      }
    } catch {
      // Ignore invalid candidates
      console.log('[DEBUG] Candidate is invalid:', normalized);
    }
  }

  console.log('[DEBUG] selectWorkingDirectory fallback triggered');
  // Guard: reject unsafe dirs even from IDEA_PROJECT_PATH (e.g. when the user
  // is developing the bridge itself). The home dir is always a safe fallback.
  const fallback = envProjectPath || getRealHomeDir();
  if (isUnsafeWorkingDirectory(fallback)) {
    console.log('[DEBUG] Fallback env path is unsafe, using home dir instead');
    return getRealHomeDir();
  }
  return fallback;
}
