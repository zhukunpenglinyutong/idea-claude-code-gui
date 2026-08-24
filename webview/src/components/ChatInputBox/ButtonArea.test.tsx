import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonArea } from './ButtonArea';
import type { ModelInfo } from './types';

// The catalog auto-select effect under test lives inline in ButtonArea; the
// selector components and the compact-measure hook are rendering concerns
// only — stub them so the test pins the fallback contract, not selector
// internals (same module-stub approach as ChatInputBoxHeader.test.tsx).
vi.mock('./selectors', () => ({
  CodexFastModeSelect: () => null,
  ConfigSelect: () => null,
  DshPresetSelect: () => null,
  LongContextToggle: () => null,
  ModeSelect: () => null,
  ModelSelect: () => null,
  ProviderSelect: () => null,
  ReasoningSelect: () => null,
}));
vi.mock('./hooks/useToolbarSelectorCompact', () => ({
  useToolbarSelectorCompact: () => false,
}));

const cliState = vi.hoisted(() => ({
  cliModels: [] as ModelInfo[],
  cliDefaultModel: null as string | null,
  cliCatalogHasEntries: false,
}));
vi.mock('../../hooks/providers/useCliModels', () => ({
  useCliModels: () => ({
    cliModels: cliState.cliModels,
    cliModelsLoading: false,
    cliModelsError: null,
    refreshCliModels: () => {},
    cliDefaultModel: cliState.cliDefaultModel,
    cliCatalogHasEntries: cliState.cliCatalogHasEntries,
  }),
  useOmpRoles: () => [],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CATALOG: ModelInfo[] = [
  { id: 'catalog-first', label: 'First' },
  { id: 'catalog-second', label: 'Second' },
];

describe('ButtonArea catalog auto-select', () => {
  beforeEach(() => {
    cliState.cliModels = CATALOG;
    cliState.cliDefaultModel = null;
    cliState.cliCatalogHasEntries = true;
  });

  it('falls back to the CLI-reported default even when it is absent from the fetched catalog', () => {
    // Dynamic catalogs (dsh renders cliModels verbatim): the CLI may report a
    // default the catalog fetch did not list — the reported default still
    // wins over the positional first entry. Catalog-membership gating here
    // would snap the selection to the first entry instead (review nit on the
    // base behavior `cliDefaultModel ?? availableModels[0].id`).
    cliState.cliDefaultModel = 'cli-only-default';

    const onModelSelect = vi.fn();
    render(
      <ButtonArea
        currentProvider="dsh"
        selectedModel="saved-but-gone"
        onModelSelect={onModelSelect}
      />,
    );

    expect(onModelSelect).toHaveBeenCalledWith('cli-only-default');
  });

  it('uses the first catalog entry only when the CLI reports no default', () => {
    const onModelSelect = vi.fn();
    render(
      <ButtonArea
        currentProvider="dsh"
        selectedModel="saved-but-gone"
        onModelSelect={onModelSelect}
      />,
    );

    expect(onModelSelect).toHaveBeenCalledWith('catalog-first');
  });

  it('does not auto-select before the backend returned real catalog entries', () => {
    // cliModels may be a static fallback list while the fetch is in flight —
    // the fallback must not clobber a missing selection until
    // cliCatalogHasEntries says the list is real.
    cliState.cliCatalogHasEntries = false;

    const onModelSelect = vi.fn();
    render(
      <ButtonArea
        currentProvider="dsh"
        selectedModel="saved-but-gone"
        onModelSelect={onModelSelect}
      />,
    );

    expect(onModelSelect).not.toHaveBeenCalled();
  });
});
