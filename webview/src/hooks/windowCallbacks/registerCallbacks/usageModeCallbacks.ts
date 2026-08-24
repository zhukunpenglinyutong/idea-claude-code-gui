/**
 * usageModeCallbacks.ts
 *
 * Registers window bridge callbacks for usage statistics, permission modes, and
 * model/provider updates: onUsageUpdate, onModeChanged, onModeReceived,
 * onModelChanged, onModelConfirmed, updateActiveProvider, updateThinkingEnabled,
 * updateStreamingEnabled, updateSendShortcut, updateAutoOpenFileEnabled.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { CodexFastMode, PermissionMode, ReasoningEffort } from '../../../components/ChatInputBox/types';
import {
  has1MContextSuffix,
  isValidPermissionMode,
  isLiveClaudeModelId,
  normalizeClaudeModelId,
  splitGeminiAgyModelId,
  strip1MContextSuffix,
  toGeminiFamilyId,
  REASONING_EFFORTS,
  REASONING_EFFORTS_SHARED,
} from '../../../components/ChatInputBox/types';
import { drainPendingSettings, startInitialSettingsRequest } from '../settingsBootstrap';
import { clampPermissionDialogTimeoutSeconds } from '../../../utils/permissionDialogTimeout';

export function registerUsageModeCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setUsagePercentage,
    setUsageUsedTokens,
    setUsageMaxTokens,
    setPermissionMode,
    setCurrentProvider,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setGeminiPermissionMode,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGeminiModel,
    resolveDefaultEffort,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    setProviderConfigVersion,
    setActiveProviderConfig,
    setClaudeSettingsAlwaysThinkingEnabled,
    setStreamingEnabledSetting,
    setSendShortcut,
    setAutoOpenFileEnabled,
    setPermissionDialogTimeoutSeconds,
    currentProviderRef,
    syncActiveProviderModelMapping,
  } = options;

  window.onUsageUpdate = (json) => {
    try {
      const data = JSON.parse(json);
      if (typeof data.percentage === 'number') {
        const used =
          typeof data.usedTokens === 'number'
            ? data.usedTokens
            : typeof data.totalTokens === 'number'
              ? data.totalTokens
              : undefined;
        const max =
          typeof data.maxTokens === 'number'
            ? data.maxTokens
            : typeof data.limit === 'number'
              ? data.limit
              : undefined;

        if (used !== undefined && max !== undefined && used > max * 2) {
          console.warn(
            '[Frontend] Usage data may be incorrect: used=' + used + ', max=' + max,
          );
        }

        const safePercentage = Math.max(0, Math.min(100, data.percentage));
        setUsagePercentage(safePercentage);
        setUsageUsedTokens(used);
        setUsageMaxTokens(max);
      }
    } catch (error) {
      console.error('[Frontend] Failed to parse usage update:', error);
    }
  };

  if (typeof window.__pendingUsageUpdate === 'string') {
    const pending = window.__pendingUsageUpdate;
    delete window.__pendingUsageUpdate;
    window.onUsageUpdate(pending);
  }

  const updateMode = (mode?: PermissionMode, providerOverride?: string) => {
    const activeProvider = providerOverride || currentProviderRef.current;
    if (isValidPermissionMode(mode)) {
      const nextMode: PermissionMode =
        activeProvider === 'codex' && mode === 'plan' ? 'default' : mode;
      setPermissionMode((prev) => (prev === nextMode ? prev : nextMode));
      if (activeProvider === 'codex') {
        setCodexPermissionMode((prev) => (prev === nextMode ? prev : nextMode));
      } else if (activeProvider === 'gemini') {
        setGeminiPermissionMode((prev) => (prev === nextMode ? prev : nextMode));
      } else {
        setClaudePermissionMode((prev) => (prev === nextMode ? prev : nextMode));
      }
    }
  };

  window.onModeChanged = (mode) => updateMode(mode as PermissionMode);
  window.onModeReceived = (mode) => updateMode(mode as PermissionMode);

  const applyGeminiModelFromBackend = (modelId: string) => {
    // Backend stores full agy slugs (...-high / ...-thinking). UI selection is family base only.
    const family = toGeminiFamilyId(modelId) || modelId;
    // Cross-provider guard: applyBackendTabState / onModelConfirmed can carry
    // a claude-era tab model with provider 'gemini' (JCEF tab state is shared
    // across chat tabs). A live claude id is not an agy model — accepting it
    // poisons the slot and the catalog re-push relays it to agy, which
    // rejects it at spawn. Same guard as the persistence restore path.
    if (isLiveClaudeModelId(family)) return;
    setSelectedGeminiModel(family);
    // Mirror the slug's effort tier into the shared slot — the separate
    // reasoningEffort field excludes gemini-only tiers (...-thinking), so
    // without this the slot stays stale while the backend runs -thinking.
    const { effort } = splitGeminiAgyModelId(modelId);
    // ReasoningEffort (the type) excludes the gemini-only 'thinking' tier;
    // the runtime slot accepts it — REASONING_EFFORTS is that seam's
    // single source of truth.
    if (effort && (REASONING_EFFORTS as readonly string[]).includes(effort)) {
      setReasoningEffort(effort as ReasoningEffort);
    } else if (resolveDefaultEffort) {
      // Bare family id (legacy persisted tab state): mirror the family
      // default into the shared slot — the same shape as the App.tsx
      // history path's bare-row branch; without it the slot keeps the
      // previous tab's tier while the backend runs the default.
      setReasoningEffort(resolveDefaultEffort(family));
    }
  };

  window.onModelChanged = (modelId) => {
    const provider = currentProviderRef.current;
    if (provider === 'claude') {
      setSelectedClaudeModel(normalizeClaudeModelId(modelId));
    } else if (provider === 'codex') {
      setSelectedCodexModel(modelId);
    } else if (provider === 'gemini') {
      applyGeminiModelFromBackend(modelId);
    }
  };

  window.onModelConfirmed = (modelId, provider) => {
    if (provider === 'claude') {
      setSelectedClaudeModel(normalizeClaudeModelId(modelId));
    } else if (provider === 'codex') {
      setSelectedCodexModel(modelId);
    } else if (provider === 'gemini') {
      applyGeminiModelFromBackend(modelId);
    }
  };

  window.applyBackendTabState = (json: string) => {
    try {
      const state = JSON.parse(json) as Record<string, unknown>;
      const provider = state.provider;
      // Rejecting gemini here would skip __CCGUI_RECOVERY_STATE_APPLIED__,
      // leaving recoveryStatePending true — the persistence save effect then
      // reschedules at 1s intervals forever.
      if (provider !== 'claude' && provider !== 'codex' && provider !== 'gemini') {
        throw new Error('invalid provider');
      }

      // This is Java -> UI recovery state, not a user selection. Update the
      // synchronous ref and React state without emitting set_provider/set_model.
      currentProviderRef.current = provider;
      setCurrentProvider(provider);

      if (typeof state.model === 'string' && state.model.length > 0) {
        if (provider === 'claude') {
          setSelectedClaudeModel(normalizeClaudeModelId(strip1MContextSuffix(state.model)));
          setLongContextEnabled(has1MContextSuffix(state.model));
        } else if (provider === 'gemini') {
          applyGeminiModelFromBackend(state.model);
        } else {
          setSelectedCodexModel(state.model);
        }
      }

      updateMode(state.permissionMode as PermissionMode | undefined, provider);

      // Gemini effort comes from the model slug (applyGeminiModelFromBackend
      // above already synced it); the plain field lacks gemini-only tiers
      // and would clobber the slug-derived value.
      if (provider !== 'gemini' && (REASONING_EFFORTS_SHARED as readonly string[]).includes(state.reasoningEffort as string)) {
        setReasoningEffort(state.reasoningEffort as ReasoningEffort);
      }
      if (state.codexFastMode === 'normal' || state.codexFastMode === 'fast') {
        setCodexFastMode(state.codexFastMode as CodexFastMode);
      }
      window.__CCGUI_RECOVERY_STATE_APPLIED__ = true;
    } catch (error) {
      console.error('[Frontend] Failed to apply backend tab state:', error);
      // The flag means "the recovery payload was processed", not "it was
      // applicable": CLI-provider tabs and corrupt payloads land here, and
      // an unset flag leaves the persistence save effect retrying at 1s
      // intervals forever (recoveryStatePending never clears).
      window.__CCGUI_RECOVERY_STATE_APPLIED__ = true;
    }
  };

  if (typeof window.__pendingBackendTabState === 'string') {
    const pending = window.__pendingBackendTabState;
    delete window.__pendingBackendTabState;
    window.applyBackendTabState(pending);
  }

  window.updateActiveProvider = (jsonStr: string) => {
    try {
      const provider = JSON.parse(jsonStr);
      syncActiveProviderModelMapping(provider);
      setProviderConfigVersion((prev) => prev + 1);
      setActiveProviderConfig(provider);
    } catch (error) {
      console.error('[Frontend] Failed to parse active provider in App:', error);
    }
  };

  window.updateThinkingEnabled = (jsonStr: string) => {
    const trimmed = (jsonStr || '').trim();
    try {
      const data = JSON.parse(trimmed);
      if (typeof data === 'boolean') {
        setClaudeSettingsAlwaysThinkingEnabled(data);
        return;
      }
      if (data && typeof data.enabled === 'boolean') {
        setClaudeSettingsAlwaysThinkingEnabled(data.enabled);
        return;
      }
    } catch {
      if (trimmed === 'true' || trimmed === 'false') {
        setClaudeSettingsAlwaysThinkingEnabled(trimmed === 'true');
      }
    }
  };

  window.updateStreamingEnabled = (jsonStr: string) => {
    try {
      const data = JSON.parse(jsonStr);
      setStreamingEnabledSetting(data.streamingEnabled ?? true);
    } catch (error) {
      console.error('[Frontend] Failed to parse streaming enabled:', error);
    }
  };

  window.updateSendShortcut = (jsonStr: string) => {
    try {
      const data = JSON.parse(jsonStr);
      if (data.sendShortcut === 'enter' || data.sendShortcut === 'cmdEnter') {
        setSendShortcut(data.sendShortcut);
      }
    } catch (error) {
      console.error('[Frontend] Failed to parse send shortcut:', error);
    }
  };

  window.updateAutoOpenFileEnabled = (jsonStr: string) => {
    try {
      const data = JSON.parse(jsonStr);
      setAutoOpenFileEnabled(data.autoOpenFileEnabled ?? false);
    } catch (error) {
      console.error('[Frontend] Failed to parse auto open file enabled:', error);
    }
  };

  window.updatePermissionDialogTimeout = (jsonStr: string) => {
    try {
      const data = JSON.parse(jsonStr);
      setPermissionDialogTimeoutSeconds(clampPermissionDialogTimeoutSeconds(data.permissionDialogTimeoutSeconds));
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error(`[Frontend] Failed to parse permission dialog timeout payload: ${errorName}`);
    }
  };

  // Drain any pending settings that arrived before callback registration
  drainPendingSettings();
  // Kick off initial settings requests
  startInitialSettingsRequest();
}
