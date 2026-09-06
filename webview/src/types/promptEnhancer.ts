import type { AiFeatureConfig, AiFeatureProvider, AiFeatureResolutionSource } from './aiFeatureConfig';
import {
  DEFAULT_AI_FEATURE_MODELS,
  normalizeAiFeatureConfig,
} from './aiFeatureConfig';

export type PromptEnhancerProvider = AiFeatureProvider;
export type PromptEnhancerResolutionSource = AiFeatureResolutionSource;
export type PromptEnhancerConfig = AiFeatureConfig;

export const DEFAULT_PROMPT_ENHANCER_CONFIG: PromptEnhancerConfig = {
  provider: null,
  effectiveProvider: 'claude',
  resolutionSource: 'auto',
  models: { ...DEFAULT_AI_FEATURE_MODELS },
  availability: {
    claude: false,
    codex: false,
    grok: false,
    kimi: false,
    opencode: false,
    pi: false,
    omp: false,
    minimax: false,
  },
};

export function normalizePromptEnhancerConfig(
  raw: Partial<PromptEnhancerConfig> | null | undefined,
): PromptEnhancerConfig {
  return normalizeAiFeatureConfig(raw, DEFAULT_PROMPT_ENHANCER_CONFIG);
}
