import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ButtonAreaProps, CodexFastMode, ModelInfo, PermissionMode, ReasoningEffort } from './types';
import { DEFAULT_CLAUDE_MODEL_ID } from './types';
import { ConfigSelect, ModeSelect, ModelConfigSelect, ProviderSelect } from './selectors';
import { STORAGE_KEYS, validateCodexCustomModels } from '../../types/provider';
import type { CodexCustomModel } from '../../types/provider';
import { readClaudeModelMapping } from '../../utils/claudeModelMapping';
import { useCliModels, useOmpRoles } from '../../hooks/providers/useCliModels';
import { useToolbarSelectorCompact } from './hooks/useToolbarSelectorCompact';
import { resolveProviderModels } from './resolveProviderModels';

/**
 * Get custom Codex model list from localStorage
 * Uses runtime type validation for data safety
 */
function getCustomCodexModels(): ModelInfo[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    // Use runtime type validation
    const validModels = validateCodexCustomModels(parsed);
    return validModels.map(m => ({
      id: m.id,
      label: m.label || m.id,
      description: m.description,
    }));
  } catch {
    return [];
  }
}

/**
 * Get custom Claude model list from localStorage
 * Uses runtime type validation for data safety
 */
function getCustomClaudeModels(): ModelInfo[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored) as CodexCustomModel[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((m): m is CodexCustomModel => !!m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim().length > 0)
      .map(m => ({
        id: m.id,
        label: m.label || m.id,
        description: m.description,
      }));
  } catch {
    return [];
  }
}

/**
 * ButtonArea - Bottom toolbar component
 * Contains mode selector, model selector, attachment button, prompt enhancer button, send/stop button
 */
export const ButtonArea = ({
  disabled = false,
  hasInputContent = false,
  isLoading = false,
  isEnhancing = false,
  selectedModel = DEFAULT_CLAUDE_MODEL_ID,
  permissionMode = 'default',
  currentProvider = 'claude',
  reasoningEffort = 'high',
  dshPreset = '',
  codexFastMode = 'normal',
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  onReasoningChange,
  onCodexFastModeChange,
  onDshPresetChange,
  onEnhancePrompt,
  alwaysThinkingEnabled = false,
  onToggleThinking,
  streamingEnabled = true,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
  onAddModel,
  onOpenCliSettings,
  longContextEnabled = true,
  onLongContextChange,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  // const fileInputRef = useRef<HTMLInputElement>(null);
  const { cliModels, cliModelsLoading, cliModelsError, cliDefaultModel, cliCatalogHasEntries, refreshCliModels } = useCliModels(currentProvider);
  // Dynamic omp roles (static smol/slow/plan fallback until loaded).
  const ompRoles = useOmpRoles();

  // Track changes to custom models in localStorage
  // When localStorage changes, updating this version number triggers useMemo recalculation
  const [customModelsVersion, setCustomModelsVersion] = useState(0);

  // Listen for localStorage changes (cross-tab sync + same-tab custom events)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.CODEX_CUSTOM_MODELS || e.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING || e.key === STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) {
        setCustomModelsVersion(v => v + 1);
      }
    };

    // Listen for custom events (localStorage changes within the same tab)
    const handleCustomStorageChange = (e: CustomEvent<{ key: string }>) => {
      if (e.detail.key === STORAGE_KEYS.CODEX_CUSTOM_MODELS || e.detail.key === STORAGE_KEYS.CLAUDE_MODEL_MAPPING || e.detail.key === STORAGE_KEYS.CLAUDE_CUSTOM_MODELS) {
        setCustomModelsVersion(v => v + 1);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageChange', handleCustomStorageChange as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageChange', handleCustomStorageChange as EventListener);
    };
  }, []);

  // Select model list based on current provider — shared with Prompt Enhancer /
  // Commit AI settings so the three surfaces never diverge.
  // customModelsVersion triggers recalculation when localStorage changes.
  const availableModels = useMemo(() => {
    let claudeMapping = null;
    try {
      claudeMapping = readClaudeModelMapping();
    } catch {
      claudeMapping = null;
    }
    return resolveProviderModels({
      provider: currentProvider,
      cliModels,
      cliCatalogHasEntries,
      claudeCustomModels: getCustomClaudeModels(),
      codexCustomModels: getCustomCodexModels(),
      claudeMapping,
    });
    // customModelsVersion intentionally forces re-read of localStorage customs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider, customModelsVersion, cliModels, cliCatalogHasEntries]);

  // When a dynamic model catalog arrives, ensure selection is a real entry.
  useEffect(() => {
    const isDynamicProvider = currentProvider === 'kimi' || currentProvider === 'opencode'
      || currentProvider === 'pi' || currentProvider === 'codex'
      || currentProvider === 'grok' || currentProvider === 'omp'
      || currentProvider === 'dsh' || currentProvider === 'mimo';
    if (!isDynamicProvider) return;
    // Only correct once a *real* catalog arrived. Static fallback lists
    // (OPENCODE_MODELS = just "opencode-default", CODEX built-ins, …) must not
    // clobber the user's choice — especially when ChatScreen remounts after
    // leaving history and briefly shows the fallback before the cache/fetch
    // lands.
    if (!cliCatalogHasEntries) return;
    if (cliModelsLoading) return;
    if (!availableModels.length || !onModelSelect) return;
    // OMP roles are not in the model list (they live in ModeSelect), so an
    // active role must count as a valid selection — otherwise picking
    // 'smol' in the mode selector would be clobbered back to the default
    // the moment a catalog arrives.
    const exists = availableModels.some((model) => model.id === selectedModel)
      || (currentProvider === 'omp' && ompRoles.some((role) => role.id === selectedModel));
    if (!exists) {
      // The static default (e.g. 'auto') may itself be absent from the real
      // catalog — MiMo's free 'mimo/mimo-auto' is not listed once the free
      // tier ends. Land on the default only when it is a real catalog entry,
      // otherwise fall back to the first entry so the user never sends with a
      // model id the CLI will reject.
      const fallback = cliDefaultModel != null
        && availableModels.some((model) => model.id === cliDefaultModel)
        ? cliDefaultModel
        : availableModels[0].id;
      onModelSelect(fallback);
    }
  }, [
    availableModels,
    currentProvider,
    onModelSelect,
    selectedModel,
    cliDefaultModel,
    cliCatalogHasEntries,
    cliModelsLoading,
    ompRoles,
  ]);

  /**
   * Handle submit button click
   */
  const handleSubmitClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSubmit?.();
  }, [onSubmit]);

  /**
   * Handle stop button click
   */
  const handleStopClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStop?.();
  }, [onStop]);

  /**
   * Handle mode selection
   */
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    onModeSelect?.(mode);
  }, [onModeSelect]);

  /**
   * Handle model selection
   */
  const handleModelSelect = useCallback((modelId: string) => {
    onModelSelect?.(modelId);
  }, [onModelSelect]);

  /**
   * Handle provider selection
   */
  const handleProviderSelect = useCallback((providerId: string) => {
    onProviderSelect?.(providerId);
  }, [onProviderSelect]);

  /**
   * Handle reasoning depth selection
   */
  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    onReasoningChange?.(effort);
  }, [onReasoningChange]);

  /**
   * Handle Codex speed mode selection
   */
  const handleCodexFastModeChange = useCallback((mode: CodexFastMode) => {
    onCodexFastModeChange?.(mode);
  }, [onCodexFastModeChange]);

  const handleDshPresetChange = useCallback((preset: string) => {
    onDshPresetChange?.(preset);
  }, [onDshPresetChange]);

  /**
   * Handle enhance prompt button click
   */
  const handleEnhanceClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEnhancePrompt?.();
  }, [onEnhancePrompt]);

  // Collapse selector labels for every CLI when left cluster is about to hit the send cluster (10px).
  const buttonAreaRef = useRef<HTMLDivElement>(null);
  const buttonAreaLeftRef = useRef<HTMLDivElement>(null);
  const buttonAreaRightRef = useRef<HTMLDivElement>(null);
  const selectorContentKey = [
    currentProvider,
    selectedModel,
    permissionMode,
    reasoningEffort,
    codexFastMode,
    dshPreset,
    selectedAgent?.id ?? '',
    cliModelsLoading ? 'loading' : 'ready',
  ].join('|');
  const selectorsCompact = useToolbarSelectorCompact(
    buttonAreaRef,
    buttonAreaLeftRef,
    buttonAreaRightRef,
    selectorContentKey,
  );

  return (
    <div
      ref={buttonAreaRef}
      className={`button-area${selectorsCompact ? ' button-area--compact' : ''}`}
      data-provider={currentProvider}
    >
      {/* Left side: selectors */}
      <div ref={buttonAreaLeftRef} className="button-area-left">
        <ConfigSelect
          alwaysThinkingEnabled={alwaysThinkingEnabled}
          onToggleThinking={onToggleThinking}
          streamingEnabled={streamingEnabled}
          onStreamingEnabledChange={onStreamingEnabledChange}
          selectedAgent={selectedAgent}
          onAgentSelect={onAgentSelect}
          onOpenAgentSettings={onOpenAgentSettings}
          currentProvider={currentProvider}
        />
        <ProviderSelect
          value={currentProvider}
          onChange={handleProviderSelect}
          onOpenCliSettings={onOpenCliSettings}
          compact
        />
        <ModeSelect value={permissionMode} onChange={handleModeSelect} provider={currentProvider} />
        <ModelConfigSelect
          selectedModel={selectedModel}
          onModelSelect={handleModelSelect}
          models={availableModels}
          currentProvider={currentProvider}
          loading={cliModelsLoading}
          error={cliModelsError}
          onRetry={() => refreshCliModels(currentProvider)}
          onAddModel={onAddModel}
          longContextEnabled={longContextEnabled}
          onLongContextChange={onLongContextChange}
          reasoningEffort={reasoningEffort}
          onReasoningChange={handleReasoningChange}
          codexFastMode={codexFastMode}
          onCodexFastModeChange={handleCodexFastModeChange}
          dshPreset={dshPreset}
          onDshPresetChange={handleDshPresetChange}
        />
      </div>

      {/* Right side: tool buttons */}
      <div ref={buttonAreaRightRef} className="button-area-right">
        <div className="button-divider" />

        {/* Enhance prompt button */}
        <button
          className="enhance-prompt-button has-tooltip"
          onClick={handleEnhanceClick}
          disabled={disabled || !hasInputContent || isLoading || isEnhancing}
          data-tooltip={`${t('promptEnhancer.tooltip')} (${t('promptEnhancer.shortcut')})`}
        >
          <span className={`codicon ${isEnhancing ? 'codicon-loading codicon-modifier-spin' : 'codicon-sparkle'}`} />
        </button>

        {/* Send/Stop button */}
        {isLoading ? (
          <button
            className="submit-button stop-button"
            onClick={handleStopClick}
            title={t('chat.stopGeneration')}
          >
            <span className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button
            className="submit-button"
            onClick={handleSubmitClick}
            disabled={disabled || !hasInputContent}
            title={t('chat.sendMessageEnter')}
          >
            <span className="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
};

export default ButtonArea;
