import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { PpccProcessManager } from './process-manager.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

function createManager(child, overrides = {}) {
  let spawnOptions;
  const manager = new PpccProcessManager({
    executable: '/safe/ppcc-daemon',
    requestTimeoutMs: 200,
    spawnImpl: (_file, _args, options) => {
      spawnOptions = options;
      queueMicrotask(() => child.stdout.write('{"protocolVersion":1,"type":"daemon","event":"ready"}\n'));
      return child;
    },
    ...overrides,
  });
  return { manager, getSpawnOptions: () => spawnOptions };
}

async function captureRequest(child, action) {
  const writes = [];
  child.stdin.on('data', chunk => writes.push(chunk));
  const promise = action();
  await new Promise(resolve => setImmediate(resolve));
  return { request: JSON.parse(Buffer.concat(writes).toString()), promise };
}

test('PPCC process manager uses shell=false and routes events/responses', async () => {
  const child = fakeChild();
  const { manager, getSpawnOptions } = createManager(child);
  await manager.start();
  assert.equal(getSpawnOptions().shell, false);

  const { request, promise } = await captureRequest(child, () => manager.request('ppcc.status', {}, () => {}));
  child.stdout.write(`${JSON.stringify({ protocolVersion: 1, id: request.id, type: 'event', runId: 'r', seq: 1, event: { type: 'turn_started' } })}\n`);
  child.stdout.write(`${JSON.stringify({ protocolVersion: 1, id: request.id, type: 'response', success: true, result: { ok: true } })}\n`);
  assert.deepEqual(await promise, { ok: true });
});

test('PPCC executable must be explicitly configured', () => {
  const original = process.env.PPCC_DAEMON_PATH;
  delete process.env.PPCC_DAEMON_PATH;
  try {
    assert.throws(() => new PpccProcessManager(), /PPCC_DAEMON_PATH/);
  } finally {
    if (original !== undefined) process.env.PPCC_DAEMON_PATH = original;
  }
});

test('cancel maps to ppcc.cancel and keeps the target run id', async () => {
  const child = fakeChild();
  const { manager } = createManager(child);
  await manager.start();

  const { request, promise } = await captureRequest(child, () => manager.cancel('run-42'));
  assert.equal(request.method, 'ppcc.cancel');
  assert.deepEqual(request.params, { runId: 'run-42' });
  child.stdout.write(`${JSON.stringify({ protocolVersion: 1, id: request.id, type: 'response', success: true, result: { cancelled: true } })}\n`);
  assert.deepEqual(await promise, { cancelled: true });
});

test('stderr is drained without being forwarded to stdout', async () => {
  const child = fakeChild();
  const diagnostics = [];
  const { manager } = createManager(child, { onDiagnostic: text => diagnostics.push(text) });
  await manager.start();
  child.stderr.write('private diagnostic\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(diagnostics, ['private diagnostic']);
});

test('invalid protocol version fails all pending requests', async () => {
  const child = fakeChild();
  const { manager } = createManager(child);
  await manager.start();
  const { request, promise } = await captureRequest(child, () => manager.request('ppcc.status', {}));
  child.stdout.write(`${JSON.stringify({ protocolVersion: 2, id: request.id, type: 'response', success: true, result: {} })}\n`);
  await assert.rejects(promise, /protocol version/i);
});

test('pending requests fail closed and terminate the daemon on timeout', async () => {
  const child = fakeChild();
  const { manager } = createManager(child, { requestTimeoutMs: 20 });
  await manager.start();
  await assert.rejects(manager.request('ppcc.status', {}), /timed out/i);
  assert.equal(child.killed, true);
});

test('ready handshake requires protocol version 1', async () => {
  const child = fakeChild();
  const manager = new PpccProcessManager({
    executable: '/safe/ppcc-daemon',
    requestTimeoutMs: 200,
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write('{"type":"daemon","event":"ready","protocolVersion":2}\n'));
      return child;
    },
  });
  await assert.rejects(manager.start(), /protocol version/i);
  assert.equal(child.killed, true);
});

test('oversized line is rejected before a newline is buffered', async () => {
  const child = fakeChild();
  const manager = new PpccProcessManager({
    executable: '/safe/ppcc-daemon',
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write(Buffer.alloc(1_048_577, 0x61)));
      return child;
    },
  });
  await assert.rejects(manager.start(), /size limit/i);
  assert.equal(child.killed, true);
});
