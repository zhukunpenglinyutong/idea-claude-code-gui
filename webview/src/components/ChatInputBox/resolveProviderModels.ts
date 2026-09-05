import type { ModelInfo } from './types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GROK_MODELS,
  OMP_MODELS,
} from './types';
import { buildCodexModelList } from './codexModelList';
import {
  applyClaudeModelMapping,
  type ClaudeModelMapping,
} from '../../utils/claudeModelMapping';

export interface ResolveProviderModelsInput {
  provider: string;
  /** Dynamic catalog from useCliModels (may be static fallback when empty). */
  cliModels: ModelInfo[];
  /**
   * True only when the backend returned real catalog entries.
   * When false, cliModels is the static fallback and must not replace built-ins
   * for Codex (see buildCodexModelList).
   */
  cliCatalogHasEntries?: boolean;
  claudeCustomModels?: ModelInfo[];
  codexCustomModels?: ModelInfo[];
  claudeMapping?: ClaudeModelMapping | null;
}

/**
 * Single source of truth for the model picker list — used by:
 *  - main chat toolbar (ButtonArea)
 *  - Prompt Enhancer settings
 *  - Commit AI settings
 *
 * Keep all three UIs in lockstep so users never see divergent catalogs.
 */
export function resolveProviderModels({
  provider,
  cliModels,
  cliCatalogHasEntries = false,
  claudeCustomModels = [],
  codexCustomModels = [],
  claudeMapping = null,
}: ResolveProviderModelsInput): ModelInfo[] {
  if (provider === 'codex') {
    const catalogModels = cliCatalogHasEntries ? cliModels : [];
    return buildCodexModelList(catalogModels, codexCustomModels, CODEX_MODELS);
  }

  if (provider === 'grok') {
    // Prefer dynamic catalog (config profiles from get_cli_models). When the
    // catalog is empty/unavailable, fall back to the static profile slot.
    if (cliCatalogHasEntries && cliModels.length > 0) {
      return cliModels;
    }
    return cliModels.length > 0 ? cliModels : GROK_MODELS;
  }

  if (provider === 'kimi' || provider === 'mimo' || provider === 'opencode' || provider === 'pi' || provider === 'dsh') {
    // Runtime catalog from the CLI/host (static fallback list when offline).
    return cliModels;
  }

  if (provider === 'omp') {
    // 'auto' first, then the dynamic catalog. Model roles (smol/slow/plan/…)
    // are NOT listed here — they live in the mode selector (ModeSelect),
    // which sets the model to the role id as a shortcut.
    // Dedupe by id — the static-fallback cliModels IS OMP_MODELS, so 'auto'
    // would otherwise appear twice.
    const merged = [...OMP_MODELS, ...cliModels];
    const seenIds = new Set<string>();
    return merged.filter((m) => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    });
  }

  // Claude (default)
  let builtIns: ModelInfo[] = CLAUDE_MODELS;
  if (claudeMapping && Object.keys(claudeMapping).length > 0) {
    try {
      builtIns = CLAUDE_MODELS.map((m) => applyClaudeModelMapping(m, claudeMapping));
    } catch {
      builtIns = CLAUDE_MODELS;
    }
  }

  if (claudeCustomModels.length === 0) {
    return builtIns;
  }

  // Customs first; collapse duplicate *labels* (several built-in slots mapped
  // to the same real model name) the same way the settings panel used to.
  const merged = [...claudeCustomModels, ...builtIns];
  const seenLabels = new Set<string>();
  const seenIds = new Set<string>();
  return merged.filter((m) => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    const key = m.label.trim().toLowerCase();
    if (key && seenLabels.has(key)) return false;
    if (key) seenLabels.add(key);
    return true;
  });
}
