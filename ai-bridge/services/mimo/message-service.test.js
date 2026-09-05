import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMimoArgs } from './message-service.js';

test('buildMimoArgs places prompt before -f so yargs does not swallow it', () => {
  const args = buildMimoArgs({
    message: '这是什么',
    imagePaths: ['/tmp/cc-gui-cli-images/a.png'],
  });
  assert.deepEqual(args, [
    'run',
    '--format',
    'json',
    '这是什么',
    '-f',
    '/tmp/cc-gui-cli-images/a.png',
  ]);
  const promptIdx = args.indexOf('这是什么');
  const fileFlagIdx = args.indexOf('-f');
  assert.ok(promptIdx > 0);
  assert.ok(fileFlagIdx > promptIdx, 'prompt must precede -f');
});

test('buildMimoArgs supports multiple images after prompt', () => {
  const args = buildMimoArgs({
    message: 'describe both',
    model: 'provider/model',
    sessionId: 'ses_abc',
    imagePaths: ['/tmp/a.png', '/tmp/b.png'],
  });
  assert.deepEqual(args, [
    'run',
    '--format',
    'json',
    '--model',
    'provider/model',
    '--session',
    'ses_abc',
    'describe both',
    '-f',
    '/tmp/a.png',
    '-f',
    '/tmp/b.png',
  ]);
});

test('buildMimoArgs without images keeps prompt as last positional', () => {
  const args = buildMimoArgs({ message: 'hello' });
  assert.deepEqual(args, ['run', '--format', 'json', 'hello']);
});

test('buildMimoArgs drops default model tokens so the CLI resolves its own default', () => {
  for (const token of ['auto', 'default', 'mimo-default', 'mimo default', '__config_default__']) {
    const args = buildMimoArgs({ message: 'hi', model: token });
    assert.ok(!args.includes('--model'), `token ${token} must not emit --model`);
  }
});
