import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

export const FAKE_PROJECT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const FAKE_TAB_ID = '11111111-2222-3333-4444-555555555555';
export const FAKE_TAB_ID_2 = '11111111-2222-3333-4444-666666666666';
export const FAKE_SESSION_ID = 'session-1';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export type FakeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => void | Promise<void>;

export interface FakeGatewayOptions {
  readonly token: string;
  readonly handler?: FakeHandler;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/**
 * Minimal in-process gateway implementing the frozen v1 contract shapes.
 *
 * Strict about the Bearer token; every request is recorded for assertions.
 */
export class FakeGateway {
  readonly requests: RecordedRequest[] = [];
  readonly #token: string;
  readonly #handler?: FakeHandler;
  #server?: Server;
  readonly #sockets = new Set<Socket>();
  #port = 0;

  constructor(options: FakeGatewayOptions) {
    this.#token = options.token;
    this.#handler = options.handler;
  }

  get host(): string {
    return '127.0.0.1';
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    server.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    this.#port = address.port;
  }

  async stop(): Promise<void> {
    for (const socket of [...this.#sockets]) {
      socket.destroy();
    }
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    this.requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization ?? null,
      body,
    });
    if (req.headers.authorization !== `Bearer ${this.#token}`) {
      writeJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      return;
    }
    if (this.#handler !== undefined) {
      await this.#handler(req, res, body);
      return;
    }
    this.#defaultHandler(req, res, body);
  }

  #defaultHandler(req: IncomingMessage, res: ServerResponse, body: unknown): void {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    if (url === '/api/v1/health' && method === 'GET') {
      writeJson(res, 200, {
        status: 'ok',
        gatewayVersion: 1,
        pluginVersion: '0.4.8',
        ide: 'PyCharm',
        ideBuild: 'PC-test',
        bridgeReady: true,
      });
      return;
    }
    if (url === '/api/v1/status' && method === 'GET') {
      writeJson(res, 200, {
        enabled: true,
        host: '127.0.0.1',
        port: this.#port,
        openProjectCount: 1,
        bridgeReady: true,
      });
      return;
    }
    if (url === '/api/v1/projects' && method === 'GET') {
      writeJson(res, 200, {
        projects: [{ projectId: FAKE_PROJECT_ID, name: 'fake', basePath: 'D:/fake' }],
      });
      return;
    }
    const tabsMatch = url.match(/^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs$/);
    if (tabsMatch !== null && method === 'GET') {
      const projectId = tabsMatch[1];
      if (projectId !== FAKE_PROJECT_ID) {
        writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Project not found' } });
        return;
      }
      writeJson(res, 200, {
        projectId,
        tabs: [
          {
            tabId: FAKE_TAB_ID,
            index: 0,
            selected: true,
            sessionId: FAKE_SESSION_ID,
            provider: 'claude',
            model: 'deepseek-v4-pro',
            cwd: 'D:/fake',
            busy: false,
          },
        ],
      });
      return;
    }
    const tabMatch = url.match(/^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs\/([0-9a-f-]{36})$/);
    if (tabMatch !== null && method === 'GET') {
      const tabId = tabMatch[2];
      if (tabMatch[1] !== FAKE_PROJECT_ID || tabId !== FAKE_TAB_ID) {
        writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Tab not found' } });
        return;
      }
      writeJson(res, 200, {
        tabId,
        index: 0,
        selected: true,
        sessionId: FAKE_SESSION_ID,
        provider: 'claude',
        model: 'deepseek-v4-pro',
        cwd: 'D:/fake',
        busy: false,
      });
      return;
    }
    const chatMatch = url.match(/^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs\/([0-9a-f-]{36})\/chat$/);
    if (chatMatch !== null && method === 'POST') {
      writeJson(res, 202, {
        taskId: 'task-1',
        projectId: chatMatch[1],
        tabId: chatMatch[2],
        sessionId: FAKE_SESSION_ID,
        status: 'accepted',
      });
      return;
    }
    const abortMatch = url.match(/^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs\/([0-9a-f-]{36})\/tasks\/([^/]+)\/abort$/);
    if (abortMatch !== null && method === 'POST') {
      writeJson(res, 202, { taskId: abortMatch[3], status: 'aborting' });
      return;
    }
    const modeMatch = url.match(/^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs\/([0-9a-f-]{36})\/mode$/);
    if (modeMatch !== null) {
      writeJson(res, 200, {
        projectId: modeMatch[1],
        tabId: modeMatch[2],
        sessionId: FAKE_SESSION_ID,
        mode: 'default',
        validModes: ['default', 'plan', 'acceptEdits', 'autoEdit', 'bypassPermissions'],
      });
      return;
    }
    const permissionMatch = url.match(
      /^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs\/([0-9a-f-]{36})\/permissions\/([^/]+)\/decision$/,
    );
    if (permissionMatch !== null && method === 'POST') {
      if (typeof (body as { taskId?: unknown }).taskId !== 'string') {
        writeJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Missing taskId' } });
        return;
      }
      writeJson(res, 200, { interactionId: permissionMatch[3], resolved: true });
      return;
    }
    const questionMatch = url.match(
      /^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs\/([0-9a-f-]{36})\/questions\/([^/]+)\/answer$/,
    );
    if (questionMatch !== null && method === 'POST') {
      if (typeof (body as { taskId?: unknown }).taskId !== 'string') {
        writeJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Missing taskId' } });
        return;
      }
      writeJson(res, 200, { interactionId: questionMatch[3], resolved: true });
      return;
    }
    const planMatch = url.match(
      /^\/api\/v1\/projects\/([0-9a-f]{32})\/tabs\/([0-9a-f-]{36})\/plans\/([^/]+)\/decision$/,
    );
    if (planMatch !== null && method === 'POST') {
      if (typeof (body as { taskId?: unknown }).taskId !== 'string') {
        writeJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Missing taskId' } });
        return;
      }
      writeJson(res, 200, { interactionId: planMatch[3], resolved: true });
      return;
    }
    writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
}
