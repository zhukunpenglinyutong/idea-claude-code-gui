import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ILinkClient } from '../../src/ilink/client.js';
import { InboxJournal } from '../../src/ilink/journal.js';
import { WeixinTransport } from '../../src/weixin/transport.js';
import type { BotCredentials } from '../../src/ilink/store.js';
import { FakeIlink, makeTextMessage, type IlinkHandler } from '../helpers/fakeIlink.js';
import { waitUntil } from '../helpers/wait.js';

const TOKEN = 'ilink-token';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-weixin-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function credentials(port: number): BotCredentials {
  return {
    botAccountId: 'bot-1',
    botToken: TOKEN,
    baseUrl: `http://127.0.0.1:${port}`,
    authorizedWeixinUserId: 'user-1',
    savedAt: 1,
  };
}

async function buildTransport(
  ilink: FakeIlink,
  overrides: Partial<ConstructorParameters<typeof WeixinTransport>[0]> = {},
): Promise<{ transport: WeixinTransport; context: Map<string, string> }> {
  const context = new Map<string, string>();
  const journal = new InboxJournal(dir);
  const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
  const transport = new WeixinTransport({
    client,
    journal,
    credentials: () => credentials(ilink.port),
    getContextToken: async (botAccountId, fromUserId) => context.get(`${botAccountId}:${fromUserId}`),
    setContextToken: async (botAccountId, fromUserId, token) => {
      context.set(`${botAccountId}:${fromUserId}`, token);
    },
    backoffBaseMs: 10,
    backoffMaxMs: 50,
    ...overrides,
  });
  return { transport, context };
}

describe('WeixinTransport', () => {
  it('long-polls, persists inbound text, advances cursor and refreshes context token', async () => {
    let calls = 0;
    const handler: IlinkHandler = (_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ret: 0,
            msgs: [makeTextMessage('m1', 'user-1', 'hello', { context_token: 'ctx-1' })],
            get_updates_buf: 'c1',
            longpolling_timeout_ms: 35_000,
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c1' }));
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    const { transport, context } = await buildTransport(ilink);
    const received: string[] = [];
    transport.onInbound((message) => received.push(message.messageId));
    transport.startPolling();
    try {
      await waitUntil(() => received.length === 1);
      expect(received).toEqual(['bot-1:m1']);
      expect(await new InboxJournal(dir).loadCursor('bot-1')).toBe('c1');
      expect(context.get('bot-1:user-1')).toBe('ctx-1');
    } finally {
      transport.stop();
      await ilink.stop();
    }
  });

  it('does not re-emit a duplicate message across transport restarts', async () => {
    const handler: IlinkHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ret: 0,
          msgs: [makeTextMessage('m1', 'user-1', 'hello')],
          get_updates_buf: 'c1',
        }),
      );
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    const received: string[] = [];
    try {
      const first = await buildTransport(ilink);
      first.transport.onInbound((message) => received.push(message.messageId));
      first.transport.startPolling();
      await waitUntil(() => received.length === 1);
      first.transport.stop();

      const second = await buildTransport(ilink);
      second.transport.onInbound((message) => received.push(message.messageId));
      second.transport.startPolling();
      await new Promise((resolve) => setTimeout(resolve, 150));
      second.transport.stop();
      expect(received).toEqual(['bot-1:m1']);
    } finally {
      await ilink.stop();
    }
  });

  it('filters non-authorized users and non-text messages', async () => {
    const handler: IlinkHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ret: 0,
          msgs: [
            makeTextMessage('m1', 'user-2', 'ignored'),
            { message_id: 'm2', seq: 2, from_user_id: 'user-1', message_type: 2, item_list: [{ type: 3 }] },
          ],
          get_updates_buf: 'c1',
        }),
      );
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    const { transport } = await buildTransport(ilink);
    const received: string[] = [];
    transport.onInbound((message) => received.push(message.messageId));
    transport.startPolling();
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toEqual([]);
    } finally {
      transport.stop();
      await ilink.stop();
    }
  });

  it('sends long replies as sequential labelled chunks', async () => {
    const ilink = new FakeIlink({ token: TOKEN });
    await ilink.start();
    const { transport, context } = await buildTransport(ilink);
    context.set('bot-1:user-1', 'ctx-9');
    try {
      await transport.sendText('a'.repeat(9_000));
      const sends = ilink.requests.filter((request) => request.url === '/ilink/bot/sendmessage');
      expect(sends.length).toBe(3);
      const texts = sends.map((request) => (request.body as { msg: { item_list: Array<{ text_item?: { text: string } }> } }).msg.item_list[0]?.text_item?.text);
      expect(texts[0]).toBe('[1/3] ' + 'a'.repeat(3_994));
      expect(texts[2]).toBe('[3/3] ' + 'a'.repeat(1_012));
      for (const text of texts) {
        expect(Array.from(text ?? '').length).toBeLessThanOrEqual(4000);
      }
      const ids = sends.map((request) => (request.body as { msg: { client_id: string } }).msg.client_id);
      expect(new Set(ids).size).toBe(3);
      const first = sends[0]?.body as { msg: { message_type: number; message_state: number }; base_info: unknown };
      expect(first.msg.message_type).toBe(2);
      expect(first.msg.message_state).toBe(2);
      expect(first.base_info).toBeDefined();
    } finally {
      transport.stop();
      await ilink.stop();
    }
  });

  it('refuses to send before a context token exists', async () => {
    const ilink = new FakeIlink({ token: TOKEN });
    await ilink.start();
    const { transport } = await buildTransport(ilink);
    try {
      await expect(transport.sendText('hi')).rejects.toThrow(/context token/);
    } finally {
      transport.stop();
      await ilink.stop();
    }
  });

  it('treats a sendMessage response without ret as success (official semantics)', async () => {
    const handler: IlinkHandler = (_req, res) => {
      if (_req.url === '/ilink/bot/sendmessage') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errmsg: 'ok' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c0' }));
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    const { transport, context } = await buildTransport(ilink);
    context.set('bot-1:user-1', 'ctx-9');
    try {
      await expect(transport.sendText('hi')).resolves.toBeUndefined();
      const sends = ilink.requests.filter((request) => request.url === '/ilink/bot/sendmessage');
      expect(sends.length).toBe(1);
    } finally {
      transport.stop();
      await ilink.stop();
    }
  });

  it('stops polling and signals reauth on errcode -14', async () => {
    let calls = 0;
    const handler: IlinkHandler = (_req, res) => {
      calls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        calls === 1
          ? JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c1' })
          : JSON.stringify({ ret: 0, errcode: -14, errmsg: 'token invalid' }),
      );
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    let reauth = false;
    const { transport } = await buildTransport(ilink, { onReauthRequired: () => (reauth = true) });
    transport.startPolling();
    try {
      await waitUntil(() => reauth);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls).toBe(2);
    } finally {
      transport.stop();
      await ilink.stop();
    }
  });

  it('backs off and retries after a network failure', async () => {
    const handler: IlinkHandler = (_req, res) => {
      res.destroy();
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    const { transport } = await buildTransport(ilink);
    transport.startPolling();
    try {
      await waitUntil(() => ilink.requests.length >= 3, 3_000);
    } finally {
      transport.stop();
      await ilink.stop();
    }
  });
});
