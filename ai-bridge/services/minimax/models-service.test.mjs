import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMiniMaxModelsFromYaml } from './models-service.js';

// Model entries in config.yaml are block mappings (properties on the lines
// below), matching the real mcode config layout.
const CONFIG = `
provider:
  minimax:
    name: MiniMax
    models:
      MiniMax-M2.7:
        context_window: 200000
      MiniMax-M3:
        context_window: 1000000
custom_provider:
  provider-abc:
    name: Acme Gateway
    enabled: true
    models:
      acme-pro:
        context_window: 128000
      7b-instruct:
        context_window: 32000
defaultModel: minimax/MiniMax-M3
`;

test('parses official and custom-provider models with refs and labels', () => {
  const { defaultModel, models } = parseMiniMaxModelsFromYaml(CONFIG);
  assert.equal(defaultModel, 'minimax/MiniMax-M3');
  assert.deepEqual(
    models.map((m) => m.id),
    ['minimax/MiniMax-M2.7', 'minimax/MiniMax-M3', 'custom_provider:provider-abc/acme-pro', 'custom_provider:provider-abc/7b-instruct'],
  );
  const custom = models.find((m) => m.id === 'custom_provider:provider-abc/7b-instruct');
  assert.equal(custom.label, 'Acme Gateway / 7b-instruct');
});

test('model ids starting with a digit are not skipped', () => {
  const { models } = parseMiniMaxModelsFromYaml(`
custom_provider:
  provider-x:
    models:
      360-gpt:
        context_window: 64000
`);
  assert.deepEqual(models.map((m) => m.id), ['custom_provider:provider-x/360-gpt']);
});

test('empty or unrelated yaml yields no models and null default', () => {
  assert.deepEqual(parseMiniMaxModelsFromYaml(''), { defaultModel: null, models: [] });
  assert.deepEqual(parseMiniMaxModelsFromYaml('other:\n  key: value\n'), { defaultModel: null, models: [] });
});

test('duplicate model refs are deduplicated', () => {
  const { models } = parseMiniMaxModelsFromYaml(`
provider:
  minimax:
    models:
      MiniMax-M3:
        a: 1
      MiniMax-M3:
        b: 2
`);
  assert.equal(models.length, 1);
});
