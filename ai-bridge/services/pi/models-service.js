/**
 * Discover PI models via `pi --list-models`.
 * Output is a fixed-width table:
 *   provider     model             context  max-out  thinking  images
 *   anthropic    claude-sonnet-5   200.0K   64.0K    yes       yes
 */

import { spawnSync } from 'child_process';
import { homedir } from 'os';
import {
  commonCliBinDirs,
  enrichPathWithBinDirs,
  isWindowsCmdShim,
  quoteWindowsShellBin,
  resolvePiCliPath,
} from '../../utils/cli-path.js';

function stripAnsi(input) {
  return String(input || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Parse `pi --list-models` stdout into model entries.
 * @param {string} stdout
 * @returns {{ id: string, label: string, description?: string }[]}
 */
export function parsePiModelsOutput(stdout) {
  const clean = stripAnsi(stdout);
  const seen = new Set();
  const models = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Columns are separated by 2+ spaces; provider/model must not contain spaces.
    const columns = line.split(/\s{2,}/).map((col) => col.trim()).filter(Boolean);
    if (columns.length < 2) continue;
    const [provider, model] = columns;
    // Skip the header row.
    if (provider === 'provider' && model === 'model') continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const [context, maxOut, thinking, images] = columns.slice(2);
    const details = [];
    if (context) details.push(`ctx ${context}`);
    if (thinking === 'yes') details.push('thinking');
    if (images === 'yes') details.push('vision');
    models.push({
      id,
      label: id,
      description: details.length > 0 ? details.join(' · ') : maxOut || id,
    });
  }
  return models;
}

/**
 * List models available to the local PI CLI.
 * Prints a single JSON object to stdout (for channel-manager listModels).
 */
export function listModels() {
  const bin = resolvePiCliPath();
  const env = { ...process.env };
  enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));

  let result;
  try {
    // Quote spaced paths for the shell spawn (see quoteWindowsShellBin, #1665).
    const needsShell = isWindowsCmdShim(bin);
    result = spawnSync(needsShell ? quoteWindowsShellBin(bin) : bin, ['--list-models'], {
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
      ? 'PI CLI not found. Install it and ensure `pi` is on PATH (or set PI_BIN).'
      : (result.error.message || String(result.error));
    console.log(JSON.stringify({ success: false, error: hint, models: [] }));
    return;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().slice(-800);
    console.log(JSON.stringify({
      success: false,
      error: `pi --list-models failed (code ${result.status})${stderr ? `: ${stderr}` : ''}`,
      models: [],
    }));
    return;
  }

  const models = parsePiModelsOutput(result.stdout || '');
  // Keep a default entry so UI always has a selectable fallback.
  if (models.length === 0) {
    models.push({
      id: 'auto',
      label: 'PI Auto',
      description: 'Use PI CLI default model',
    });
  }

  console.log(JSON.stringify({ success: true, provider: 'pi', models }));
}
