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

  it('prepends OMP Auto + role entries for OMP and appends the catalog', () => {
    const catalog = [{ id: 'github-copilot/claude-fable-5', label: 'Claude Fable 5' }];
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: catalog,
      cliCatalogHasEntries: true,
    });
    expect(result.map((m) => m.id)).toEqual([
      'auto',
      'smol',
      'slow',
      'plan',
      'github-copilot/claude-fable-5',
    ]);
  });

  it('does not duplicate OMP Auto when cliModels is the static OMP_MODELS fallback', () => {
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: OMP_MODELS,
      cliCatalogHasEntries: false,
    });
    expect(result.map((m) => m.id)).toEqual(['auto', 'smol', 'slow', 'plan']);
    expect(result.filter((m) => m.id === 'auto')).toHaveLength(1);
  });

  it('uses dynamic cliRoles for OMP, inserted between auto and the catalog', () => {
    const roles = [
      { id: 'smol', label: 'Smol', description: 'openai/gpt-5-mini' },
      { id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' },
    ];
    const catalog = [{ id: 'github-copilot/claude-fable-5', label: 'Claude Fable 5' }];
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: catalog,
      cliCatalogHasEntries: true,
      cliRoles: roles,
    });
    expect(result.map((m) => m.id)).toEqual([
      'auto',
      'smol',
      'designer',
      'github-copilot/claude-fable-5',
    ]);
    expect(result.find((m) => m.id === 'designer')).toEqual(roles[1]);
  });

  it('dedupes catalog entries that collide with a dynamic role id (role wins)', () => {
    const roles = [{ id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' }];
    const catalog = [{ id: 'designer', label: 'Stale catalog entry' }];
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: catalog,
      cliCatalogHasEntries: true,
      cliRoles: roles,
    });
    expect(result.filter((m) => m.id === 'designer')).toEqual(roles);
  });

  it('falls back to the static smol/slow/plan roles when cliRoles is empty', () => {
    const result = resolveProviderModels({
      provider: 'omp',
      cliModels: [],
      cliCatalogHasEntries: false,
      cliRoles: [],
    });
    expect(result.map((m) => m.id)).toEqual(['auto', 'smol', 'slow', 'plan']);
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

  it('prefers Gemini family list and never uses flat cli effort slugs', () => {
    const families = [
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    ];
    const flatCli = [
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
      { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    ];
    expect(
      resolveProviderModels({
        provider: 'gemini',
        cliModels: flatCli,
        cliCatalogHasEntries: true,
        geminiModels: families,
      }),
    ).toEqual(families);

    // Without geminiModels, fall back to static family list — not flat cliModels
    const fallback = resolveProviderModels({
      provider: 'gemini',
      cliModels: flatCli,
      cliCatalogHasEntries: true,
    });
    expect(fallback.map((m) => m.id)).not.toContain('gemini-3.6-flash-high');
    expect(fallback.map((m) => m.id)).toContain('gemini-3.5-flash');
  });
});
