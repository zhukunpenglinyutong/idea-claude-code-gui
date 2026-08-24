import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  isValidDshPreset,
  isValidPermissionMode,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from '../components/ChatInputBox/types';
import type { PermissionMode, ReasoningEffort } from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useGeminiProvider } from './providers/useGeminiProvider';
import { useGrokProvider } from './providers/useGrokProvider';
import { useKimiProvider } from './providers/useKimiProvider';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { usePiProvider } from './providers/usePiProvider';
import { useOmpProvider } from './providers/useOmpProvider';
import { isCliOnlyProvider, normalizeCliPermissionMode, ompModeForModelId } from './providers/cliProviders';
import { useOmpRoles } from './providers/useCliModels';
import { useDshProvider } from './providers/useDshProvider';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state. Composes four single-purpose
 * sub-hooks (Claude / Codex / usage tracking / provider settings) plus a
 * persistence hook, then wires the cross-slice state (currentProvider +
 * permissionMode) and the cross-provider handlers (mode/model/provider switch,
 * long-context toggle, always-thinking toggle).
 *
 * The flat return shape is preserved as the public API: callers (App,
 * ChatScreen, AppDialogs, useMessageSender) destructure individual fields.
 *
 * `currentProviderRef` is exposed for window callbacks registered with stable
 * identity that must read the current provider when fired by the JCEF bridge.
 * The ref is updated via render-time assignment (no useEffect mirror).
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Render-time assignment avoids the useRef + useEffect
  // mirror anti-pattern (rule 5.15).
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  // ── Provider-specific sub-hooks ──
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const grok = useGrokProvider();
  const gemini = useGeminiProvider();
  const kimi = useKimiProvider();
  const openCode = useOpenCodeProvider();
  const pi = usePiProvider();
  const omp = useOmpProvider();
  // Dynamic omp model roles (listModels payload; static smol/slow/plan until
  // loaded) — drive mode⇔model unification for omp.
  const ompRoles = useOmpRoles();
  const dsh = useDshProvider();
  const { isSdkInstalled, isSdkStatusKnown, sdkStatus, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

  const {
    selectedClaudeModel, setSelectedClaudeModel,
    claudePermissionMode, setClaudePermissionMode,
    longContextEnabled, setLongContextEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  } = claude;
  const {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
    codexFastMode, setCodexFastMode,
    handleReasoningChange: codexHandleReasoningChange,
    handleCodexFastModeChange,
  } = codex;
  const {
    selectedGrokModel, setSelectedGrokModel,
    grokPermissionMode, setGrokPermissionMode,
  } = grok;
  const {
    selectedGeminiModel, setSelectedGeminiModel,
    geminiPermissionMode, setGeminiPermissionMode,
    geminiFamilies,
    geminiModels,
    geminiCatalogLoaded,
    fetchGeminiModels,
    resolveGeminiAgyModelId,
    resolveDefaultEffortForFamily,
  } = gemini;
  const {
    selectedKimiModel, setSelectedKimiModel,
    kimiPermissionMode, setKimiPermissionMode,
  } = kimi;
  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = openCode;
  const {
    selectedPiModel, setSelectedPiModel,
    piPermissionMode, setPiPermissionMode,
  } = pi;
  const {
    selectedOmpModel, setSelectedOmpModel,
    ompPermissionMode, setOmpPermissionMode,
  } = omp;
  const {
    selectedDshModel, setSelectedDshModel,
    dshPermissionMode, setDshPermissionMode,
    dshPreset, setDshPreset,
  } = dsh;

  // Pull live agy catalog when Gemini is active (new tab / provider switch).
  useEffect(() => {
    if (currentProvider === 'gemini') {
      fetchGeminiModels();
    }
  }, [currentProvider, fetchGeminiModels]);

  // After catalog arrives, re-push full agy slug so session state is never left
  // on a bare family id that agy rejects without --effort.
  useEffect(() => {
    if (currentProvider !== 'gemini' || !geminiCatalogLoaded) {
      return;
    }
    const fullSlug = resolveGeminiAgyModelId(selectedGeminiModel, reasoningEffort);
    if (fullSlug) {
      sendBridgeEvent('set_model', fullSlug);
    }
  }, [
    currentProvider,
    geminiCatalogLoaded,
    reasoningEffort,
    resolveGeminiAgyModelId,
    selectedGeminiModel,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prev = window.onTabActivated;
    window.onTabActivated = () => {
      if (currentProviderRef.current === 'gemini') {
        fetchGeminiModels();
      }
      if (typeof prev === 'function') {
        try {
          prev();
        } catch {
          // ignore
        }
      }
    };
    return () => {
      window.onTabActivated = prev;
    };
  }, [fetchGeminiModels]);

  // ── Persistence: load on mount + save on change ──
  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGeminiModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setGeminiPermissionMode,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setSelectedDshModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setDshPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    setDshPreset,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    selectedGeminiModel,
    claudePermissionMode,
    codexPermissionMode,
    geminiPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    dshPreset,
  });

  // ── Computed values ──
  const selectedModel = currentProvider === 'codex'
    ? selectedCodexModel
    : currentProvider === 'gemini'
      ? selectedGeminiModel
      : currentProvider === 'grok'
        ? selectedGrokModel
        : currentProvider === 'kimi'
          ? selectedKimiModel
          : currentProvider === 'opencode'
            ? selectedOpenCodeModel
            : currentProvider === 'pi'
              ? selectedPiModel
              : currentProvider === 'omp'
                ? selectedOmpModel              : currentProvider === 'dsh'
                ? selectedDshModel
                : selectedClaudeModel;
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );
  const currentSdkStatusError = useMemo(
    () => usage.sdkStatusError !== null && !isSdkStatusKnown(currentProvider)
      ? usage.sdkStatusError
      : null,
    [currentProvider, isSdkStatusKnown, usage.sdkStatusError],
  );
  // Whether the installed Claude SDK meets the minimum version required for the
  // selected model's tier (Fable needs >= 0.3.182). `undefined` means the backend
  // hasn't reported it (SDK not installed, or an old plugin version without the
  // field) — callers must only warn on an explicit `false` to avoid false positives.
  const claudeSdkMeetsMinimum = sdkStatus?.['claude-sdk']?.meetsMinimumVersion;

  // ── Cross-provider handlers ──
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      const codexMode: PermissionMode = mode === 'plan' ? 'default' : mode;
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    if (currentProvider === 'gemini') {
      setPermissionMode(mode);
      setGeminiPermissionMode(mode);
      sendBridgeEvent('set_mode', mode);
      return;
    }
    if (isCliOnlyProvider(currentProvider)) {
      const cliMode = normalizeCliPermissionMode(mode, currentProvider);
      setPermissionMode(cliMode);
      if (currentProvider === 'grok') setGrokPermissionMode(cliMode);
      if (currentProvider === 'kimi') setKimiPermissionMode(cliMode);
      if (currentProvider === 'opencode') setOpenCodePermissionMode(cliMode);
      if (currentProvider === 'pi') setPiPermissionMode(cliMode);
      if (currentProvider === 'omp') {
        setOmpPermissionMode(cliMode);
        // The omp mode selector is a shortcut over the model value: role modes
        // set the model to the role id, 'default' selects the CLI default.
        const ompModel = cliMode === 'default' ? 'auto' : cliMode;
        setSelectedOmpModel(ompModel);
        sendBridgeEvent('set_model', ompModel);
        // Java's VALID_PERMISSION_MODES is a static whitelist — dynamic roles
        // (e.g. 'designer') would be rejected there; set_model carries them.
        if (isValidPermissionMode(cliMode)) {
          sendBridgeEvent('set_mode', cliMode);
        }
        return;
      }
      if (currentProvider === 'dsh') setDshPermissionMode(cliMode);
      sendBridgeEvent('set_mode', cliMode);
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [
    currentProvider,
    setCodexPermissionMode,
    setClaudePermissionMode,
    setGeminiPermissionMode,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setSelectedOmpModel,
    setDshPermissionMode,
  ]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'claude') {
      const strippedModelId = strip1MContextSuffix(modelId);
      const normalizedModelId = normalizeClaudeModelId(strippedModelId);
      setSelectedClaudeModel(normalizedModelId);
      sendBridgeEvent('set_model', apply1MContextSuffix(normalizedModelId, longContextEnabled));
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'gemini') {
      setSelectedGeminiModel(modelId);
      const effort = resolveDefaultEffortForFamily(modelId);
      setReasoningEffort(effort);
      sendBridgeEvent('set_reasoning_effort', effort);
      const fullSlug = resolveGeminiAgyModelId(modelId, effort);
      sendBridgeEvent('set_model', fullSlug);
    } else if (currentProvider === 'grok') {
      setSelectedGrokModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'kimi') {
      setSelectedKimiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'opencode') {
      setSelectedOpenCodeModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'pi') {
      setSelectedPiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'omp') {
      setSelectedOmpModel(modelId);
      sendBridgeEvent('set_model', modelId);
      // Mode⇔model unification: role models select the same-named mode,
      // anything else ('auto' or catalog models) selects 'default'.
      const ompMode = ompModeForModelId(modelId, ompRoles);
      setOmpPermissionMode(ompMode);
      setPermissionMode(ompMode);
      // Dynamic roles are not in Java's static mode whitelist — set_model
      // above already carries the role; skip set_mode for them.
      if (isValidPermissionMode(ompMode)) {
        sendBridgeEvent('set_mode', ompMode);
      }
    } else if (currentProvider === 'dsh') {
      setSelectedDshModel(modelId);
      sendBridgeEvent('set_model', modelId);
    }
  }, [
    currentProvider,
    longContextEnabled,
    ompRoles,
    resolveDefaultEffortForFamily,
    resolveGeminiAgyModelId,
    setReasoningEffort,    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGeminiModel,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setOmpPermissionMode,
    setSelectedDshModel,
  ]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    if (currentProvider === 'gemini') {
      setReasoningEffort(effort);
      sendBridgeEvent('set_reasoning_effort', effort);
      const fullSlug = resolveGeminiAgyModelId(selectedGeminiModel, effort);
      sendBridgeEvent('set_model', fullSlug);
      return;
    }
    codexHandleReasoningChange(effort);
  }, [
    codexHandleReasoningChange,
    currentProvider,
    resolveGeminiAgyModelId,
    selectedGeminiModel,
    setReasoningEffort,
  ]);

    const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    // 'thinking' is a gemini-only effort tier. ReasoningSelect casts family
    // tiers into the shared slot (e.id as ReasoningEffort), so a gemini-only
    // value can be present at runtime even though the shared type excludes
    // it. Clamp at the source — otherwise the slot (and the persistence
    // snapshot) carries a value codex/claude/grok silently reject until the
    // selector's own post-render correction lands.
    if (providerId !== 'gemini' && (reasoningEffort as string) === 'thinking') {
      setReasoningEffort('high');
      // Mirror the clamp to the backend — otherwise Java's session state keeps
      // 'thinking' for the newly selected provider (codex silently normalizes
      // it to medium while the UI shows high).
      sendBridgeEvent('set_reasoning_effort', 'high');
    }

    let modeToSet: PermissionMode = claudePermissionMode;
    if (providerId === 'codex') {
      modeToSet = normalizeCliPermissionMode(codexPermissionMode, providerId);
    } else if (providerId === 'gemini') {
      modeToSet = geminiPermissionMode;
      fetchGeminiModels();    } else if (providerId === 'grok') {
      modeToSet = normalizeCliPermissionMode(grokPermissionMode, providerId);
    } else if (providerId === 'kimi') {
      modeToSet = normalizeCliPermissionMode(kimiPermissionMode, providerId);
    } else if (providerId === 'opencode') {
      modeToSet = normalizeCliPermissionMode(openCodePermissionMode, providerId);
    } else if (providerId === 'pi') {
      modeToSet = normalizeCliPermissionMode(piPermissionMode, providerId);
    } else if (providerId === 'omp') {
      modeToSet = normalizeCliPermissionMode(ompPermissionMode, providerId);
    } else if (providerId === 'dsh') {
      modeToSet = normalizeCliPermissionMode(dshPermissionMode, providerId);
    }
    setPermissionMode(modeToSet);
    // Dynamic omp roles are not in Java's static mode whitelist — the
    // set_model event below carries the role; skip set_mode for them.
    if (providerId !== 'omp' || isValidPermissionMode(modeToSet)) {
      sendBridgeEvent('set_mode', modeToSet);
    }

    let newModel = apply1MContextSuffix(selectedClaudeModel, longContextEnabled);
    if (providerId === 'codex') newModel = selectedCodexModel;
    else if (providerId === 'gemini') newModel = resolveGeminiAgyModelId(selectedGeminiModel, reasoningEffort);
    else if (providerId === 'grok') newModel = selectedGrokModel;
    else if (providerId === 'kimi') newModel = selectedKimiModel;
    else if (providerId === 'opencode') newModel = selectedOpenCodeModel;
    else if (providerId === 'pi') newModel = selectedPiModel;
    else if (providerId === 'omp') newModel = selectedOmpModel;
    else if (providerId === 'dsh') newModel = selectedDshModel;
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    fetchGeminiModels,
    geminiPermissionMode,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    longContextEnabled,
    reasoningEffort,
    resolveGeminiAgyModelId,
    selectedCodexModel,
    selectedClaudeModel,
    selectedGeminiModel,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    longContextEnabled,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProvider === 'claude') {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  const handleDshPresetChange = useCallback((preset: string) => {
    if (!isValidDshPreset(preset)) return;
    setDshPreset(preset);
    if (currentProvider === 'dsh') {
      sendBridgeEvent('set_dsh_preset', preset);
    }
  }, [currentProvider, setDshPreset]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled,
      },
    } : null);

    sendBridgeEvent('update_provider', JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled,
        },
      },
    }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...gemini,
    ...grok,
    ...kimi,
    ...openCode,
    ...pi,
    ...omp,
    ...dsh,
    ...usage,
    ...settings,
    sdkStatus,
    sdkStatusError: currentSdkStatusError,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    geminiFamilies,
    geminiModels,
    geminiCatalogLoaded,
    currentSdkInstalled,
    claudeSdkMeetsMinimum,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleDshPresetChange,
    handleReasoningChange,
    handleCodexFastModeChange,
    handleLongContextChange,
    handleToggleThinking,
    fetchGeminiModels,
    resolveGeminiAgyModelId,
  };
}
