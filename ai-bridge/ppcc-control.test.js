import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDaemonRequestLine,
  validatePpccApprovalParams,
} from './ppcc-control.js';

test('ppcc cancel control accepts only an explicit request id', () => {
  const request = parseDaemonRequestLine(JSON.stringify({ id: 'cancel-1', method: 'ppcc.cancel', params: {} }));
  assert.equal(request.id, 'cancel-1');
  assert.equal(request.method, 'ppcc.cancel');
});

test('daemon rejects oversized NDJSON input before parsing', () => {
  const oversized = JSON.stringify({ id: '1', method: 'ppcc.cancel', padding: 'x'.repeat(1_048_576) });
  assert.throws(() => parseDaemonRequestLine(oversized), /maximum/i);
});

test('daemon rejects requests with missing or invalid protocol fields', () => {
  assert.throws(() => parseDaemonRequestLine('{}'), /id/i);
  assert.throws(() => parseDaemonRequestLine('{"id":"1"}'), /method/i);
  assert.throws(() => parseDaemonRequestLine('{"id":1,"method":"ppcc.cancel"}'), /id/i);
});

test('approval controls require all PPCC digest bindings', () => {
  assert.deepEqual(validatePpccApprovalParams({
    runId: 'run-1',
    approvalId: 'approval-1',
    diffSha256: 'a'.repeat(64),
  }), {
    runId: 'run-1',
    approvalId: 'approval-1',
    diffSha256: 'a'.repeat(64),
  });

  assert.throws(() => validatePpccApprovalParams({ runId: 'run-1' }), /approvalId/i);
  assert.throws(() => validatePpccApprovalParams({
    runId: 'run-1', approvalId: 'approval-1', diffSha256: 'not-a-digest',
  }), /diffSha256/i);
});
