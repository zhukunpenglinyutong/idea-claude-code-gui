import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PromptEnhancerSection from './index';
import type { PromptEnhancerConfig } from '../../../types/promptEnhancer';
import { DEFAULT_AI_FEATURE_MODELS } from '../../../types/aiFeatureConfig';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../../hooks/providers/useCliModels', () => ({
  useCliModels: () => ({
    cliModels: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
    ],
    cliCatalogHasEntries: true,
    cliModelsLoading: false,
    cliModelsError: null,
  }),
  useOmpRoles: () => [],
}));

describe('PromptEnhancerSection', () => {
  it('renders prompt enhancer settings as a standalone section', () => {
    const config: PromptEnhancerConfig = {
      provider: null,
      effectiveProvider: 'codex',
      resolutionSource: 'auto',
      models: { ...DEFAULT_AI_FEATURE_MODELS },
      availability: {
        claude: true,
        codex: true,
        grok: false,
        kimi: false,
        opencode: false,
        pi: false,
        omp: false,
        minimax: false,
      },
    };

    render(
      <PromptEnhancerSection
        promptEnhancerConfig={config}
        onPromptEnhancerProviderChange={vi.fn()}
        onPromptEnhancerModelChange={vi.fn()}
        onPromptEnhancerResetToDefault={vi.fn()}
      />
    );

    expect(screen.getByText('settings.promptEnhancer.title')).toBeTruthy();
    expect(screen.getByText('settings.promptEnhancer.description')).toBeTruthy();
    expect(screen.getByTestId('prompt-enhancer-provider-card')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-mode-segment')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-auto-summary')).toBeTruthy();
    // Auto mode hides selects until user switches to Manual.
    expect(screen.queryByTestId('ai-feature-provider-select')).toBeNull();
    expect(screen.queryByTestId('ai-feature-model-select')).toBeNull();
  });

  it('switches to auto mode via segmented control from standalone section', () => {
    const onPromptEnhancerResetToDefault = vi.fn();

    render(
      <PromptEnhancerSection
        promptEnhancerConfig={{
          provider: 'claude',
          effectiveProvider: 'claude',
          resolutionSource: 'manual',
          models: {
            ...DEFAULT_AI_FEATURE_MODELS,
            claude: 'claude-opus-4-8',
            codex: 'gpt-5.4',
          },
          availability: {
            claude: true,
            codex: true,
            grok: false,
            kimi: false,
            opencode: false,
            pi: false,
            omp: false,
            minimax: false,
          },
        }}
        onPromptEnhancerProviderChange={vi.fn()}
        onPromptEnhancerModelChange={vi.fn()}
        onPromptEnhancerResetToDefault={onPromptEnhancerResetToDefault}
      />
    );

    expect(screen.getByTestId('ai-feature-provider-select')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-feature-mode-auto'));
    expect(onPromptEnhancerResetToDefault).toHaveBeenCalledTimes(1);
  });
});
