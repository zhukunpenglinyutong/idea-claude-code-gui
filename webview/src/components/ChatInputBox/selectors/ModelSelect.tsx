import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODELS, normalizeClaudeModelId, modelSupports1MContext, strip1MContextSuffix } from '../types';
import type { ModelInfo } from '../types';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import Switch from 'antd/es/switch';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  marginBottom: '4px',
  zIndex: 10000,
};
const MODEL_OPTION_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1 };
const LONG_CONTEXT_OPTION_STYLE: React.CSSProperties = { justifyContent: 'space-between', cursor: 'default' };
const LONG_CONTEXT_LABEL_STYLE: React.CSSProperties = { fontSize: '12px' };

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
}

const DEFAULT_MODEL_MAP: Record<string, ModelInfo> = AVAILABLE_MODELS.reduce(
  (acc, model) => {
    acc[model.id] = model;
    return acc;
  },
  {} as Record<string, ModelInfo>
);

const MODEL_LABEL_KEYS: Record<string, string> = {
  'claude-sonnet-4-6': 'models.claude.sonnet46.label',
  'claude-fable-5': 'models.claude.fable5.label',
  'claude-opus-4-8': 'models.claude.opus48.label',
  'claude-opus-4-7': 'models.claude.opus46.label',
  'claude-opus-4-6': 'models.claude.opus46_1m.label',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.label',
  'claude-haiku-4-5': 'models.claude.haiku45.label',
  'gpt-5.5': 'models.codex.gpt55.label',
  'gpt-5.4': 'models.codex.gpt54.label',
  'gpt-5.2-codex': 'models.codex.gpt52codex.label',
  'gpt-5.1-codex-max': 'models.codex.gpt51codexMax.label',
  'gpt-5.4-mini': 'models.codex.gpt54mini.label',
  'gpt-5.3-codex': 'models.codex.gpt53codex.label',
  'gpt-5.3-codex-spark': 'models.codex.gpt53codexSpark.label',
  'gpt-5.2': 'models.codex.gpt52.label',
  'gpt-5.1-codex-mini': 'models.codex.gpt51codexMini.label',
};

const MODEL_DESCRIPTION_KEYS: Record<string, string> = {
  'claude-sonnet-4-6': 'models.claude.sonnet46.description',
  'claude-fable-5': 'models.claude.fable5.description',
  'claude-opus-4-8': 'models.claude.opus48.description',
  'claude-opus-4-7': 'models.claude.opus46.description',
  'claude-opus-4-6': 'models.claude.opus46_1m.description',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.description',
  'claude-haiku-4-5': 'models.claude.haiku45.description',
  'gpt-5.5': 'models.codex.gpt55.description',
  'gpt-5.4': 'models.codex.gpt54.description',
  'gpt-5.2-codex': 'models.codex.gpt52codex.description',
  'gpt-5.1-codex-max': 'models.codex.gpt51codexMax.description',
  'gpt-5.4-mini': 'models.codex.gpt54mini.description',
  'gpt-5.3-codex': 'models.codex.gpt53codex.description',
  'gpt-5.3-codex-spark': 'models.codex.gpt53codexSpark.description',
  'gpt-5.2': 'models.codex.gpt52.description',
  'gpt-5.1-codex-mini': 'models.codex.gpt51codexMini.description',
};

/**
 * Maps model IDs to mapping keys for looking up actual model names
 * from the 'claude-model-mapping' localStorage entry.
 * Legacy Opus 4.6 IDs share the same opus mapping bucket.
 */
const MODEL_ID_TO_MAPPING_KEY: Record<string, string> = {
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-8': 'opus',
  'claude-opus-4-7': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-6[1m]': 'opus',
  'claude-haiku-4-5': 'haiku',
};

const resolveMappedModelName = (
  mappingKey: string | undefined,
  modelMapping: Record<string, string | undefined>
): string | undefined => {
  if (!mappingKey) {
    return modelMapping.main?.trim() || undefined;
  }

  const mapped = modelMapping[mappingKey]
    || (mappingKey === 'opus_1m' ? modelMapping.opus : undefined)
    || modelMapping.main;

  return mapped?.trim() || undefined;
};

/**
 * Resolve the display model name for icon matching.
 * For mapped Claude models, returns the mapped name; otherwise the original ID.
 */
const resolveModelIdForIcon = (
  modelId: string,
  modelMapping: Record<string, string | undefined>,
  mappingKeyMap: Record<string, string>
): string => {
  const mappingKey = mappingKeyMap[modelId];
  if (!mappingKey) {
    return modelId;
  }
  const mapped = resolveMappedModelName(mappingKey, modelMapping);
  if (mapped) {
    return mapped;
  }
  return modelId;
};

/**
 * ModelSelect - Model selector component
 * Supports switching between Sonnet 4.5, Opus 4.5, and other models, including Codex models
 */
export const ModelSelect = ({ value, onChange, models = AVAILABLE_MODELS, currentProvider = 'claude', onAddModel, longContextEnabled = true, onLongContextChange }: ModelSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Strip [1m] suffix for finding the model in the list
  const strippedValue = strip1MContextSuffix(value);
  const normalizedValue = currentProvider === 'claude' ? normalizeClaudeModelId(strippedValue) : strippedValue;
  const currentModel = models.find(m => m.id === normalizedValue) || models.find(m => m.id === strippedValue) || models[0];
  const modelMapping = readClaudeModelMapping();

  const isSelectedModel = (modelId: string): boolean => {
    if (currentProvider !== 'claude') {
      return modelId === strippedValue;
    }
    return normalizeClaudeModelId(modelId) === normalizedValue;
  };

  const getModelLabel = (model: ModelInfo, show1MContext = false): string => {
    const mappingKey = MODEL_ID_TO_MAPPING_KEY[model.id];
    if (mappingKey) {
      const mappedName = resolveMappedModelName(mappingKey, modelMapping);
      if (mappedName) {
        const mappedLabelKey = MODEL_LABEL_KEYS[mappedName];
        if (!mappedLabelKey) {
          // Not a known Claude model (e.g. a custom model like "glm-4.7") — show as-is
          return append1MContextSuffix(mappedName, model.id, show1MContext);
        }
        if (normalizeClaudeModelId(mappedName) === normalizeClaudeModelId(model.id)) {
          // Same model — show its proper display name
          return append1MContextSuffix(t(mappedLabelKey), model.id, show1MContext);
        }
        // Different Claude model bled in via main fallback — ignore and fall through
      }
    }

    const defaultModel = DEFAULT_MODEL_MAP[model.id];
    const labelKey = MODEL_LABEL_KEYS[model.id];
    const hasCustomLabel = defaultModel && model.label && model.label !== defaultModel.label;

    if (hasCustomLabel) {
      const customLabelKey = MODEL_LABEL_KEYS[model.label ?? ''];
      if (!customLabelKey) {
        return append1MContextSuffix(model.label ?? '', model.id, show1MContext);
      }
      if (normalizeClaudeModelId(model.label ?? '') === normalizeClaudeModelId(model.id)) {
        return append1MContextSuffix(t(customLabelKey), model.id, show1MContext);
      }
      // Different Claude model ID set as label — fall through to own label
    }

    if (labelKey) {
      return append1MContextSuffix(t(labelKey), model.id, show1MContext);
    }

    return append1MContextSuffix(model.label ?? '', model.id, show1MContext);
  };

  const append1MContextSuffix = (label: string, modelId: string, show1MContext: boolean): string => {
    // Only show 1M context suffix for Claude provider
    if (currentProvider === 'claude' && show1MContext && modelSupports1MContext(modelId) && longContextEnabled) {
      return `${label} (${t('models.longContext.shortLabel')})`;
    }
    return label;
  };

  const getModelDescription = (model: ModelInfo): string | undefined => {
    const descriptionKey = MODEL_DESCRIPTION_KEYS[model.id];
    if (descriptionKey) {
      return t(descriptionKey);
    }
    return model.description;
  };

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  }, [isOpen]);

  /**
   * Select model
   */
  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
  }, [onChange]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={t('chat.currentModel', { model: getModelLabel(currentModel, true) })}
      >
        <ProviderModelIcon
          providerId={currentProvider}
          modelId={resolveModelIdForIcon(currentModel.id, modelMapping, MODEL_ID_TO_MAPPING_KEY)}
          size={12}
          colored
        />
        <span className="selector-button-text">{getModelLabel(currentModel, true)}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={DROPDOWN_STYLE}
        >
          {models.map((model) => (
            <div
              key={model.id}
              className={`selector-option ${isSelectedModel(model.id) ? 'selected' : ''}`}
              onClick={() => handleSelect(model.id)}
            >
              <ProviderModelIcon
                providerId={currentProvider}
                modelId={resolveModelIdForIcon(model.id, modelMapping, MODEL_ID_TO_MAPPING_KEY)}
                size={16}
                colored
              />
              <div style={MODEL_OPTION_INFO_STYLE}>
                <span>{getModelLabel(model, false)}</span>
                {getModelDescription(model) && (
                  <span className="model-description">{getModelDescription(model)}</span>
                )}
              </div>
              {isSelectedModel(model.id) && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
          {currentProvider === 'claude' && onLongContextChange && (
            <>
              <div className="selector-divider" />
              <div
                className="selector-option"
                style={LONG_CONTEXT_OPTION_STYLE}
                onClick={(e) => e.stopPropagation()}
              >
                <span style={LONG_CONTEXT_LABEL_STYLE}>{t('models.longContext.shortLabel')}</span>
                <Switch
                  size="small"
                  checked={modelSupports1MContext(value) ? longContextEnabled : false}
                  disabled={!modelSupports1MContext(value)}
                  onChange={onLongContextChange}
                />
              </div>
            </>
          )}
          {onAddModel && (
            <>
              <div className="selector-divider" />
              <div
                className="selector-option selector-option-add"
                onClick={() => { onAddModel(); setIsOpen(false); }}
              >
                <span className="codicon codicon-add selector-add-icon" />
                <span>{t('models.addModel')}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelSelect;
