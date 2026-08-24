import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AVAILABLE_MODELS,
  normalizeClaudeModelId,
  modelSupports1MContext,
  strip1MContextSuffix,
  toGeminiFamilyId,
} from '../types';
import type { ModelInfo } from '../types';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import Switch from 'antd/es/switch';
import {
  buildModelDropdownSections,
  MAX_VISIBLE_MODEL_OPTIONS,
  PINNED_GROUP_ID,
  readPinnedModelIds,
  shouldShowModelSearch,
  togglePinnedModelId,
} from '../modelSelectUtils';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};
const MODEL_OPTION_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODEL_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const LONG_CONTEXT_OPTION_STYLE: React.CSSProperties = { justifyContent: 'space-between', cursor: 'default' };
const LONG_CONTEXT_LABEL_STYLE: React.CSSProperties = { fontSize: '12px' };
const DROPDOWN_LIST_STYLE: React.CSSProperties = { overflowY: 'auto', flex: 1, minHeight: 0 };
/** Cap model dropdown height so long lists scroll instead of filling the panel. */
const DROPDOWN_MAX_HEIGHT_PX = 300;

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  /** True while CLI providers (OpenCode / Kimi) are still fetching model catalogs. */
  loading?: boolean;
  /** Set when the CLI model catalog fetch failed (or timed out); row offers retry. */
  error?: string | null;
  /** Retries the CLI model catalog fetch for the current provider. */
  onRetry?: () => void;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
}

const LOADING_OPTION_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'default',
};

const DEFAULT_MODEL_MAP: Record<string, ModelInfo> = AVAILABLE_MODELS.reduce(
  (acc, model) => {
    acc[model.id] = model;
    return acc;
  },
  {} as Record<string, ModelInfo>
);

const MODEL_LABEL_KEYS: Record<string, string> = {
  'claude-opus-5': 'models.claude.opus5.label',
  'claude-sonnet-5': 'models.claude.sonnet5.label',
  'claude-sonnet-4-6': 'models.claude.sonnet46.label',
  'claude-fable-5': 'models.claude.fable5.label',
  'claude-opus-4-8': 'models.claude.opus48.label',
  'claude-opus-4-6': 'models.claude.opus46_1m.label',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.label',
  'claude-haiku-4-5': 'models.claude.haiku45.label',
  'gpt-5.6-sol': 'models.codex.gpt56sol.label',
  'gpt-5.6-terra': 'models.codex.gpt56terra.label',
  'gpt-5.6-luna': 'models.codex.gpt56luna.label',
  'gpt-5.5': 'models.codex.gpt55.label',
  'gpt-5.4': 'models.codex.gpt54.label',
  'grok-4.6': 'models.grok.grok46.label',
  'grok-4.5': 'models.grok.grok46.label',
  grok: 'models.grok.grok46.label',
};

const MODEL_DESCRIPTION_KEYS: Record<string, string> = {
  'claude-opus-5': 'models.claude.opus5.description',
  'claude-sonnet-5': 'models.claude.sonnet5.description',
  'claude-sonnet-4-6': 'models.claude.sonnet46.description',
  'claude-fable-5': 'models.claude.fable5.description',
  'claude-opus-4-8': 'models.claude.opus48.description',
  'claude-opus-4-6': 'models.claude.opus46_1m.description',
  'claude-opus-4-6[1m]': 'models.claude.opus46_1m.description',
  'claude-haiku-4-5': 'models.claude.haiku45.description',
  'gpt-5.6-sol': 'models.codex.gpt56sol.description',
  'gpt-5.6-terra': 'models.codex.gpt56terra.description',
  'gpt-5.6-luna': 'models.codex.gpt56luna.description',
  'gpt-5.5': 'models.codex.gpt55.description',
  'gpt-5.4': 'models.codex.gpt54.description',
  'grok-4.6': 'models.grok.grok46.description',
  'grok-4.5': 'models.grok.grok46.description',
  grok: 'models.grok.grok46.description',
};

/**
 * Maps model IDs to mapping keys for looking up actual model names
 * from the 'claude-model-mapping' localStorage entry.
 * Legacy Opus 4.6 IDs share the same opus mapping bucket.
 */
const MODEL_ID_TO_MAPPING_KEY: Record<string, string> = {
  'claude-fable-5': 'fable',
  'claude-opus-5': 'opus',
  'claude-sonnet-5': 'sonnet',
  'claude-sonnet-4-7': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-8': 'opus',
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
export const ModelSelect = ({ value, onChange, models = AVAILABLE_MODELS, currentProvider = 'claude', loading = false, error = null, onRetry, onAddModel, longContextEnabled = true, onLongContextChange }: ModelSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedModelIds(currentProvider));
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, maxHeight, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  // Strip [1m] suffix for finding the model in the list.
  // Gemini: backend may echo full agy slugs (...-high); UI list is family base ids.
  const strippedValue = strip1MContextSuffix(value);
  const normalizedValue = currentProvider === 'claude'
    ? normalizeClaudeModelId(strippedValue)
    : currentProvider === 'gemini'
      ? toGeminiFamilyId(strippedValue) || strippedValue
      : strippedValue;
  // Prefer the user's selection even when the catalog is still loading / only a
  // static fallback is available. Falling back to models[0] made OpenCode (and
  // other dynamic providers) visually snap back to the first entry after leaving
  // history and remounting ChatScreen.
  const currentModel = models.find(m => m.id === normalizedValue)
    || models.find(m => m.id === strippedValue)
    || (strippedValue
      ? { id: strippedValue, label: strippedValue } as ModelInfo
      : models[0]);
  const modelMapping = readClaudeModelMapping();

  useEffect(() => {
    setPinnedIds(readPinnedModelIds(currentProvider));
  }, [currentProvider]);

  const isSelectedModel = (modelId: string): boolean => {
    if (currentProvider === 'gemini') {
      return modelId === normalizedValue || modelId === strippedValue;
    }
    if (currentProvider !== 'claude') {
      return modelId === strippedValue;
    }
    return normalizeClaudeModelId(modelId) === normalizedValue;
  };

  const getModelLabel = (model: ModelInfo, show1MContext = false): string => {
    // The Anthropic slot maps below (MODEL_ID_TO_MAPPING_KEY, DEFAULT_MODEL_MAP,
    // MODEL_LABEL_KEYS) are keyed by claude-* ids. Third-party catalogs (agy, CLI
    // providers) expose models whose ids collide with those slots (e.g.
    // claude-sonnet-4-6). For any non-claude provider, render the catalog label
    // verbatim — never let the Claude model mapping override catalog labels.

    if (currentProvider !== 'claude') {
      return append1MContextSuffix(model.label ?? '', model.id, show1MContext);
    }

    const mappingKey = MODEL_ID_TO_MAPPING_KEY[model.id];
    if (mappingKey) {
      const mappedName = resolveMappedModelName(mappingKey, modelMapping);
      if (mappedName) {
        return append1MContextSuffix(mappedName, model.id, show1MContext);
      }
    }

    const defaultModel = DEFAULT_MODEL_MAP[model.id];
    const labelKey = MODEL_LABEL_KEYS[model.id];
    const hasCustomLabel = defaultModel && model.label && model.label !== defaultModel.label;

    if (hasCustomLabel) {
      return append1MContextSuffix(model.label ?? '', model.id, show1MContext);
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

  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const filteredModels = normalizedSearchQuery
    ? models.filter((model) => {
        const label = getModelLabel(model, false);
        const description = getModelDescription(model) ?? '';
        return [model.id, label, description].some((text) => text.toLowerCase().includes(normalizedSearchQuery));
      })
    : models;

  const { sections, hiddenCount: hiddenModelCount } = buildModelDropdownSections(filteredModels, pinnedIds, {
    visibleLimit: MAX_VISIBLE_MODEL_OPTIONS,
  });
  const visibleModelCount = sections.reduce((n, s) => n + s.models.length, 0);
  const showSearch = shouldShowModelSearch(models.length, searchQuery);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery('');
    }
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Select model
   */
  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
    setSearchQuery('');
  }, [onChange]);

  const handleTogglePin = useCallback((e: React.MouseEvent, modelId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setPinnedIds(togglePinnedModelId(currentProvider, modelId));
  }, [currentProvider]);

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
        setSearchQuery('');
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

  useLayoutEffect(() => {
    if (isOpen) {
      recalculate();
    }
  }, [isOpen, filteredModels.length, pinnedIds.length, loading, recalculate]);

  const renderSectionLabel = (sectionId: string, sectionLabel: string): string => {
    if (sectionId === PINNED_GROUP_ID) {
      return t('models.pinned', { defaultValue: 'Pinned' });
    }
    return sectionLabel;
  };

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
          modelId={resolveModelIdForIcon(currentModel.id, currentProvider === 'claude' ? modelMapping : {}, MODEL_ID_TO_MAPPING_KEY)}
          size={12}
          colored
        />
        <span className="selector-button-text">{getModelLabel(currentModel, true)}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown model-selector-dropdown"
          style={{
            ...DROPDOWN_STYLE,
            ...positionedStyle,
            maxHeight: maxHeight
              ? `${Math.min(DROPDOWN_MAX_HEIGHT_PX, maxHeight)}px`
              : `${DROPDOWN_MAX_HEIGHT_PX}px`,
          }}
        >
          {showSearch && (
            <div className="selector-search-row selector-search-row--sticky">
              <input
                className="selector-search-input"
                data-testid="model-search-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('models.searchPlaceholder', { defaultValue: 'Search models' })}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          )}
          <div className="model-selector-list" style={DROPDOWN_LIST_STYLE}>
            {loading && (
              <div
                className="selector-option selector-option-status"
                data-testid="model-loading"
                style={LOADING_OPTION_STYLE}
              >
                <span className="codicon codicon-loading codicon-modifier-spin" />
                <span>{t('chat.loadingDropdown')}</span>
              </div>
            )}
            {!loading && error && (
              <div
                className="selector-option selector-option-status"
                data-testid="model-load-error"
                style={{ ...LOADING_OPTION_STYLE, cursor: onRetry ? 'pointer' : 'default' }}
                title={error}
                onClick={() => onRetry?.()}
              >
                <span className="codicon codicon-warning" />
                <span style={{ flex: 1, minWidth: 0 }}>{t('chat.modelsLoadFailed')}</span>
                <span className="codicon codicon-refresh" />
              </div>
            )}
            {sections.map((section) => (
              <div key={section.id} className="model-selector-section" data-testid={`model-section-${section.id}`}>
                {section.label !== '' || section.id === PINNED_GROUP_ID ? (
                  <div className="model-selector-group-header" data-testid={`model-group-${section.id}`}>
                    {section.id === PINNED_GROUP_ID && (
                      <span className="codicon codicon-pinned model-selector-group-icon" />
                    )}
                    <span>{renderSectionLabel(section.id, section.label)}</span>
                  </div>
                ) : null}
                {section.models.map((model) => {
                  const isPinned = pinnedSet.has(model.id);
                  return (
                    <div
                      key={model.id}
                      className={`selector-option ${isSelectedModel(model.id) ? 'selected' : ''}`}
                      onClick={() => handleSelect(model.id)}
                      data-testid={`model-option-${model.id}`}
                    >
                      <ProviderModelIcon
                        providerId={currentProvider}
                        modelId={resolveModelIdForIcon(model.id, currentProvider === 'claude' ? modelMapping : {}, MODEL_ID_TO_MAPPING_KEY)}
                        size={16}
                        colored
                      />
                      <div style={MODEL_OPTION_INFO_STYLE}>
                        <span style={MODEL_TEXT_STYLE}>{getModelLabel(model, false)}</span>
                        {getModelDescription(model) && (
                          <span className="model-description" style={MODEL_TEXT_STYLE}>{getModelDescription(model)}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className={`model-pin-button ${isPinned ? 'is-pinned' : ''}`}
                        data-testid={`model-pin-${model.id}`}
                        title={isPinned
                          ? t('models.unpin', { defaultValue: 'Unpin' })
                          : t('models.pin', { defaultValue: 'Pin' })}
                        aria-label={isPinned
                          ? t('models.unpin', { defaultValue: 'Unpin' })
                          : t('models.pin', { defaultValue: 'Pin' })}
                        onClick={(e) => handleTogglePin(e, model.id)}
                      >
                        <span className={`codicon ${isPinned ? 'codicon-pinned' : 'codicon-pin'}`} />
                      </button>
                      {isSelectedModel(model.id) && (
                        <span className="codicon codicon-check check-mark" />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {visibleModelCount === 0 && !loading && (
              <div className="selector-option selector-option-status">
                {t('models.noModelsFound', { defaultValue: 'No models found' })}
              </div>
            )}
            {hiddenModelCount > 0 && (
              <div className="selector-option selector-option-status" data-testid="model-hidden-count">
                {t('models.hiddenModelCount', {
                  count: hiddenModelCount,
                  defaultValue: `+ ${hiddenModelCount} more models. Type to search.`,
                })}
              </div>
            )}
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
                  onClick={() => { onAddModel(); setIsOpen(false); setSearchQuery(''); }}
                >
                  <span className="codicon codicon-add selector-add-icon" />
                  <span>{t('models.addModel')}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelect;
