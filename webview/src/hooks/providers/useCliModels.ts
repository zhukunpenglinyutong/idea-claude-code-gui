import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import type { ModelInfo, ReasoningEffort } from '../../components/ChatInputBox/types';
import {
  CODEBUDDY_MODELS,
  CODEX_MODELS,
  DSH_MODELS,
  GROK_MODELS,
  KIMI_MODELS,
  MINIMAX_MODELS,
  OMP_MODELS,
  OMP_ROLE_MODELS,
  OPENCODE_MODELS,
  PI_MODELS,
} from '../../components/ChatInputBox/types';
import { isCliOnlyProvider } from './cliProviders';
import { subscribeActiveCodexProvider } from '../../utils/runtimeProviderCapabilities';

type CliModelsByProvider = Record<string, ModelInfo[]>;

/** Java may never answer get_cli_models — don't leave the spinner on forever. */
const CLI_MODELS_TIMEOUT_MS = 15_000;

/**
 * Module-level caches so switching away from chat (history/settings) and back
 * does not drop the catalog and re-trigger a spinner + auto-select reset.
 * ChatScreen unmounts on view change; these survive that remount.
 */
const modelsCache: CliModelsByProvider = {};
const defaultModelCache: Record<string, string> = {};
const catalogHasEntriesCache: Record<string, boolean> = {};
/** Last error *code* per provider (e.g. CODEBUDDY_LOCAL_CONFIG_REQUIRED) for actionable error UI. */
const errorCodeCache: Record<string, string> = {};

/**
 * Dynamic model roles from the listModels payload (`roles: [{id,label,description}]`,
 * description = resolved model selector). Empty until a payload with roles
 * arrives; omp consumers fall back to the static smol/slow/plan entries.
 */
const rolesCache: Record<string, ModelInfo[]> = {};
const rolesListeners = new Set<() => void>();
/** Stable empty snapshot — useSyncExternalStore requires cached references. */
const NO_ROLES: ModelInfo[] = [];

function notifyRolesListeners() {
  for (const listener of rolesListeners) listener();
}

function subscribeRoles(listener: () => void): () => void {
  rolesListeners.add(listener);
  return () => {
    rolesListeners.delete(listener);
  };
}

/**
 * Drop the cached catalog for a provider at the module level (usable even when
 * no chat surface is mounted — e.g. Settings edits models.json while
 * ChatScreen is unmounted). The next useCliModels mount refetches.
 */
export function invalidateCliModelsCache(providerId: string) {
  delete modelsCache[providerId];
  delete defaultModelCache[providerId];
  delete catalogHasEntriesCache[providerId];
  delete errorCodeCache[providerId];
}

/** Test-only: clear module caches between cases. */
export function __resetCliModelsCacheForTests() {
  for (const key of Object.keys(modelsCache)) delete modelsCache[key];
  for (const key of Object.keys(defaultModelCache)) delete defaultModelCache[key];
  for (const key of Object.keys(catalogHasEntriesCache)) delete catalogHasEntriesCache[key];
  for (const key of Object.keys(errorCodeCache)) delete errorCodeCache[key];
  for (const key of Object.keys(rolesCache)) delete rolesCache[key];
}

function fallbackModels(providerId: string): ModelInfo[] {
  if (providerId === 'grok') return GROK_MODELS;
  if (providerId === 'kimi') return KIMI_MODELS;
  if (providerId === 'minimax') return MINIMAX_MODELS;
  if (providerId === 'opencode') return OPENCODE_MODELS;
  if (providerId === 'pi') return PI_MODELS;
  if (providerId === 'omp') return OMP_MODELS;
  if (providerId === 'dsh') return DSH_MODELS;
  if (providerId === 'codebuddy') return CODEBUDDY_MODELS;
  if (providerId === 'codex') return CODEX_MODELS;
  return [];
}

/**
 * Providers whose model list is discovered dynamically via `get_cli_models`.
 * Codex is included even though it is not a CLI-only provider: its list comes
 * from ~/.codex/config.toml + model_catalog_json, same as the codex CLI picker.
 */
function supportsDynamicModels(providerId: string): boolean {
  if (providerId === 'codex' || providerId === 'codebuddy') return true;
  return isCliOnlyProvider(providerId);
}

function normalizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.label === 'string' && row.label.trim()
      ? row.label.trim()
      : id;
    const description = typeof row.description === 'string' ? row.description : undefined;
    const credits = typeof row.credits === 'string' && row.credits.trim()
      ? row.credits.trim()
      : undefined;
    const supportedEfforts = Array.isArray(row.supportedEfforts)
      ? row.supportedEfforts.filter((effort): effort is ReasoningEffort =>
        typeof effort === 'string'
        && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
      : undefined;
    const reasoningSupported = typeof row.reasoningSupported === 'boolean'
      ? row.reasoningSupported
      : undefined;
    out.push({
      id,
      label,
      description,
      credits,
      ...(supportedEfforts?.length ? { supportedEfforts } : {}),
      ...(reasoningSupported !== undefined ? { reasoningSupported } : {}),
    });
  }
  return out;
}

/**
 * Loads model catalogs for headless CLI providers (Kimi / OpenCode) and Codex
 * via channel-manager `listModels`. Falls back to static defaults until loaded.
 */
export function useCliModels(currentProvider: string) {
  // Seed from module cache so history→chat remounts keep the last catalog.
  const [modelsByProvider, setModelsByProvider] = useState<CliModelsByProvider>(() => ({ ...modelsCache }));
  const [defaultModelByProvider, setDefaultModelByProvider] = useState<Record<string, string>>(
    () => ({ ...defaultModelCache }),
  );
  /** Whether the last payload for a provider carried real catalog entries (vs empty → fallback). */
  const [catalogHasEntriesByProvider, setCatalogHasEntriesByProvider] = useState<Record<string, boolean>>(
    () => ({ ...catalogHasEntriesCache }),
  );
  const [errorCodeByProvider, setErrorCodeByProvider] = useState<Record<string, string>>(
    () => ({ ...errorCodeCache }),
  );
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [errorByProvider, setErrorByProvider] = useState<Record<string, string>>({});
  const pendingLoadRef = useRef<{ provider: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const clearPendingLoad = useCallback(() => {
    if (pendingLoadRef.current) {
      clearTimeout(pendingLoadRef.current.timer);
      pendingLoadRef.current = null;
    }
  }, []);

  const beginLoad = useCallback((providerId: string) => {
    // A request for this provider is already in flight — Java collapses
    // concurrent get_cli_models anyway; don't pile on duplicate spawns. The
    // invalidate paths below clear pendingLoadRef first, so a forced refetch
    // after a settings edit always gets through.
    if (pendingLoadRef.current?.provider === providerId) return;
    clearPendingLoad();
    setLoadingProvider(providerId);
    setErrorByProvider((prev) => {
      if (!(providerId in prev)) return prev;
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    sendBridgeEvent('get_cli_models', providerId);
    pendingLoadRef.current = {
      provider: providerId,
      timer: setTimeout(() => {
        pendingLoadRef.current = null;
        // No response arrived in time — fall back to the static catalog and
        // surface the failure so the user isn't staring at a bare fallback list.
        setLoadingProvider((current) => (current === providerId ? null : current));
        setErrorByProvider((prev) => ({ ...prev, [providerId]: 'timeout' }));
      }, CLI_MODELS_TIMEOUT_MS),
    };
  }, [clearPendingLoad]);

  useEffect(() => {
    const handler = (dataOrStr: string | { provider?: string; models?: unknown; roles?: unknown; success?: boolean; error?: string; errorCode?: unknown; defaultModel?: unknown }) => {
      let payload: { provider?: string; models?: unknown; roles?: unknown; success?: boolean; error?: string; errorCode?: unknown; defaultModel?: unknown } | null = null;
      if (typeof dataOrStr === 'string') {
        try {
          payload = JSON.parse(dataOrStr);
        } catch {
          return;
        }
      } else if (dataOrStr && typeof dataOrStr === 'object') {
        payload = dataOrStr;
      }
      if (!payload?.provider) return;
      const provider = payload.provider;
      const models = normalizeModels(payload.models);
      const resolvedModels = models.length > 0 ? models : fallbackModels(provider);
      modelsCache[provider] = resolvedModels;
      catalogHasEntriesCache[provider] = models.length > 0;
      if (typeof payload.errorCode === 'string' && payload.errorCode.trim()) {
        errorCodeCache[provider] = payload.errorCode.trim();
      } else {
        delete errorCodeCache[provider];
      }
      // Dynamic model roles (omp listModels ≥ roles support). Missing/invalid
      // roles → [] so consumers keep their static fallback.
      rolesCache[provider] = normalizeModels(payload.roles);
      notifyRolesListeners();
      setModelsByProvider((prev) => ({
        ...prev,
        [provider]: resolvedModels,
      }));
      setCatalogHasEntriesByProvider((prev) => ({ ...prev, [provider]: models.length > 0 }));
      setErrorCodeByProvider((prev) => {
        const code = typeof payload.errorCode === 'string' && payload.errorCode.trim()
          ? payload.errorCode.trim()
          : undefined;
        if (code) return { ...prev, [provider]: code };
        if (!(provider in prev)) return prev;
        const next = { ...prev };
        delete next[provider];
        return next;
      });
      const defaultModel = typeof payload.defaultModel === 'string' && payload.defaultModel.trim()
        ? payload.defaultModel.trim()
        : null;
      if (defaultModel) {
        defaultModelCache[provider] = defaultModel;
      } else {
        delete defaultModelCache[provider];
      }
      setDefaultModelByProvider((prev) => {
        const next = { ...prev };
        if (defaultModel) {
          next[provider] = defaultModel;
        } else {
          delete next[provider];
        }
        return next;
      });
      if (payload.success === false) {
        // Backend reported a failure (CLI missing, non-zero exit, …) — keep the
        // fallback list but remember the error so the dropdown can show it.
        const message = typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : 'unknown error';
        setErrorByProvider((prev) => ({ ...prev, [provider]: message }));
      } else {
        setErrorByProvider((prev) => {
          if (!(provider in prev)) return prev;
          const next = { ...prev };
          delete next[provider];
          return next;
        });
      }
      if (pendingLoadRef.current?.provider === provider) {
        clearPendingLoad();
      }
      setLoadingProvider((current) => (current === provider ? null : current));
    };

    window.setCliModels = handler;
    return () => {
      if (window.setCliModels === handler) {
        delete window.setCliModels;
      }
      clearPendingLoad();
    };
  }, [clearPendingLoad]);

  useEffect(() => {
    if (!supportsDynamicModels(currentProvider)) return;
    if (modelsByProvider[currentProvider]?.length) return;

    beginLoad(currentProvider);
  }, [currentProvider, modelsByProvider, beginLoad]);

  // Switching the active Codex provider rewrites ~/.codex/config.toml, so the
  // cached catalog no longer reflects what the CLI would serve. Drop the cache
  // and refetch when the chat is currently on codex.
  useEffect(() => {
    return subscribeActiveCodexProvider(() => {
      delete modelsCache.codex;
      delete defaultModelCache.codex;
      delete catalogHasEntriesCache.codex;
      delete errorCodeCache.codex;
      setModelsByProvider((prev) => {
        if (!('codex' in prev)) return prev;
        const next = { ...prev };
        delete next.codex;
        return next;
      });
      setDefaultModelByProvider((prev) => {
        if (!('codex' in prev)) return prev;
        const next = { ...prev };
        delete next.codex;
        return next;
      });
      setCatalogHasEntriesByProvider((prev) => {
        if (!('codex' in prev)) return prev;
        const next = { ...prev };
        delete next.codex;
        return next;
      });
      if (currentProvider === 'codex') {
        // Clear an in-flight request so the post-switch refetch is never
        // swallowed by the beginLoad pending guard.
        clearPendingLoad();
        beginLoad('codex');
      }
    });
  }, [currentProvider, beginLoad, clearPendingLoad]);

  // Editing models.json in Settings changes what the CodeBuddy SDK serves, so
  // the cached catalog must be dropped when the user returns to chat —
  // otherwise deleted models stay selectable.
  useEffect(() => {
    const invalidate = () => {
      invalidateCliModelsCache('codebuddy');
      setModelsByProvider((prev) => {
        if (!('codebuddy' in prev)) return prev;
        const next = { ...prev };
        delete next.codebuddy;
        return next;
      });
      setDefaultModelByProvider((prev) => {
        if (!('codebuddy' in prev)) return prev;
        const next = { ...prev };
        delete next.codebuddy;
        return next;
      });
      setCatalogHasEntriesByProvider((prev) => {
        if (!('codebuddy' in prev)) return prev;
        const next = { ...prev };
        delete next.codebuddy;
        return next;
      });
      if (currentProvider === 'codebuddy') {
        // A pre-save request may still be pending — drop it so the refetch
        // forced by this invalidation isn't swallowed by the pending guard.
        clearPendingLoad();
        beginLoad('codebuddy');
      }
    };
    window.addEventListener('codebuddy-models-config-changed', invalidate);
    return () => window.removeEventListener('codebuddy-models-config-changed', invalidate);
  }, [currentProvider, beginLoad, clearPendingLoad]);

  const refreshCliModels = useCallback((providerId: string) => {
    if (!supportsDynamicModels(providerId)) return;
    beginLoad(providerId);
  }, [beginLoad]);

  const cliModels = modelsByProvider[currentProvider]?.length
    ? modelsByProvider[currentProvider]
    : fallbackModels(currentProvider);

  return {
    cliModels,
    cliModelsLoading: loadingProvider === currentProvider,
    cliModelsError: errorByProvider[currentProvider] ?? null,
    cliModelsErrorCode: errorCodeByProvider[currentProvider] ?? null,
    cliDefaultModel: defaultModelByProvider[currentProvider] ?? null,
    cliCatalogHasEntries: catalogHasEntriesByProvider[currentProvider] ?? false,
    refreshCliModels,
    modelsByProvider,
  };
}

export type UseCliModelsReturn = ReturnType<typeof useCliModels>;

/**
 * Dynamic OMP model roles discovered via the listModels payload (roles arrive
 * through `window.setCliModels` regardless of which provider is active, so
 * this subscribes directly to the module-level roles cache).
 * Falls back to the static smol/slow/plan role entries until a payload with
 * roles arrives (CLI missing, old omp without roles support, fetch failure).
 */
export function useOmpRoles(): ModelInfo[] {
  const roles = useSyncExternalStore(subscribeRoles, () => rolesCache.omp ?? NO_ROLES);
  return roles.length > 0 ? roles : OMP_ROLE_MODELS;
}
