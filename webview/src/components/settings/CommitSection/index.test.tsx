import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CommitSection from './index';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
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

describe('CommitSection', () => {
  it('renders commit provider model controls above the prompt textarea', () => {
    const config: CommitAiConfig = {
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
        mimo: false,
      },
    };

    render(
      <CommitSection
        commitAiConfig={config}
        onCommitAiProviderChange={vi.fn()}
        onCommitAiModelChange={vi.fn()}
        onCommitAiResetToDefault={vi.fn()}
        commitPrompt="use english"
        projectCommitPrompt=""
        onCommitPromptChange={vi.fn()}
        onProjectCommitPromptChange={vi.fn()}
        onSaveCommitPrompt={vi.fn()}
        onSaveProjectCommitPrompt={vi.fn()}
        savingCommitPrompt={false}
        savingProjectCommitPrompt={false}
      />
    );

    expect(screen.getByText('settings.commit.title')).toBeTruthy();
    expect(screen.getByText('settings.commit.description')).toBeTruthy();
    expect(screen.getByTestId('commit-ai-provider-card')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-mode-segment')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-auto-summary')).toBeTruthy();
    // Auto mode hides selects until user switches to Manual.
    expect(screen.queryByTestId('ai-feature-provider-select')).toBeNull();
    expect(screen.queryByTestId('ai-feature-model-select')).toBeNull();
    expect(screen.getByDisplayValue('use english')).toBeTruthy();
    expect(screen.queryByText('settings.commit.codeReview.label')).toBeNull();
  });
});
