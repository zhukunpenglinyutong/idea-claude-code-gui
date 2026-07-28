import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCodexCliEnvironment } from './codex-utils.js';

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
