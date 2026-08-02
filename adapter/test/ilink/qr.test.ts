import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ILinkClient } from '../../src/ilink/client.js';
import { FIXED_ILINK_BASE_URL, runQrAuthorization } from '../../src/ilink/qr.js';
import { CredentialStore } from '../../src/ilink/store.js';
import { FakeIlink, type IlinkHandler } from '../helpers/fakeIlink.js';

const TOKEN = 'qr-token';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-qr-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function harness(ilink: FakeIlink) {
  const store = new CredentialStore(dir);
  const baseUrls: string[] = [];
  const displayed: string[] = [];
  const deps = {
    createClient: (baseUrl: string): ILinkClient => {
      baseUrls.push(baseUrl);
      return new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: '' });
    },
    store,
    display: async (url: string): Promise<void> => {
      displayed.push(url);
    },
    readVerifyCode: async (): Promise<string> => '1234',
    sleep: async (): Promise<void> => undefined,
  };
  return { store, baseUrls, displayed, deps };
}

function confirmedStatus(): Record<string, unknown> {
  return {
    status: 'confirmed',
    bot_token: 'bot-token-1',
    ilink_bot_id: 'bot-1',
    baseurl: 'https://api.example',
    ilink_user_id: 'user-1',
  };
}

function qrHandler(statuses: Record<string, unknown>[]): IlinkHandler {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (_req.url?.includes('get_bot_qrcode') === true) {
      res.end(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'img-data' }));
      return;
    }
    res.end(JSON.stringify(statuses.shift() ?? { status: 'wait' }));
  };
}

describe('runQrAuthorization', () => {
  it('persists credentials after wait -> confirmed', async () => {
    const statuses = [{ status: 'wait' }, confirmedStatus()];
    const ilink = new FakeIlink({ token: TOKEN, handler: qrHandler(statuses) });
    await ilink.start();
    try {
      const { store, baseUrls, displayed, deps } = harness(ilink);
      const result = await runQrAuthorization(deps);
      expect(result.ok).toBe(true);
      expect(result.credentials?.botAccountId).toBe('bot-1');
      expect(result.credentials?.botToken).toBe('bot-token-1');
      expect(result.credentials?.baseUrl).toBe('https://api.example');
      expect(result.credentials?.authorizedWeixinUserId).toBe('user-1');
      expect(baseUrls).toEqual([FIXED_ILINK_BASE_URL]);
      expect(displayed).toEqual(['img-data']);
      expect((await store.loadBotCredentials())?.botAccountId).toBe('bot-1');
    } finally {
      await ilink.stop();
    }
  });

  it('prompts for and carries the verify code', async () => {
    const statuses = [
      { status: 'need_verifycode' },
      { status: 'scaned' },
      confirmedStatus(),
    ];
    const ilink = new FakeIlink({ token: TOKEN, handler: qrHandler(statuses) });
    await ilink.start();
    try {
      const { deps } = harness(ilink);
      const result = await runQrAuthorization(deps);
      expect(result.ok).toBe(true);
      const statusRequests = ilink.requests.filter((r) => r.url.includes('get_qrcode_status'));
      expect(statusRequests.some((r) => r.url.includes('verify_code=1234'))).toBe(true);
    } finally {
      await ilink.stop();
    }
  });

  it('refreshes the QR once after expired and still succeeds', async () => {
    const statuses = [{ status: 'expired' }, confirmedStatus()];
    let qrCalls = 0;
    const handler: IlinkHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (_req.url?.includes('get_bot_qrcode') === true) {
        qrCalls += 1;
        res.end(
          JSON.stringify(
            qrCalls === 1
              ? { qrcode: 'qr-1', qrcode_img_content: 'img-data' }
              : { qrcode: 'qr-2', qrcode_img_content: 'url-2' },
          ),
        );
        return;
      }
      res.end(JSON.stringify(statuses.shift() ?? { status: 'wait' }));
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    try {
      const { displayed, deps } = harness(ilink);
      const result = await runQrAuthorization(deps);
      expect(result.ok).toBe(true);
      expect(displayed).toEqual(['img-data', 'url-2']);
      expect(ilink.requests.filter((r) => r.url.includes('get_bot_qrcode')).length).toBe(2);
    } finally {
      await ilink.stop();
    }
  });

  it('treats binded_redirect as already connected without saving', async () => {
    const ilink = new FakeIlink({ token: TOKEN, handler: qrHandler([{ status: 'binded_redirect' }]) });
    await ilink.start();
    try {
      const { store, deps } = harness(ilink);
      const result = await runQrAuthorization(deps);
      expect(result.ok).toBe(true);
      expect(result.alreadyConnected).toBe(true);
      expect(await store.loadBotCredentials()).toBeUndefined();
    } finally {
      await ilink.stop();
    }
  });

  it('switches the polling host on scaned_but_redirect', async () => {
    const statuses = [
      { status: 'scaned_but_redirect', redirect_host: 'host2.example' },
      { status: 'wait' },
      confirmedStatus(),
    ];
    const ilink = new FakeIlink({ token: TOKEN, handler: qrHandler(statuses) });
    await ilink.start();
    try {
      const { baseUrls, deps } = harness(ilink);
      const result = await runQrAuthorization(deps);
      expect(result.ok).toBe(true);
      expect(baseUrls).toEqual([FIXED_ILINK_BASE_URL, 'https://host2.example']);
    } finally {
      await ilink.stop();
    }
  });

  it('fails when the QR cannot be fetched', async () => {
    const handler: IlinkHandler = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ret: 500, errmsg: 'boom' }));
    };
    const ilink = new FakeIlink({ token: TOKEN, handler });
    await ilink.start();
    try {
      const { deps } = harness(ilink);
      const result = await runQrAuthorization(deps);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('获取二维码失败');
    } finally {
      await ilink.stop();
    }
  });
});
