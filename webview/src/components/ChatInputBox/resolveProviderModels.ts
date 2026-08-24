import type { ModelInfo } from './types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  OMP_MODELS,
  OMP_ROLE_MODELS,
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
  /**
   * Dynamic OMP model roles (useOmpRoles). Absent/empty → static
   * smol/slow/plan role entries. Only consumed for provider 'omp'.
   */
  cliRoles?: ModelInfo[];
  claudeCustomModels?: ModelInfo[];
  codexCustomModels?: ModelInfo[];
  claudeMapping?: ClaudeModelMapping | null;
  /** Live Gemini family rows from parent; falls back to GEMINI_MODELS / cliModels. */
  geminiModels?: ModelInfo[];
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
  cliRoles,
  claudeCustomModels = [],
  codexCustomModels = [],
  claudeMapping = null,
  geminiModels,
}: ResolveProviderModelsInput): ModelInfo[] {
  if (provider === 'codex') {
    const catalogModels = cliCatalogHasEntries ? cliModels : [];
    return buildCodexModelList(catalogModels, codexCustomModels, CODEX_MODELS);
  }

  if (provider === 'gemini') {
    // Family base ids only (effort suffixes live in ReasoningSelect via geminiFamilies).
    // Never fall back to flat get_cli_models slugs (...-high / ...-thinking).
    if (geminiModels && geminiModels.length > 0) {
      return geminiModels;
    }
    return GEMINI_MODELS;
  }

  if (provider === 'grok') {
    // Prefer dynamic catalog (config profiles from get_cli_models). When the
    // catalog is empty/unavailable, fall back to the static profile slot.
    if (cliCatalogHasEntries && cliModels.length > 0) {
      return cliModels;
    }
    return cliModels.length > 0 ? cliModels : GROK_MODELS;
  }

  if (provider === 'kimi' || provider === 'opencode' || provider === 'pi' || provider === 'dsh') {
    // Runtime catalog from the CLI/host (static fallback list when offline).
    return cliModels;
  }

  if (provider === 'omp') {
    // Built-ins first: 'auto' plus the role entries (dynamic from listModels,
    // static smol/slow/plan until loaded), then the dynamic catalog appended.
    // Dedupe by id — the role selector entries win on collision, and the
    // static-fallback 'auto' must not duplicate the OMP_MODELS one.
    const roles = cliRoles && cliRoles.length > 0 ? cliRoles : OMP_ROLE_MODELS;
    const merged = [...OMP_MODELS, ...roles, ...cliModels];
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
