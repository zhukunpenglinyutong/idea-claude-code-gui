import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODELS,
  composeGeminiAgyModelId,
  splitGeminiAgyModelId,
  toGeminiFamilyId,
  type GeminiEffortOption,
  type GeminiModelFamily,
  type ModelInfo,
  type PermissionMode,
  type ReasoningEffort,
} from '../../components/ChatInputBox/types';
import { sendBridgeEvent } from '../../utils/bridge';

const AGY_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'thinking', ''] as const;

function effortLabel(effort: string): string {
  const e = (effort || '').toLowerCase();
  if (e === 'low') return 'Low';
  if (e === 'medium') return 'Medium';
  if (e === 'high') return 'High';
  if (e === 'xhigh') return 'XHigh';
  if (e === 'thinking') return 'Thinking';
  if (!e) return 'Default';
  return e.charAt(0).toUpperCase() + e.slice(1);
}

function stripParenEffort(label: string): string {
  return (label || '')
    .replace(/\s*\((?:Very\s+)?(?:High|Medium|Low|XHigh|Max|Thinking)\)\s*$/i, '')
    .trim() || label;
}

/** Humanize a bare slug for display when agy only printed the id. */
function humanizeFamilyLabel(baseId: string, rawLabel: string): string {
  const stripped = stripParenEffort(rawLabel);
  // If label is just the full slug / base id, prettify
  if (!stripped || stripped === baseId || stripped.startsWith(baseId + '-')) {
    return baseId
      .split('-')
      .map((p) => {
        if (/^\d+(\.\d+)*$/.test(p)) return p;
        if (p.toLowerCase() === 'gpt') return 'GPT';
        if (p.toLowerCase() === 'oss') return 'OSS';
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join(' ');
  }
  return stripped;
}

function normalizeFlatEntries(
  models: unknown,
): Array<{ id: string; label: string }> {
  if (!Array.isArray(models)) return [];
  const out: Array<{ id: string; label: string }> = [];
  for (const m of models) {
    if (typeof m === 'string' && m.trim()) {
      out.push({ id: m.trim(), label: m.trim() });
      continue;
    }
    if (m && typeof m === 'object' && typeof (m as { id?: string }).id === 'string') {
      const id = (m as { id: string }).id.trim();
      if (!id) continue;
      const label = String((m as { label?: string }).label || id).trim() || id;
      out.push({ id, label });
    }
  }
  return out;
}

/** Group flat agy catalog into UI families (client-side fallback). */
export function groupGeminiFamiliesFromFlat(
  entries: Array<{ id: string; label: string }>,
): GeminiModelFamily[] {
  const families = new Map<string, {
    id: string;
    label: string;
    efforts: GeminiEffortOption[];
    order: number;
  }>();
  let order = 0;

  for (const entry of entries) {
    if (!entry?.id) continue;
    const { baseId, effort } = splitGeminiAgyModelId(entry.id);
    const familyId = baseId || entry.id;
    let fam = families.get(familyId);
    if (!fam) {
      fam = {
        id: familyId,
        label: humanizeFamilyLabel(familyId, entry.label),
        efforts: [],
        order: order++,
      };
      families.set(familyId, fam);
    } else {
      const candidate = humanizeFamilyLabel(familyId, entry.label);
      // Prefer human labels over slug-looking ones
      if (candidate && !candidate.includes('-') && fam.label.includes('-')) {
        fam.label = candidate;
      }
    }

    if (effort) {
      if (!fam.efforts.some((e) => e.id === effort)) {
        fam.efforts.push({ id: effort, label: effortLabel(effort), modelId: entry.id });
      }
    } else if (!fam.efforts.some((e) => e.modelId === entry.id)) {
      fam.efforts.push({ id: '', label: 'Default', modelId: entry.id });
    }
  }

  const rank = (id: string) => {
    const i = (AGY_EFFORT_ORDER as readonly string[]).indexOf(id);
    return i >= 0 ? i : 50;
  };

  return [...families.values()]
    .sort((a, b) => a.order - b.order)
    .map((fam) => {
      const efforts = [...fam.efforts].sort((a, b) => rank(a.id) - rank(b.id));
      const defaultEffort =
        efforts.find((e) => e.id === 'medium')?.id
        ?? efforts.find((e) => e.id === 'high')?.id
        ?? efforts.find((e) => e.id === 'thinking')?.id
        ?? efforts[0]?.id
        ?? '';
      const defaultModelId =
        efforts.find((e) => e.id === defaultEffort)?.modelId
        ?? efforts[0]?.modelId
        ?? fam.id;
      return {
        id: fam.id,
        label: fam.label,
        description: efforts.filter((e) => e.id).length > 1
          ? `${efforts.filter((e) => e.id).length} effort levels`
          : (efforts[0]?.label || ''),
        efforts,
        defaultEffort,
        defaultModelId,
      };
    });
}

/**
 * Gemini / Antigravity CLI selectable state + live model catalog from `agy models`.
 */
export function useGeminiProvider() {
  const [selectedGeminiModel, setSelectedGeminiModel] = useState(DEFAULT_GEMINI_MODEL_ID);
  const [geminiPermissionMode, setGeminiPermissionMode] = useState<PermissionMode>('default');
  const [geminiFamilies, setGeminiFamilies] = useState<GeminiModelFamily[]>([]);
  const [geminiModels, setGeminiModels] = useState<ModelInfo[]>(GEMINI_MODELS);
  const [geminiCatalogLoaded, setGeminiCatalogLoaded] = useState(false);

  const applyGeminiCatalog = useCallback((payload: {
    success?: boolean;
    families?: GeminiModelFamily[];
    models?: unknown;
  }) => {
    if (!payload || payload.success === false) {
      return;
    }

    let families = Array.isArray(payload.families) ? payload.families.filter(Boolean) : [];
    // Prefer server families only if they have real effort nesting; else rebuild.
    const familiesLookUsable = families.length > 0 && families.some(
      (f) => Array.isArray(f.efforts) && f.efforts.length > 0 && f.id && f.label,
    );

    if (!familiesLookUsable) {
      const flat = normalizeFlatEntries(payload.models);
      if (flat.length > 0) {
        families = groupGeminiFamiliesFromFlat(flat);
      }
    }

    // Normalize server families: ensure labels are human when missing/slug-like
    if (familiesLookUsable) {
      families = families.map((f) => ({
        ...f,
        label: humanizeFamilyLabel(f.id, f.label || f.id),
        efforts: Array.isArray(f.efforts) ? f.efforts : [],
        defaultEffort: f.defaultEffort ?? '',
        defaultModelId: f.defaultModelId || f.id,
      }));
    }

    if (families.length === 0) {
      return;
    }

    setGeminiFamilies(families);
    setGeminiModels(
      families.map((f) => ({
        id: f.id,
        label: f.label,
        description: f.description || '',
      })),
    );
    setGeminiCatalogLoaded(true);

    // Keep selection on a known family; migrate full slugs -> family id.
    // Never silently jump to catalog[0] when prev is a valid family we just lost
    // only due to transient empty payload (already guarded above).
    setSelectedGeminiModel((prev) => {
      const familyId = toGeminiFamilyId(prev) || prev;
      if (families.some((f) => f.id === familyId)) {
        return familyId;
      }
      if (families.some((f) => f.id === prev)) {
        return prev;
      }
      const preferred =
        families.find((f) => f.id === DEFAULT_GEMINI_MODEL_ID)
        || families[0];
      return preferred?.id || prev;
    });
  }, []);

  const fetchGeminiModels = useCallback(() => {
    sendBridgeEvent('get_gemini_models', '');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prev = window.updateGeminiModels;
    window.updateGeminiModels = (json: string) => {
      try {
        const payload = typeof json === 'string' ? JSON.parse(json) : json;
        applyGeminiCatalog(payload || {});
      } catch (e) {
        console.warn('[useGeminiProvider] Failed to parse gemini models', e);
      }
      // Do not chain prev no-op placeholders that clear state.
    };
    return () => {
      // Restore previous handler if it was a real one; keep our handler if prev was placeholder.
      if (typeof prev === 'function' && prev !== window.updateGeminiModels) {
        window.updateGeminiModels = prev;
      }
    };
  }, [applyGeminiCatalog]);

  const resolveGeminiAgyModelId = useCallback(
    (familyId: string, effort: string): string => {
      const fam = geminiFamilies.find((f) => f.id === familyId);
      if (fam) {
        const match = fam.efforts.find((e) => e.id === (effort || ''))
          || fam.efforts.find((e) => e.id === fam.defaultEffort)
          || fam.efforts[0];
        if (match?.modelId) return match.modelId;
        return fam.defaultModelId || composeGeminiAgyModelId(familyId, effort);
      }
      return composeGeminiAgyModelId(familyId, effort);
    },
    [geminiFamilies],
  );

  const resolveDefaultEffortForFamily = useCallback(
    (familyId: string): ReasoningEffort => {
      const fam = geminiFamilies.find((f) => f.id === familyId);
      if (fam && fam.defaultEffort !== undefined && fam.defaultEffort !== null) {
        // '' is a meaningful tier here: bare single-slug families (e.g.
        // claude-sonnet-4-6) have the bare id as their default — not a
        // missing value. Truthiness would wrongly fall through to 'high'
        // and compose claude-sonnet-4-6-high, which agy rejects.
        return fam.defaultEffort as ReasoningEffort;
      }
      // Bare single-slug families (e.g. claude-sonnet-4-6) have empty effort
      const only = fam?.efforts?.length === 1 ? fam.efforts[0].id : '';
      if (only) return only as ReasoningEffort;
      // Unknown/unloaded family — mirror resolveAgySpawnModel's spawn-side
      // fallbacks (ai-bridge/services/gemini/agy-utils.js): gemini bare ids
      // need a tier (every gemini family ships -high; some lack -medium),
      // gpt-oss ships -medium, and claude-style bare ids must pass through
      // UNSUFFIXED — agy rejects invented tiers for single-slug models
      // (claude-sonnet-4-6-high → "not recognized as a known model").
      if (/^gemini-/i.test(familyId)) return 'high';
      if (/^gpt-oss-/i.test(familyId)) return 'medium';
      const bare: string = '';
      return bare as ReasoningEffort;
    },
    [geminiFamilies],
  );

  return {
    selectedGeminiModel,
    setSelectedGeminiModel,
    geminiPermissionMode,
    setGeminiPermissionMode,
    geminiFamilies,
    geminiModels,
    geminiCatalogLoaded,
    fetchGeminiModels,
    resolveGeminiAgyModelId,
    resolveDefaultEffortForFamily,
    applyGeminiCatalog,
  };
}

export type UseGeminiProviderReturn = ReturnType<typeof useGeminiProvider>;
