import { describe, expect, it } from 'vitest';
import { AdapterApp, NotBoundError, TargetUnavailableError } from '../src/app.js';
import { BindingValidationError } from '../src/binding.js';
import type { GatewayDiscovery } from '../src/discovery.js';
import { GatewayError, isGatewayError } from '../src/gateway/errors.js';
import { GatewayClient } from '../src/gateway/client.js';
import {
  FAKE_PROJECT_ID,
  FAKE_TAB_ID,
  FAKE_TAB_ID_2,
  FakeGateway,
  type FakeHandler,
} from './helpers/fakeGateway.js';

const TOKEN = 'token-app';

function discoveryFor(port: number): GatewayDiscovery {
  return { version: 1, host: '127.0.0.1', port, tokenFile: 'token.txt', pid: 1 };
}

function clientFor(gateway: FakeGateway): GatewayClient {
  return new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN });
}

function writeJson(res: Parameters<FakeHandler>[1], status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('AdapterApp', () => {
  it('binds an existing target after validating it via GET /tabs', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => clientFor(gateway) });
    try {
      const target = await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      expect(target).toEqual({ projectId: FAKE_PROJECT_ID, tabId: FAKE_TAB_ID });
      expect(app.state).toEqual({ state: 'BOUND', target });
      expect(gateway.requests.some((r) => r.url.endsWith('/tabs') && r.method === 'GET')).toBe(true);
    } finally {
      app.stop();
      await gateway.stop();
    }
  });

  it('rejects a non-existent target and stays UNBOUND', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => clientFor(gateway) });
    try {
      await expect(app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID_2)).rejects.toBeInstanceOf(TargetUnavailableError);
      expect(app.state.state).toBe('UNBOUND');
    } finally {
      app.stop();
      await gateway.stop();
    }
  });

  it('rejects malformed identity formats before any HTTP call', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => clientFor(gateway) });
    try {
      await expect(app.bind('not-hex', FAKE_TAB_ID)).rejects.toBeInstanceOf(BindingValidationError);
      await expect(app.bind(FAKE_PROJECT_ID, 'not-a-uuid')).rejects.toBeInstanceOf(BindingValidationError);
      expect(gateway.requests.length).toBe(0);
    } finally {
      app.stop();
      await gateway.stop();
    }
  });

  it('rebinds atomically and routes new messages to the new tab', async () => {
    const handler: FakeHandler = (_req, res, body) => {
      const url = (_req.url ?? '') as string;
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [
            { tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false },
            { tabId: FAKE_TAB_ID_2, index: 1, selected: false, busy: false },
          ],
        });
        return;
      }
      if (url.endsWith('/chat') && _req.method === 'POST') {
        writeJson(res, 202, {
          taskId: 'task-2',
          projectId: FAKE_PROJECT_ID,
          tabId: url.split('/')[7],
          status: 'accepted',
        });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      void body;
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => clientFor(gateway) });
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID_2);
      expect(app.state.target?.tabId).toBe(FAKE_TAB_ID_2);
      await app.sendMessage('hello');
      const chatRequests = gateway.requests.filter((r) => r.url.endsWith('/chat'));
      expect(chatRequests.length).toBe(1);
      expect(chatRequests[0]?.url).toContain(FAKE_TAB_ID_2);
      expect(chatRequests[0]?.body).toEqual({ message: 'hello' });
    } finally {
      app.stop();
      await gateway.stop();
    }
  });

  it('moves OFFLINE when the gateway dies and recovers BOUND via fresh discovery', async () => {
    let gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const app = new AdapterApp({
      loadClient: async () => clientFor(gateway),
    });
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      await gateway.stop();
      await app.checkNow();
      expect(app.state.state).toBe('OFFLINE');
      expect(app.state.target?.tabId).toBe(FAKE_TAB_ID);

      gateway = new FakeGateway({ token: TOKEN });
      await gateway.start();
      await app.checkNow();
      expect(app.state.state).toBe('BOUND');
      expect(app.state.target?.tabId).toBe(FAKE_TAB_ID);
    } finally {
      app.stop();
      await gateway.stop();
    }
  });

  it('moves INVALID when the bound tab disappears and never picks another', async () => {
    let closed = false;
    const handler: FakeHandler = (_req, res) => {
      if (closed) {
        writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Tab not found' } });
        return;
      }
      writeJson(res, 200, {
        projectId: FAKE_PROJECT_ID,
        tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
      });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => clientFor(gateway) });
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      closed = true;
      await app.checkNow();
      expect(app.state.state).toBe('INVALID');
      expect(app.state.target?.tabId).toBe(FAKE_TAB_ID);
    } finally {
      app.stop();
      await gateway.stop();
    }
  });

  it('sends only while BOUND and propagates TAB_BUSY', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => clientFor(gateway) });
    try {
      await expect(app.sendMessage('x')).rejects.toBeInstanceOf(NotBoundError);
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      const result = await app.sendMessage('hi');
      expect(result.taskId).toBe('task-1');
    } finally {
      app.stop();
      await gateway.stop();
    }

    const busyHandler: FakeHandler = (_req, res) => {
      const url = (_req.url ?? '') as string;
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [{ tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false }],
        });
        return;
      }
      writeJson(res, 409, { error: { code: 'TAB_BUSY', message: 'Tab is busy' } });
    };
    const busyGateway = new FakeGateway({ token: TOKEN, handler: busyHandler });
    await busyGateway.start();
    const busyApp = new AdapterApp({ loadClient: async () => clientFor(busyGateway) });
    try {
      await busyApp.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      const error = await busyApp.sendMessage('x').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(GatewayError);
      expect(isGatewayError(error, 'busy')).toBe(true);
      expect((error as GatewayError).code).toBe('TAB_BUSY');
    } finally {
      busyApp.stop();
      await busyGateway.stop();
    }
  });

  it('start()/stop() owns the re-check timer', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const app = new AdapterApp({
      loadClient: async () => clientFor(gateway),
      pollIntervalMs: 20,
    });
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      app.start();
      await new Promise((resolve) => setTimeout(resolve, 70));
      app.stop();
      const checks = gateway.requests.filter((r) => r.url.endsWith('/tabs'));
      expect(checks.length).toBeGreaterThanOrEqual(2);
    } finally {
      app.stop();
      await gateway.stop();
    }
  });

  it('sendMessage honours a captured target after rebind', async () => {
    const TAB_B = '11111111-2222-3333-4444-777777777777';
    const chats: string[] = [];
    const handler: FakeHandler = (_req, res) => {
      const url = _req.url ?? '';
      if (url.endsWith('/tabs') && _req.method === 'GET') {
        writeJson(res, 200, {
          projectId: FAKE_PROJECT_ID,
          tabs: [
            { tabId: FAKE_TAB_ID, index: 0, selected: false, busy: false },
            { tabId: TAB_B, index: 1, selected: false, busy: false },
          ],
        });
        return;
      }
      const chatMatch = url.match(/\/tabs\/([0-9a-f-]{36})\/chat$/);
      if (chatMatch !== null && _req.method === 'POST') {
        chats.push(chatMatch[1] ?? '');
        writeJson(res, 202, { taskId: 't', projectId: FAKE_PROJECT_ID, tabId: chatMatch[1], status: 'accepted' });
        return;
      }
      writeJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    const app = new AdapterApp({ loadClient: async () => clientFor(gateway) });
    try {
      await app.bind(FAKE_PROJECT_ID, FAKE_TAB_ID);
      const captured = app.state.target;
      expect(captured?.tabId).toBe(FAKE_TAB_ID);
      await app.bind(FAKE_PROJECT_ID, TAB_B);
      await app.sendMessage('stale', captured);
      await app.sendMessage('fresh');
      expect(chats).toEqual([FAKE_TAB_ID, TAB_B]);
    } finally {
      app.stop();
      await gateway.stop();
    }
  });
});
