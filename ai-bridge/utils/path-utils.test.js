import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
  selectWorkingDirectory,
  isBridgeDirectory,
  normalizePathForComparison,
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

test('isBridgeDirectory matches the ai-bridge install dir', () => {
  assert.equal(isBridgeDirectory(BRIDGE_DIR), true);
});

test('isBridgeDirectory rejects unrelated, empty, and nullish paths', () => {
  assert.equal(isBridgeDirectory(homedir()), false);
  assert.equal(isBridgeDirectory(''), false);
  assert.equal(isBridgeDirectory(null), false);
  assert.equal(isBridgeDirectory(undefined), false);
});

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
