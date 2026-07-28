import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const bridgeDir = dirname(fileURLToPath(import.meta.url));
const channelManager = join(bridgeDir, 'channel-manager.js');

test('system command keeps stdout reserved for its JSON response', () => {
  const result = spawnSync(process.execPath, [channelManager, 'system', 'checkCodexSdk'], {
    cwd: bridgeDir,
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\[DIAG-|\[sdk-loader\]/);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(typeof response.success, 'boolean');
  assert.equal(typeof response.available, 'boolean');
});
