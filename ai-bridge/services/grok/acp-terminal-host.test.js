import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AcpTerminalHost,
  truncateOutputFromStart,
  isTerminalMethod,
  unwrapShellWrapperCommand,
  loginShellSpawnArgs,
  needsFileExecution,
  writeTempScript,
} from './acp-terminal-host.js';

test('isTerminalMethod recognizes ACP methods', () => {
  assert.equal(isTerminalMethod('terminal/create'), true);
  assert.equal(isTerminalMethod('terminal/wait_for_exit'), true);
  assert.equal(isTerminalMethod('fs/read_text_file'), false);
});

test('truncateOutputFromStart keeps suffix within byte limit', () => {
  const s = 'abcdefghijklmnopqrstuvwxyz';
  const { text, truncated } = truncateOutputFromStart(s, 5);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 5);
  assert.ok(text.endsWith('z'));
});

test('create → output → wait_for_exit for simple command', async (t) => {
  const host = new AcpTerminalHost({
    defaultCwd: process.cwd(),
    authorizeCreate: async () => true,
  });
  t.after(() => host.disposeAll());
  const { terminalId } = await host.create({
    sessionId: 's1',
    command: process.execPath,
    args: ['-e', 'process.stdout.write("hello-acp"); process.exit(0)'],
    outputByteLimit: 10_000,
  });
  assert.ok(terminalId);

  const waited = await host.waitForExit({ terminalId });
  assert.equal(waited.exitCode, 0);

  const out = await host.output({ terminalId });
  assert.match(out.output, /hello-acp/);
  assert.equal(out.truncated, false);
  assert.equal(out.exitStatus.exitCode, 0);

  await host.release({ terminalId });
  assert.equal(host.size(), 0);
});

test('argv preserves spaces, quotes and shell metacharacters', async (t) => {
  const host = new AcpTerminalHost({ authorizeCreate: async () => true });
  t.after(() => host.disposeAll());
  const values = ['two words', 'a"b', '%PATH%', 'x&echo wrong', 'tail\\', '', "it's"];
  const { terminalId } = await host.create({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values],
  });
  assert.equal((await host.waitForExit({ terminalId })).exitCode, 0);
  assert.deepEqual(JSON.parse((await host.output({ terminalId })).output), values);
});

test('failed commands report their actual exit code', async (t) => {
  const host = new AcpTerminalHost({ authorizeCreate: async () => true });
  t.after(() => host.disposeAll());
  const { terminalId } = await host.create({ command: process.execPath, args: ['-e', 'process.exit(17)'] });
  assert.equal((await host.waitForExit({ terminalId })).exitCode, 17);
});

test('launches a CLI shim from a directory containing spaces', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok cli '));
  const shim = path.join(dir, process.platform === 'win32' ? 'tool.cmd' : 'tool');
  const script = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@"\n`;
  fs.writeFileSync(shim, script, { mode: 0o700 });
  const host = new AcpTerminalHost({ authorizeCreate: async () => true });
  t.after(async () => {
    await host.disposeAll();
    fs.unlinkSync(shim);
    fs.rmdirSync(dir);
  });
  const { terminalId } = await host.create({ command: shim, args: ['two words', 'x&y'] });
  assert.equal((await host.waitForExit({ terminalId })).exitCode, 0);
  assert.deepEqual(JSON.parse((await host.output({ terminalId })).output), ['two words', 'x&y']);
});

test('kill terminates long-running process', async () => {
  const host = new AcpTerminalHost({ authorizeCreate: async () => true });
  const { terminalId } = await host.create({
    sessionId: 's1',
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{}, 1000)'],
  });
  await host.kill({ terminalId });
  const waited = await host.waitForExit({ terminalId });
  // SIGTERM may yield null exitCode + signal, or non-zero code depending on platform
  assert.ok(waited.exitCode !== 0 || waited.signal);
  await host.release({ terminalId });
});

test('authorizeCreate denial rejects create', async () => {
  const host = new AcpTerminalHost({ authorizeCreate: async () => false });
  await assert.rejects(
    () => host.create({ sessionId: 's', command: 'echo', args: ['x'] }),
    /denied/i
  );
});

test('unwrapShellWrapperCommand strips /bin/bash -lc split form', () => {
  const inner = unwrapShellWrapperCommand('/bin/bash', ['-lc', 'echo hi']);
  assert.equal(inner, 'echo hi');
});

test('unwrapShellWrapperCommand strips full wrapper in command field', () => {
  const inner = unwrapShellWrapperCommand("/bin/bash -lc 'echo hi'", []);
  assert.equal(inner, 'echo hi');
});

test('unwrapShellWrapperCommand keeps bare shell script when args empty', () => {
  assert.equal(unwrapShellWrapperCommand('echo shell-ok', []), 'echo shell-ok');
  assert.equal(
    unwrapShellWrapperCommand('echo hello && echo world', []),
    'echo hello && echo world'
  );
});

test('unwrapShellWrapperCommand escapes argv-form executable + args', () => {
  assert.equal(
    unwrapShellWrapperCommand('printf', ['%s', 'a|b']),
    "printf '%s' 'a|b'"
  );
});

test('loginShellSpawnArgs matches daemon.js flag shapes', () => {
  assert.deepEqual(loginShellSpawnArgs('/bin/bash', 'echo hi'), ['-lc', 'echo hi']);
  assert.deepEqual(loginShellSpawnArgs('/bin/zsh', 'echo hi'), ['-l', '-c', 'echo hi']);
  assert.deepEqual(loginShellSpawnArgs('/usr/bin/fish', 'echo hi'), ['-c', 'echo hi']);
});

test('create with Grok-style /bin/bash -lc args', async (t) => {
  const host = new AcpTerminalHost({
    authorizeCreate: async () => true,
    env: { ...process.env, SHELL: '/bin/bash' },
  });
  t.after(() => host.disposeAll());
  const { terminalId } = await host.create({
    sessionId: 's',
    command: '/bin/bash',
    args: ['-lc', 'echo grok-unwrap-ok'],
  });
  await host.waitForExit({ terminalId });
  const out = await host.output({ terminalId });
  assert.match(out.output, /grok-unwrap-ok/);
  await host.release({ terminalId });
});

test('shell string command with empty args', async (t) => {
  const host = new AcpTerminalHost({
    authorizeCreate: async () => true,
    env: { ...process.env, SHELL: '/bin/bash' },
  });
  t.after(() => host.disposeAll());
  const { terminalId } = await host.create({
    sessionId: 's',
    command: 'echo shell-ok',
    args: [],
  });
  const waited = await host.waitForExit({ terminalId });
  assert.equal(waited.exitCode, 0);
  const out = await host.output({ terminalId });
  assert.match(out.output, /shell-ok/);
  assert.doesNotMatch(out.output, /command not found/);
  await host.release({ terminalId });
});

test('shell string with metacharacters runs as script not as binary name', async (t) => {
  const host = new AcpTerminalHost({
    authorizeCreate: async () => true,
    env: { ...process.env, SHELL: '/bin/bash' },
  });
  t.after(() => host.disposeAll());
  const { terminalId } = await host.create({
    sessionId: 's',
    command: 'echo hello && echo world',
    args: [],
  });
  const waited = await host.waitForExit({ terminalId });
  assert.equal(waited.exitCode, 0);
  const out = await host.output({ terminalId });
  assert.match(out.output, /hello/);
  assert.match(out.output, /world/);
  assert.doesNotMatch(out.output, /command not found/);
  await host.release({ terminalId });
});

test('needsFileExecution detects shebang, heredoc, bang, heavy quoting', () => {
  assert.equal(needsFileExecution('#!/bin/bash\necho hi'), true);
  assert.equal(needsFileExecution('cat << EOF\nbody\nEOF'), true);
  assert.equal(needsFileExecution("echo 'bang!'"), true);
  assert.equal(needsFileExecution('echo "a" "b" "c" "d" "e"'), true);
  assert.equal(needsFileExecution('echo simple'), false);
});

test('writeTempScript writes executable file and returns path', () => {
  const p = writeTempScript('echo hello from temp script');
  assert.ok(p && p.includes('grok-cmd-'));
  // cleanup best-effort
  try {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  } catch {}
});
