import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_ASK_PROVIDERS,
  isCliAskProvider,
  mergeAssistantTextSnapshot,
  askCliProvider,
  extractCliEventErrorMessage,
} from './cli-ask.js';

test('CLI_ASK_PROVIDERS lists headless CLI providers', () => {
  assert.deepEqual(CLI_ASK_PROVIDERS, ['grok', 'kimi', 'opencode', 'pi', 'omp', 'minimax']);
});

test('isCliAskProvider accepts only supported CLI ids', () => {
  assert.equal(isCliAskProvider('grok'), true);
  assert.equal(isCliAskProvider('kimi'), true);
  assert.equal(isCliAskProvider('opencode'), true);
  assert.equal(isCliAskProvider('pi'), true);
  assert.equal(isCliAskProvider('omp'), true);
  assert.equal(isCliAskProvider('claude'), false);
  assert.equal(isCliAskProvider('codex'), false);
  assert.equal(isCliAskProvider(null), false);
});

test('mergeAssistantTextSnapshot returns delta for growing prefix snapshots', () => {
  assert.equal(mergeAssistantTextSnapshot('', 'Hello'), 'Hello');
  assert.equal(mergeAssistantTextSnapshot('Hello', 'Hello world'), ' world');
  assert.equal(mergeAssistantTextSnapshot('Hello', 'Hello'), null);
  assert.equal(mergeAssistantTextSnapshot('Hello world', 'Hello'), null);
  assert.equal(mergeAssistantTextSnapshot('Hi', 'Hello'), '\nHello');
});

test('askCliProvider rejects unsupported providers', async () => {
  await assert.rejects(
    () => askCliProvider({ provider: 'claude', prompt: 'x' }),
    /Unsupported CLI ask provider/
  );
});

test('askCliProvider returns empty string for empty prompt without spawning', async () => {
  const result = await askCliProvider({ provider: 'grok', prompt: '   ' });
  assert.equal(result, '');
});

test('extractCliEventErrorMessage reads OpenCode nested error.data.message', () => {
  const message = extractCliEventErrorMessage({
    type: 'error',
    error: {
      name: 'UnknownError',
      data: { message: 'Model not found: xaio/XAIO-C-4-5-Sonnet.' },
    },
  });
  assert.equal(message, 'Model not found: xaio/XAIO-C-4-5-Sonnet.');
});

test('extractCliEventErrorMessage prefers error.message over nested data', () => {
  const message = extractCliEventErrorMessage({
    type: 'error',
    error: {
      message: 'Top-level error',
      data: { message: 'Nested error' },
    },
  });
  assert.equal(message, 'Top-level error');
});

test('extractCliEventErrorMessage falls back to error.name', () => {
  const message = extractCliEventErrorMessage({
    type: 'error',
    error: { name: 'ProviderModelNotFoundError' },
  });
  assert.equal(message, 'ProviderModelNotFoundError');
});

test('extractCliEventErrorMessage returns null for empty events', () => {
  assert.equal(extractCliEventErrorMessage(null), null);
  assert.equal(extractCliEventErrorMessage({}), null);
  assert.equal(extractCliEventErrorMessage({ type: 'error', error: {} }), null);
});
