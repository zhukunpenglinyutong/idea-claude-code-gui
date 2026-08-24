import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
  selectWorkingDirectory,
  isUnsafeWorkingDirectory,
  normalizePathForComparison,
  getClaudeProjectKey,
  getClaudeProjectSessionFilePath,
} from './path-utils.js';

// This test sits in <bridge>/utils/, so the bridge install dir is one level up.
// Resolve symlinks the same way path-utils.js does so equality checks stay stable.
function resolveBridgeDir() {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}
const BRIDGE_DIR = resolveBridgeDir();

const samePath = (a, b) => normalizePathForComparison(a) === normalizePathForComparison(b);

/**
 * Runs `fn` with IDEA_PROJECT_PATH / PROJECT_PATH cleared, restoring them after
 * so working-directory resolution is exercised without ambient project env.
 */
function withoutProjectEnv(fn) {
  const keys = ['IDEA_PROJECT_PATH', 'PROJECT_PATH'];
  const saved = {};
  for (const k of keys) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('selectWorkingDirectory never resolves to the bridge dir (issue #1343)', () => {
  withoutProjectEnv(() => {
    const result = selectWorkingDirectory(BRIDGE_DIR);
    assert.ok(!samePath(result, BRIDGE_DIR), `expected a non-bridge dir, got ${result}`);
  });
});

test('selectWorkingDirectory prefers IDEA_PROJECT_PATH over a bridge-dir request', () => {
  withoutProjectEnv(() => {
    const projectPath = homedir(); // a real, existing dir that is not the bridge dir
    process.env.IDEA_PROJECT_PATH = projectPath;
    assert.ok(samePath(selectWorkingDirectory(BRIDGE_DIR), projectPath));
  });
});

test('selectWorkingDirectory returns a valid requested cwd unchanged', () => {
  withoutProjectEnv(() => {
    const home = homedir();
    assert.ok(samePath(selectWorkingDirectory(home), resolve(home)));
  });
});

test('isUnsafeWorkingDirectory rejects plugin and gemini homes', () => {
  assert.equal(
    isUnsafeWorkingDirectory('/Users/x/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/idea-claude-code-gui/ai-bridge'),
    true,
  );
  assert.equal(isUnsafeWorkingDirectory('/Users/x/.gemini'), true);
  assert.equal(isUnsafeWorkingDirectory('/Users/x/.gemini/antigravity-cli'), true);
  assert.equal(isUnsafeWorkingDirectory('/path/to/normal/project'), false);
});

test('isUnsafeWorkingDirectory rejects the bridge install tree, not dirs named ai-bridge', () => {
  // Inside the actual install tree (this module's own root) — unsafe.
  assert.equal(isUnsafeWorkingDirectory(BRIDGE_DIR), true);
  assert.equal(isUnsafeWorkingDirectory(join(BRIDGE_DIR, 'services')), true);
  // A project merely living under a directory NAMED ai-bridge is legitimate.
  assert.equal(isUnsafeWorkingDirectory('/Users/x/dev/ai-bridge/my-project'), false);
  assert.equal(isUnsafeWorkingDirectory('/home/x/src/ai-bridge'), false);
});

test('isUnsafeWorkingDirectory matches real-case JetBrains trees on case-sensitive platforms (linux)', () => {
  // Linux does not fold case, so the lowercase literal alone never matched
  // the real ~/.local/share/JetBrains/... tree — both spellings must reject.
  assert.equal(isUnsafeWorkingDirectory('/home/x/.local/share/JetBrains/IntelliJIdea2026.2', 'linux'), true);
  assert.equal(isUnsafeWorkingDirectory('/home/x/.local/share/jetbrains/IntelliJIdea2026.2', 'linux'), true);
  assert.equal(isUnsafeWorkingDirectory('/home/x/.config', 'linux'), false);
});

test('isUnsafeWorkingDirectory rejects Windows AppData and Linux .config JetBrains trees', () => {
  // Windows roots: win32 normalization folds case and slashes, so one
  // lowercase spelling each covers Roaming and Local.
  assert.equal(isUnsafeWorkingDirectory('C:\\Users\\u\\AppData\\Roaming\\JetBrains\\IntelliJIdea2026.2', 'win32'), true);
  assert.equal(isUnsafeWorkingDirectory('C:\\Users\\u\\AppData\\Local\\JetBrains\\IntelliJIdea2026.2', 'win32'), true);
  assert.equal(isUnsafeWorkingDirectory('C:\\Users\\u\\AppData\\Roaming\\OtherApp', 'win32'), false);
  // Linux config root — both spellings, like .local/share above.
  assert.equal(isUnsafeWorkingDirectory('/home/x/.config/JetBrains/IntelliJIdea2026.2', 'linux'), true);
  assert.equal(isUnsafeWorkingDirectory('/home/x/.config/jetbrains/ide', 'linux'), true);
  // A non-JetBrains .config path stays legitimate everywhere.
  assert.equal(isUnsafeWorkingDirectory('/home/x/.config/my-tool', 'linux'), false);
});

test('normalizePathForComparison lowercases on darwin/win32 and preserves case on linux', () => {
  // Injectable platform (defaults to process.platform) so the darwin branch
  // is testable on linux CI — same convention as cli-path's forceWindows.
  const p = '/Users/x/Library/Application Support/JetBrains';
  assert.equal(normalizePathForComparison(p, 'darwin'), '/users/x/library/application support/jetbrains');
  assert.equal(normalizePathForComparison(p, 'win32'), '/users/x/library/application support/jetbrains');
  assert.equal(normalizePathForComparison(p, 'linux'), p);
});

test('isUnsafeWorkingDirectory matches the JetBrains guard on darwin via case-folding only', () => {
  // Both exact spellings (…application support/jetbrains… and
  // …Application Support/JetBrains…) are listed as literals, so each matches
  // on every platform by design. This variant matches NEITHER literal — it
  // can only match through darwin/win32 case folding, which pins the fold.
  const macPath = '/Users/x/Library/Application support/JetBrains/IntelliJIdea2026.2';
  assert.equal(isUnsafeWorkingDirectory(macPath, 'darwin'), true);
  assert.equal(isUnsafeWorkingDirectory(macPath, 'linux'), false);
  // The canonical real-case macOS tree is rejected on linux too — via the
  // real-case literal, not the fold (Linux JetBrains trees use this spelling).
  assert.equal(
    isUnsafeWorkingDirectory('/Users/x/Library/Application Support/JetBrains/IntelliJIdea2026.2', 'linux'),
    true,
  );
});

test('selectWorkingDirectory skips ~/.gemini candidate', () => {
  withoutProjectEnv(() => {
    const home = homedir();
    const result = selectWorkingDirectory(join(home, '.gemini'));
    assert.ok(!samePath(result, join(home, '.gemini')), `expected non-gemini cwd, got ${result}`);
  });
});

test('selectWorkingDirectory rejects IDEA_PROJECT_PATH set to bridge dir (issue #1343)', () => {
  // Simulates a developer working on the bridge itself with IDEA_PROJECT_PATH
  // pointing at the bridge root — the fallback must not return the bridge dir.
  const saved = process.env.IDEA_PROJECT_PATH;
  process.env.IDEA_PROJECT_PATH = BRIDGE_DIR;
  delete process.env.PROJECT_PATH;
  try {
    const result = selectWorkingDirectory('');
    assert.ok(!samePath(result, BRIDGE_DIR), `expected non-bridge fallback, got ${result}`);
  } finally {
    if (saved === undefined) delete process.env.IDEA_PROJECT_PATH;
    else process.env.IDEA_PROJECT_PATH = saved;
  }
});

test('selectWorkingDirectory skips bridge dir when it appears as process.cwd() candidate', () => {
  // When run from the bridge dir (typical daemon startup), an empty requestedCwd
  // must not resolve to the bridge dir.
  withoutProjectEnv(() => {
    if (!samePath(process.cwd(), BRIDGE_DIR)) return; // only meaningful from bridge dir
    const result = selectWorkingDirectory('');
    assert.ok(!samePath(result, BRIDGE_DIR), `expected non-bridge dir, got ${result}`);
  });
});

test('getClaudeProjectKey matches the session writer for common paths', () => {
  assert.equal(getClaudeProjectKey('D:\\Projects\\My Project'), 'D--Projects-My-Project');
  assert.equal(getClaudeProjectKey('/Users/test/demo'), '-Users-test-demo');
});

test('getClaudeProjectKey preserves the complete key for long paths', () => {
  const longPath = `C:\\Users\\name\\${'deep\\'.repeat(60)}project`;
  const projectKey = getClaudeProjectKey(longPath);

  assert.equal(projectKey, longPath.replace(/[^a-zA-Z0-9]/g, '-'));
  assert.ok(projectKey.length > 200);
});

test('getClaudeProjectSessionFilePath uses the shared project key', () => {
  const cwd = `C:\\Users\\name\\${'deep\\'.repeat(60)}project`;
  const sessionFile = getClaudeProjectSessionFilePath('session-1', cwd);

  assert.ok(sessionFile.includes(getClaudeProjectKey(cwd)));
  assert.ok(sessionFile.endsWith('session-1.jsonl'));
});

test('getClaudeProjectSessionFilePath rejects path-like session IDs', () => {
  assert.throws(
    () => getClaudeProjectSessionFilePath('../outside', 'C:\\project'),
    /Invalid session ID/,
  );
});
