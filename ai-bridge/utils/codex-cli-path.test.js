import test from 'node:test';
import assert from 'node:assert/strict';
import { getCodexCliPathOverride } from './codex-cli-path.js';

/**
 * Runs `fn` with CODEX_CODE_PATH set to `value` (or unset when `value === undefined`),
 * restoring the previous environment afterwards so tests stay isolated.
 */
function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'CODEX_CODE_PATH');
  const prev = process.env.CODEX_CODE_PATH;
  if (value === undefined) {
    delete process.env.CODEX_CODE_PATH;
  } else {
    process.env.CODEX_CODE_PATH = value;
  }
  try {
    return fn();
  } finally {
    if (had) process.env.CODEX_CODE_PATH = prev;
    else delete process.env.CODEX_CODE_PATH;
  }
}

test('returns null when CODEX_CODE_PATH is unset', () => {
  withEnv(undefined, () => {
    assert.equal(getCodexCliPathOverride(), null);
  });
});

test('returns null when CODEX_CODE_PATH is blank/whitespace only', () => {
  withEnv('   \t  ', () => {
    assert.equal(getCodexCliPathOverride(), null);
  });
});

test('trims surrounding whitespace from the configured path', () => {
  withEnv('  /usr/local/bin/codex  ', () => {
    assert.equal(getCodexCliPathOverride(), '/usr/local/bin/codex');
  });
});

test('returns the path unchanged when already clean', () => {
  withEnv('/opt/codex/bin/codex', () => {
    assert.equal(getCodexCliPathOverride(), '/opt/codex/bin/codex');
  });
});
