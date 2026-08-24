import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGeminiCommand } from './gemini-channel.js';

// The channel runs one-shot per command (channel-manager spawns a fresh
// process), so listModels must produce a complete catalog in one go — the
// Java side shows an empty model dropdown otherwise.
test('listModels prints a populated catalog from one `agy models` probe', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agy-chan-'));
  const bin = join(dir, 'agy-fake');
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv[2] === 'models') {
  console.log('gemini-3.5-flash-low Low');
  console.log('gemini-3.5-flash-high High');
  console.log('claude-sonnet-4-6 Claude Sonnet 4.6');
  process.exit(0);
}
process.exit(1);
`, 'utf8');
  fs.chmodSync(bin, 0o755);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try {
    await handleGeminiCommand('listModels', [], {});
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const payload = JSON.parse(lines.find((l) => l.trim().startsWith('{')));
  assert.equal(payload.success, true);
  assert.ok(Array.isArray(payload.models) && payload.models.length >= 3, `expected flat models, got: ${JSON.stringify(payload.models)}`);
  assert.ok(payload.models.some((m) => m.id === 'gemini-3.5-flash-low'));
  const flashFamily = payload.families?.find((f) => f.id === 'gemini-3.5-flash');
  assert.ok(flashFamily, 'expected a gemini-3.5-flash family group');
  assert.equal(flashFamily.efforts.length, 2);
  assert.equal(flashFamily.defaultEffort, 'high');
  assert.ok(payload.binary, 'expected the resolved binary reported');
});

test('unknown commands throw', async () => {
  await assert.rejects(
    () => handleGeminiCommand('nope', [], {}),
    /Unknown Gemini\/agy command/,
  );
});
