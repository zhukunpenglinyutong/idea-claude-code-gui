import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlServer, type ControlServiceFacade } from '../../src/control/server.js';

const TOKEN = 'control-token-abc';

class FakeFacade implements ControlServiceFacade {
  bindCalls = 0;
  unbindCalls = 0;
  logoutCalls = 0;
  shutdownCalls = 0;

  status(): unknown {
    return {
      version: 1,
      authState: 'AUTHORIZED',
      transportRunning: true,
      login: null,
      binding: { state: 'BOUND' },
    };
  }

  loginStart(): { loginId: string; status: string; expiresAt: number } {
    return { loginId: 'L1', status: 'QR_PENDING', expiresAt: 1_234 };
  }

  loginStatus(loginId: string): unknown {
    return loginId === 'L1'
      ? { loginId: 'L1', status: 'SCANNED', expiresAt: 1_234, verifyCodeRequired: false }
      : undefined;
  }

  loginQrPng(loginId: string): Buffer | undefined {
    return loginId === 'L1' ? Buffer.from('FAKE-PNG') : undefined;
  }

  loginVerify(loginId: string, code: string): boolean {
    return loginId === 'L1' && code === '1234';
  }

  loginCancel(loginId: string): boolean {
    return loginId === 'L1';
  }

  async bind(): Promise<void> {
    this.bindCalls += 1;
  }

  async unbind(): Promise<void> {
    this.unbindCalls += 1;
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

describe('ControlServer', () => {
  let server: ControlServer;
  let facade: FakeFacade;
  let base: string;

  afterEach(async () => {
    await server?.stop();
  });

  async function start(): Promise<void> {
    facade = new FakeFacade();
    server = new ControlServer({ token: TOKEN, facade });
    const port = await server.start();
    base = `http://127.0.0.1:${port}`;
  }

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('rejects missing/wrong tokens and allows health', async () => {
    await start();
    const noAuth = await fetch(`${base}/control/v1/health`);
    expect(noAuth.status).toBe(401);
    const wrong = await call('GET', '/control/v1/health', undefined, { Authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    const ok = await call('GET', '/control/v1/health');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok', version: 1 });
  });

  it('rejects a non-loopback Origin', async () => {
    await start();
    const res = await call('GET', '/control/v1/status', undefined, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects a non-loopback Host header', async () => {
    await start();
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/control/v1/health`);
      const req = httpRequest(
        { host: '127.0.0.1', port: url.port, path: '/control/v1/health', method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.setHeader('Host', 'evil.example');
      req.setHeader('Authorization', `Bearer ${TOKEN}`);
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('exposes status without the control token', async () => {
    await start();
    const res = await call('GET', '/control/v1/status');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
  });

  it('implements the login lifecycle endpoints', async () => {
    await start();
    const loginStartRes = await call('POST', '/control/v1/login/start');
    expect(loginStartRes.status).toBe(200);
    expect(await loginStartRes.json()).toEqual({ loginId: 'L1', status: 'QR_PENDING', expiresAt: 1_234 });

    const status = await call('GET', '/control/v1/login/L1/status');
    expect(status.status).toBe(200);

    const qr = await call('GET', '/control/v1/login/L1/qr');
    expect(qr.status).toBe(200);
    expect(qr.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await qr.arrayBuffer()).toString()).toBe('FAKE-PNG');

    const verifyOk = await call('POST', '/control/v1/login/L1/verify', { code: '1234' });
    expect(verifyOk.status).toBe(200);
    const verifyBad = await call('POST', '/control/v1/login/L1/verify', { code: '0000' });
    expect(verifyBad.status).toBe(409);

    const cancel = await call('POST', '/control/v1/login/L1/cancel');
    expect(cancel.status).toBe(200);
    const missing = await call('GET', '/control/v1/login/unknown/status');
    expect(missing.status).toBe(404);
  });

  it('implements binding, logout and shutdown', async () => {
    await start();
    const put = await call('PUT', '/control/v1/binding', { projectId: 'p', tabId: 't' });
    expect(put.status).toBe(200);
    expect(facade.bindCalls).toBe(1);
    const bad = await call('PUT', '/control/v1/binding', {});
    expect(bad.status).toBe(400);
    const del = await call('DELETE', '/control/v1/binding');
    expect(del.status).toBe(200);
    expect(facade.unbindCalls).toBe(1);
    const logout = await call('POST', '/control/v1/logout');
    expect(logout.status).toBe(200);
    expect(facade.logoutCalls).toBe(1);
    const shutdown = await call('POST', '/control/v1/shutdown');
    expect(shutdown.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(facade.shutdownCalls).toBe(1);
  });

  it('bounds request bodies', async () => {
    await start();
    const server2 = new ControlServer({ token: TOKEN, facade, maxBodyBytes: 16 });
    const port2 = await server2.start();
    const res = await fetch(`http://127.0.0.1:${port2}/control/v1/binding`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'x'.repeat(100), tabId: 'y'.repeat(100) }),
    });
    expect(res.status).toBe(413);
    await server2.stop();
  });

  it('returns structured 404 for unknown routes', async () => {
    await start();
    const res = await call('GET', '/control/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
});
