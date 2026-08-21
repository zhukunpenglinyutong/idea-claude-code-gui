/**
 * Discover OpenCode models via `opencode models`.
 * Output lines look like: `opencode/big-pickle`, `anthropic/claude-fable-5`
 */

import { spawnSync } from 'child_process';
import { homedir } from 'os';
import {
  commonCliBinDirs,
  enrichPathWithBinDirs,
  isWindowsCmdShim,
  quoteWindowsShellBin,
  resolveOpenCodeCliPath,
} from '../../utils/cli-path.js';

function stripAnsi(input) {
  return String(input || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function formatLabel(fullId) {
  const trimmed = String(fullId || '').trim();
  if (!trimmed) return 'OpenCode';
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return trimmed;
  const provider = trimmed.slice(0, slash);
  const model = trimmed.slice(slash + 1);
  // Title-case-ish for display; keep provider prefix like the desktop client.
  const prettyModel = model
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('-');
  return `${provider}/${prettyModel}`;
}

/**
 * Parse `opencode models` stdout into model entries.
 * @param {string} stdout
 * @returns {{ id: string, label: string, description?: string }[]}
 */
export function parseOpenCodeModelsOutput(stdout) {
  const clean = stripAnsi(stdout);
  const seen = new Set();
  const models = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const token = line.split(/\s+/).find((part) => part.includes('/'));
    if (!token || seen.has(token)) continue;
    seen.add(token);
    models.push({
      id: token,
      label: formatLabel(token),
      description: token,
    });
  }
  return models;
}

/**
 * List models available to the local OpenCode CLI.
 * Prints a single JSON object to stdout (for channel-manager listModels).
 */
export function listModels() {
  const bin = resolveOpenCodeCliPath();
  const env = { ...process.env };
  enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));

  let result;
  try {
    // Quote spaced paths for the shell spawn (see quoteWindowsShellBin, #1665).
    const needsShell = isWindowsCmdShim(bin);
    result = spawnSync(needsShell ? quoteWindowsShellBin(bin) : bin, ['models'], {
      encoding: 'utf8',
      env,
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
      // Windows npm `.cmd` shims require a shell to spawn.
      shell: needsShell,
    });
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error?.message || String(error),
      models: [],
    }));
    return;
  }

  if (result.error) {
    const hint = result.error.code === 'ENOENT'
      ? 'OpenCode CLI not found. Install it and ensure `opencode` is on PATH (or set OPENCODE_BIN).'
      : (result.error.message || String(result.error));
    console.log(JSON.stringify({ success: false, error: hint, models: [] }));
    return;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().slice(-800);
    console.log(JSON.stringify({
      success: false,
      error: `opencode models failed (code ${result.status})${stderr ? `: ${stderr}` : ''}`,
      models: [],
    }));
    return;
  }

  const models = parseOpenCodeModelsOutput(result.stdout || '');
  // Keep a default entry so UI always has a selectable fallback.
  if (models.length === 0) {
    models.push({
      id: 'opencode-default',
      label: 'OpenCode Default',
      description: 'Use OpenCode CLI default model',
    });
  }

  console.log(JSON.stringify({ success: true, provider: 'opencode', models }));
}
