import { describe, expect, it } from 'vitest';
import type { GatewayDiscovery } from '../src/discovery.js';
import { GatewayError, isGatewayError } from '../src/gateway/errors.js';
import { GatewayClient } from '../src/gateway/client.js';
import {
  FAKE_PROJECT_ID,
  FAKE_TAB_ID,
  FakeGateway,
  type FakeHandler,
} from './helpers/fakeGateway.js';

const TOKEN = 'token-123';

function discoveryFor(port: number, host = '127.0.0.1'): GatewayDiscovery {
  return { version: 1, host, port, tokenFile: 'token.txt', pid: 1 };
}

function writeJson(res: Parameters<FakeHandler>[1], status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('GatewayClient', () => {
  it('implements the v1 happy-path endpoints with Bearer auth', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    try {
      const client = new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN });
      const health = await client.health();
      expect(health.bridgeReady).toBe(true);
      expect((await client.status()).openProjectCount).toBe(1);
      expect((await client.projects()).map((p) => p.projectId)).toEqual([FAKE_PROJECT_ID]);
      expect((await client.tabs(FAKE_PROJECT_ID)).map((t) => t.tabId)).toEqual([FAKE_TAB_ID]);
      expect((await client.tab(FAKE_PROJECT_ID, FAKE_TAB_ID)).busy).toBe(false);
      expect((await client.chat(FAKE_PROJECT_ID, FAKE_TAB_ID, 'hello')).taskId).toBe('task-1');
      expect((await client.abort(FAKE_PROJECT_ID, FAKE_TAB_ID, 'task-1')).status).toBe('aborting');
      expect((await client.getMode(FAKE_PROJECT_ID, FAKE_TAB_ID)).mode).toBe('default');
      expect((await client.setMode(FAKE_PROJECT_ID, FAKE_TAB_ID, 'plan')).mode).toBe('default');
      expect(
        (await client.resolvePermission(FAKE_PROJECT_ID, FAKE_TAB_ID, 'task-1', 'i1', 'ALLOW')).resolved,
      ).toBe(true);
      expect(
        (await client.answerQuestion(FAKE_PROJECT_ID, FAKE_TAB_ID, 'task-1', 'i2', { q: 'a' })).resolved,
      ).toBe(true);
      expect(
        (await client.decidePlan(FAKE_PROJECT_ID, FAKE_TAB_ID, 'task-1', 'i3', true, 'plan')).resolved,
      ).toBe(true);
      expect(gateway.requests.length).toBeGreaterThan(0);
      for (const request of gateway.requests) {
        expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      }
      client.close();
    } finally {
      await gateway.stop();
    }
  });

  it('includes taskId in interaction control bodies', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    try {
      const client = new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN });
      await client.resolvePermission(FAKE_PROJECT_ID, FAKE_TAB_ID, 'task-9', 'i1', 'ALLOW');
      await client.answerQuestion(FAKE_PROJECT_ID, FAKE_TAB_ID, 'task-9', 'i2', { q: 'a' });
      await client.decidePlan(FAKE_PROJECT_ID, FAKE_TAB_ID, 'task-9', 'i3', true, 'plan');
      const control = gateway.requests.filter((r) => r.url.includes('/permissions/') || r.url.includes('/questions/') || r.url.includes('/plans/'));
      expect(control.length).toBe(3);
      for (const request of control) {
        expect((request.body as { taskId: string }).taskId).toBe('task-9');
      }
      client.close();
    } finally {
      await gateway.stop();
    }
  });

  it('classifies TAB_BUSY 409 as busy with the original code', async () => {
    const handler: FakeHandler = (_req, res) => {
      writeJson(res, 409, { error: { code: 'TAB_BUSY', message: 'Tab is busy' } });
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    try {
      const client = new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN });
      await expect(client.chat(FAKE_PROJECT_ID, FAKE_TAB_ID, 'x')).rejects.toMatchObject({
        kind: 'busy',
        code: 'TAB_BUSY',
        status: 409,
      });
      client.close();
    } finally {
      await gateway.stop();
    }
  });

  it('classifies 404 as not_found and 401 as auth', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    try {
      const client = new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN });
      await expect(client.tabs('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).rejects.toMatchObject({
        kind: 'not_found',
      });
      const wrongToken = new GatewayClient({ discovery: discoveryFor(gateway.port), token: 'wrong' });
      await expect(wrongToken.health()).rejects.toMatchObject({ kind: 'auth', status: 401 });
      client.close();
      wrongToken.close();
    } finally {
      await gateway.stop();
    }
  });

  it('classifies an unreachable gateway as network', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const port = gateway.port;
    await gateway.stop();
    const client = new GatewayClient({ discovery: discoveryFor(port), token: TOKEN });
    try {
      await expect(client.health()).rejects.toMatchObject({ kind: 'network' });
    } finally {
      client.close();
    }
  });

  it('classifies a hung request as timeout', async () => {
    const handler: FakeHandler = () => {
      // Never respond; the client timeout must abort.
    };
    const gateway = new FakeGateway({ token: TOKEN, handler });
    await gateway.start();
    try {
      const client = new GatewayClient({
        discovery: discoveryFor(gateway.port),
        token: TOKEN,
        timeoutMs: 200,
      });
      await expect(client.health()).rejects.toMatchObject({ kind: 'timeout' });
      client.close();
    } finally {
      await gateway.stop();
    }
  });

  it('rejects requests after close()', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    try {
      const client = new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN });
      client.close();
      await expect(client.health()).rejects.toMatchObject({ kind: 'invalid' });
    } finally {
      await gateway.stop();
    }
  });

  it('existsTarget() returns false for a missing tab and propagates network errors', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    try {
      const client = new GatewayClient({ discovery: discoveryFor(gateway.port), token: TOKEN });
      expect(await client.existsTarget(FAKE_PROJECT_ID, FAKE_TAB_ID)).toBe(true);
      expect(await client.existsTarget(FAKE_PROJECT_ID, '11111111-2222-3333-4444-999999999999')).toBe(false);
      expect(await client.existsTarget('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', FAKE_TAB_ID)).toBe(false);
      client.close();
    } finally {
      await gateway.stop();
    }

    const deadGateway = new FakeGateway({ token: TOKEN });
    await deadGateway.start();
    const deadPort = deadGateway.port;
    await deadGateway.stop();
    const deadClient = new GatewayClient({ discovery: discoveryFor(deadPort), token: TOKEN });
    try {
      await expect(deadClient.existsTarget(FAKE_PROJECT_ID, FAKE_TAB_ID)).rejects.toMatchObject({
        kind: 'network',
      });
    } finally {
      deadClient.close();
    }
  });

  it('does not leak the token into error messages', async () => {
    const gateway = new FakeGateway({ token: TOKEN });
    await gateway.start();
    const port = gateway.port;
    await gateway.stop();
    const client = new GatewayClient({ discovery: discoveryFor(port), token: TOKEN });
    try {
      const error = await client.health().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(GatewayError);
      expect(isGatewayError(error, 'network')).toBe(true);
      expect(String((error as Error).message)).not.toContain(TOKEN);
    } finally {
      client.close();
    }
  });
});
