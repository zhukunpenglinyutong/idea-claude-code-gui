/**
 * Discover MiMo Code models via `mimo models`.
 * MiMo Code is an OpenCode fork, so output lines look like: `provider/model-id`.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  commonCliBinDirs,
  decodeCliOutput,
  enrichPathWithBinDirs,
  resolveCliSpawn,
  resolveMimoCliPath,
} from '../../utils/cli-path.js';

function stripAnsi(input) {
  return String(input || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function formatLabel(fullId) {
  // MiMo model ids are already readable (e.g. blueswords/gpt-5.6-luna) — the
  // generic title-casing mangles them ("gpt" → "Gpt"), so keep the raw id.
  const trimmed = String(fullId || '').trim();
  return trimmed || 'MiMo';
}

/**
 * A model id looks like `provider/model`. Reject Windows paths (`C:/...`),
 * URLs, and UNC-ish tokens so noisy CLI output cannot become a bogus model.
 * @param {string} part
 * @returns {boolean}
 */
function isModelIdToken(part) {
  if (!part || !part.includes('/')) return false;
  if (/^[a-z]:[\/\\]/i.test(part)) return false;
  if (/^https?:\/\//i.test(part)) return false;
  if (part.includes('\\')) return false;
  return /^[\w.-]+\/[\w./-]+$/.test(part);
}

/**
 * Parse `mimo models` stdout into model entries.
 * @param {string} stdout
 * @returns {{ id: string, label: string, description?: string }[]}
 */
export function parseMimoModelsOutput(stdout) {
  const clean = stripAnsi(stdout);
  const seen = new Set();
  const models = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const token = line.split(/\s+/).find(isModelIdToken);
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
 * Windows fallback: some Bun-compiled binaries lose piped stdout entirely when
 * spawned non-TTY. Redirecting through cmd's file handle (`mimo models > file`)
 * bypasses the pipe path.
 *
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} raw file content, '' on any failure
 */
export function runModelsViaTempRedirect(bin, env) {
  // mkdtemp gives an unpredictable, exclusively-owned directory (CWE-377): a
  // predictable tmpdir path would let another local process pre-create or
  // symlink the redirect target.
  const tmpDir = mkdtempSync(join(tmpdir(), 'cc-gui-mimo-models-'));
  const tmpFile = join(tmpDir, 'models.txt');
  try {
    const invocation = resolveCliSpawn(bin, ['models'], {
      env,
      timeout: 45_000,
      stdio: ['ignore', 'ignore', 'ignore'],
      redirectTo: tmpFile,
    });
    spawnSync(invocation.file, invocation.args, invocation.options);
    return readFileSync(tmpFile, 'utf8');
  } catch {
    return '';
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * List models available to the local MiMo Code CLI.
 * Prints a single JSON object to stdout (for channel-manager listModels).
 */
export function listModels() {
  const bin = resolveMimoCliPath();
  const env = { ...process.env };
  enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));

  let result;
  try {
    const invocation = resolveCliSpawn(bin, ['models'], {
      env,
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
    });
    result = spawnSync(invocation.file, invocation.args, invocation.options);
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error?.message || String(error),
      models: [],
    }));
    return;
  }

  const stdout = decodeCliOutput(result.stdout);
  const stderr = decodeCliOutput(result.stderr);

  if (result.error) {
    const hint = result.error.code === 'ENOENT'
      ? 'MiMo Code CLI not found. Install it and ensure `mimo` is on PATH (or set MIMO_BIN).'
      : (result.error.message || String(result.error));
    console.log(JSON.stringify({ success: false, error: hint, models: [] }));
    return;
  }

  let models = parseMimoModelsOutput(stdout);
  let source = models.length > 0 ? 'stdout' : null;

  // Some builds emit the list on stderr instead of stdout.
  if (models.length === 0 && stderr) {
    models = parseMimoModelsOutput(stderr);
    if (models.length > 0) source = 'stderr';
  }

  // Windows: piped stdout can come back empty (or the first spawn can fail
  // with a quoting error) even when the CLI works in a terminal — retry once
  // through cmd file redirection before surfacing the failure.
  if (models.length === 0 && process.platform === 'win32') {
    const fromFile = parseMimoModelsOutput(runModelsViaTempRedirect(bin, env));
    if (fromFile.length > 0) {
      models = fromFile;
      source = result.status === 0 ? 'file-redirect' : 'file-redirect-after-error';
    }
  }

  if (result.status !== 0 && models.length === 0) {
    const errTail = stderr.trim().slice(-800);
    console.log(JSON.stringify({
      success: false,
      error: `mimo models failed (code ${result.status})${errTail ? `: ${errTail}` : ''}`,
      models: [],
    }));
    return;
  }

  if (models.length === 0) {
    // Keep a default entry so UI always has a selectable fallback. Attach the
    // raw output tails so support can tell "no providers configured" apart
    // from "output lost on Windows pipes" from the IDE log.
    models.push({
      id: 'mimo-default',
      label: 'MiMo Default',
      description: 'Use MiMo Code CLI default model',
    });
  }

  const payload = { success: true, provider: 'mimo', models };
  const usedDefaultFallback = models.length === 1 && models[0].id === 'mimo-default';
  if (usedDefaultFallback) {
    // Surfaces in the IDE log via CliModelsHandler — key for telling
    // "no providers configured" apart from "output lost on Windows pipes".
    payload.debug = {
      reason: 'no-models-parsed',
      status: result.status,
      stdoutTail: stdout.slice(-500),
      stderrTail: stderr.slice(-500),
    };
  } else if (source && source !== 'stdout') {
    payload.debug = { modelsSource: source };
  }
  console.log(JSON.stringify(payload));
}
