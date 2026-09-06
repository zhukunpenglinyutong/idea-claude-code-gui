import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DSH_PRESET_IDS,
  buildPresetOverlay,
  extractPersonaText,
  getKnownDshPresetIds,
  isKnownDshPresetId,
  parsePresetEntries,
} from './preset-overlay.js';

test('parsePresetEntries splits column-0 dash blocks and extracts ids', () => {
  const text = [
    '# file header comment is dropped',
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: hello',
    '- id: tool-bash',
    '  name: bash',
  ].join('\n');
  const entries = parsePresetEntries(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'persona');
  assert.equal(entries[1].id, 'tool-bash');
  assert.ok(entries[0].block[0].startsWith('- id: persona'));
  assert.ok(!entries[0].block.some((line) => line.includes('header comment')));
});

test('parsePresetEntries reads ids from a 2-space indented id line and handles CRLF', () => {
  const entries = parsePresetEntries('- name: no-inline\r\n  id: nested-id\r\n  config: {}\r\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'nested-id');
});

test('parsePresetEntries returns an empty list for empty input', () => {
  assert.deepEqual(parsePresetEntries(''), []);
  assert.deepEqual(parsePresetEntries(null), []);
  assert.deepEqual(parsePresetEntries('# only a comment\n'), []);
});

test('extractPersonaText returns an inline scalar', () => {
  const block = [
    '- id: persona',
    '  config:',
    '    text: You are minimal.',
  ];
  assert.equal(extractPersonaText(block), 'You are minimal.');
});

test('extractPersonaText unwraps a multi-line folded scalar', () => {
  const block = [
    '- id: persona',
    '  config:',
    '    text: >-',
    '      Line one',
    '      Line two',
    '  other: key',
  ];
  assert.equal(extractPersonaText(block), '>-\n      Line one\n      Line two');
});

test('extractPersonaText returns null when the block has no text', () => {
  assert.equal(extractPersonaText(['- id: persona', '  config: {}']), null);
});

test('buildPresetOverlay overrides known base rows and inserts new ids', () => {
  const presetText = [
    '- id: tool-bash',
    '  name: bash-override',
    '- id: my-custom',
    '  name: custom',
    '  config:',
    '    key: value',
  ].join('\n');
  const overlay = buildPresetOverlay({
    presetId: 'standard',
    presetText,
    baseIds: new Set(['tool-bash']),
  });
  // Known base id → plain override entry at top level.
  assert.ok(overlay.includes('- id: tool-bash\n  name: bash-override'));
  // New id → wrapped in an insert block with 4-space indentation.
  assert.ok(overlay.includes('- insert:\n    - id: my-custom\n      name: custom\n      config:\n        key: value'));
});

test('buildPresetOverlay remaps persona onto the base system-prompt row', () => {
  const presetText = [
    '- id: persona',
    '  config:',
    '    text: You are minimal.',
  ].join('\n');
  const overlay = buildPresetOverlay({
    presetId: 'standard',
    presetText,
    baseIds: new Set(['system-prompt']),
  });
  assert.ok(overlay.includes('- id: system-prompt\n  config:\n    persona: You are minimal.'));
  // The persona plugin row itself must not be inserted (double registration).
  assert.ok(!overlay.includes('- id: persona'));
});

test('buildPresetOverlay disables only the minimal-removed rows that exist in the base', () => {
  const overlay = buildPresetOverlay({
    presetId: 'minimal',
    presetText: '- id: tool-bash\n  name: bash\n',
    baseIds: new Set(['tool-bash', 'tool-fs', 'system-prompt']),
  });
  assert.ok(overlay.includes('- id: tool-bash\n  disabled: true'));
  assert.ok(overlay.includes('- id: tool-fs\n  disabled: true'));
  // tool-web is in the removal list but absent from this base → skipped.
  assert.ok(!overlay.includes('- id: tool-web\n  disabled: true'));
});

test('buildPresetOverlay strips the nested str-replace-editor entry for minimal', () => {
  const presetText = [
    '- id: filesystem',
    '  name: filesystem-group',
    '  config:',
    '    - id: bash',
    '    - id: str-replace-editor',
    '      config:',
    '        maxLines: 100',
    '    - id: other',
  ].join('\n');
  const overlay = buildPresetOverlay({
    presetId: 'minimal',
    presetText,
    baseIds: new Set(),
  });
  assert.ok(!overlay.includes('str-replace-editor'));
  assert.ok(!overlay.includes('maxLines'));
  // Sibling nested entries survive.
  assert.ok(overlay.includes('- id: bash'));
  assert.ok(overlay.includes('- id: other'));
});

test('buildPresetOverlay drops the tool-cordis row for the cordis preset', () => {
  const presetText = [
    '- id: tool-cordis',
    '  name: cordis',
    '- id: tool-bash',
    '  name: bash',
  ].join('\n');
  const overlay = buildPresetOverlay({
    presetId: 'cordis',
    presetText,
    baseIds: new Set(['tool-bash']),
  });
  assert.ok(!overlay.includes('tool-cordis'));
  assert.ok(overlay.includes('- id: tool-bash'));
});

test('buildPresetOverlay rewrites relative plugin rows and baseUrl against the preset dir', () => {
  const presetDir = resolve('test-presets', 'router');
  const presetText = [
    '- id: router',
    '  name: ./router-bootstrap.mjs',
    '  config:',
    '    root: baseUrl',
    "    - !!js \"fileURLToPath(new URL('skills/', baseUrl))\"",
  ].join('\n');
  const overlay = buildPresetOverlay({
    presetId: 'router-standard',
    presetText,
    baseIds: new Set(),
    presetDir,
  });
  assert.ok(overlay.includes(`name: ${pathToFileURL(join(presetDir, 'router-bootstrap.mjs')).href}`));
  assert.ok(overlay.includes(`root: "${pathToFileURL(presetDir + '/').href}"`));
  // The skills/ + baseUrl expression is emitted as a resolved path.
  assert.ok(overlay.includes(`- ${join(presetDir, 'skills').replace(/\\/g, '/')}`));
  assert.ok(!overlay.includes('baseUrl'));
});

test('isKnownDshPresetId accepts shipped presets and rejects unknown/empty ids', () => {
  for (const id of DSH_PRESET_IDS) {
    assert.equal(isKnownDshPresetId(id), true, `expected ${id} to be known`);
  }
  assert.equal(isKnownDshPresetId(''), false);
  assert.equal(isKnownDshPresetId(null), false);
  assert.equal(isKnownDshPresetId(undefined), false);
  assert.equal(isKnownDshPresetId('definitely-not-a-real-preset-zzz'), false);
});

test('getKnownDshPresetIds contains the shipped presets without duplicates', () => {
  const ids = getKnownDshPresetIds();
  for (const id of DSH_PRESET_IDS) {
    assert.ok(ids.includes(id), `expected ${id} in known ids`);
  }
  assert.equal(new Set(ids).size, ids.length);
});
