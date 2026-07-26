/**
 * Path safety utilities for permission checks.
 * Handles path rewriting (/tmp → project root) and dangerous path detection.
 */
import { basename, resolve, sep } from 'path';
import { getRealHomeDir } from './utils/path-utils.js';

const TEMP_PATH_PREFIXES = ['/tmp', '/var/tmp', '/private/tmp'];

export function getProjectRoot() {
  return process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH || process.cwd();
}

/**
 * Rewrite tool input paths from /tmp to the project root directory.
 * @param {string} toolName - Tool name (for logging)
 * @param {Object} input - Tool parameters (mutated in place)
 * @returns {{ changed: boolean }} - Whether any paths were rewritten
 */
export function rewriteToolInputPaths(toolName, input) {
  const projectRoot = getProjectRoot();
  if (!projectRoot || !input || typeof input !== 'object') {
    return { changed: false };
  }

  const prefixes = [...TEMP_PATH_PREFIXES];
  if (process.env.TMPDIR) {
    prefixes.push(process.env.TMPDIR);
  }

  const rewrites = [];

  const rewritePath = (pathValue) => {
    if (typeof pathValue !== 'string') return pathValue;
    const matchedPrefix = prefixes.find(prefix => prefix && pathValue.startsWith(prefix));
    if (!matchedPrefix) return pathValue;

    let relative = pathValue.slice(matchedPrefix.length).replace(/^\/+/, '');
    if (!relative) {
      relative = basename(pathValue);
    }
    const sanitized = resolve(projectRoot, relative);

    // Verify the resolved path is still within the project root
    const resolvedRoot = resolve(projectRoot);
    if (!sanitized.startsWith(resolvedRoot + sep) && sanitized !== resolvedRoot) {
      console.error(`[PERMISSION][PATH_REWRITE_BLOCKED] Rewritten path escaped project root: ${pathValue} → ${sanitized} (root: ${resolvedRoot})`);
      return pathValue;
    }

    rewrites.push({ from: pathValue, to: sanitized });
    return sanitized;
  };

  const traverse = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(traverse);
      return;
    }
    if (typeof value === 'object') {
      if (typeof value.file_path === 'string') {
        value.file_path = rewritePath(value.file_path);
      }
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (child && typeof child === 'object') {
          traverse(child);
        }
      }
    }
  };

  traverse(input);

  if (rewrites.length > 0) {
    console.error(`[PERMISSION] Rewrote paths for ${toolName}:`, JSON.stringify(rewrites));
  }

  return { changed: rewrites.length > 0 };
}

// ========== acceptEdits CWD path validation ==========
// Matches CLI's filesystem.ts: pathInAllowedWorkingPath + checkPathSafetyForAutoEdit

// Files that should NOT be auto-edited even within CWD (matches CLI's DANGEROUS_FILES/DIRECTORIES)
const DANGEROUS_AUTO_EDIT_FILES = new Set([
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc',
  '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.claude.json',
]);

const DANGEROUS_AUTO_EDIT_DIRS = new Set([
  '.git', '.vscode', '.idea', '.claude',
]);

/**
 * Check if a file path is within the allowed working directory.
 * Matches CLI's pathInAllowedWorkingPath (filesystem.ts:683-707).
 * @param {string} filePath - Absolute file path to check
 * @param {string} cwd - Working directory
 * @param {string[]} [additionalDirs] - Additional allowed directories
 * @returns {boolean}
 */
export function isPathInWorkingDirectory(filePath, cwd, additionalDirs = []) {
  if (!filePath || !cwd) return false;

  const resolvedPath = resolve(filePath);
  const allowedDirs = [cwd, ...additionalDirs].filter(Boolean).map(d => resolve(d));

  return allowedDirs.some(dir => {
    if (resolvedPath === dir) return true;
    return resolvedPath.startsWith(dir + sep);
  });
}

/**
 * Check if a file path is safe for auto-edit in acceptEdits mode.
 * Matches CLI's checkPathSafetyForAutoEdit (filesystem.ts:620-665).
 * Returns false for dangerous config files and directories even if inside CWD.
 * @param {string} filePath - Absolute file path to check
 * @returns {{ safe: boolean, message?: string }}
 */
export function checkPathSafetyForAutoEdit(filePath) {
  if (!filePath) return { safe: false, message: 'No file path provided' };

  const resolvedPath = resolve(filePath);
  const parts = resolvedPath.split(sep);
  const fileName = parts[parts.length - 1];

  // Check if file is in a dangerous directory (e.g. .git/, .vscode/, .idea/, .claude/)
  for (const part of parts) {
    if (DANGEROUS_AUTO_EDIT_DIRS.has(part)) {
      return { safe: false, message: `Auto-edit not allowed in ${part}/ directory` };
    }
  }

  // Check if file itself is a dangerous config file
  if (DANGEROUS_AUTO_EDIT_FILES.has(fileName)) {
    return { safe: false, message: `Auto-edit not allowed for ${fileName}` };
  }

  return { safe: true };
}

/**
 * Full acceptEdits path validation: CWD check + safety check.
 * Returns true only if the path is within CWD AND passes safety checks.
 * @param {string} filePath - File path from tool input
 * @param {string} cwd - Working directory
 * @param {string[]} [additionalDirs] - Additional allowed directories
 * @returns {boolean}
 */
export function isAcceptEditsAllowed(filePath, cwd, additionalDirs) {
  if (!filePath || !cwd) return false;
  const safety = checkPathSafetyForAutoEdit(filePath);
  if (!safety.safe) return false;
  return isPathInWorkingDirectory(filePath, cwd, additionalDirs);
}

/**
 * Check whether a file path matches any known dangerous pattern.
 * @param {string} filePath - The path to check
 * @returns {boolean} - true if the path is dangerous and should be denied
 */
export function isDangerousPath(filePath) {
  if (!filePath) return false;

  const userHomeDir = getRealHomeDir();
  const isWindows = process.platform === 'win32';

  const dangerousPatterns = [
    // Unix/macOS system paths
    '/etc/',
    '/System/',
    '/usr/',
    '/bin/',
    '/sbin/',
    // User-sensitive directories (credentials, config)
    `${userHomeDir}/.ssh/`,
    `${userHomeDir}/.aws/`,
    `${userHomeDir}/.gnupg/`,
    `${userHomeDir}/.kube/`,
    `${userHomeDir}/.docker/`,
    `${userHomeDir}/.config/`,
    `${userHomeDir}/.local/`,
    `${userHomeDir}/.claude/.credentials.json`,
  ];

  if (isWindows) {
    dangerousPatterns.push(
      'C:\\Windows\\',
      'C:\\Program Files\\',
      'C:\\Program Files (x86)\\',
      `${userHomeDir}\\.ssh\\`,
      `${userHomeDir}\\.aws\\`,
      `${userHomeDir}\\.gnupg\\`,
      `${userHomeDir}\\.kube\\`,
      `${userHomeDir}\\.docker\\`,
      `${userHomeDir}\\AppData\\`,
      `${userHomeDir}\\.config\\`,
      `${userHomeDir}\\.local\\`,
    );
  }

  // Security (K): expand a leading ~ to the real home dir so shell-style references such as
  // "cat ~/.ssh/id_rsa" inside a Bash command are matched, not only absolute paths.
  let expandedPath = String(filePath);
  if (userHomeDir) {
    expandedPath = expandedPath.split('~/').join(`${userHomeDir}/`);
    if (isWindows) {
      expandedPath = expandedPath.split('~\\').join(`${userHomeDir}\\`);
    }
  }
  const normalizedPath = isWindows ? expandedPath.toLowerCase() : expandedPath;
  for (const pattern of dangerousPatterns) {
    const normalizedPattern = isWindows ? pattern.toLowerCase() : pattern;
    if (normalizedPath.includes(normalizedPattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Collect all filesystem path-like strings from a tool input, including Bash command
 * strings, so dangerous-path checks cover more than just file_path/path. (Security K)
 * @param {string} toolName - tool name (reserved for future per-tool extraction)
 * @param {Object} input - tool input object
 * @returns {string[]} candidate path/command strings to screen with isDangerousPath
 */
export function collectToolInputPaths(toolName, input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const push = (v) => { if (typeof v === 'string' && v) out.push(v); };
  push(input.file_path);
  push(input.path);
  push(input.notebook_path);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (edit && typeof edit === 'object') { push(edit.file_path); push(edit.path); }
    }
  }
  // Bash / shell command strings carry their target paths inline.
  push(input.command);
  return out;
}
