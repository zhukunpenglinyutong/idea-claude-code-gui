import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ILinkClient } from '../../src/ilink/client.js';
import { WechatLoginService } from '../../src/ilink/loginService.js';
import { CredentialStore } from '../../src/ilink/store.js';
import { FakeIlink, type IlinkHandler } from '../helpers/fakeIlink.js';
import { waitUntil } from '../helpers/wait.js';

const QR_TOKEN = 'qr-token';
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-login-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function confirmedStatus(baseUrl: string): Record<string, unknown> {
  return {
    status: 'confirmed',
    bot_token: 'bot-token-1',
    ilink_bot_id: 'bot-1',
    baseurl: baseUrl,
    ilink_user_id: 'user-1',
  };
}

function qrHandler(statuses: Record<string, unknown>[]): IlinkHandler {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (_req.url?.includes('get_bot_qrcode') === true) {
      res.end(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.example/login' }));
      return;
    }
    res.end(JSON.stringify(statuses.shift() ?? { status: 'wait' }));
  };
}

async function harness(ilink: FakeIlink) {
  const store = new CredentialStore(dir);
  const confirmed: string[] = [];
  const service = new WechatLoginService({
    store,
    sleep: async () => undefined,
    createClient: (_baseUrl) => new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: '' }),
    onConfirmed: (credentials) => confirmed.push(credentials.botAccountId),
  });
  return { store, service, confirmed };
}

describe('WechatLoginService', () => {
  it('starts a QR_PENDING session with no credentials', async () => {
    const ilink = new FakeIlink({ token: QR_TOKEN, handler: qrHandler([]) });
    await ilink.start();
    try {
      const { service, store } = await harness(ilink);
      const view = service.startLogin();
      expect(view.status).toBe('QR_PENDING');
      expect(service.activeLoginId).toBe(view.loginId);
      expect(await store.loadBotCredentials()).toBeUndefined();
      service.cancel(view.loginId);
    } finally {
      await ilink.stop();
    }
  });

  it('returns the same session for duplicate login starts', async () => {
    const ilink = new FakeIlink({ token: QR_TOKEN, handler: qrHandler([]) });
    await ilink.start();
    try {
      const { service } = await harness(ilink);
      const first = service.startLogin();
      const second = service.startLogin();
      expect(second.loginId).toBe(first.loginId);
      service.cancel(first.loginId);
    } finally {
      await ilink.stop();
    }
  });

  it('loginStart after cancel immediately supersedes with a fresh session', async () => {
    const ilink = new FakeIlink({ token: QR_TOKEN, handler: qrHandler([]) });
    await ilink.start();
    try {
      const { service } = await harness(ilink);
      const first = service.startLogin();
      service.cancel(first.loginId);
      const second = service.startLogin();
      expect(second.loginId).not.toBe(first.loginId);
      expect(second.status).toBe('QR_PENDING');
      expect(service.activeLoginId).toBe(second.loginId);
      service.cancel(second.loginId);
    } finally {
      await ilink.stop();
    }
  });

  it('cancel aborts the in-flight long poll immediately', async () => {
    const store = new CredentialStore(dir);
    let aborted = false;
    let markPollStarted: () => void = () => undefined;
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    const service = new WechatLoginService({
      store,
      sleep: async () => undefined,
      createClient: () =>
        ({
          getQrCode: async () => ({
            qrcode: 'qr-1',
            qrcode_img_content: 'https://qr.example/login',
          }),
          getQrCodeStatus: async (
            _qrcode: string,
            _verifyCode?: string,
            options?: { signal?: AbortSignal },
          ) => {
            markPollStarted();
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            });
          },
        }) as unknown as ILinkClient,
      onConfirmed: () => undefined,
    });
    const view = service.startLogin();
    await pollStarted;
    service.cancel(view.loginId);
    await waitUntil(() => aborted);
    expect(aborted).toBe(true);
  });

  it('confirms, persists credentials and notifies the service', async () => {
    const ilink = new FakeIlink({ token: QR_TOKEN });
    await ilink.start();
    const handler = qrHandler([{ status: 'wait' }, confirmedStatus(`http://127.0.0.1:${ilink.port}`)]);
    const ilink2 = new FakeIlink({ token: QR_TOKEN, handler });
    await ilink2.start();
    try {
      const { service, store, confirmed } = await harness(ilink2);
      const view = service.startLogin();
      await waitUntil(() => confirmed.length === 1);
      expect(confirmed).toEqual(['bot-1']);
      expect((await store.loadBotCredentials())?.botAccountId).toBe('bot-1');
      expect(service.get(view.loginId)?.status).toBe('CONFIRMED');
    } finally {
      await ilink.stop();
      await ilink2.stop();
    }
  });

  it('round-trips a verify code', async () => {
    const statuses = [{ status: 'need_verifycode' }, { status: 'scaned' }, confirmedStatus('https://api.example')];
    const ilink = new FakeIlink({ token: QR_TOKEN, handler: qrHandler(statuses) });
    await ilink.start();
    try {
      const { service, confirmed } = await harness(ilink);
      const view = service.startLogin();
      await waitUntil(() => service.get(view.loginId)?.status === 'VERIFY_CODE_REQUIRED');
      expect(service.submitVerifyCode(view.loginId, '1234')).toBe(true);
      await waitUntil(() => confirmed.length === 1);
      const statusRequests = ilink.requests.filter((r) => r.url.includes('get_qrcode_status'));
      expect(statusRequests.some((r) => r.url.includes('verify_code=1234'))).toBe(true);
    } finally {
      await ilink.stop();
    }
  });

  it('refreshes deterministically after expiry and reaches confirmed', async () => {
    const statuses = [{ status: 'expired' }, confirmedStatus('https://api.example')];
    const ilink = new FakeIlink({ token: QR_TOKEN, handler: qrHandler(statuses) });
    await ilink.start();
    try {
      const { service, confirmed } = await harness(ilink);
      const view = service.startLogin();
      await waitUntil(() => confirmed.length === 1);
      expect(ilink.requests.filter((r) => r.url.includes('get_bot_qrcode')).length).toBe(2);
      expect(service.get(view.loginId)?.status).toBe('CONFIRMED');
    } finally {
      await ilink.stop();
    }
  });

  it('cancel stops an in-flight login', async () => {
    const ilink = new FakeIlink({ token: QR_TOKEN, handler: qrHandler([]) });
    await ilink.start();
    try {
      const { service } = await harness(ilink);
      const view = service.startLogin();
      service.cancel(view.loginId);
      await waitUntil(() => service.get(view.loginId)?.status === 'CANCELLED');
      expect(service.activeLoginId).toBeUndefined();
    } finally {
      await ilink.stop();
    }
  });

  it('never exposes credentials in session views or QR data', async () => {
    const ilink = new FakeIlink({ token: QR_TOKEN, handler: qrHandler([confirmedStatus('https://api.example')]) });
    await ilink.start();
    try {
      const { service, confirmed } = await harness(ilink);
      const view = service.startLogin();
      await waitUntil(() => confirmed.length === 1);
      const finalView = service.get(view.loginId);
      expect(JSON.stringify(finalView)).not.toContain('bot-token-1');
      const png = service.getQrPng(view.loginId);
      expect(png).toBeDefined();
      expect(png?.length).toBeGreaterThan(0);
      expect(png?.toString('utf8')).not.toContain('bot-token-1');
    } finally {
      await ilink.stop();
    }
  });
});
