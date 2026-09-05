import { describe, expect, it } from 'vitest';
import { resolveProviderModels } from './resolveProviderModels';
import { CODEX_MODELS, GROK_MODELS, CLAUDE_MODELS, OMP_MODELS } from './types';

describe('resolveProviderModels', () => {
  it('uses dynamic Grok catalog when catalogHasEntries is true', () => {
    const catalog = [
      { id: 'grok', label: 'Grok 4.6', description: 'grok-4.6' },
      { id: 'work', label: 'Work', description: 'grok-4.6' },
    ];
    expect(
      resolveProviderModels({
        provider: 'grok',
        cliModels: catalog,
        cliCatalogHasEntries: true,
      }),
    ).toEqual(catalog);
  });

  it('falls back to static GROK_MODELS when Grok catalog is empty', () => {
    expect(
      resolveProviderModels({
        provider: 'grok',
        cliModels: [],
        cliCatalogHasEntries: false,
      }),
    ).toEqual(GROK_MODELS);
  });

  it('does not dump static fallback as "catalog" for Codex — keeps built-ins + customs', () => {
    const customs = [{ id: 'my-gpt', label: 'My GPT' }];
    const result = resolveProviderModels({
      provider: 'codex',
      cliModels: CODEX_MODELS, // static fallback masquerading as catalog
      cliCatalogHasEntries: false,
      codexCustomModels: customs,
    });
    expect(result.map((m) => m.id)).toEqual([
      'my-gpt',
      ...CODEX_MODELS.map((m) => m.id),
    ]);
  });

  it('merges real Codex catalog entries with customs and built-ins', () => {
    const catalog = [{ id: 'kimi-k3', label: 'Kimi K3' }];
    const customs = [{ id: 'my-gpt', label: 'My GPT' }];
    const result = resolveProviderModels({
      provider: 'codex',
      cliModels: catalog,
      cliCatalogHasEntries: true,
      codexCustomModels: customs,
    });
    expect(result.map((m) => m.id)[0]).toBe('my-gpt');
    expect(result.map((m) => m.id)).toContain('kimi-k3');
    expect(result.map((m) => m.id)).toContain(CODEX_MODELS[0].id);
  });

  it('returns cliModels for Kimi / OpenCode / PI', () => {
    const models = [{ id: 'auto', label: 'Auto' }];
    expect(
      resolveProviderModels({
        provider: 'kimi',
        cliModels: models,
        cliCatalogHasEntries: true,
      }),
    ).toEqual(models);
    expect(
      resolveProviderModels({
        provider: 'opencode',
        cliModels: models,
        cliCatalogHasEntries: true,
      }),
    ).toEqual(models);
    expect(
      resolveProviderModels({
        provider: 'pi',
        cliModels: models,
        cliCatalogHasEntries: true,
      }),
    ).toEqual(models);
  });

  it('prepends OMP Auto and appends the catalog for OMP', () => {
    const catalog = [{ id: 'github-copilot/claude-fable-5', label: 'Claude Fable 5' }];
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: catalog,
      cliCatalogHasEntries: true,
    });
    expect(result.map((m) => m.id)).toEqual([
      'auto',
      'github-copilot/claude-fable-5',
    ]);
  });

  it('does not duplicate OMP Auto when cliModels is the static OMP_MODELS fallback', () => {
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: OMP_MODELS,
      cliCatalogHasEntries: false,
    });
    expect(result.map((m) => m.id)).toEqual(['auto']);
  });

  it('keeps model roles (smol/slow/plan) out of the OMP model list', () => {
    // Roles are selected via ModeSelect, not the model dropdown.
    const catalog = [{ id: 'github-copilot/claude-fable-5', label: 'Claude Fable 5' }];
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: catalog,
      cliCatalogHasEntries: true,
    });
    expect(result.some((m) => m.id === 'smol')).toBe(false);
    expect(result.some((m) => m.id === 'slow')).toBe(false);
    expect(result.some((m) => m.id === 'plan')).toBe(false);
  });

  it('merges CodeBuddy SDK models with models.json customs', () => {
    const models = [{ id: 'configured/codebuddy', label: 'Configured CodeBuddy' }];
    expect(
      resolveProviderModels({
        provider: 'codebuddy',
        cliModels: [{ id: 'sdk/model', label: 'SDK Model' }],
        cliCatalogHasEntries: true,
        codeBuddyCustomModels: models,
      }),
    ).toEqual([...models, { id: 'sdk/model', label: 'SDK Model' }]);
  });

  it('shows CodeBuddy SDK models when models.json is empty', () => {
    const result = resolveProviderModels({
      provider: 'codebuddy',
      cliModels: [
        { id: 'gpt-5.5', label: 'Discovered GPT-5.5' },
        { id: 'vendor/discovered', label: 'Discovered Model' },
      ],
      codeBuddyCustomModels: [],
    });

    expect(result).toEqual([
      { id: 'gpt-5.5', label: 'Discovered GPT-5.5' },
      { id: 'vendor/discovered', label: 'Discovered Model' },
    ]);
  });

  it('lets a models.json custom override a CodeBuddy built-in with the same ID', () => {
    const custom = { id: 'gpt-5.5', label: 'Configured GPT-5.5', reasoningSupported: true };
    const result = resolveProviderModels({
      provider: 'codebuddy',
      cliModels: [{ id: 'gpt-5.5', label: 'Discovered GPT-5.5' }, { id: 'gpt-5.4', label: 'Discovered GPT-5.4' }],
      codeBuddyCustomModels: [custom],
    });

    expect(result).toEqual([custom, { id: 'gpt-5.4', label: 'Discovered GPT-5.4' }]);
  });

  it('dedupes CodeBuddy SDK custom-local:<id> entries against models.json customs', () => {
    const custom = {
      id: 'gpt-5.5',
      label: 'Configured GPT-5.5',
      vendor: 'gpt-5.5',
      apiKey: 'sk-xxx',
      url: 'https://codexapis.com/v1/chat/completions',
      maxInputTokens: 300000,
    };
    const result = resolveProviderModels({
      provider: 'codebuddy',
      cliModels: [
        { id: 'custom-local:gpt-5.5', label: 'gpt-5.5' },
        { id: 'custom-local:gpt-5.4', label: 'gpt-5.4' },
        { id: 'hy3', label: 'Hy3' },
      ],
      codeBuddyCustomModels: [custom],
    });

    // models.json copy (no prefix) wins; the SDK's custom-local:gpt-5.5 is dropped.
    expect(result).toEqual([
      custom,
      { id: 'custom-local:gpt-5.4', label: 'gpt-5.4' },
      { id: 'hy3', label: 'Hy3' },
    ]);
    expect(result.filter((m) => m.id === 'gpt-5.5' || m.id === 'custom-local:gpt-5.5')).toHaveLength(1);
  });

  it('puts Claude customs first and keeps built-ins', () => {
    const customs = [{ id: 'my-claude', label: 'My Claude' }];
    const result = resolveProviderModels({
      provider: 'claude',
      cliModels: [],
      claudeCustomModels: customs,
    });
    expect(result[0]).toEqual(customs[0]);
    expect(result.map((m) => m.id)).toContain(CLAUDE_MODELS[0].id);
  });
});
