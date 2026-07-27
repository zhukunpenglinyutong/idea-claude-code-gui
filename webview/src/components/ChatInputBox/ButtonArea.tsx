import { useCallback, useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ButtonAreaProps, CodexFastMode, ModelInfo, PermissionMode, ReasoningEffort } from './types';
import { CodexFastModeSelect, ConfigSelect, ModelSelect, ModeSelect, ProviderSelect, ReasoningSelect } from './selectors';
import { CLAUDE_MODELS, CODEX_MODELS } from './types';
import { STORAGE_KEYS, validateCodexCustomModels } from '../../types/provider';
import type { CodexCustomModel } from '../../types/provider';
import { readClaudeModelMapping } from '../../utils/claudeModelMapping';

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
  selectedModel = 'claude-sonnet-4-6',
  permissionMode = 'default',
  currentProvider = 'claude',
  reasoningEffort = 'high',
  codexFastMode = 'normal',
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  onReasoningChange,
  onCodexFastModeChange,
  onEnhancePrompt,
  alwaysThinkingEnabled = false,
  onToggleThinking,
  streamingEnabled = true,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
  onAddModel,
  longContextEnabled = true,
  onLongContextChange,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  // const fileInputRef = useRef<HTMLInputElement>(null);

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

  /**
   * Apply model name mapping
   * Maps base model IDs to actual model names (e.g., versions with capacity suffixes)
   */
  const applyModelMapping = useCallback((model: ModelInfo, mapping: { main?: string; haiku?: string; sonnet?: string; opus?: string }): ModelInfo => {
    const modelKeyMap: Record<string, keyof typeof mapping> = {
      'claude-sonnet-5': 'sonnet',
      'claude-sonnet-4-6': 'sonnet',
      'claude-opus-5': 'opus',
      'claude-opus-4-8': 'opus',
      'claude-haiku-4-5': 'haiku',
    };

    const key = modelKeyMap[model.id];
    const resolvedMapping = (key ? mapping[key] : undefined) || mapping.main;
    if (resolvedMapping) {
      const actualModel = String(resolvedMapping).trim();
      if (actualModel.length > 0) {
        // Keep the original id as unique identifier, only modify label to custom name
        // This ensures id remains unique even if multiple models share the same displayName
        return { ...model, label: actualModel };
      }
    }
    return model;
  }, []);

  // Select model list based on current provider
  // customModelsVersion triggers recalculation when localStorage changes
  const availableModels = useMemo(() => {
    if (currentProvider === 'codex') {
      // Merge built-in models and custom models
      const customModels = getCustomCodexModels();
      if (customModels.length === 0) {
        return CODEX_MODELS;
      }
      // Custom models first, built-in models after
      // Filter out built-in models that duplicate custom models
      const customIds = new Set(customModels.map(m => m.id));
      const filteredBuiltIn = CODEX_MODELS.filter(m => !customIds.has(m.id));
      return [...customModels, ...filteredBuiltIn];
    }
    if (typeof window === 'undefined' || !window.localStorage) {
      return CLAUDE_MODELS;
    }

    // Apply model mapping to built-in models
    let builtInModels = CLAUDE_MODELS;
    try {
      const mapping = readClaudeModelMapping();
      if (Object.keys(mapping).length > 0) {
        builtInModels = CLAUDE_MODELS.map((m) => applyModelMapping(m, mapping));
      }
    } catch {
      // ignore
    }

    // Merge custom models (displayed before built-in models)
    const customModels = getCustomClaudeModels();
    if (customModels.length === 0) {
      return builtInModels;
    }
    // Filter out built-in models that duplicate custom models
    const customIds = new Set(customModels.map(m => m.id));
    const filteredBuiltIn = builtInModels.filter(m => !customIds.has(m.id));
    return [...customModels, ...filteredBuiltIn];
  }, [currentProvider, applyModelMapping, customModelsVersion]);

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

  /**
   * Handle enhance prompt button click
   */
  const handleEnhanceClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEnhancePrompt?.();
  }, [onEnhancePrompt]);

  return (
    <div className="button-area" data-provider={currentProvider}>
      {/* Left side: selectors */}
      <div className="button-area-left">
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
          compact
        />
        <ModeSelect value={permissionMode} onChange={handleModeSelect} provider={currentProvider} />
        <ModelSelect value={selectedModel} onChange={handleModelSelect} models={availableModels} currentProvider={currentProvider} onAddModel={onAddModel} longContextEnabled={longContextEnabled} onLongContextChange={onLongContextChange} />
        <ReasoningSelect value={reasoningEffort} onChange={handleReasoningChange} selectedModel={selectedModel} currentProvider={currentProvider} />
        {currentProvider === 'codex' && (
          <CodexFastModeSelect value={codexFastMode} onChange={handleCodexFastModeChange} />
        )}
      </div>

      {/* Right side: tool buttons */}
      <div className="button-area-right">
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
