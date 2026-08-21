/**
 * Shared headless CLI spawn + stream loop for Grok / Kimi / OpenCode.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { emitSendError, endStream } from './marker-protocol.js';
import { isWindowsCmdShim, quoteWindowsShellBin } from './cli-path.js';

function killChildTree(child, label) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      child.kill();
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch (error) {
    console.error(`[WARN][${label}] Failed to kill child:`, error?.message || error);
  }
}

/**
 * Spawn a CLI, stream stdout lines, map stderr for diagnostics.
 *
 * @param {object} options
 * @param {string} options.bin
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} options.label - log / error label
 * @param {(line: string) => void} options.onLine
 * @param {() => void} [options.onCloseBeforeEnd] - called before endStream once
 * @param {(message: string) => void} [options.onError] - when set, called instead of
 *   writing `[SEND_ERROR]` (used by session-less ask paths: prompt enhance / commit)
 * @param {boolean} [options.emitEndStream=true] - when false, skip chat stream end markers
 * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null, hadError: boolean, errorMessage?: string }>}
 */
export function runCliStreaming({
  bin,
  args,
  cwd,
  env = process.env,
  label,
  onLine,
  onCloseBeforeEnd,
  onError,
  emitEndStream = true,
}) {
  return new Promise((resolve) => {
    let hadError = false;
    let lastErrorMessage = '';
    let streamEnded = false;

    const reportError = (message) => {
      lastErrorMessage = String(message || `Unknown ${label} error`);
      if (typeof onError === 'function') {
        try {
          onError(lastErrorMessage);
        } catch (error) {
          console.error(`[WARN][${label}] onError failed:`, error?.message || error);
        }
        return;
      }
      emitSendError(lastErrorMessage, label);
    };

    const finish = (payload) => {
      if (streamEnded) return;
      streamEnded = true;
      try {
        onCloseBeforeEnd?.();
      } catch (error) {
        console.error(`[WARN][${label}] onCloseBeforeEnd failed:`, error?.message || error);
      }
      if (emitEndStream !== false) {
        endStream();
      }
      resolve({
        ...payload,
        ...(lastErrorMessage ? { errorMessage: lastErrorMessage } : {}),
      });
    };

    let child;
    try {
      // Windows .cmd/.bat shims must be spawned via a shell, and Node does not
      // quote `bin` in shell mode - quote paths containing spaces ourselves so
      // cmd.exe does not split them at the first space (#1665).
      const needsShell = isWindowsCmdShim(bin);
      child = spawn(needsShell ? quoteWindowsShellBin(bin) : bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: needsShell,
      });
    } catch (error) {
      hadError = true;
      reportError(`Failed to spawn ${label} CLI (${bin}): ${error?.message || error}`);
      finish({ code: null, signal: null, hadError });
      return;
    }

    const onParentSignal = () => killChildTree(child, label);
    process.once('SIGTERM', onParentSignal);
    process.once('SIGINT', onParentSignal);
    process.once('SIGHUP', onParentSignal);

    const stdoutRl = createInterface({ input: child.stdout });
    // Rolling tail only — never accumulate the child's full stderr.
    let stderrTail = '';

    stdoutRl.on('line', (line) => {
      try {
        onLine(line);
      } catch (error) {
        console.error(`[WARN][${label}] onLine failed:`, error?.message || error);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      process.stderr.write(text);
    });

    child.on('error', (error) => {
      hadError = true;
      const hint = error?.code === 'ENOENT'
        ? `${label} CLI not found. Install it and ensure \`${bin}\` is on PATH.`
        : (error?.message || String(error));
      reportError(hint);
    });

    child.on('close', (code, signal) => {
      process.off('SIGTERM', onParentSignal);
      process.off('SIGINT', onParentSignal);
      process.off('SIGHUP', onParentSignal);

      if (!hadError && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        const tail = stderrTail.trim().slice(-800);
        reportError(
          `${label} CLI exited with code ${code}${signal ? ` (signal ${signal})` : ''}`
          + (tail ? `\n${tail}` : '')
        );
        hadError = true;
      }

      finish({ code, signal, hadError });
    });
  });
}
