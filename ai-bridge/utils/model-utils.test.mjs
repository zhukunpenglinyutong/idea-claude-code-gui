import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapModelIdToSdkName,
  resolveModelFromSettings,
  setModelEnvironmentVariables,
  modelSupportsVision,
} from './model-utils.js';

// --- mapModelIdToSdkName ------------------------------------------------

test('mapModelIdToSdkName maps Claude families to short SDK names', () => {
  assert.equal(mapModelIdToSdkName('claude-opus-4-8'), 'opus');
  assert.equal(mapModelIdToSdkName('claude-haiku-4-5'), 'haiku');
  assert.equal(mapModelIdToSdkName('claude-sonnet-4-6'), 'sonnet');
  // Unknown / third-party IDs fall back to sonnet (because the SDK uses
  // ANTHROPIC_DEFAULT_SONNET_MODEL as the lookup target for arbitrary names).
  assert.equal(mapModelIdToSdkName('mimo-v2.5-pro'), 'sonnet');
  assert.equal(mapModelIdToSdkName(''), 'sonnet');
  assert.equal(mapModelIdToSdkName(null), 'sonnet');
});

// --- resolveModelFromSettings -------------------------------------------

test('resolveModelFromSettings returns original when no settings env provided', () => {
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', null), 'claude-sonnet-4-6');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', {}), 'claude-sonnet-4-6');
});

test('resolveModelFromSettings applies model-specific settings mapping', () => {
  const env = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7-opus',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7-flash',
  };
  assert.equal(resolveModelFromSettings('claude-opus-4-8', env), 'glm-4.7-opus');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'glm-4.7');
  assert.equal(resolveModelFromSettings('claude-haiku-4-5', env), 'glm-4.7-flash');
});

test('resolveModelFromSettings uses ANTHROPIC_MODEL as fallback when family mapping is absent', () => {
  const env = {
    ANTHROPIC_MODEL: 'override-everywhere',
  };
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'override-everywhere');
  assert.equal(resolveModelFromSettings('claude-opus-4-8', env), 'override-everywhere');
});

test('resolveModelFromSettings prefers family mapping over stale ANTHROPIC_MODEL', () => {
  const env = {
    ANTHROPIC_MODEL: 'deepseek-v4-pro',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
  };
  assert.equal(resolveModelFromSettings('claude-haiku-4-5', env), 'deepseek-v4-flash');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'deepseek-v4-flash');
});

test('resolveModelFromSettings ignores empty / whitespace mapping values', () => {
  const env = {
    ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
  };
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'claude-sonnet-4-6');
  assert.equal(resolveModelFromSettings('claude-opus-4-8', env), 'claude-opus-4-8');
});

test('resolveModelFromSettings does NOT remap non-Anthropic model IDs', () => {
  // A third-party model name like 'qwen3-max' should pass through unchanged
  // even when ANTHROPIC_DEFAULT_SONNET_MODEL is configured. Otherwise we would
  // silently rewrite intentional model selections.
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' };
  assert.equal(resolveModelFromSettings('qwen3-max', env), 'qwen3-max');
  assert.equal(resolveModelFromSettings('deepseek-v4-pro', env), 'deepseek-v4-pro');
});

// --- [1m] suffix follows the webview request state ------------------------
//
// Bug: when a user opens the 1M context toggle in the UI, the frontend sends
//   `claude-sonnet-4-6[1m]` to the backend. If `settings.json` contains a
//   provider mapping like `ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.7` (no [1m]),
//   the old resolver returned `'glm-4.7'`, silently dropping the suffix.
//   The Claude SDK then read the env var without [1m] and did NOT enable the
//   1M context window even though the toggle was on.
// Fix: make the request modelId the source of truth. Preserve/append [1m] when
// the toggle is on, and strip stale mapping suffixes when the toggle is off.

test('resolveModelFromSettings preserves [1m] suffix when mapping value lacks it', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6[1m]', env),
    'glm-4.7[1m]',
    'request asked for 1M, mapping must keep the [1m] suffix so the SDK enables 1M context'
  );
});

test('resolveModelFromSettings does not double-append [1m] when mapping already has it', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6[1m]', env),
    'deepseek-v4-pro[1m]'
  );
});

test('resolveModelFromSettings strips stale [1m] suffix when 1M toggle is OFF', () => {
  const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7[1M]' };
  assert.equal(
    resolveModelFromSettings('claude-sonnet-4-6', env),
    'glm-4.7',
    'request did not ask for 1M, stale settings mapping suffix must not force it on'
  );
});

test('resolveModelFromSettings preserves [1m] across ANTHROPIC_MODEL global override', () => {
  const env = { ANTHROPIC_MODEL: 'override-model[1M]' };
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6[1m]', env), 'override-model[1m]');
  assert.equal(resolveModelFromSettings('claude-sonnet-4-6', env), 'override-model');
});

test('resolveModelFromSettings preserves [1m] for opus mapping', () => {
  const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro' };
  assert.equal(resolveModelFromSettings('claude-opus-4-8[1m]', env), 'mimo-v2.5-pro[1m]');
});

// --- setModelEnvironmentVariables ---------------------------------------

test('setModelEnvironmentVariables sets sonnet env for sonnet-family base model', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

    setModelEnvironmentVariables('glm-4.7[1m]', 'claude-sonnet-4-6[1m]');

    assert.equal(process.env.ANTHROPIC_MODEL, 'glm-4.7[1m]');
    assert.equal(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-4.7[1m]');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('setModelEnvironmentVariables routes haiku base to haiku env', () => {
  const previous = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  };
  try {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

    setModelEnvironmentVariables('glm-4.7-flash', 'claude-haiku-4-5');

    assert.equal(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.7-flash');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// --- modelSupportsVision -------------------------------------------------

test('modelSupportsVision only matches the canonical claude- prefix', () => {
  assert.equal(modelSupportsVision('claude-sonnet-4-6'), true);
  assert.equal(modelSupportsVision('claude-opus-4-8'), true);
  // Third-party proxies that merely contain "claude" must NOT be treated as
  // native vision-capable models.
  assert.equal(modelSupportsVision('claude-compatible-proxy'), true); // starts with 'claude-'
  assert.equal(modelSupportsVision('mimo-claude-bridge'), false);
  assert.equal(modelSupportsVision('glm-4.7'), false);
  assert.equal(modelSupportsVision('deepseek-v4-pro[1m]'), false);
  assert.equal(modelSupportsVision(''), true);
  assert.equal(modelSupportsVision(null), true);
});
