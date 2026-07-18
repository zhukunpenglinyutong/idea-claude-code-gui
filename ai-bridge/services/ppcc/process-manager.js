import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 11 * 60_000;

function safeExecutable() {
  const configured = process.env.PPCC_DAEMON_PATH;
  if (!configured) throw new Error('PPCC_DAEMON_PATH is not configured');
  return configured;
}

function isValidMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.protocolVersion !== PROTOCOL_VERSION) return false;
  if (message.type === 'daemon' && message.event === 'ready') return true;
  if (typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 200) return false;
  return message.type === 'event' || message.type === 'response';
}

export class PpccProcessManager {
  constructor({
    executable = safeExecutable(),
    args = [],
    spawnImpl = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onDiagnostic = () => {},
  } = {}) {
    this.executable = executable;
    this.args = args;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onDiagnostic = onDiagnostic;
    this.child = null;
    this.pending = new Map();
    this.ready = null;
  }

  async start() {
    if (this.child && !this.child.killed) return;
    const child = this.spawnImpl(this.executable, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PPCC_GUI_BRIDGE: '1' },
      shell: false,
    });
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('PPCC daemon ready timeout');
        reject(error);
        this.#failAll(error);
        this.stop();
      }, 30_000);
      let stdoutBuffer = Buffer.alloc(0);
      let stderrBuffer = '';
      const failProtocol = error => {
        reject(error);
        this.#failAll(error);
        this.stop();
      };
      const handleStdoutLine = lineBuffer => {
        let line = lineBuffer;
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (line.length === 0) return;
        let message;
        try { message = JSON.parse(line.toString('utf8')); } catch {
          failProtocol(new Error('PPCC daemon returned invalid JSON'));
          return;
        }
        if (message.type === 'daemon' && message.event === 'ready' && isValidMessage(message)) {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (!isValidMessage(message)) {
          failProtocol(new Error('PPCC daemon protocol version or message shape is invalid'));
          return;
        }
        const handler = this.pending.get(message.id);
        if (!handler) return;
        if (message.type === 'event') {
          handler.onEvent?.(message);
          return;
        }
        this.#settle(message.id, handler, () => {
          if (message.success === true) handler.resolve(message.result);
          else handler.reject(new Error(message.error?.message || 'PPCC request failed'));
        });
      };
      child.stdout.on('data', chunk => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        if (stdoutBuffer.length > MAX_LINE_BYTES && stdoutBuffer.indexOf(0x0a) === -1) {
          failProtocol(new Error('PPCC daemon response exceeds size limit'));
          return;
        }
        let newline;
        while ((newline = stdoutBuffer.indexOf(0x0a)) !== -1) {
          if (newline > MAX_LINE_BYTES) {
            failProtocol(new Error('PPCC daemon response exceeds size limit'));
            return;
          }
          const line = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          handleStdoutLine(line);
          if (!this.child) return;
        }
      });
      child.stderr.on('data', chunk => {
        stderrBuffer += chunk.toString('utf8');
        if (stderrBuffer.length > MAX_LINE_BYTES) stderrBuffer = stderrBuffer.slice(-MAX_LINE_BYTES);
        let newline;
        while ((newline = stderrBuffer.indexOf('\n')) !== -1) {
          const line = stderrBuffer.slice(0, newline).replace(/\r$/, '');
          stderrBuffer = stderrBuffer.slice(newline + 1);
          try { this.onDiagnostic(line); } catch { /* diagnostics must not break protocol */ }
        }
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
        this.#failAll(error);
        this.stop();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        const error = new Error('PPCC daemon exited');
        reject(error);
        this.#failAll(error);
        this.child = null;
      });
    });
    await this.ready;
  }

  async request(method, params, onEvent) {
    await this.start();
    const id = `gui-${randomUUID()}`;
    const request = { protocolVersion: PROTOCOL_VERSION, id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const handler = this.pending.get(id);
        if (!handler) return;
        this.#settle(id, handler, () => reject(new Error(`PPCC request timed out: ${method}`)));
        this.#failAll(new Error(`PPCC daemon stopped after request timeout: ${method}`));
        this.stop();
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, onEvent, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, error => {
        if (!error) return;
        const handler = this.pending.get(id);
        if (handler) this.#settle(id, handler, () => reject(error));
      });
    });
  }

  cancel(runId) {
    if (typeof runId !== 'string' || runId.length === 0) {
      return Promise.reject(new Error('PPCC cancel requires runId'));
    }
    return this.request('ppcc.cancel', { runId });
  }

  respondApproval(params) {
    return this.request('ppcc.approval.respond', params);
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }

  #settle(id, handler, action) {
    this.pending.delete(id);
    clearTimeout(handler.timer);
    action();
  }

  #failAll(error) {
    for (const [id, handler] of this.pending.entries()) {
      this.#settle(id, handler, () => handler.reject(error));
    }
  }
}
