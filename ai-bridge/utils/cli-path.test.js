import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWindowsCmdShim,
  selectWindowsWhereMatch,
  resolveWindowsSpawnableBin,
  quoteWindowsShellBin,
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

// ---------- quoteWindowsShellBin (#1665) ----------

test('quoteWindowsShellBin wraps spaced paths in double quotes', () => {
  assert.equal(
    quoteWindowsShellBin('D:\\Program Files\\nodejs\\opencode.cmd'),
    '"D:\\Program Files\\nodejs\\opencode.cmd"',
  );
});

test('quoteWindowsShellBin leaves space-free paths untouched', () => {
  // Bare names must stay unquoted: quoting would break cmd's PATH lookup.
  assert.equal(quoteWindowsShellBin('opencode.cmd'), 'opencode.cmd');
  assert.equal(quoteWindowsShellBin('C:\\npm\\opencode.cmd'), 'C:\\npm\\opencode.cmd');
  assert.equal(quoteWindowsShellBin('pi'), 'pi');
});

test('quoteWindowsShellBin does not double-quote already quoted values', () => {
  const quoted = '"D:\\Program Files\\nodejs\\opencode.cmd"';
  assert.equal(quoteWindowsShellBin(quoted), quoted);
});

test('quoteWindowsShellBin escapes embedded quotes by doubling them', () => {
  assert.equal(
    quoteWindowsShellBin('C:\\weird "path"\\opencode.cmd'),
    '"C:\\weird ""path""\\opencode.cmd"',
  );
});

test('quoteWindowsShellBin handles empty and falsy input', () => {
  assert.equal(quoteWindowsShellBin(''), '');
  assert.equal(quoteWindowsShellBin(null), '');
  assert.equal(quoteWindowsShellBin(undefined), '');
});
