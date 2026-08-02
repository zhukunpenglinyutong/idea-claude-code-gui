import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface IlinkRecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly authorizationType: string | null;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
}

export type IlinkHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => void | Promise<void>;

export interface FakeIlinkOptions {
  readonly token: string;
  readonly handler?: IlinkHandler;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
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

export class FakeIlink {
  readonly requests: IlinkRecordedRequest[] = [];
  readonly #token: string;
  #handler?: IlinkHandler;
  #server?: Server;
  readonly #sockets = new Set<Socket>();
  #port = 0;

  constructor(options: FakeIlinkOptions) {
    this.#token = options.token;
    this.#handler = options.handler;
  }

  setHandler(handler: IlinkHandler): void {
    this.#handler = handler;
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
    this.#port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of [...this.#sockets]) {
      socket.destroy();
    }
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    this.requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization ?? null,
      authorizationType:
        typeof req.headers.authorizationtype === 'string' ? req.headers.authorizationtype : null,
      headers: { ...req.headers },
      body,
    });
    const isQrEndpoint = (req.url ?? '').includes('get_bot_qrcode') || (req.url ?? '').includes('get_qrcode_status');
    if (!isQrEndpoint && req.headers.authorization !== `Bearer ${this.#token}`) {
      writeJson(res, 401, { ret: 401, errmsg: 'Unauthorized' });
      return;
    }
    if (this.#handler !== undefined) {
      await this.#handler(req, res, body);
      return;
    }
    this.#defaultHandler(req, res);
  }

  #defaultHandler(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';
    const method = req.method ?? 'POST';
    if (url === '/ilink/bot/getupdates' && method === 'POST') {
      writeJson(res, 200, { ret: 0, msgs: [], get_updates_buf: 'c0', longpolling_timeout_ms: 35_000 });
      return;
    }
    if (url === '/ilink/bot/sendmessage' && method === 'POST') {
      writeJson(res, 200, { ret: 0 });
      return;
    }
    if (url === '/ilink/bot/get_bot_qrcode?bot_type=3' && method === 'POST') {
      writeJson(res, 200, { qrcode: 'qr-1', qrcode_img_content: 'img-data' });
      return;
    }
    if (url.startsWith('/ilink/bot/get_qrcode_status?') && method === 'GET') {
      writeJson(res, 200, { status: 'wait' });
      return;
    }
    if (url === '/ilink/bot/getconfig' && method === 'POST') {
      writeJson(res, 200, { ret: 0, typing_ticket: 'ticket-1' });
      return;
    }
    if (url === '/ilink/bot/sendtyping' && method === 'POST') {
      writeJson(res, 200, { ret: 0 });
      return;
    }
    if ((url === '/ilink/bot/msg/notifystart' || url === '/ilink/bot/msg/notifystop') && method === 'POST') {
      writeJson(res, 200, { ret: 0 });
      return;
    }
    writeJson(res, 404, { ret: 404, errmsg: 'Not found' });
  }
}

export function makeTextMessage(
  messageId: string,
  fromUserId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: messageId,
    seq: 1,
    from_user_id: fromUserId,
    message_type: 1,
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  };
}
