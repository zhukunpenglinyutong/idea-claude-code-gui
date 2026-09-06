/**
 * ACP Terminal Host — client-side implementation of:
 *   terminal/create | terminal/output | terminal/wait_for_exit | terminal/kill | terminal/release
 *
 * Spec: https://agentclientprotocol.com/protocol/terminals
 * Schema: agentclientprotocol typescript-sdk schema.json
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliSpawn } from '../../utils/cli-path.js';

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024; // 1 MiB soft default if agent omits limit
const MAX_TERMINALS = 32;

export function isTerminalMethod(method) {
  if (!method) return false;
  const m = String(method);
  return (
    m === 'terminal/create' ||
    m === 'terminal/output' ||
    m === 'terminal/wait_for_exit' ||
    m === 'terminal/waitForExit' ||
    m === 'terminal/kill' ||
    m === 'terminal/release' ||
    m.startsWith('terminal/')
  );
}

function normalizeMethod(method) {
  const m = String(method || '');
  if (m === 'terminal/waitForExit') return 'terminal/wait_for_exit';
  return m;
}

/**
 * Truncate from the beginning so retained suffix stays within byteLimit,
 * cutting at a UTF-8 character boundary (approx via Buffer).
 */
export function truncateOutputFromStart(text, byteLimit) {
  if (byteLimit == null || byteLimit <= 0) {
    return { text: text || '', truncated: false };
  }
  const buf = Buffer.from(text || '', 'utf8');
  if (buf.length <= byteLimit) {
    return { text: text || '', truncated: false };
  }
  // Keep the last byteLimit bytes, then re-decode safely
  let start = buf.length - byteLimit;
  // skip incomplete leading UTF-8 sequence
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return { text: buf.subarray(start).toString('utf8'), truncated: true };
}

function buildEnv(baseEnv, envList) {
  const env = { ...baseEnv };
  if (Array.isArray(envList)) {
    for (const item of envList) {
      if (!item || typeof item !== 'object') continue;
      const name = item.name ?? item.key;
      if (name == null || name === '') continue;
      env[String(name)] = item.value == null ? '' : String(item.value);
    }
  } else if (envList && typeof envList === 'object') {
    for (const [k, v] of Object.entries(envList)) {
      env[k] = v == null ? '' : String(v);
    }
  }
  return env;
}

function formatCommandLine(command, args) {
  const parts = [command, ...(Array.isArray(args) ? args : [])].map(String);
  return parts.join(' ');
}

function stripWrappingQuotes(s) {
  const t = String(s || '').trim();
  if (t.length >= 2) {
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1);
    }
  }
  return t;
}

function isShellExecutable(bin) {
  return /^(?:\/bin\/)?(?:bash|zsh|sh)$/.test(String(bin || '').trim());
}

/**
 * Grok run_terminal_command / ACP terminal/create often sends an outer
 * `/bin/bash -lc '…'` layer. This host already runs `loginShell -l -c <script>`;
 * strip the outer wrapper so the inner command is the -c script (never a bogus
 * “script path” like `/bin/bash -lc '…'`, which yields exit 127).
 */
export function unwrapShellWrapperCommand(command, args = []) {
  const cmd = String(command || '').trim();
  const argList = Array.isArray(args) ? args.map(String) : [];

  if (isShellExecutable(cmd) && argList.length >= 1) {
    const flag = argList[0];
    if (flag === '-lc' || flag === '-c') {
      return argList.length >= 2 ? argList.slice(1).join(' ') : '';
    }
    const combined = argList[0].match(/^-(?:lc|c)\s+([\s\S]+)$/);
    if (combined) return combined[1];
  }

  const wrapperMatch = cmd.match(/^\/bin\/(?:zsh|bash|sh)\s+(?:-lc|-c)\s+([\s\S]+)$/);
  if (wrapperMatch) {
    let inner = stripWrappingQuotes(wrapperMatch[1].trim());
    inner = inner.replace(/'\\''/g, "'");
    inner = inner.replace(/'"'"'/g, "'");
    return inner;
  }

  // args empty -> command is already the full -c script (spaces/pipes/quotes).
  // Do NOT single-quote the whole string: bash then looks up a binary named
  // like echo-with-args and yields exit 127.
  if (argList.length === 0) {
    return cmd;
  }

  // argv form: executable + args -> join with per-arg shell escaping for -c.
  const parts = [cmd, ...argList];
  return parts.map(escapeForShell).join(' ');
}

/**
 * Simple shell escaping for passing to sh -c or zsh -c.
 * Uses single quotes to avoid most interpretation.
 */
function escapeForShell(arg) {
  const s = String(arg);
  // If no special chars, return as-is for readability
  if (/^[a-zA-Z0-9_\/:.-]+$/.test(s)) return s;
  // Escape single quotes by closing, adding \', reopening
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Login-shell argv for -c, aligned with daemon.js env probe:
 * bash → -lc; fish → -c; zsh/other → -l -c.
 */
export function loginShellSpawnArgs(loginShell, commandLine) {
  const shellBase = path.basename(String(loginShell || ''));
  if (shellBase === 'fish') return ['-c', commandLine];
  if (shellBase === 'bash') return ['-lc', commandLine];
  return ['-l', '-c', commandLine];
}

/**
 * Detect payloads that are unsafe or unreliable via sh -c:
 *   - shebang (#!/...)
 *   - heredoc (<< or <<'...')
 *   - history expansion bang (!)
 *   - nested single/double quotes that the outer wrapper mangles
 */
export function needsFileExecution(commandLine) {
  const s = String(commandLine || '').trim();

  // Always use temp script for anything non-trivial
  if (/^#!/.test(s)) return true;                    // shebang
  if (/\b<<['"]?/.test(s)) return true;              // heredoc
  if (/[&|;`$(){}<>!]/.test(s)) return true;         // shell metacharacters
  if (s.includes('&&') || s.includes('||')) return true;
  if (s.includes('!')) return true;                  // history expansion
  if (s.includes("'") || s.includes('"')) return true; // any quote risks mangling by outer wrapper

  return false;
}

/** Write a temp script (0700) and return its absolute path. */
export function writeTempScript(commandLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cmd-'));
  const scriptPath = path.join(dir, 'cmd.sh');
  fs.writeFileSync(scriptPath, String(commandLine), { mode: 0o700 });
  return scriptPath;
}

export class AcpTerminalHost {
  /**
   * @param {object} opts
   * @param {string} [opts.defaultCwd]
   * @param {NodeJS.ProcessEnv} [opts.env]
   * @param {(event: string, data?: any) => void} [opts.onEvent]
   * @param {(info: {command:string,args:string[],cwd:string,sessionId:string}) => Promise<boolean>} [opts.authorizeCreate]
   */
  constructor({ defaultCwd = process.cwd(), env = process.env, onEvent, authorizeCreate } = {}) {
    this.defaultCwd = defaultCwd || process.cwd();
    this.env = env || process.env;
    this.onEvent = onEvent || (() => {});
    this.authorizeCreate = authorizeCreate || (async () => true);
    /** @type {Map<string, any>} */
    this.terminals = new Map();
  }

  size() {
    return this.terminals.size;
  }

  /**
   * Dispatch an ACP terminal/* method.
   * @returns {Promise<object>} JSON-RPC result object
   */
  async handle(method, params = {}) {
    const m = normalizeMethod(method);
    switch (m) {
      case 'terminal/create':
        return this.create(params);
      case 'terminal/output':
        return this.output(params);
      case 'terminal/wait_for_exit':
        return this.waitForExit(params);
      case 'terminal/kill':
        return this.kill(params);
      case 'terminal/release':
        return this.release(params);
      default:
        throw Object.assign(new Error(`Unsupported terminal method: ${method}`), {
          code: -32601,
        });
    }
  }

  async create(params = {}) {
    const command = params.command;
    if (!command || !String(command).trim()) {
      throw Object.assign(new Error('command is required'), { code: -32602 });
    }
    if (this.terminals.size >= MAX_TERMINALS) {
      throw Object.assign(new Error(`Too many open terminals (max ${MAX_TERMINALS})`), {
        code: -32000,
      });
    }

    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const sessionId = params.sessionId || params.session_id || '';
    let cwd = params.cwd || this.defaultCwd;
    if (cwd && !path.isAbsolute(cwd)) {
      cwd = path.resolve(this.defaultCwd, cwd);
    }
    cwd = cwd || this.defaultCwd;

    const outputByteLimit =
      params.outputByteLimit == null || params.outputByteLimit === ''
        ? DEFAULT_OUTPUT_BYTE_LIMIT
        : Number(params.outputByteLimit);

    const allowed = await this.authorizeCreate({
      command: String(command),
      args,
      cwd,
      sessionId,
      commandLine: formatCommandLine(command, args),
    });
    if (!allowed) {
      throw Object.assign(new Error('Terminal create denied by user'), { code: -32000 });
    }

    const terminalId = randomUUID();
    const rawEnv = buildEnv(this.env, params.env);

    // Unix login shells rebuild the user environment without IDEA_* pollution.
    // Native Windows tools also need SystemRoot, ComSpec and the profile paths.
    const cleanEnv = process.platform === 'win32' ? rawEnv : {
      PATH: rawEnv.PATH || process.env.PATH,
      HOME: rawEnv.HOME || process.env.HOME,
      USER: rawEnv.USER || process.env.USER,
      SHELL: rawEnv.SHELL || process.env.SHELL,
      LANG: rawEnv.LANG || process.env.LANG || 'en_US.UTF-8',
      LC_ALL: rawEnv.LC_ALL || process.env.LC_ALL || '',
      TMPDIR: rawEnv.TMPDIR || process.env.TMPDIR || '',
      TEMP: rawEnv.TEMP || process.env.TEMP || '',
      TMP: rawEnv.TMP || process.env.TMP || '',
    };
    if (rawEnv.NODE_PATH) cleanEnv.NODE_PATH = rawEnv.NODE_PATH;

    // Windows command strings need cmd syntax even when Git Bash sets SHELL.
    // Unix commands retain the user's login shell and its profiles.
    function resolveDefaultShell() {
      if (process.platform === 'win32') return 'cmd.exe';
      if (process.platform === 'darwin') {
        if (fs.existsSync('/bin/zsh')) return '/bin/zsh';
        if (fs.existsSync('/bin/bash')) return '/bin/bash';
        return '/bin/sh';
      }
      // Linux / other Unix
      if (fs.existsSync('/bin/bash')) return '/bin/bash';
      return '/bin/sh';
    }

    const loginShell = process.platform === 'win32'
      ? rawEnv.ComSpec || rawEnv.COMSPEC || resolveDefaultShell()
      : rawEnv.SHELL || process.env.SHELL || resolveDefaultShell();
    let commandLine = unwrapShellWrapperCommand(command, args);
    if (!commandLine.trim()) {
      throw Object.assign(new Error('command is empty after unwrapping shell wrapper'), {
        code: -32602,
      });
    }

    let scriptPath = null;
    if (process.platform !== 'win32' && needsFileExecution(commandLine)) {
      // Complex payload (shebang / heredoc / ! / heavy quoting) — write to temp script.
      // This bypasses the outer wrapper mangling that corrupts heredoc, bang, nested quotes.
      scriptPath = writeTempScript(commandLine);
      commandLine = scriptPath; // pass the path; loginShell will exec it
    }

    // Unix shells read complex scripts as files, which also works on noexec mounts.
    let child;
    if (process.platform === 'win32') {
      const options = { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
      if (args.length > 0 && !isShellExecutable(command)) {
        // Keep argv intact; shell escaping would turn literal metacharacters into code.
        const invocation = resolveCliSpawn(String(command), args, options);
        child = spawn(invocation.file, invocation.args, invocation.options);
      } else {
        child = spawn(loginShell, ['/d', '/s', '/c', `"${commandLine}"`], {
          ...options,
          windowsVerbatimArguments: true,
        });
      }
    } else if (scriptPath) {
      // Execute the temp script directly via the login shell as a file, not via -c.
      // This bypasses the outer ACP wrapper entirely and avoids treating the path as code.
      // Strategy: loginShell -l scriptPath  (or equivalent per shell)
      const shellBase = path.basename(String(loginShell || ''));
      let scriptArgs;
      if (shellBase === 'fish') {
        scriptArgs = [scriptPath];
      } else if (shellBase === 'bash' || shellBase === 'zsh' || shellBase === 'sh') {
        scriptArgs = ['-l', scriptPath];
      } else {
        scriptArgs = [scriptPath];
      }
      child = spawn(loginShell, scriptArgs, {
        cwd,
        env: cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } else {
      const args = loginShellSpawnArgs(loginShell, commandLine);
      child = spawn(loginShell, args, {
        cwd,
        env: cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    }

    const state = {
      terminalId,
      sessionId,
      command: String(command),
      args,
      cwd,
      outputByteLimit: Number.isFinite(outputByteLimit) ? outputByteLimit : DEFAULT_OUTPUT_BYTE_LIMIT,
      chunks: [],
      byteLength: 0,
      truncated: false,
      exitCode: null,
      signal: null,
      exited: false,
      released: false,
      child,
      exitPromise: null,
      scriptPath, // may be null; used for cleanup on close
    };

    state.exitPromise = new Promise((resolve) => {
      const finish = (code, signal) => {
        if (state.exited) return;
        state.exited = true;
        state.exitCode = code == null ? null : Number(code);
        state.signal = signal || null;
        this.onEvent('exit', {
          terminalId,
          exitCode: state.exitCode,
          signal: state.signal,
        });
        resolve({ exitCode: state.exitCode, signal: state.signal });
      };
      child.on('error', (err) => {
        this.#append(state, `[spawn error] ${err.message || String(err)}\n`);
        finish(1, null);
      });
      child.on('close', (code, signal) => {
        // Best-effort cleanup of any temp script we created for complex payloads.
        if (state.scriptPath) {
          try {
            fs.rmSync(path.dirname(state.scriptPath), { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
        finish(code, signal);
      });
    });

    const onData = (buf) => {
      this.#append(state, buf.toString('utf8'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    this.terminals.set(terminalId, state);
    this.onEvent('create', {
      terminalId,
      command: state.command,
      args,
      cwd,
      sessionId,
    });

    return { terminalId };
  }

  #append(state, text) {
    if (state.released || !text) return;
    state.chunks.push(text);
    state.byteLength += Buffer.byteLength(text, 'utf8');
    // Eager trim if over 2x limit to bound memory; final view uses truncateOutputFromStart
    const hard = Math.max(state.outputByteLimit * 2, state.outputByteLimit + 4096);
    if (state.byteLength > hard) {
      const joined = state.chunks.join('');
      const { text: kept, truncated } = truncateOutputFromStart(joined, state.outputByteLimit);
      state.chunks = [kept];
      state.byteLength = Buffer.byteLength(kept, 'utf8');
      state.truncated = state.truncated || truncated;
    }
  }

  #get(terminalId) {
    const id = terminalId || '';
    const state = this.terminals.get(id);
    if (!state || state.released) {
      throw Object.assign(new Error(`Unknown terminalId: ${id}`), { code: -32000 });
    }
    return state;
  }

  #snapshotOutput(state) {
    const joined = state.chunks.join('');
    const { text, truncated } = truncateOutputFromStart(joined, state.outputByteLimit);
    return {
      output: text,
      truncated: truncated || state.truncated,
      exitStatus: state.exited
        ? { exitCode: state.exitCode, signal: state.signal }
        : null,
    };
  }

  async output(params = {}) {
    const state = this.#get(params.terminalId || params.terminal_id);
    return this.#snapshotOutput(state);
  }

  async waitForExit(params = {}) {
    const state = this.#get(params.terminalId || params.terminal_id);
    if (!state.exited) {
      await state.exitPromise;
    }
    return {
      exitCode: state.exitCode,
      signal: state.signal,
    };
  }

  async kill(params = {}) {
    const state = this.#get(params.terminalId || params.terminal_id);
    if (!state.exited && state.child && !state.child.killed) {
      try {
        state.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      // Force kill shortly after if still running
      setTimeout(() => {
        if (!state.exited && state.child && !state.child.killed) {
          try {
            state.child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, 500).unref?.();
    }
    // Wait briefly for exit so subsequent output has status
    if (!state.exited) {
      await Promise.race([
        state.exitPromise,
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }
    // Best-effort cleanup of any temp script
    if (state.scriptPath) {
      try {
        fs.rmSync(path.dirname(state.scriptPath), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.onEvent('kill', { terminalId: state.terminalId });
    return {};
  }

  async release(params = {}) {
    const id = params.terminalId || params.terminal_id;
    const state = this.terminals.get(id);
    if (!state) {
      // Idempotent release
      return {};
    }
    if (!state.exited && state.child && !state.child.killed) {
      try {
        state.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      try {
        state.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    state.released = true;
    // Best-effort cleanup of any temp script
    if (state && state.scriptPath) {
      try {
        fs.rmSync(path.dirname(state.scriptPath), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.terminals.delete(id);
    this.onEvent('release', { terminalId: id });
    return {};
  }

  async disposeAll() {
    const ids = [...this.terminals.keys()];
    for (const id of ids) {
      try {
        await this.release({ terminalId: id });
      } catch {
        // ignore
      }
    }
  }
}

export default AcpTerminalHost;
