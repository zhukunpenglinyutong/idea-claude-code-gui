import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueryOptions,
  buildPromptWithAttachments,
  computeAssistantSnapshotDelta,
  getResultError,
  normalizeReasoningEffort,
} from './message-service.js';

test('getResultError returns null for success and non-result messages', () => {
  assert.equal(getResultError(null), null);
  assert.equal(getResultError({ type: 'assistant' }), null);
  assert.equal(getResultError({ type: 'result', subtype: 'success', is_error: false }), null);
  assert.equal(getResultError({ type: 'result', subtype: 'usage' }), null);
  assert.equal(getResultError({ type: 'result' }), null);
});

test('getResultError surfaces error results instead of swallowing them', () => {
  assert.equal(
    getResultError({ type: 'result', is_error: true, errors: ['token expired', 'retry failed'] }),
    'token expired; retry failed',
  );
  assert.equal(
    getResultError({ type: 'result', subtype: 'error_during_execution', error: 'boom' }),
    'boom',
  );
  assert.equal(
    getResultError({ type: 'result', subtype: 'error_max_turns', result: 'stopped after 1000 turns' }),
    'stopped after 1000 turns',
  );
  assert.equal(
    getResultError({ type: 'result', is_error: true }),
    'CodeBuddy run failed',
  );
});

test('normalizes CodeBuddy reasoning effort and preserves max', () => {
  assert.equal(normalizeReasoningEffort(' MAX '), 'max');
  assert.equal(normalizeReasoningEffort('minimal'), 'minimal');
  assert.equal(normalizeReasoningEffort('unsupported'), '');
});

test('buildQueryOptions forwards effort, model and session resume', () => {
  const options = buildQueryOptions({
    cwd: 'C:/project',
    permissionMode: 'bypassPermissions',
    model: 'gpt-5.5',
    sessionId: 'session-1',
    reasoningEffort: 'max',
  });

  assert.equal(options.cwd, 'C:/project');
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.equal(options.model, 'gpt-5.5');
  assert.equal(options.resume, 'session-1');
  assert.equal(options.effort, 'max');
});

test('omits an invalid reasoning effort instead of sending an invalid SDK option', () => {
  const options = buildQueryOptions({ reasoningEffort: 'xlarge' });
  assert.equal('effort' in options, false);
});

test('recovers each assistant snapshot turn without duplicating cumulative text', () => {
  assert.equal(computeAssistantSnapshotDelta('hello', '', ''), 'hello');
  assert.equal(computeAssistantSnapshotDelta('hello world', 'hello', 'hello'), ' world');
  assert.equal(computeAssistantSnapshotDelta('hello world', 'hello world', 'hello world'), '');
  assert.equal(computeAssistantSnapshotDelta('same', '', 'same'), '');
  assert.equal(computeAssistantSnapshotDelta('same', '', 'same', true), 'same');
  assert.equal(computeAssistantSnapshotDelta('hello world', '', 'hello'), ' world');
  assert.equal(computeAssistantSnapshotDelta('hello', 'hello world', 'hello world'), '');
});

test('keeps CodeBuddy attachments in the prompt instead of dropping them', () => {
  const prompt = buildPromptWithAttachments('inspect this', [{
    fileName: 'diagram.png',
    mediaType: 'image/png',
    data: 'aGVsbG8=',
  }]);
  assert.match(prompt, /diagram\.png/);
  assert.match(prompt, /data:image\/png;base64,aGVsbG8=/);
});

test('inlines text attachments and flags unsupported ones explicitly', () => {
  const prompt = buildPromptWithAttachments('review', [
    { fileName: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('hello notes').toString('base64') },
    { fileName: 'app.bin', mediaType: 'application/octet-stream', data: 'AAECAw==' },
    { fileName: 'empty.txt', mediaType: 'text/plain', data: '' },
  ]);
  assert.match(prompt, /File: notes\.txt \(text\/plain\):\n```\nhello notes\n```/);
  // Binary content is never sent, but the user is told so explicitly.
  assert.match(prompt, /app\.bin \(application\/octet-stream\) — skipped: binary content cannot be inlined/);
  assert.match(prompt, /empty\.txt \(text\/plain\) — no content provided/);
});

test('embeds text-like attachments by file extension for generic media types', () => {
  const prompt = buildPromptWithAttachments('why slow', [
    { fileName: 'app.ts', mediaType: 'application/octet-stream', data: Buffer.from('const a = 1;').toString('base64') },
  ]);
  assert.match(prompt, /File: app\.ts.*\n```[\s\S]*const a = 1;/);
});

test('skips oversized attachments with an explicit note', () => {
  const bigData = Buffer.alloc(90_000).toString('base64'); // ~120k chars of base64
  const prompt = buildPromptWithAttachments('look', [{
    fileName: 'huge.png',
    mediaType: 'image/png',
    data: bigData,
  }]);
  assert.match(prompt, /huge\.png \(image\/png\) — skipped: image too large/);
  assert.doesNotMatch(prompt, /data:image\/png;base64,/);
});
