import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  PERMISSION_REQUEST_SAFETY_NET_MS,
  SAFETY_NET_BUFFER_SECONDS,
  describeAnswersForLog,
  describeContentForLog,
  describeInputForLog,
  parsePermissionAllowResponse,
  resolvePermissionRequestSafetyNetMs,
} from './permission-ipc.js';

test('default safety net is derived from the default user-facing timeout plus buffer', () => {
  assert.equal(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS, 3600);
  assert.equal(SAFETY_NET_BUFFER_SECONDS, 60);
  assert.equal(
    PERMISSION_REQUEST_SAFETY_NET_MS,
    resolvePermissionRequestSafetyNetMs(process.env.CLAUDE_PERMISSION_SAFETY_NET_MS)
  );
});

test('safety net env override is clamped and defaults conservatively', () => {
  assert.equal(
    resolvePermissionRequestSafetyNetMs(undefined),
    (DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS + SAFETY_NET_BUFFER_SECONDS) * 1000
  );
  assert.equal(
    resolvePermissionRequestSafetyNetMs('1000'),
    (MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS + SAFETY_NET_BUFFER_SECONDS) * 1000
  );
  assert.equal(
    resolvePermissionRequestSafetyNetMs('999999999'),
    (MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS + SAFETY_NET_BUFFER_SECONDS) * 1000
  );
  assert.equal(resolvePermissionRequestSafetyNetMs('180000'), 180000);
});

test('log metadata helpers do not include raw permission payload values', () => {
  const inputMetadata = describeInputForLog({
    command: 'cat /secret/token.txt',
    questions: [{ question: 'What is the password?', options: [] }],
    allowedPrompts: [{ tool: 'Bash', prompt: 'deploy with token' }],
    plan: 'super secret plan',
  });
  const answerMetadata = describeAnswersForLog({ password: 'hunter2' });
  const contentMetadata = describeContentForLog('{"allow":true,"token":"secret"}');
  const serialized = JSON.stringify({ inputMetadata, answerMetadata, contentMetadata });

  assert.deepEqual(inputMetadata, {
    keyCount: 4,
    questionCount: 1,
    allowedPromptCount: 1,
    planLength: 'super secret plan'.length,
  });
  assert.deepEqual(answerMetadata, { answerCount: 1 });
  assert.equal(contentMetadata.byteLength, Buffer.byteLength('{"allow":true,"token":"secret"}', 'utf8'));
  assert.equal(serialized.includes('hunter2'), false);
  assert.equal(serialized.includes('secret plan'), false);
  assert.equal(serialized.includes('/secret/token.txt'), false);
});

// The Node bridge passes the result of this helper straight back to the Claude
// SDK as the "this tool may run" boolean. A truthy-but-not-strictly-true value
// (string "true", number 1, partially written file) historically would have
// been read as allow; pin the strict contract so a corrupted response file
// can never escalate into an accidental permission grant.

test('parsePermissionAllowResponse allows only when allow === true (boolean)', () => {
  assert.equal(parsePermissionAllowResponse('{"allow":true}').allowed, true);
});

test('parsePermissionAllowResponse rejects truthy-but-non-boolean allow values', () => {
  assert.equal(parsePermissionAllowResponse('{"allow":"true"}').allowed, false);
  assert.equal(parsePermissionAllowResponse('{"allow":1}').allowed, false);
  assert.equal(parsePermissionAllowResponse('{"allow":"yes"}').allowed, false);
  assert.equal(parsePermissionAllowResponse('{"allow":[true]}').allowed, false);
  assert.equal(parsePermissionAllowResponse('{"allow":{"value":true}}').allowed, false);
  // Regression guard: a prototype-pollution payload sets `__proto__` as an own
  // key on the parsed object (JSON.parse does not promote it to actual prototype),
  // so `responseData?.allow === true` still resolves against the own `allow` slot.
  // Pin the behavior so a refactor cannot reintroduce the gap.
  assert.equal(parsePermissionAllowResponse('{"__proto__":{"allow":true}}').allowed, false);
});

test('parsePermissionAllowResponse rejects explicit deny and missing field', () => {
  assert.equal(parsePermissionAllowResponse('{"allow":false}').allowed, false);
  assert.equal(parsePermissionAllowResponse('{"allow":null}').allowed, false);
  assert.equal(parsePermissionAllowResponse('{}').allowed, false);
  assert.equal(parsePermissionAllowResponse('{"remember":true}').allowed, false);
});

test('parsePermissionAllowResponse rejects malformed and empty payloads', () => {
  // A partially-written response file shows up as truncated JSON — must deny,
  // not throw, so the polling caller can continue waiting for a valid write.
  assert.equal(parsePermissionAllowResponse('').allowed, false);
  assert.equal(parsePermissionAllowResponse('not json').allowed, false);
  assert.equal(parsePermissionAllowResponse('{"allow":tru').allowed, false);
  assert.equal(parsePermissionAllowResponse('null').allowed, false);
});

// Regression: AskUserQuestion / permission IPC routes by the stable tab routing
// key in CLAUDE_SESSION_ID (set when the daemon is launched). The real Claude
// SDK conversation sessionId must never overwrite that env for a single request
// — otherwise Node writes ask-user-question-<sdkId>-*.json while Java watches
// ask-user-question-<routingId>-*.json and the dialog never appears.
test('daemon must not overwrite CLAUDE_SESSION_ID with params.sessionId', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const daemonSource = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), 'daemon.js'),
    'utf8'
  );
  assert.doesNotMatch(
    daemonSource,
    /process\.env\.CLAUDE_SESSION_ID\s*=\s*params\.sessionId/
  );
});
