import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVisibleThinkingConfig } from './model-utils.js';

test('resolveVisibleThinkingConfig returns adaptive+summarized for verified hidden-thinking models', () => {
  for (const model of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
    assert.deepEqual(
      resolveVisibleThinkingConfig(model),
      { type: 'adaptive', display: 'summarized' },
      model,
    );
  }
});

test('resolveVisibleThinkingConfig accepts the [1m] marker and dated model ids', () => {
  for (const model of [
    'claude-fable-5[1m]',
    'claude-opus-4-8[1m]',
    'claude-sonnet-5-20260101',
    'claude-opus-4-8-20260514',
  ]) {
    assert.deepEqual(
      resolveVisibleThinkingConfig(model),
      { type: 'adaptive', display: 'summarized' },
      model,
    );
  }
});

test('resolveVisibleThinkingConfig does not match custom or proxied variants', () => {
  // A bare family match let unverified ids claim the adaptive config; these must
  // fall back to the legacy maxThinkingTokens path instead.
  for (const model of ['mythos-proxy', 'fable-gateway', 'sonnet-5-lite', 'my-mythos-router', 'opus-4-8-custom']) {
    assert.equal(resolveVisibleThinkingConfig(model), null, model);
  }
});

test('resolveVisibleThinkingConfig returns disabled when thinking is opted out', () => {
  assert.deepEqual(
    resolveVisibleThinkingConfig('claude-fable-5', true),
    { type: 'disabled' },
  );
});

test('resolveVisibleThinkingConfig leaves other models on the legacy path', () => {
  assert.equal(resolveVisibleThinkingConfig('claude-opus-4-6'), null);
  assert.equal(resolveVisibleThinkingConfig('claude-opus-4-6[1m]'), null);
  assert.equal(resolveVisibleThinkingConfig('claude-sonnet-4-6'), null);
  assert.equal(resolveVisibleThinkingConfig('claude-haiku-4-5-20251001'), null);
  assert.equal(resolveVisibleThinkingConfig('MiniMax-M2.5'), null);
  assert.equal(resolveVisibleThinkingConfig(null), null);
  assert.equal(resolveVisibleThinkingConfig(''), null);
  assert.equal(resolveVisibleThinkingConfig(undefined, true), null);
});
