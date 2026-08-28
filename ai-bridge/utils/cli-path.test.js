import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCliOutput,
  isWindowsCmdShim,
  quoteCmdArg,
  resolveCliSpawn,
  selectWindowsWhereMatch,
  resolveWindowsSpawnableBin,
  resolveOmpCliPath,
  commonCliBinDirs,
} from './cli-path.js';

test('isWindowsCmdShim detects .cmd/.bat only on win32-style paths', () => {
  // Function gates on process.platform; we only assert the regex half via
  // known Windows-like paths when running on Windows, and always assert
  // non-matching extensions return false on any platform.
  assert.equal(isWindowsCmdShim('opencode.exe'), false);
  assert.equal(isWindowsCmdShim('pi'), false);
  assert.equal(isWindowsCmdShim('C:\\Users\\a\\AppData\\Roaming\\npm\\pi'), false);
  if (process.platform === 'win32') {
    assert.equal(isWindowsCmdShim('C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd'), true);
    assert.equal(isWindowsCmdShim('opencode.bat'), true);
  } else {
    // Non-Windows: always false even for .cmd paths
    assert.equal(isWindowsCmdShim('C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd'), false);
  }
});

test('selectWindowsWhereMatch prefers .cmd over extensionless npm shim', () => {
  const chosen = selectWindowsWhereMatch([
    'C:\\Users\\83429\\AppData\\Roaming\\npm\\pi',
    'C:\\Users\\83429\\AppData\\Roaming\\npm\\pi.cmd',
  ]);
  assert.equal(chosen, 'C:\\Users\\83429\\AppData\\Roaming\\npm\\pi.cmd');
});

test('selectWindowsWhereMatch prefers .exe when present', () => {
  const chosen = selectWindowsWhereMatch([
    'D:\\develop\\node-v24.13.1-win-x64\\opencode',
    'D:\\develop\\node-v24.13.1-win-x64\\opencode.exe',
  ]);
  assert.equal(chosen, 'D:\\develop\\node-v24.13.1-win-x64\\opencode.exe');
});

test('selectWindowsWhereMatch prefers .cmd over .ps1-only noise and keeps first good match', () => {
  const chosen = selectWindowsWhereMatch([
    'D:\\software\\nvm4w\\nodejs\\opencode',
    'D:\\software\\nvm4w\\nodejs\\opencode.ps1',
    'D:\\software\\nvm4w\\nodejs\\opencode.cmd',
  ]);
  assert.equal(chosen, 'D:\\software\\nvm4w\\nodejs\\opencode.cmd');
});

test('selectWindowsWhereMatch falls back to first line when no spawnable extension', () => {
  const chosen = selectWindowsWhereMatch([
    'C:\\tools\\pi',
    'C:\\other\\pi',
  ]);
  assert.equal(chosen, 'C:\\tools\\pi');
});

test('selectWindowsWhereMatch ignores blanks', () => {
  assert.equal(selectWindowsWhereMatch(['', '  ', 'C:\\x\\pi.cmd']), 'C:\\x\\pi.cmd');
  assert.equal(selectWindowsWhereMatch([]), null);
  assert.equal(selectWindowsWhereMatch(null), null);
});

test('resolveWindowsSpawnableBin upgrades extensionless path when sibling .cmd exists', () => {
  const exists = (p) => p === 'C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd';
  const resolved = resolveWindowsSpawnableBin(
    'C:\\Users\\a\\AppData\\Roaming\\npm\\pi',
    exists,
    true, // force Windows behavior for cross-platform unit tests
  );
  assert.equal(resolved, 'C:\\Users\\a\\AppData\\Roaming\\npm\\pi.cmd');
});

test('resolveWindowsSpawnableBin prefers .exe over .cmd when both exist', () => {
  const exists = (p) =>
    p === 'D:\\node\\opencode.cmd' || p === 'D:\\node\\opencode.exe';
  const resolved = resolveWindowsSpawnableBin('D:\\node\\opencode', exists, true);
  assert.equal(resolved, 'D:\\node\\opencode.exe');
});

test('resolveWindowsSpawnableBin leaves .cmd paths unchanged', () => {
  const resolved = resolveWindowsSpawnableBin(
    'C:\\npm\\pi.cmd',
    () => false,
    true,
  );
  assert.equal(resolved, 'C:\\npm\\pi.cmd');
});

test('resolveWindowsSpawnableBin leaves bare names unchanged', () => {
  // Bare names rely on PATHEXT at spawn time; do not invent a path.
  const resolved = resolveWindowsSpawnableBin('pi', () => true, true);
  assert.equal(resolved, 'pi');
});

test('resolveWindowsSpawnableBin no-ops when forceWindows is false', () => {
  const exists = (p) => p === '/home/u/.local/bin/pi.cmd';
  const resolved = resolveWindowsSpawnableBin('/home/u/.local/bin/pi', exists, false);
  assert.equal(resolved, '/home/u/.local/bin/pi');
});

test('resolveWindowsSpawnableBin handles paths with spaces', () => {
  const base = 'C:\\Program Files\\nodejs\\opencode';
  const exists = (p) => p === `${base}.cmd`;
  const resolved = resolveWindowsSpawnableBin(base, exists, true);
  assert.equal(resolved, `${base}.cmd`);
});

test('resolveOmpCliPath honors OMP_BIN env override', () => {
  const saved = {
    OMP_BIN: process.env.OMP_BIN,
    OMP_PATH: process.env.OMP_PATH,
    OMP_CLI_PATH: process.env.OMP_CLI_PATH,
  };
  try {
    process.env.OMP_BIN = '/tmp/custom-omp/bin/omp';
    delete process.env.OMP_PATH;
    delete process.env.OMP_CLI_PATH;
    assert.equal(resolveOmpCliPath(), '/tmp/custom-omp/bin/omp');

    process.env.OMP_BIN = '';
    process.env.OMP_PATH = '/tmp/alt-omp/bin/omp';
    assert.equal(resolveOmpCliPath(), '/tmp/alt-omp/bin/omp');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('commonCliBinDirs includes the OMP bin dir after the PI entry', () => {
  const dirs = commonCliBinDirs('/home/tester');
  // Normalize backslashes to forward slashes for cross-platform assertions
  const normalized = dirs.map(d => d.replace(/\\/g, '/'));
  const piIndex = normalized.indexOf('/home/tester/.pi/bin');
  const ompIndex = normalized.indexOf('/home/tester/.omp/bin');
  assert.ok(piIndex !== -1, 'expected .pi/bin entry');
  assert.ok(ompIndex !== -1, 'expected .omp/bin entry');
  assert.equal(ompIndex, piIndex + 1);
});

test('quoteCmdArg wraps and escapes cmd metacharacters', () => {
  assert.equal(quoteCmdArg('models'), '"models"');
  assert.equal(quoteCmdArg('C:\\Program Files\\nodejs\\opencode.cmd'), '"C:\\Program Files\\nodejs\\opencode.cmd"');
  assert.equal(quoteCmdArg('say "hi"'), '"say ""hi"""');
  assert.equal(quoteCmdArg('%PATH%'), '"%%PATH%%"');
});

test('decodeCliOutput keeps valid UTF-8 and recovers GBK stderr', () => {
  assert.equal(decodeCliOutput('opencode/big-pickle'), 'opencode/big-pickle');
  assert.equal(decodeCliOutput(Buffer.from('opencode/big-pickle')), 'opencode/big-pickle');
  let gbkSupported = false;
  for (const label of ['gbk', 'gb18030']) {
    try {
      // eslint-disable-next-line no-new
      new TextDecoder(label);
      gbkSupported = true;
      break;
    } catch {
      // Node without full ICU
    }
  }
  if (!gbkSupported) return;
  // GBK for 不是内部或外部命令 — the cmd.exe message after `'C:\\Program'`.
  const gbk = Buffer.from([0xB2, 0xBB, 0xCA, 0xC7, 0xC4, 0xDA, 0xB2, 0xBF, 0xBB, 0xF2, 0xCD, 0xE2, 0xB2, 0xBF, 0xC3, 0xFC, 0xC1, 0xEE]);
  const decoded = decodeCliOutput(gbk);
  assert.equal(decoded.includes('\uFFFD'), false);
  assert.match(decoded, /命令/);
});

test('resolveCliSpawn launches spaced .cmd shims via cmd basename + PATH', () => {
  const env = { PATH: 'C:\\Windows\\system32', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const invocation = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.cmd',
    ['models'],
    { env },
    true,
  );
  assert.equal(invocation.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  // /s strips the outer quotes, leaving `"opencode.cmd" "models"`.
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', '""opencode.cmd" "models""']);
  assert.match(invocation.options.env.PATH, /^C:\\Program Files\\nodejs;/);
  // The command token must not contain the spaced prefix that cmd splits on.
  assert.equal(invocation.args[3].includes('C:\\Program'), false);
});

test('resolveCliSpawn strips a previously quoted .cmd path', () => {
  const invocation = resolveCliSpawn(
    '"C:\\Program Files\\nodejs\\opencode.cmd"',
    ['models'],
    { env: { PATH: 'C:\\Windows\\system32' } },
    true,
  );
  assert.equal(invocation.args[3].includes('C:\\Program'), false);
  assert.match(invocation.args[3], /opencode\.cmd/);
});

test('resolveCliSpawn leaves .exe and non-Windows targets as a direct spawn', () => {
  const exe = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.exe',
    ['models'],
    { env: { PATH: 'C:\\Windows\\system32' } },
    true,
  );
  assert.equal(exe.file, 'C:\\Program Files\\nodejs\\opencode.exe');
  assert.deepEqual(exe.args, ['models']);
  assert.notEqual(exe.options.shell, true);

  const posix = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.cmd',
    ['models'],
    {},
    false,
  );
  assert.equal(posix.file, 'C:\\Program Files\\nodejs\\opencode.cmd');
  assert.deepEqual(posix.args, ['models']);
});

test('resolveCliSpawn file-redirect quotes both the shim and the dest path', () => {
  const invocation = resolveCliSpawn(
    'C:\\Program Files\\nodejs\\opencode.cmd',
    ['models'],
    { env: { PATH: 'C:\\Windows\\system32' }, redirectTo: 'C:\\Users\\a\\AppData\\Local\\Temp\\models.txt' },
    true,
  );
  assert.equal(invocation.file.endsWith('cmd.exe') || invocation.file === 'cmd.exe', true);
  assert.match(invocation.args[3], /opencode\.cmd/);
  assert.match(invocation.args[3], />/);
  assert.match(invocation.args[3], /models\.txt/);
  assert.equal(invocation.args[3].includes('C:\\Program'), false);
});
