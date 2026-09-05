/**
 * Shared CLI binary path resolution for headless CLI providers.
 *
 * Priority:
 * 1. Explicit env overrides
 * 2. PATH lookup (`which` / `where`)
 * 3. Common home install candidates
 * 4. Bare binary name fallback
 *
 * Windows note: npm global installs create three shims (`pi`, `pi.cmd`, `pi.ps1`).
 * `where pi` often lists the extensionless bash wrapper first. Node's
 * `spawn()` cannot CreateProcess that file (ENOENT). Prefer `.cmd` / `.exe`
 * and launch `.cmd`/`.bat` via `cmd.exe /d /s /c` (see `resolveCliSpawn`).
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute, win32 as pathWin32 } from 'path';
import { execFileSync, execSync } from 'child_process';

/** Extensions that can be launched on Windows (`.cmd`/`.bat` via cmd.exe). */
const WINDOWS_SPAWNABLE_EXT = /\.(cmd|bat|exe)$/i;
/** Prefer real PE binaries, then cmd shims, over extensionless npm wrappers. */
const WINDOWS_SPAWNABLE_PRIORITY = ['.exe', '.cmd', '.bat'];

function stripOuterQuotes(value) {
  const s = String(value ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Windows npm global installs only ship a `.cmd` / `.bat` shim (no `.exe`),
 * and Node cannot CreateProcess those without going through `cmd.exe`.
 * @param {string} bin - resolved binary path or bare name
 * @returns {boolean}
 */
export function isWindowsCmdShim(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(stripOuterQuotes(bin));
}

/**
 * Quote one argv token for `cmd.exe /s /c`. Doubles quotes and percents so a
 * spaced path or a `%VAR%` fragment cannot be re-parsed / expanded.
 * @param {unknown} value
 * @returns {string}
 */
export function quoteCmdArg(value) {
  return `"${String(value ?? '').replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function prependPathDir(env, dir) {
  if (!dir || dir === '.') return env;
  const current = env.PATH || env.Path || '';
  const parts = current ? current.split(';') : [];
  if (!parts.includes(dir)) parts.unshift(dir);
  const merged = parts.join(';');
  env.PATH = merged;
  env.Path = merged;
  return env;
}

/**
 * Build a spawn/spawnSync invocation that can run Windows npm `.cmd`/`.bat`
 * shims without `shell: true`.
 *
 * Node's `shell: true` concatenates `file + ' ' + args` and does **not** quote
 * `file`. A shim under npm's default prefix (`C:\Program Files\nodejs\opencode.cmd`)
 * is then re-parsed by cmd as `'C:\Program'` (exit code 1). Passing a
 * pre-quoted file into `shell: true` is also fragile: Node wraps the whole
 * command again (`cmd /s /c "…"`), and a second quote pair becomes `""C:\Program`.
 *
 * Instead, launch `cmd.exe /d /s /c` ourselves with `windowsVerbatimArguments`
 * and invoke the shim by **basename** after prepending its directory to PATH.
 * That keeps spaces out of the command token entirely.
 *
 * @param {string} bin
 * @param {string[]} [args]
 * @param {import('child_process').SpawnOptions & { redirectTo?: string }} [extraOptions]
 * @param {boolean} [forceWindows] - test hook; defaults to process.platform === 'win32'
 * @returns {{ file: string, args: string[], options: object }}
 */
export function resolveCliSpawn(
  bin,
  args = [],
  extraOptions = {},
  forceWindows = process.platform === 'win32',
) {
  const { redirectTo, ...options } = extraOptions || {};
  const normalized = stripOuterQuotes(bin);
  const isShim = forceWindows && /\.(cmd|bat)$/i.test(normalized);
  // `.cmd`/`.bat` must go through cmd (CVE-2024-27980). File-redirect
  // recovery for Bun-on-Windows also needs cmd, including `.exe` paths.
  const needsCmd = isShim || (forceWindows && Boolean(redirectTo));

  if (needsCmd) {
    const looksLikePath = pathWin32.isAbsolute(normalized) || /[\\/]/.test(normalized);
    // Invoke shims by basename so `C:\Program Files\...` never appears as the
    // command token. Keep the full path for real `.exe` binaries.
    const invokeName = isShim && looksLikePath ? pathWin32.basename(normalized) : normalized;
    const env = prependPathDir(
      { ...(options.env || process.env) },
      looksLikePath ? pathWin32.dirname(normalized) : '',
    );
    let command = [invokeName, ...args].map(quoteCmdArg).join(' ');
    if (redirectTo) command += ` > ${quoteCmdArg(redirectTo)}`;
    return {
      file: env.ComSpec || env.COMSPEC || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${command}"`],
      options: {
        ...options,
        env,
        shell: false,
        windowsVerbatimArguments: true,
        windowsHide: options.windowsHide !== false,
      },
    };
  }

  return {
    file: normalized,
    args,
    options: {
      ...options,
      ...(forceWindows ? { windowsHide: options.windowsHide !== false } : {}),
    },
  };
}

/**
 * Decode CLI stdout/stderr. Windows `cmd` often emits GBK/CP936, which Node
 * turns into U+FFFD replacement characters when forced to UTF-8.
 * @param {string|Buffer|null|undefined} value
 * @returns {string}
 */
export function decodeCliOutput(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const label of ['gbk', 'gb18030']) {
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      // Node builds without full ICU cannot decode GBK; try the next label.
    }
  }
  return utf8;
}

/**
 * Pick the best match from `where` output lines on Windows.
 * Prefer `.exe` / `.cmd` / `.bat` over extensionless npm bash shims.
 *
 * @param {string[]|null|undefined} matches
 * @returns {string|null}
 */
export function selectWindowsWhereMatch(matches) {
  const lines = (Array.isArray(matches) ? matches : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const hit = lines.find((line) => line.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return lines[0];
}

/**
 * If `bin` is an absolute/relative path without a spawnable Windows extension
 * and a sibling `.exe`/`.cmd`/`.bat` exists, return that sibling.
 *
 * Bare names (`pi`) are left unchanged so PATH+PATHEXT still apply at spawn.
 *
 * @param {string} bin
 * @param {(path: string) => boolean} [existsFn]
 * @param {boolean} [forceWindows] - test hook; defaults to process.platform === 'win32'
 * @returns {string}
 */
export function resolveWindowsSpawnableBin(
  bin,
  existsFn = pathExists,
  forceWindows = process.platform === 'win32',
) {
  if (!forceWindows || typeof bin !== 'string') return bin;
  const trimmed = bin.trim();
  if (!trimmed) return bin;
  if (WINDOWS_SPAWNABLE_EXT.test(trimmed)) return trimmed;

  // Bare command names: let PATHEXT / shell resolve; do not invent a path.
  const looksLikePath = isAbsolute(trimmed)
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || /^[A-Za-z]:/.test(trimmed);
  if (!looksLikePath) return trimmed;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const candidate = `${trimmed}${ext}`;
    if (existsFn(candidate)) return candidate;
  }
  return trimmed;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pathExists(candidate) {
  try {
    return typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Shells allowed for login-env probing: `$SHELL` is attacker-influenced, so only
 * standard system/Homebrew shell binaries may be invoked.
 */
const ALLOWED_LOGIN_SHELLS = new Set([
  '/bin/zsh', '/bin/bash', '/bin/sh',
  '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/sh',
  '/usr/local/bin/zsh', '/usr/local/bin/bash',
  '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/bash',
  '/usr/local/bin/fish', '/opt/homebrew/bin/fish',
]);

/**
 * Resolve a binary through the user's login shell (non-Windows only). Returns
 * an absolute path or null. The binary name is an internal constant; the result
 * is validated against the filesystem before use.
 *
 * @param {string} binaryName
 * @param {string} [shellOverride] - test hook; defaults to allowlisted $SHELL
 * @returns {string|null}
 */
export function whichViaLoginShell(binaryName, shellOverride) {
  if (process.platform === 'win32') return null;
  if (!/^[a-z0-9._-]+$/i.test(String(binaryName || ''))) return null;
  let shell = shellOverride || process.env.SHELL || '';
  if (!ALLOWED_LOGIN_SHELLS.has(shell)) {
    shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((candidate) => pathExists(candidate)) || '';
  }
  if (!shell) return null;
  const fish = shell.endsWith('fish');
  // -l -i: nvm/fnm/mise only export PATH from interactive login rc files.
  const args = fish
    ? ['-c', `command -v ${binaryName}`]
    : ['-l', '-i', '-c', `command -v ${binaryName}`];
  try {
    const output = execFileSync(shell, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
      timeout: 8000,
    });
    const first = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first && first.startsWith('/') && pathExists(first)) return first;
    return null;
  } catch {
    return null;
  }
}

function whichOnPath(binaryName) {
  try {
    if (process.platform === 'win32') {
      // Prefer execFile so the binary name is not re-parsed by a shell.
      // `where` lists every PATHEXT match; the extensionless npm shim is often first
      // and cannot be spawned — selectWindowsWhereMatch prefers .cmd/.exe.
      let output;
      try {
        output = execFileSync('where.exe', [binaryName], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          windowsHide: true,
        });
      } catch {
        // Fallback for systems where where.exe is not on PATH of the IDE process.
        output = execSync(`where ${binaryName}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          windowsHide: true,
        });
      }
      const lines = String(output || '').split(/\r?\n/);
      return selectWindowsWhereMatch(lines);
    }

    const output = execFileSync('which', [binaryName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    const first = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.binaryName - e.g. "grok" | "kimi" | "opencode"
 * @param {string[]} [options.envKeys] - env var names for path override
 * @param {string[]} [options.homeCandidates] - absolute-ish candidates under $HOME
 *   (use `{home}` placeholder or pass full relative segments)
 * @returns {string}
 */
export function resolveCliPath({ binaryName, envKeys = [], homeCandidates = [] }) {
  const win = process.platform === 'win32';
  // npm global installs on Windows ship `.cmd` shims, not `.exe`.
  const exeNames = win
    ? [`${binaryName}.cmd`, `${binaryName}.bat`, `${binaryName}.exe`, binaryName]
    : [binaryName];

  const envOverride = firstNonEmpty(...envKeys.map((key) => process.env[key]));
  if (envOverride) {
    return resolveWindowsSpawnableBin(envOverride);
  }

  // `where <name>` (no extension) honors PATHEXT; we then prefer .cmd/.exe.
  const fromPath = whichOnPath(binaryName);
  if (fromPath) return resolveWindowsSpawnableBin(fromPath);

  const home = homedir();
  for (const template of homeCandidates) {
    for (const exeName of exeNames) {
      const resolved = template
        .replace('{home}', home)
        .replace('{localAppData}', process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
        .replace('{bin}', exeName)
        .replace('{name}', binaryName);
      if (pathExists(resolved)) return resolveWindowsSpawnableBin(resolved);
    }
  }

  // Version managers (nvm/fnm/mise/asdf) and other well-known bin dirs. This
  // must stay in sync with the spawn PATH enrichment in commonCliBinDirs so a
  // resolved path can actually launch.
  for (const dir of commonCliBinDirs(home)) {
    for (const exeName of exeNames) {
      const resolved = join(dir, exeName);
      if (pathExists(resolved)) return resolveWindowsSpawnableBin(resolved);
    }
  }

  // Last resort: the user's login shell. IDE/daemon processes can run with a
  // minimal PATH, so CLIs installed via nvm/fnm/mise/asdf or custom prefixes
  // only become visible once the login rc files are sourced.
  const fromShell = whichViaLoginShell(binaryName);
  if (fromShell) return resolveWindowsSpawnableBin(fromShell);

  return binaryName;
}

/**
 * Prepend extra bin dirs to PATH when missing (IDE PATH is often sparse).
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} binDirs
 */
export function enrichPathWithBinDirs(env, binDirs = []) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  let current = env[pathKey] || env.PATH || '';
  const parts = current ? current.split(sep) : [];
  for (const dir of binDirs) {
    if (dir && !parts.includes(dir)) {
      parts.unshift(dir);
    }
  }
  env[pathKey] = parts.join(sep);
  if (pathKey !== 'PATH') {
    env.PATH = env[pathKey];
  }
}

export function resolveGrokCliPath() {
  return resolveCliPath({
    binaryName: 'grok',
    envKeys: ['GROK_BIN', 'GROK_PATH', 'GROK_CLI_PATH'],
    homeCandidates: [
      '{home}/.grok/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}

/**
 * Node version-manager global bin dirs. IDEs launched from Finder/launchd get
 * a sparse PATH, so npm CLIs installed under nvm/fnm/mise/asdf version dirs are
 * invisible unless the login shell is sourced — and the login-shell fallback is
 * fragile (slow or stdin-blocking rc files). Scan the well-known roots directly.
 *
 * Each dir also contains its own `node`, so adding these to the spawn PATH lets
 * `#!/usr/bin/env node` npm shims launch. Newest versions first.
 *
 * @param {string} [home]
 * @returns {string[]}
 */
export function versionManagerBinDirs(home = homedir()) {
  const dirs = [];
  if (!home) return dirs;
  if (process.platform === 'win32') return dirs;
  // Static single-node managers (bin dir sits next to the managed node).
  dirs.push(
    join(home, '.hermes', 'node', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.fnm', 'aliases', 'default', 'bin'),
    join(home, '.nvmd', 'bin'),
  );
  // Per-version managers: one global bin dir per installed node version.
  const versionedRoots = [
    { root: join(home, '.nvm', 'versions', 'node'), binSub: ['bin'] },
    { root: join(home, '.local', 'share', 'fnm', 'node-versions'), binSub: ['installation', 'bin'] },
    { root: join(home, '.local', 'share', 'mise', 'installs', 'node'), binSub: ['bin'] },
    { root: join(home, '.asdf', 'installs', 'nodejs'), binSub: ['bin'] },
  ];
  for (const { root, binSub } of versionedRoots) {
    for (const version of listVersionDirsDesc(root)) {
      dirs.push(join(root, version, ...binSub));
    }
  }
  return dirs;
}

/** Directory names under `root` that look like versions, newest first. */
function listVersionDirsDesc(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => /\d/.test(name))
    .sort(compareVersionNamesDesc);
}

/** Numeric-descending compare for names like `v22.22.3` / `24.11.1`. */
function compareVersionNamesDesc(a, b) {
  const pa = a.split(/\D+/).filter(Boolean).map(Number);
  const pb = b.split(/\D+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Common user-level CLI install dirs (IDE PATH is often sparse / no login shell).
 * Used both for binary resolution and spawn PATH enrichment.
 */
export function commonCliBinDirs(home = homedir()) {
  const dirs = [];
  if (!home) return dirs;
  dirs.push(
    join(home, '.kimi-code', 'bin'),
    join(home, '.kimi', 'bin'),
    join(home, '.moonshot', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.local', 'share', 'opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.pi', 'bin'),
    join(home, '.omp', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.minimax', 'bin'),
    join(home, '.minimax-code'),
    join(home, '.claude', 'bin'),
    join(home, '.yarn', 'bin'),
    // pnpm global installs (PNPM_HOME defaults per platform)
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
  );
  // Version-manager dirs carry both the npm-installed CLI shims and the `node`
  // those `#!/usr/bin/env node` shims need at spawn time.
  dirs.push(...versionManagerBinDirs(home));
  if (process.platform === 'win32') {
    // npm global bin dir on Windows (e.g. C:\Users\<user>\AppData\Roaming\npm).
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    dirs.push(join(appData, 'npm'));
    // OMP Windows native installer (e.g. C:\Users\<user>\AppData\Local\omp).
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(localAppData, 'omp'));
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    dirs.push(join(programFiles, 'nodejs'));
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (programFilesX86) dirs.push(join(programFilesX86, 'nodejs'));
  }
  return dirs;
}

export function resolveKimiCliPath() {
  return resolveCliPath({
    binaryName: 'kimi',
    envKeys: ['KIMI_BIN', 'KIMI_PATH', 'KIMI_CLI_PATH', 'KIMI_CODE_BIN'],
    homeCandidates: [
      // Official kimi-code install location (current)
      '{home}/.kimi-code/bin/{bin}',
      '{home}/.local/bin/{bin}',
      // Legacy install paths
      '{home}/.kimi/bin/{bin}',
      '{home}/.moonshot/bin/{bin}',
    ],
  });
}

export function resolveOpenCodeCliPath() {
  return resolveCliPath({
    binaryName: 'opencode',
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    homeCandidates: [
      '{home}/.opencode/bin/{bin}',
      '{home}/.local/bin/{bin}',
      '{home}/.local/share/opencode/bin/{bin}',
    ],
  });
}

export function resolvePiCliPath() {
  return resolveCliPath({
    binaryName: 'pi',
    envKeys: ['PI_BIN', 'PI_PATH', 'PI_CLI_PATH'],
    homeCandidates: [
      '{home}/.pi/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}

export function resolveOmpCliPath() {
  return resolveCliPath({
    binaryName: 'omp',
    envKeys: ['OMP_BIN', 'OMP_PATH', 'OMP_CLI_PATH'],
    homeCandidates: [
      '{home}/.omp/bin/{bin}',
      '{home}/.bun/bin/{bin}',
      // Windows native installer: %LOCALAPPDATA%\omp\omp.exe
      '{localAppData}/omp/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
}
/**
 * Resolve the Node.js entry point for a globally installed CodeBuddy CLI.
 *
 * The Agent SDK expects the extensionless `bin/codebuddy` entry point (it
 * launches that file with Node and maps it to the headless bundle). Passing
 * npm's `codebuddy.cmd` shim would make Node try to parse the batch file.
 */
export function resolveCodeBuddyCliPath() {
  const envOverride = firstNonEmpty(process.env.CODEBUDDY_CODE_PATH);
  if (envOverride && pathExists(envOverride)) {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(envOverride)) {
      const scriptPath = envOverride.replace(/\.(cmd|bat)$/i, '');
      if (pathExists(scriptPath)) return scriptPath;
    }
    return envOverride;
  }

  const home = homedir();
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const npmPrefix = firstNonEmpty(process.env.npm_config_prefix);
  const candidates = [
    join(appData, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    npmPrefix && join(npmPrefix, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    join(home, '.npm-global', 'lib', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    join(home, '.local', 'lib', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    ...(process.platform !== 'win32' ? [
      join('/usr/local', 'lib', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
      join('/opt/homebrew', 'lib', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    ] : []),
  ].filter(Boolean);

  return candidates.find(pathExists) || null;

}


export function resolveMiniMaxCliPath() {
  // Official installer exposes `minimax`; npm global installs expose `mcode`.
  // Try the official name first, then fall back to the npm bin name.
  const envKeys = ['MINIMAX_BIN', 'MINIMAX_PATH', 'MINIMAX_CLI_PATH', 'MCODE_BIN'];
  const minimax = resolveCliPath({
    binaryName: 'minimax',
    envKeys,
    homeCandidates: [
      '{home}/.minimax/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
  if (minimax !== 'minimax') {
    return minimax;
  }
  const mcode = resolveCliPath({
    binaryName: 'mcode',
    envKeys,
    homeCandidates: [
      '{home}/.minimax-code/{bin}',
      '{home}/.minimax/bin/{bin}',
      '{home}/.local/bin/{bin}',
    ],
  });
  // resolveCliPath returns the bare name when nothing resolved; prefer mcode's
  // result (it may be a real path) and only fall back to `minimax` at the very end.
  return mcode !== 'mcode' ? mcode : minimax;
}
