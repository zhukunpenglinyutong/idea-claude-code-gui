/**
 * Spawn Antigravity CLI headless turn and parse stream-json NDJSON from stdout.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import {
  resolveAgyBinary,
  buildAgyArgs,
  buildAgyEnv,
  resolveAgySpawnModel,
  getCachedAgyModelFamilies,
} from './agy-utils.js';
import { selectWorkingDirectory, isUnsafeWorkingDirectory } from '../../utils/path-utils.js';
import { resolveCliSpawn } from '../../utils/cli-path.js';

/**
 * Run one agy headless turn.
 *
 * @param {object} options
 * @param {(obj: object) => void} options.onEvent - parsed NDJSON event
 * @param {(chunk: string) => void} [options.onStderr]
 * @returns {Promise<{ conversationId: string, status: string, response: string, usage: object|null, error: string|null, exitCode: number }>}
 */
export function runAgyTurn(options = {}) {
  const {
    message = '',
    sessionId = '',
    cwd = '',
    model = '',
    reasoningEffort = '',
    agent = '',
    permissionMode = '',
    printTimeout = '',
    addDirs = [],
    env: envOverride = null,
    onEvent = () => {},
    onStderr = () => {},
  } = options;

  const bin = resolveAgyBinary();
  if (!bin) {
    // Setups that followed the old spec silently lose their GEMINI_CLI_PATH
    // override — point them at the cause instead of a bare "not found".
    const ignoredHint = (process.env.GEMINI_CLI_PATH || '').trim()
      ? ' GEMINI_CLI_PATH is deliberately ignored (it names Google\'s gemini CLI); use AGY_PATH or AGY_CLI_PATH.'
      : '';
    return Promise.reject(new Error(
      'Antigravity CLI (agy) not found. Install from https://antigravity.google/docs/cli/install '
      + `or set AGY_PATH (or AGY_CLI_PATH) to the agy binary.${ignoredHint}`
    ));
  }

  // Resolve family base (gemini-3.6-flash) → full catalog slug. The families
  // catalog picks a tier the family actually offers (the default varies by
  // family); the send path warms it via warmAgyModelCatalogForModel — the
  // one-shot channel-manager process never sees a listModels process's cache,
  // while the long-lived daemon keeps the module cache until restart (no TTL
  // — staleness is tracked in deferred-work). Without a warm catalog we guess
  // a -high suffix.
  // Never pass a separate --effort: bare slugs like claude-sonnet-4-6 reject it,
  // and effort-required families are selected via the full --model slug.
  const resolved = resolveAgySpawnModel(model, reasoningEffort, getCachedAgyModelFamilies());
  const modelStr = resolved.model;
  // Guard against plugin/ai-bridge/~/.gemini paths becoming workspaceDirs.
  const workCwd = selectWorkingDirectory(cwd);

  const effectiveAddDirs = Array.isArray(addDirs) ? [...addDirs] : [];
  if (workCwd && !isUnsafeWorkingDirectory(workCwd) && !effectiveAddDirs.includes(workCwd)) {
    effectiveAddDirs.push(workCwd);
  }

  const args = buildAgyArgs({
    message,
    conversationId: sessionId,
    model: modelStr,
    effort: '',
    agent,
    permissionMode,
    printTimeout,
    addDirs: effectiveAddDirs,
  });

  const env = buildAgyEnv(envOverride || process.env);

  // Avoid logging full prompt body (-p value)
  const safeArgs = args.map((a, i) => (i > 0 && args[i - 1] === '-p' ? '<prompt>' : a));
  console.error('[AGY] spawn', bin, safeArgs.join(' '), 'cwd=' + workCwd);

  return new Promise((resolve, reject) => {
    let settled = false;
    let conversationId = sessionId || '';
    let status = '';
    let response = '';
    let usage = null;
    let resultError = null;
    let stderrBuf = '';

    // A discovered Windows `agy.cmd` shim cannot be spawned directly (Node's
    // CVE-2024-27980 patch throws EINVAL) — resolveCliSpawn routes .cmd/.bat
    // through `cmd.exe /d /s /c`, the same wrapper the pi/opencode/dsh
    // providers use; on posix it is a passthrough (same file/args/options).
    const invocation = resolveCliSpawn(bin, args, {
      cwd: workCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const child = spawn(invocation.file, invocation.args, invocation.options);

    const cleanupChild = () => {
      killProcessGroup(child);
    };
    // Per-turn shutdown hooks. They MUST be removed when the turn settles —
    // stacked handlers from earlier turns all run on the next signal, and
    // each one's process.exit(0) preempts the daemon's graceful shutdown.
    const onExit = () => cleanupChild();
    const onSigterm = () => { cleanupChild(); process.exit(0); };
    const onSigint = () => { cleanupChild(); process.exit(0); };
    process.on('exit', onExit);
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
    const removeProcessListeners = () => {
      process.removeListener('exit', onExit);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    };

    const timeoutMs = options.turnTimeoutMs != null
      ? Number(options.turnTimeoutMs)
      : 15 * 60 * 1000; // 15-minute default IDLE window

    // Idle watchdog, not a total turn cap: re-armed on every stdout line and
    // stderr chunk. A hard cap kills legitimately long turns (builds, emulator
    // sessions) while the CLI is still streaming; the watchdog exists to reap
    // HUNG turns (auth prompt, stuck pipe) — those stop producing output.
    let timeoutTimer = null;
    const disarmWatchdog = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };
    const armWatchdog = () => {
      if (settled || !(timeoutMs > 0)) return;
      disarmWatchdog();
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        console.error(`[AGY] Watchdog: no output for ${Math.round(timeoutMs / 1000)}s — terminating process group ${child.pid}`);
        settled = true;
        killProcessGroup(child);
        rl.close();
        removeProcessListeners();
        reject(new Error(
          `Antigravity CLI (agy) turn timed out: no output for ${Math.round(timeoutMs / 60000)} minutes.`
          + ' If the agent is mid-way through a long silent task (like starting an emulator), run it in background with output redirected (e.g. `nohup emulator @nexus > /dev/null 2>&1 &`).'
        ));
      }, timeoutMs);
    };
    armWatchdog();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on('line', (line) => {
      armWatchdog(); // any output line proves the turn is alive
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('{')) {
        console.error('[AGY-STDOUT-NONJSON]', trimmed.slice(0, 200));
        return;
      }
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        console.error('[AGY-STDOUT-PARSE]', trimmed.slice(0, 200));
        return;
      }

      try {
        onEvent(obj);
      } catch (e) {
        console.error('[AGY-ONEVENT]', e?.message || e);
      }

      if (obj.event === 'init' && obj.conversation_id) {
        conversationId = obj.conversation_id;
      }
      if (obj.event === 'result' && obj.result) {
        const r = obj.result;
        conversationId = r.conversation_id || conversationId;
        status = r.status || status;
        response = r.response != null ? String(r.response) : response;
        usage = r.usage || usage;
        if (r.error) resultError = String(r.error);
      }
      if (!obj.event && obj.conversation_id && obj.status) {
        conversationId = obj.conversation_id;
        status = obj.status;
        response = obj.response != null ? String(obj.response) : response;
        usage = obj.usage || usage;
        if (obj.error) resultError = String(obj.error);
        onEvent({ event: 'result', result: obj });
      }
    });

    child.stderr.on('data', (buf) => {
      armWatchdog(); // stderr chatter is liveness too (progress, deprecation notes)
      const s = buf.toString('utf8');
      stderrBuf += s;
      onStderr(s);
    });

    child.on('error', (err) => {
      if (settled) return;
      disarmWatchdog();
      settled = true;
      killProcessGroup(child);
      rl.close();
      removeProcessListeners();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) {
        // Settled via timeout/error above — listeners already removed there.
        return;
      }
      disarmWatchdog();
      settled = true;
      rl.close();
      removeProcessListeners();

      const exitCode = code == null ? 1 : code;
      const st = String(status || '').toUpperCase();

      if (exitCode !== 0 && (!st || st === 'ERROR' || st === 'INVALID')) {
        const stderrSnippet = String(stderrBuf || '').trim();
        const errText = resultError
          || extractAuthHint(stderrBuf)
          || (stderrSnippet ? `agy stderr: ${stderrSnippet}` : null)
          || `agy exited with code ${exitCode}`;
        if (!response && !conversationId) {
          reject(new Error(errText));
          return;
        }
      }

      resolve({
        conversationId,
        status: st || (exitCode === 0 ? 'SUCCESS' : 'ERROR'),
        response,
        usage,
        error: resultError,
        exitCode,
      });
    });
  });
}

/**
 * Terminate an agy child process and its process group.
 * @param {import('node:child_process').ChildProcess} child
 */
export function killProcessGroup(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

function extractAuthHint(stderrText) {
  const s = String(stderrText || '');
  if (/authentication required/i.test(s)) {
    return 'Antigravity CLI authentication required. Run `agy` once in a terminal and complete Google Sign-In, then retry.';
  }
  if (/not recognized as a known model/i.test(s)) {
    return s.trim().slice(0, 500);
  }
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.slice(-5).join('\n').slice(0, 500) : '';
}
