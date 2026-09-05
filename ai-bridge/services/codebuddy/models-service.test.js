import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodeBuddyModels } from './models-service.js';

test('normalizes CodeBuddy model credits and reasoning capabilities', () => {
  const models = normalizeCodeBuddyModels([
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      credits: 'x0.79 credits',
      supportsReasoning: true,
      reasoning: {
        supportedEfforts: ['low', { id: 'max' }, 'unsupported'],
      },
    },
  ]);

  assert.deepEqual(models, [{
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: undefined,
    credits: 'x0.79 credits',
    reasoningSupported: true,
    supportedEfforts: ['low', 'max'],
  }]);
});

test('drops invalid model rows', () => {
  assert.deepEqual(normalizeCodeBuddyModels([null, {}, { id: '  ' }, { id: 'valid' }]), [{
    id: 'valid',
    label: 'valid',
    description: undefined,
    credits: undefined,
  }]);
});

test('normalizes the SDK custom-local: prefix to the plain models.json id', () => {
  const models = normalizeCodeBuddyModels([
    { id: 'custom-local:gpt-5.5', name: 'GPT-5.5 custom' },
    { modelId: 'custom-local:kimi-k2', name: 'K2 custom' },
    { id: 'glm-4.7', name: 'GLM 4.7' },
  ]);
  assert.deepEqual(models.map((model) => model.id), ['gpt-5.5', 'kimi-k2', 'glm-4.7']);
});
