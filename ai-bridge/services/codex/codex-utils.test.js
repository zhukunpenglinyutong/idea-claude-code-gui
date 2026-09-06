import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexCliEnvironment,
  isCodexNativeAutoReviewSupported,
  normalizeCodexPermissionMode,
} from './codex-utils.js';

test('removes inherited proxy variables by default', () => {
  const result = buildCodexCliEnvironment({
    HTTP_PROXY: 'http://127.0.0.1:8080',
    https_proxy: 'http://127.0.0.1:8081',
    ALL_PROXY: 'socks5://127.0.0.1:1080',
    NPM_CONFIG_PROXY: 'http://127.0.0.1:8082',
    NPM_CONFIG_HTTPS_PROXY: 'http://127.0.0.1:8083',
    PATH: 'C:\\Windows'
  });

  assert.deepEqual(result.cliEnv, { PATH: 'C:\\Windows' });
  assert.deepEqual(result.removedKeys, [
    'HTTP_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTPS_PROXY'
  ]);
});

test('keeps proxy variables after explicit opt-in', () => {
  const result = buildCodexCliEnvironment({
    cc_gui_codex_inherit_proxy: 'true',
    HTTP_PROXY: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8080'
  });

  assert.deepEqual(result.cliEnv, {
    HTTP_PROXY: 'http://proxy.example:8080',
    HTTPS_PROXY: 'http://proxy.example:8080'
  });
  assert.deepEqual(result.removedKeys, ['cc_gui_codex_inherit_proxy']);
});

test('does not enable proxy inheritance for false-like values', () => {
  const result = buildCodexCliEnvironment({
    CC_GUI_CODEX_INHERIT_PROXY: 'false',
    HTTP_PROXY: 'http://proxy.example:8080'
  });

  assert.deepEqual(result.cliEnv, {});
  assert.deepEqual(result.removedKeys, [
    'CC_GUI_CODEX_INHERIT_PROXY',
    'HTTP_PROXY'
  ]);
});

test('removes Codex policy variables regardless of key casing', () => {
  const result = buildCodexCliEnvironment({
    codex_approval_policy: 'never',
    CoDeX_SaNdBoX: 'danger-full-access',
    SAFE_VALUE: 'kept'
  });

  assert.deepEqual(result.cliEnv, { SAFE_VALUE: 'kept' });
  assert.deepEqual(result.removedKeys, ['codex_approval_policy', 'CoDeX_SaNdBoX']);
});

test('normalizes native auto mode casing and aliases before dispatch', () => {
  assert.equal(normalizeCodexPermissionMode('AUTO'), 'auto');
  assert.equal(normalizeCodexPermissionMode(' auto '), 'auto');
  assert.equal(normalizeCodexPermissionMode('AUTOEDIT'), 'acceptEdits');
  assert.equal(normalizeCodexPermissionMode(' AutoEdit '), 'acceptEdits');
});

test('requires Codex 0.146.0 or later for native auto review config', () => {
  assert.equal(isCodexNativeAutoReviewSupported('0.145.0'), false);
  assert.equal(isCodexNativeAutoReviewSupported('0.146.0'), true);
  assert.equal(isCodexNativeAutoReviewSupported('0.151.0'), true);
  assert.equal(isCodexNativeAutoReviewSupported('not-a-version'), false);
});
