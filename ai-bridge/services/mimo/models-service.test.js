import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'fs';
import { tmpdir } from 'os';
import { parseMimoModelsOutput, runModelsViaTempRedirect } from './models-service.js';

test('parses provider/model lines and dedups', () => {
  const out = 'xiaomi/mimo-v2.5-pro\nmimo/mimo-v2.5-flash\nxiaomi/mimo-v2.5-pro\n';
  const models = parseMimoModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['xiaomi/mimo-v2.5-pro', 'mimo/mimo-v2.5-flash']);
  assert.equal(models[0].label, 'xiaomi/mimo-v2.5-pro');
});

test('handles CRLF and ANSI escape sequences (Windows terminals)', () => {
  const out = '\u001b[32mxiaomi/mimo-v2.5-pro\u001b[0m\r\n\u001b[2mmimo/mimo-v2.5-flash\u001b[0m\r\n';
  const models = parseMimoModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['xiaomi/mimo-v2.5-pro', 'mimo/mimo-v2.5-flash']);
});

test('picks the model token even when the line has extra columns', () => {
  const out = 'default  xiaomi/mimo-v2.5-pro  1m context\n';
  const models = parseMimoModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['xiaomi/mimo-v2.5-pro']);
});

test('rejects Windows paths, URLs and UNC-ish tokens', () => {
  const out = [
    'Config loaded from C:/Users/x/.config/mimocode/mimocode.jsonc',
    'Docs: https://mimo.xiaomi.com/docs/models',
    'Share \\\\server\\share\\dir',
    'D:\\tools\\mimo.cmd run',
    'xiaomi/mimo-v2.5-pro',
  ].join('\r\n');
  const models = parseMimoModelsOutput(out);
  assert.deepEqual(models.map((m) => m.id), ['xiaomi/mimo-v2.5-pro']);
});

test('returns empty list for empty or unparseable output', () => {
  assert.deepEqual(parseMimoModelsOutput(''), []);
  assert.deepEqual(parseMimoModelsOutput('No providers configured.\nRun `mimo auth login`.'), []);
});

test('runModelsViaTempRedirect uses a private mkdtemp directory and cleans it up', () => {
  // CWE-377 regression: the redirect target must live in an unpredictable,
  // exclusively-owned temp directory, and that directory must not be left
  // behind — even when the spawn fails (bogus bin here).
  const leftoversBefore = readdirSync(tmpdir())
    .filter((name) => name.startsWith('cc-gui-mimo-models-'));
  const result = runModelsViaTempRedirect('/nonexistent/mimo-bin', { ...process.env });
  assert.equal(result, '', 'a failed spawn must yield empty output');
  const leftoversAfter = readdirSync(tmpdir())
    .filter((name) => name.startsWith('cc-gui-mimo-models-'));
  assert.deepEqual(leftoversAfter, leftoversBefore,
    'the private temp directory must be removed after use');
});
