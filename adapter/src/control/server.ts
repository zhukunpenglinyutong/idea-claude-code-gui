import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface BindingInput {
  readonly projectId: string;
  readonly tabId: string;
}

export interface LoginStartResult {
  readonly loginId: string;
  readonly status: string;
  readonly expiresAt: number;
}

export interface ControlServiceFacade {
  status(): unknown;
  loginStart(): LoginStartResult;
  loginStatus(loginId: string): unknown | undefined;
  loginQrPng(loginId: string): Buffer | undefined;
  loginVerify(loginId: string, code: string): boolean;
  loginCancel(loginId: string): boolean;
  bind(input: BindingInput): Promise<void>;
  unbind(): Promise<void>;
  logout(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ControlServerOptions {
  readonly token: string;
  readonly facade: ControlServiceFacade;
  readonly maxBodyBytes?: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_MAX_BODY_BYTES = 65_536;

export class ControlServer {
  readonly #options: ControlServerOptions;
  #server?: ReturnType<typeof createServer>;
  #port = 0;

  constructor(options: ControlServerOptions) {
    this.#options = options;
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<number> {
    const server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.#port = (server.address() as AddressInfo).port;
    return this.#port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!LOOPBACK_HOSTS.has(url.hostname)) {
        this.#json(res, 403, { error: { code: 'FORBIDDEN', message: 'Host must be loopback' } });
        return;
      }
      const hostHeader = req.headers.host;
      if (hostHeader !== undefined) {
        const host = hostHeader.split(':')[0]?.toLowerCase() ?? '';
        if (!LOOPBACK_HOSTS.has(host)) {
          this.#json(res, 403, { error: { code: 'FORBIDDEN', message: 'Host must be loopback' } });
          return;
        }
      }
      const origin = req.headers.origin;
      if (origin !== undefined) {
        try {
          const originUrl = new URL(origin);
          if (!LOOPBACK_HOSTS.has(originUrl.hostname)) {
            this.#json(res, 403, { error: { code: 'FORBIDDEN', message: 'Origin must be loopback' } });
            return;
          }
        } catch {
          this.#json(res, 403, { error: { code: 'FORBIDDEN', message: 'Invalid Origin' } });
          return;
        }
      }
      if (!this.#authorized(req)) {
        this.#json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
        return;
      }
      const body = await this.#readBody(req);
      await this.#route(req.method ?? 'GET', url.pathname, body, res);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        this.#json(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
        return;
      }
      this.#json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    }
  }

  #authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) {
      return false;
    }
    const provided = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.#options.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  async #readBody(req: IncomingMessage): Promise<unknown> {
    const limit = this.#options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > limit) {
        throw new BodyTooLargeError();
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) {
      return undefined;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }

  async #route(
    method: string,
    path: string,
    body: unknown,
    res: ServerResponse,
  ): Promise<void> {
    if (path === '/control/v1/health' && method === 'GET') {
      this.#json(res, 200, { status: 'ok', version: 1 });
      return;
    }
    if (path === '/control/v1/status' && method === 'GET') {
      this.#json(res, 200, this.#options.facade.status());
      return;
    }
    if (path === '/control/v1/login/start' && method === 'POST') {
      this.#json(res, 200, this.#options.facade.loginStart());
      return;
    }
    const statusMatch = path.match(/^\/control\/v1\/login\/([^/]+)\/status$/);
    if (statusMatch !== null && method === 'GET') {
      const view = this.#options.facade.loginStatus(statusMatch[1] ?? '');
      if (view === undefined) {
        this.#json(res, 404, { error: { code: 'LOGIN_NOT_FOUND', message: 'Login session not found' } });
        return;
      }
      this.#json(res, 200, view);
      return;
    }
    const qrMatch = path.match(/^\/control\/v1\/login\/([^/]+)\/qr$/);
    if (qrMatch !== null && method === 'GET') {
      const png = this.#options.facade.loginQrPng(qrMatch[1] ?? '');
      if (png === undefined) {
        this.#json(res, 404, { error: { code: 'LOGIN_NOT_FOUND', message: 'QR not available' } });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
      res.end(png);
      return;
    }
    const verifyMatch = path.match(/^\/control\/v1\/login\/([^/]+)\/verify$/);
    if (verifyMatch !== null && method === 'POST') {
      const code = (body as { code?: unknown }).code;
      if (typeof code !== 'string') {
        this.#json(res, 400, { error: { code: 'BAD_REQUEST', message: 'code is required' } });
        return;
      }
      if (!this.#options.facade.loginVerify(verifyMatch[1] ?? '', code)) {
        this.#json(res, 409, { error: { code: 'LOGIN_INVALID_STATE', message: 'Login session cannot accept a code' } });
        return;
      }
      this.#json(res, 200, { accepted: true });
      return;
    }
    const cancelMatch = path.match(/^\/control\/v1\/login\/([^/]+)\/cancel$/);
    if (cancelMatch !== null && method === 'POST') {
      if (!this.#options.facade.loginCancel(cancelMatch[1] ?? '')) {
        this.#json(res, 409, { error: { code: 'LOGIN_INVALID_STATE', message: 'Login session cannot be cancelled' } });
        return;
      }
      this.#json(res, 200, { cancelled: true });
      return;
    }
    if (path === '/control/v1/binding' && method === 'PUT') {
      const projectId = (body as { projectId?: unknown }).projectId;
      const tabId = (body as { tabId?: unknown }).tabId;
      if (typeof projectId !== 'string' || typeof tabId !== 'string') {
        this.#json(res, 400, { error: { code: 'BAD_REQUEST', message: 'projectId and tabId are required' } });
        return;
      }
      try {
        await this.#options.facade.bind({ projectId, tabId });
        this.#json(res, 200, { bound: { projectId, tabId } });
      } catch (err) {
        this.#json(res, 409, {
          error: { code: 'BIND_FAILED', message: err instanceof Error ? err.message : 'Bind failed' },
        });
      }
      return;
    }
    if (path === '/control/v1/binding' && method === 'DELETE') {
      await this.#options.facade.unbind();
      this.#json(res, 200, { unbound: true });
      return;
    }
    if (path === '/control/v1/logout' && method === 'POST') {
      await this.#options.facade.logout();
      this.#json(res, 200, { loggedOut: true });
      return;
    }
    if (path === '/control/v1/shutdown' && method === 'POST') {
      this.#json(res, 200, { shuttingDown: true });
      setTimeout(() => {
        void this.#options.facade.shutdown();
      }, 50);
      return;
    }
    this.#json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }
}

class BodyTooLargeError extends Error {}
