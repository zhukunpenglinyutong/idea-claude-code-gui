import { describe, expect, it } from 'vitest';
import {
  AI_FEATURE_PROVIDERS,
  DEFAULT_AI_FEATURE_MODELS,
  DEFAULT_COMMIT_AI_CONFIG,
  normalizeAiFeatureConfig,
  pickAutoAiFeatureProvider,
} from './aiFeatureConfig';
import {
  DEFAULT_PROMPT_ENHANCER_CONFIG,
  normalizePromptEnhancerConfig,
} from './promptEnhancer';

describe('normalizeAiFeatureConfig', () => {
  it('fills missing availability/models for all CLI providers', () => {
    const normalized = normalizeAiFeatureConfig({}, DEFAULT_COMMIT_AI_CONFIG);
    for (const provider of AI_FEATURE_PROVIDERS) {
      expect(normalized.availability[provider]).toBe(false);
      expect(normalized.models[provider]).toBe(DEFAULT_AI_FEATURE_MODELS[provider]);
    }
    expect(normalized.provider).toBeNull();
  });

  it('preserves valid multi-CLI provider and availability flags', () => {
    const normalized = normalizeAiFeatureConfig({
      provider: 'grok',
      effectiveProvider: 'grok',
      resolutionSource: 'manual',
      // Partial payload from the backend: only three providers configured,
      // the rest must be filled from defaults by normalize.
      models: { claude: 'claude-opus-4-8', codex: 'gpt-5.4', grok: 'grok' },
      availability: { claude: true, codex: false, grok: true },
    });
    expect(normalized.provider).toBe('grok');
    expect(normalized.availability.claude).toBe(true);
    expect(normalized.availability.codex).toBe(false);
    expect(normalized.availability.grok).toBe(true);
    expect(normalized.models.claude).toBe('claude-opus-4-8');
    expect(normalized.models.grok).toBe('grok');
    expect(normalized.models.kimi).toBe(DEFAULT_AI_FEATURE_MODELS.kimi);
  });

  it('rejects unknown provider ids', () => {
    const normalized = normalizeAiFeatureConfig({
      provider: 'gemini' as never,
      effectiveProvider: 'gemini' as never,
    });
    expect(normalized.provider).toBeNull();
    expect(normalized.effectiveProvider).toBeNull();
  });
});

describe('pickAutoAiFeatureProvider', () => {
  it('prefers codex then claude before beta CLIs', () => {
    expect(pickAutoAiFeatureProvider({
      claude: true,
      codex: true,
      grok: true,
      kimi: true,
      opencode: true,
      pi: true,
      omp: true,
      minimax: true,
    })).toBe('codex');
    expect(pickAutoAiFeatureProvider({
      claude: true,
      codex: false,
      grok: true,
      kimi: false,
      opencode: false,
      pi: false,
      omp: false,
      minimax: false,
    })).toBe('claude');
    expect(pickAutoAiFeatureProvider({
      claude: false,
      codex: false,
      grok: true,
      kimi: true,
      opencode: false,
      pi: false,
      omp: false,
      minimax: false,
    })).toBe('grok');
  });

  it('prefers the current chat provider when available (prompt enhancer auto)', () => {
    expect(pickAutoAiFeatureProvider({
      claude: true,
      codex: true,
      grok: true,
      kimi: false,
      opencode: false,
      pi: false,
      omp: false,
      minimax: false,
    }, 'grok')).toBe('grok');
    expect(pickAutoAiFeatureProvider({
      claude: true,
      codex: true,
      grok: false,
      kimi: false,
      opencode: false,
      pi: false,
      omp: false,
      minimax: false,
    }, 'grok')).toBe('codex');
    expect(pickAutoAiFeatureProvider({
      claude: true,
      codex: true,
      grok: true,
      kimi: false,
      opencode: false,
      pi: false,
      omp: false,
      minimax: false,
    }, 'unknown-cli')).toBe('codex');
  });
});

describe('normalizePromptEnhancerConfig', () => {
  it('uses prompt enhancer defaults including CLI models', () => {
    const normalized = normalizePromptEnhancerConfig(null);
    expect(normalized.effectiveProvider).toBe(DEFAULT_PROMPT_ENHANCER_CONFIG.effectiveProvider);
    expect(normalized.models).toEqual(DEFAULT_PROMPT_ENHANCER_CONFIG.models);
    expect(normalized.models.opencode).toBe('opencode-default');
  });
});
