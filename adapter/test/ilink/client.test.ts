import { describe, expect, it } from 'vitest';
import { ILinkClient } from '../../src/ilink/client.js';
import {
  ILinkApiError,
  ILinkNetworkError,
  ILinkRateLimitedError,
  ILinkReauthError,
  ILinkTimeoutError,
  isReauthError,
} from '../../src/ilink/errors.js';
import { encodeClientVersion, randomWechatUin } from '../../src/ilink/client.js';
import { FakeIlink, type IlinkHandler } from '../helpers/fakeIlink.js';

const TOKEN = 'ilink-token';

describe('ILinkClient', () => {
  it('calls getUpdates with cursor and base_info using iLink auth headers', async () => {
    const ilink = new FakeIlink({ token: TOKEN });
    await ilink.start();
    try {
      const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
      const response = await client.getUpdates('cursor-1');
      expect(response.ret).toBe(0);
      expect(ilink.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(ilink.requests[0]?.authorizationType).toBe('ilink_bot_token');
      expect(ilink.requests[0]?.body).toMatchObject({
        get_updates_buf: 'cursor-1',
        base_info: { channel_version: '0.1.0', bot_agent: 'CCGUI-WeChat/0.1.0' },
      });
    } finally {
      await ilink.stop();
    }
  });

  it('sends official iLink headers on every request', async () => {
    const ilink = new FakeIlink({ token: TOKEN });
    await ilink.start();
    try {
      const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
      await client.getUpdates('c');
      const request = ilink.requests[0];
      expect(request).toBeDefined();
      // Node lowercases incoming header names; wire case is preserved by fetch.
      expect(request?.headers['ilink-app-id']).toBe('bot');
      expect(request?.headers['ilink-app-clientversion']).toBe('256');
      expect(request?.headers['authorizationtype']).toBe('ilink_bot_token');
      expect(request?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(request?.headers['x-wechat-uin']).toBeDefined();
      expect(encodeClientVersion('0.1.0')).toBe(256);
      expect(encodeClientVersion('1.0.11')).toBe(65_547);
      expect(encodeClientVersion('2.4.6')).toBe(132_102);
      expect(randomWechatUin()).toMatch(/^[A-Za-z0-9+/=]+$/);
    } finally {
      await ilink.stop();
    }
  });

  it('includes base_info in sendMessage and uses BOT/FINISH message fields', async () => {
    const ilink = new FakeIlink({ token: TOKEN });
    await ilink.start();
    try {
      const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
      const response = await client.sendMessage({
        msg: {
          from_user_id: '',
          to_user_id: 'user-1',
          client_id: 'c-1',
          message_type: 2,
          message_state: 2,
          context_token: 'ctx',
          item_list: [{ type: 1, text_item: { text: 'hi' } }],
        },
      });
      expect(response.ret).toBe(0);
      expect(ilink.requests[0]?.body).toMatchObject({
        msg: { client_id: 'c-1', context_token: 'ctx', to_user_id: 'user-1', message_type: 2, message_state: 2 },
        base_info: { channel_version: '0.1.0' },
      });
    } finally {
      await ilink.stop();
    }
  });

  it('surfaces QR endpoints', async () => {
    const ilink = new FakeIlink({ token: TOKEN });
    await ilink.start();
    try {
      const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
      const qr = await client.getQrCode([]);
      expect(qr.qrcode).toBe('qr-1');
      const status = await client.getQrCodeStatus('qr-1');
      expect(status.status).toBe('wait');
      expect(ilink.requests[1]?.url).toBe('/ilink/bot/get_qrcode_status?qrcode=qr-1');
      const withCode = await client.getQrCodeStatus('qr-1', '1234');
      expect(withCode.status).toBe('wait');
      expect(ilink.requests[2]?.url).toBe('/ilink/bot/get_qrcode_status?qrcode=qr-1&verify_code=1234');
      expect((await client.getConfig('user-1', 'ctx')).typing_ticket).toBe('ticket-1');
      expect(ilink.requests[3]?.body).toMatchObject({ ilink_user_id: 'user-1', context_token: 'ctx' });
      expect((await client.sendTyping('user-1', 'ticket-1', 1)).ret).toBe(0);
      expect(ilink.requests[4]?.body).toMatchObject({ ilink_user_id: 'user-1', typing_ticket: 'ticket-1', status: 1 });
      expect((await client.notifyStart()).ret).toBe(0);
      expect((await client.notifyStop()).ret).toBe(0);
      expect(ilink.requests[5]?.url).toBe('/ilink/bot/msg/notifystart');
      expect(ilink.requests[6]?.url).toBe('/ilink/bot/msg/notifystop');
    } finally {
      await ilink.stop();
    }
  });

  it('classifies non-zero ret as ILinkApiError', async () => {
    const handler: IlinkHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 1001, errmsg: 'bad request' }));
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    try {
      const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
      const error = await client.getUpdates('').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ILinkApiError);
      expect((error as ILinkApiError).ret).toBe(1001);
    } finally {
      await ilink.stop();
    }
  });

  it('classifies errcode -14 as reauth and never as retry', async () => {
    const handler: IlinkHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, errcode: -14, errmsg: 'token invalid' }));
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    try {
      const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
      const error = await client.getUpdates('').catch((err: unknown) => err);
      expect(isReauthError(error)).toBe(true);
      expect(error).toBeInstanceOf(ILinkReauthError);
    } finally {
      await ilink.stop();
    }
  });

  it('classifies 429 with Retry-After as rate limited', async () => {
    const handler: IlinkHandler = (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end(JSON.stringify({ ret: 429, errmsg: 'rate limited' }));
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    try {
      const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: TOKEN });
      const error = await client.getUpdates('').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ILinkRateLimitedError);
      expect((error as ILinkRateLimitedError).retryAfterMs).toBe(5_000);
    } finally {
      await ilink.stop();
    }
  });

  it('classifies connection failures as network', async () => {
    const ilink = new FakeIlink({ token: TOKEN });
    await ilink.start();
    const port = ilink.port;
    await ilink.stop();
    const client = new ILinkClient({ baseUrl: `http://127.0.0.1:${port}`, botToken: TOKEN });
    const error = await client.getUpdates('').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ILinkNetworkError);
  });

  it('classifies a hung request as timeout', async () => {
    const handler: IlinkHandler = () => {
      // Never respond.
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    try {
      const client = new ILinkClient({
        baseUrl: `http://127.0.0.1:${ilink.port}`,
        botToken: TOKEN,
        timeoutMs: 100,
      });
      const error = await client.getUpdates('', {}, 1_000).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ILinkTimeoutError);
    } finally {
      await ilink.stop();
    }
  });
});
