import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ILinkClient } from '../src/ilink/client.js';
import { AdapterService } from '../src/service.js';
import { FakeGateway, FAKE_PROJECT_ID, FAKE_TAB_ID, type FakeHandler } from './helpers/fakeGateway.js';
import { FakeIlink, type IlinkHandler } from './helpers/fakeIlink.js';
import { waitUntil } from './helpers/wait.js';

const GW_TOKEN = 'gw-token';
const ILINK_TOKEN = 'ilink-token';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-service-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(path.join(dir, name), JSON.stringify(value), 'utf8');
}

interface Env {
  gateway: FakeGateway;
  ilink: FakeIlink;
  discovery: string;
  ilinkBase: string;
}

function gatewayHandler(): FakeHandler {
  return (_req, res) => {
    const url = _req.url ?? '';
    if (url.endsWith('/tabs') && _req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        }),
      );
      return;
    }
    if (url.endsWith('/events') && _req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      res.write(': keepalive\n\n');
      return;
    }
    if (url.endsWith('/chat') && _req.method === 'POST') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'task-1', projectId: FAKE_PROJECT_ID, tabId: FAKE_TAB_ID, status: 'accepted' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  };
}

function qrStatuses(statuses: Array<Record<string, unknown>>): IlinkHandler {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (_req.url?.includes('get_bot_qrcode') === true) {
      res.end(JSON.stringify({ qrcode: 'qr-1', qrcode_img_content: 'https://qr.example/login' }));
      return;
    }
    if (_req.url?.includes('getupdates') === true) {
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'c0' }));
      return;
    }
    res.end(JSON.stringify(statuses.shift() ?? { status: 'wait' }));
  };
}

async function startEnv(): Promise<Env> {
  const gateway = new FakeGateway({ token: GW_TOKEN, handler: gatewayHandler() });
  await gateway.start();
  const ilink = new FakeIlink({ token: ILINK_TOKEN, handler: qrStatuses([]) });
  await ilink.start();
  const discovery = path.join(dir, 'gateway.json');
  await writeJson('gateway.json', {
    version: 1,
    host: '127.0.0.1',
    port: gateway.port,
    tokenFile: path.join(dir, 'gw-token.txt'),
    pid: 1,
  });
  await writeFile(path.join(dir, 'gw-token.txt'), GW_TOKEN, 'utf8');
  return { gateway, ilink, discovery, ilinkBase: `http://127.0.0.1:${ilink.port}` };
}

function makeService(env: Env, ilink: FakeIlink): AdapterService {
  return new AdapterService({
    stateDir: dir,
    discoveryPath: env.discovery,
    controlToken: 'svc-token',
    createLoginClient: (_baseUrl) => new ILinkClient({ baseUrl: `http://127.0.0.1:${ilink.port}`, botToken: '' }),
    loginSleep: async () => undefined,
    loginTimeoutMs: 30_000,
    log: () => undefined,
  });
}

describe('AdapterService', () => {
  it('starts logged out without transport', async () => {
    const env = await startEnv();
    const service = makeService(env, env.ilink);
    try {
      await service.start();
      const status = service.status() as { authState: string; transportRunning: boolean };
      expect(status.authState).toBe('UNCONFIGURED');
      expect(status.transportRunning).toBe(false);
    } finally {
      await service.shutdown();
      await env.gateway.stop();
      await env.ilink.stop();
    }
  });

  it('starts transport when credentials already exist (CONNECTED_UNBOUND)', async () => {
    const env = await startEnv();
    await writeJson('bot-account.json', {
      botAccountId: 'bot-1',
      botToken: ILINK_TOKEN,
      baseUrl: env.ilinkBase,
      authorizedWeixinUserId: 'user-1',
      savedAt: 1,
    });
    const service = makeService(env, env.ilink);
    try {
      await service.start();
      const status = service.status() as { authState: string; transportRunning: boolean; binding: { state: string } };
      expect(status.authState).toBe('AUTHORIZED');
      expect(status.transportRunning).toBe(true);
      expect(status.binding.state).toBe('UNBOUND');
    } finally {
      await service.shutdown();
      await env.gateway.stop();
      await env.ilink.stop();
    }
  });

  it('starts transport in the same process after login confirm', async () => {
    const env = await startEnv();
    await env.ilink.stop();
    const statuses = [
      { status: 'wait' },
      { status: 'confirmed', bot_token: ILINK_TOKEN, ilink_bot_id: 'bot-1', baseurl: env.ilinkBase, ilink_user_id: 'user-1' },
    ];
    const ilink = new FakeIlink({ token: ILINK_TOKEN, handler: qrStatuses(statuses) });
    await ilink.start();
    const service = makeService(env, ilink);
    try {
      await service.start();
      service.loginStart();
      await waitUntil(() => (service.status() as { transportRunning: boolean }).transportRunning === true);
      const status = service.status() as { authState: string; transportRunning: boolean };
      expect(status.authState).toBe('AUTHORIZED');
      expect(status.transportRunning).toBe(true);
    } finally {
      await service.shutdown();
      await env.gateway.stop();
      await ilink.stop();
    }
  });

  it('logout stops transport and clears binding; relogin restarts in the same process', async () => {
    const env = await startEnv();
    await env.ilink.stop();
    const statuses = [
      { status: 'confirmed', bot_token: ILINK_TOKEN, ilink_bot_id: 'bot-1', baseurl: env.ilinkBase, ilink_user_id: 'user-1' },
    ];
    const ilink = new FakeIlink({ token: ILINK_TOKEN, handler: qrStatuses(statuses) });
    await ilink.start();
    const service = makeService(env, ilink);
    try {
      await service.start();
      service.loginStart();
      await waitUntil(() => (service.status() as { transportRunning: boolean }).transportRunning === true);
      await service.bind({ projectId: FAKE_PROJECT_ID, tabId: FAKE_TAB_ID });
      expect((service.status() as { binding: { state: string } }).binding.state).toBe('BOUND');

      await service.logout();
      let status = service.status() as { authState: string; transportRunning: boolean; binding: { state: string } };
      expect(status.transportRunning).toBe(false);
      expect(status.binding.state).toBe('UNBOUND');
      expect(status.authState).toBe('UNCONFIGURED');

      const statuses2 = [
        { status: 'confirmed', bot_token: ILINK_TOKEN, ilink_bot_id: 'bot-1', baseurl: env.ilinkBase, ilink_user_id: 'user-1' },
      ];
      ilink.setHandler(qrStatuses(statuses2));
      service.loginStart();
      await waitUntil(() => (service.status() as { transportRunning: boolean }).transportRunning === true);
      expect((service.status() as { transportRunning: boolean }).transportRunning).toBe(true);
    } finally {
      await service.shutdown();
      await env.gateway.stop();
      await ilink.stop();
    }
  });

  it('adapter restart preserves credentials but not binding', async () => {
    const env = await startEnv();
    await env.ilink.stop();
    const statuses = [
      { status: 'confirmed', bot_token: ILINK_TOKEN, ilink_bot_id: 'bot-1', baseurl: env.ilinkBase, ilink_user_id: 'user-1' },
    ];
    const ilink = new FakeIlink({ token: ILINK_TOKEN, handler: qrStatuses(statuses) });
    await ilink.start();
    const first = makeService(env, ilink);
    try {
      await first.start();
      first.loginStart();
      await waitUntil(() => (first.status() as { transportRunning: boolean }).transportRunning === true);
      await first.bind({ projectId: FAKE_PROJECT_ID, tabId: FAKE_TAB_ID });
      expect((first.status() as { binding: { state: string } }).binding.state).toBe('BOUND');
      await first.shutdown();

      const second = makeService(env, ilink);
      await second.start();
      const status = second.status() as { authState: string; transportRunning: boolean; binding: { state: string } };
      expect(status.authState).toBe('AUTHORIZED');
      expect(status.transportRunning).toBe(true);
      expect(status.binding.state).toBe('UNBOUND');
      await second.shutdown();
    } finally {
      await env.gateway.stop();
      await ilink.stop();
    }
  });
});
