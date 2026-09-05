import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiFeatureProviderModelPanel from './index';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
import { DEFAULT_AI_FEATURE_MODELS } from '../../../types/aiFeatureConfig';

const panelStyles = readFileSync(
  'src/components/settings/AiFeatureProviderModelPanel/style.module.less',
  'utf8'
);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      if (options?.provider) {
        return `${key}:${options.provider}`;
      }
      if (options?.defaultValue) {
        return options.defaultValue;
      }
      return key;
    },
  }),
}));

vi.mock('../../../hooks/providers/useCliModels', () => ({
  useCliModels: (provider: string) => {
    if (provider === 'codex') {
      return {
        cliModels: [
          { id: 'gpt-5.5', label: 'GPT-5.5' },
          { id: 'gpt-5.4', label: 'GPT-5.4' },
        ],
        cliCatalogHasEntries: true,
        cliModelsLoading: false,
        cliModelsError: null,
      };
    }
    if (provider === 'grok') {
      return {
        cliModels: [{ id: 'grok', label: 'Grok 4.6' }],
        cliCatalogHasEntries: true,
        cliModelsLoading: false,
        cliModelsError: null,
      };
    }
    return {
      cliModels: [],
      cliCatalogHasEntries: false,
      cliModelsLoading: false,
      cliModelsError: null,
    };
  },
  // Static smol/slow/plan fallback applies inside resolveProviderModels.
  useOmpRoles: () => [],
}));

describe('AiFeatureProviderModelPanel', () => {
  const config: CommitAiConfig = {
    provider: null,
    effectiveProvider: 'codex',
    resolutionSource: 'auto',
    models: { ...DEFAULT_AI_FEATURE_MODELS },
    availability: {
      claude: true,
      codex: true,
      grok: true,
      kimi: false,
      opencode: false,
      pi: false,
      omp: false,
      minimax: false,
    },
  };

  it('renders auto mode summary without provider/model selects', () => {
    render(
      <AiFeatureProviderModelPanel
        config={config}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    expect(screen.getByTestId('ai-feature-mode-segment')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-mode-auto').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('ai-feature-mode-manual').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('ai-feature-auto-summary')).toBeTruthy();
    expect(screen.getByText(/settings\.commit\.providerModel\.autoSummary/)).toBeTruthy();
    expect(screen.queryByTestId('ai-feature-provider-select')).toBeNull();
    expect(screen.queryByTestId('ai-feature-model-select')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.commit.providerModel.resetToDefault' })).toBeNull();
  });

  it('switches auto → manual by pinning the resolved provider', () => {
    const onProviderChange = vi.fn();
    render(
      <AiFeatureProviderModelPanel
        config={config}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={onProviderChange}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('ai-feature-mode-manual'));
    expect(onProviderChange).toHaveBeenCalledWith('codex');
  });

  it('switches manual → auto via reset callback', () => {
    const onResetToDefault = vi.fn();
    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'claude',
          effectiveProvider: 'claude',
          resolutionSource: 'manual',
        }}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onResetToDefault={onResetToDefault}
      />
    );

    expect(screen.getByTestId('ai-feature-mode-manual').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('ai-feature-provider-select')).toBeTruthy();
    expect(screen.getByTestId('ai-feature-model-select')).toBeTruthy();

    fireEvent.click(screen.getByTestId('ai-feature-mode-auto'));
    expect(onResetToDefault).toHaveBeenCalledTimes(1);
  });

  it('lists the same 8 providers as the main chat provider selector in manual mode', () => {
    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'claude',
          effectiveProvider: 'claude',
          resolutionSource: 'manual',
        }}
        settingsKeyPrefix="settings.basic.promptEnhancer"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        fallbackProvider="claude"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    const providerRoot = screen.getByTestId('ai-feature-provider-select');
    fireEvent.click(within(providerRoot).getByRole('button'));
    const options = within(providerRoot).getAllByRole('option');
    expect(options).toHaveLength(8);
    const labels = options.map((opt) => opt.textContent ?? '');
    expect(labels.some((l) => /Claude/i.test(l) || /providers\.claude\.label/.test(l))).toBe(true);
    expect(labels.some((l) => /Codex/i.test(l) || /providers\.codex\.label/.test(l))).toBe(true);
    expect(labels.some((l) => /Grok/i.test(l) || /providers\.grok\.label/.test(l))).toBe(true);
    expect(labels.some((l) => /Kimi/i.test(l) || /providers\.kimi\.label/.test(l))).toBe(true);
    expect(labels.some((l) => /MiniMax/i.test(l) || /providers\.minimax\.label/.test(l))).toBe(true);
    expect(labels.some((l) => /OpenCode/i.test(l) || /providers\.opencode\.label/.test(l))).toBe(true);
    expect(labels.some((l) => /PI/i.test(l) || /providers\.pi\.label/.test(l))).toBe(true);
    expect(labels.some((l) => /OMP/i.test(l) || /providers\.omp\.label/.test(l))).toBe(true);
  });

  it('keeps selects compact with ellipsis instead of wrapping', () => {
    expect(panelStyles).toMatch(
      /\.selectGroup\s*\{[\s\S]*display:\s*grid;[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.15fr\)\s+minmax\(0,\s*0\.85fr\);/
    );
    expect(panelStyles).toMatch(
      /\.selectValue\s*\{[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/
    );
    // Must use custom listbox (button trigger), not native <select>.
    expect(panelStyles).toMatch(/Custom listbox \(not native <select>\)/);
    expect(panelStyles).toMatch(/\.segmentedControl\s*\{/);
    expect(panelStyles).toMatch(/\.autoSummary\s*\{/);
    expect(panelStyles).toMatch(
      /\.statusText\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/
    );
  });

  it('keeps provider options selectable even when availability is all false', () => {
    const onProviderChange = vi.fn();
    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'claude',
          effectiveProvider: null,
          resolutionSource: 'unavailable',
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
        }}
        settingsKeyPrefix="settings.basic.promptEnhancer"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        fallbackProvider="claude"
        onProviderChange={onProviderChange}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    const providerRoot = screen.getByTestId('ai-feature-provider-select');
    const trigger = within(providerRoot).getByRole('button');
    expect((trigger as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(trigger);
    const options = within(providerRoot).getAllByRole('option');
    expect(options.length).toBe(8);
    options.forEach((opt) => {
      expect((opt as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(within(providerRoot).getByRole('option', {
      name: /^codex/i,
    }));
    expect(onProviderChange).toHaveBeenCalledWith('codex');
  });

  it('calls provider callback from manual mode selector', () => {
    const onProviderChange = vi.fn();

    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'claude',
          effectiveProvider: 'claude',
          resolutionSource: 'manual',
        }}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={onProviderChange}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    const providerRoot = screen.getByTestId('ai-feature-provider-select');
    fireEvent.click(within(providerRoot).getByRole('button'));
    fireEvent.click(within(providerRoot).getByRole('option', {
      name: /^codex/i,
    }));

    expect(onProviderChange).toHaveBeenCalledWith('codex');
  });

  it('calls model change callback from model selector in manual mode', () => {
    const onModelChange = vi.fn();

    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'codex',
          effectiveProvider: 'codex',
          resolutionSource: 'manual',
        }}
        settingsKeyPrefix="settings.commit.providerModel"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={vi.fn()}
        onModelChange={onModelChange}
        onResetToDefault={vi.fn()}
      />
    );

    const modelRoot = screen.getByTestId('ai-feature-model-select');
    fireEvent.click(within(modelRoot).getByRole('button'));
    fireEvent.click(within(modelRoot).getByRole('option', { name: /gpt-5\.4/i }));

    expect(onModelChange).toHaveBeenCalledWith('gpt-5.4');
  });

  it('can select a beta CLI provider (Grok) in manual mode', () => {
    const onProviderChange = vi.fn();
    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'codex',
          effectiveProvider: 'codex',
          resolutionSource: 'manual',
        }}
        settingsKeyPrefix="settings.basic.promptEnhancer"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={onProviderChange}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    const providerRoot = screen.getByTestId('ai-feature-provider-select');
    fireEvent.click(within(providerRoot).getByRole('button'));
    fireEvent.click(within(providerRoot).getByRole('option', {
      name: /^grok/i,
    }));
    expect(onProviderChange).toHaveBeenCalledWith('grok');
  });

  it('shows Grok profile models (not gateway catalog noise) in the model select', () => {
    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: 'grok',
          effectiveProvider: 'grok',
          resolutionSource: 'manual',
          models: {
            ...DEFAULT_AI_FEATURE_MODELS,
            grok: 'grok',
          },
        }}
        settingsKeyPrefix="settings.basic.promptEnhancer"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    const modelRoot = screen.getByTestId('ai-feature-model-select');
    fireEvent.click(within(modelRoot).getByRole('button'));
    const options = within(modelRoot).getAllByRole('option');
    const labels = options.map((opt) => opt.textContent ?? '');
    expect(labels.some((l) => /Grok 4\.6/i.test(l))).toBe(true);
    // Must not surface OpenAI-compatible gateway dump entries.
    expect(labels.some((l) => /gpt-5\.2/i.test(l) || /codex-auto-review/i.test(l))).toBe(false);
  });

  it('shows unavailable summary in auto mode when no provider is effective', () => {
    render(
      <AiFeatureProviderModelPanel
        config={{
          ...config,
          provider: null,
          effectiveProvider: null,
          resolutionSource: 'unavailable',
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
        }}
        settingsKeyPrefix="settings.basic.promptEnhancer"
        providerKeyPrefix="settings.basic.promptEnhancer.provider"
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        onResetToDefault={vi.fn()}
      />
    );

    expect(screen.getByTestId('ai-feature-auto-summary')).toBeTruthy();
    expect(screen.getByText('settings.basic.promptEnhancer.autoUnavailable')).toBeTruthy();
  });
});
