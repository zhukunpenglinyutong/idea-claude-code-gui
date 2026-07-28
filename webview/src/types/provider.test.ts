import { describe, expect, it } from 'vitest';
import {
  CODEX_PROVIDER_PRESETS,
  isValidCodexCustomModel,
  isValidModelPricing,
  PROVIDER_PRESETS,
  validateCodexCustomModels,
} from './provider';

const getModelSlots = (model: string) => ({
  ANTHROPIC_DEFAULT_FABLE_MODEL: model,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: model,
});

describe('PROVIDER_PRESETS', () => {
  it('uses the current DeepSeek Anthropic-compatible defaults', () => {
    const deepseek = PROVIDER_PRESETS.find(provider => provider.id === 'deepseek');

    expect(deepseek?.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    });
  });

  it('uses the current Xiaomi MiMo model for all Claude model slots', () => {
    const xiaomi = PROVIDER_PRESETS.find(provider => provider.id === 'xiaomi');

    expect(xiaomi?.env).toMatchObject({
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'mimo-v2.5-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-pro',
    });
  });

  it('includes the expanded Claude Code third-party preset set', () => {
    expect(PROVIDER_PRESETS.map(provider => provider.id)).toEqual([
      'custom',
      'zhipu',
      'kimi',
      'kimi-coding',
      'deepseek',
      'minimax',
      'xiaomi',
      'xiaomi-plan',
      'bailian',
      'bailian-coding',
      'longcat',
      'opencode-go',
      'openrouter',
    ]);

    expect(PROVIDER_PRESETS.find(provider => provider.id === 'kimi-coding')?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      ANTHROPIC_AUTH_TOKEN: '',
      ...getModelSlots('kimi-k3'),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
    });
    expect(PROVIDER_PRESETS.find(provider => provider.id === 'longcat')?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.longcat.chat/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ...getModelSlots('LongCat-2.0'),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '131072',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(PROVIDER_PRESETS.find(provider => provider.id === 'opencode-go')?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://opencode.ai/zen/go',
      ANTHROPIC_AUTH_TOKEN: '',
      ...getModelSlots('deepseek-v4-flash'),
    });
    expect(PROVIDER_PRESETS.find(provider => provider.id === 'bailian')?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    expect(PROVIDER_PRESETS.find(provider => provider.id === 'bailian-coding')?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
    });
  });
});

describe('CODEX_PROVIDER_PRESETS', () => {
  it('includes the expanded Codex third-party preset set', () => {
    expect(CODEX_PROVIDER_PRESETS.map(provider => provider.id)).toEqual([
      'custom',
      'zhipu',
      'kimi',
      'kimi-coding',
      'deepseek',
      'minimax',
      'xiaomi',
      'xiaomi-plan',
      'bailian',
      'bailian-coding',
      'longcat',
      'opencode-go',
      'openrouter',
    ]);

    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'kimi-coding')?.configToml).toContain('base_url = "https://api.kimi.com/coding/v1"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'kimi-coding')?.configToml).toContain('model = "kimi-k3"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'longcat')?.configToml).toContain('base_url = "https://api.longcat.chat/openai/v1"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'longcat')?.configToml).toContain('model = "LongCat-2.0"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'opencode-go')?.configToml).toContain('base_url = "https://opencode.ai/zen/go/v1"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'opencode-go')?.configToml).toContain('model = "glm-5.2"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'bailian')?.configToml).toContain('base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'bailian')?.configToml).toContain('model = "qwen3-coder-plus"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'bailian-coding')?.configToml).toContain('base_url = "https://coding.dashscope.aliyuncs.com/v1"');
    expect(CODEX_PROVIDER_PRESETS.find(provider => provider.id === 'bailian-coding')?.configToml).toContain('model = "qwen3-coder-plus"');
  });
});

describe('custom model pricing validation', () => {
  it('accepts optional non-negative per-million-token pricing fields', () => {
    expect(isValidModelPricing({
      inputCostPer1M: 1.25,
      outputCostPer1M: 3,
      cacheWriteCostPer1M: 0,
      cacheReadCostPer1M: 0.1,
    })).toBe(true);

    expect(isValidCodexCustomModel({
      id: 'vendor/custom-model',
      label: 'Custom Model',
      pricing: {
        inputCostPer1M: 0.2,
        outputCostPer1M: 0.8,
      },
    })).toBe(true);
  });

  it('rejects invalid custom pricing values', () => {
    expect(isValidModelPricing({ inputCostPer1M: -1 })).toBe(false);
    expect(isValidModelPricing({ outputCostPer1M: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isValidModelPricing({ cacheReadCostPer1M: '0.1' })).toBe(false);

    expect(validateCodexCustomModels([
      { id: 'valid-model', label: 'Valid', pricing: { inputCostPer1M: 0.1 } },
      { id: 'invalid-model', label: 'Invalid', pricing: { outputCostPer1M: -2 } },
    ])).toEqual([
      { id: 'valid-model', label: 'Valid', pricing: { inputCostPer1M: 0.1 } },
    ]);
  });
});
