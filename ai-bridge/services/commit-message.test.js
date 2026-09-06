import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClaudeCommitPath, buildCommitAskRequest } from './commit-message.js';

// ---------- resolveClaudeCommitPath (#1655) ----------

test('resolveClaudeCommitPath picks ask path for real API key auth', () => {
  for (const authType of ['api_key', 'auth_token']) {
    assert.equal(
      resolveClaudeCommitPath({ apiKey: 'sk-test', authType }),
      'ask',
      `authType=${authType} should use the Anthropic ask path`,
    );
  }
});

test('resolveClaudeCommitPath picks agent path for CLI login (subscription OAuth)', () => {
  // setupApiKey() returns apiKey: '' + authType: 'cli_login' for CLI Login mode -
  // the exact shape that used to hard-fail with "No API key configured" (#1655).
  assert.equal(
    resolveClaudeCommitPath({ apiKey: '', authType: 'cli_login' }),
    'agent',
  );
});

test('resolveClaudeCommitPath picks agent path when no key is configured at all', () => {
  assert.equal(resolveClaudeCommitPath({ apiKey: null, authType: 'unknown' }), 'agent');
  assert.equal(resolveClaudeCommitPath(null), 'agent');
});

// ---------- buildCommitAskRequest (#1693) ----------

test('buildCommitAskRequest disables thinking so reasoning models still emit text', () => {
  const request = buildCommitAskRequest('deepseek-reasoner', 'write a commit message');
  // Reasoning models default to thinking and can spend the whole max_tokens
  // budget on `thinking` blocks, so stream.on('text') never fires and the
  // finalMessage fallback finds no text block — the commit message comes out
  // empty. thinking must stay disabled on this path.
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(request.model, 'deepseek-reasoner');
  assert.equal(request.max_tokens, 1024);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'write a commit message' }]);
});
