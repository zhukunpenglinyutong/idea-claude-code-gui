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
