import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthError } from './auth-service.js';

test('classifies a timeout as CODEBUDDY_AUTH_CHECK_TIMEOUT', () => {
  const err = new Error('timed out after 4000ms');
  err.code = 'timeout';
  const status = classifyAuthError(err);
  assert.equal(status.success, false);
  assert.equal(status.errorCode, 'CODEBUDDY_AUTH_CHECK_TIMEOUT');
});

test('classifies a "timed out" message as timeout even without a code', () => {
  const status = classifyAuthError(new Error('operation timed out'));
  assert.equal(status.errorCode, 'CODEBUDDY_AUTH_CHECK_TIMEOUT');
});

test('surfaces real auth failures as CODEBUDDY_AUTH_CHECK_FAILED', () => {
  // The old classifier used /timed out|authentication/i which would swallow a
  // genuine "authentication failed: token expired" into a login-required code.
  const status = classifyAuthError(new Error('authentication failed: token expired'));
  assert.equal(status.errorCode, 'CODEBUDDY_AUTH_CHECK_FAILED');
});

test('preserves the root cause message', () => {
  const status = classifyAuthError(new Error('boom'));
  assert.equal(status.error, 'boom');
  assert.equal(status.success, false);
  assert.equal(status.authenticated, false);
});
