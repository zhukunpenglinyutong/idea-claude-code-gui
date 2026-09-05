import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexCustomModel, ModelPricing } from '../../../types/provider';
// Model ID format is intentionally not restricted — see isValidModelId() JSDoc for rationale
import styles from './style.module.less';

const DIALOG_STYLE: React.CSSProperties = { maxWidth: '640px' };
const FLEX_1_STYLE: React.CSSProperties = { flex: 1 };
const DESC_INPUT_STYLE: React.CSSProperties = { width: '100%', marginBottom: '8px' };
const ADD_ICON_STYLE: React.CSSProperties = { marginRight: '4px' };
const CONTEXT_WINDOW_TOKENS_PER_K = 1_000;
const MAX_CONTEXT_WINDOW_TOKENS = 2_147_483_647;
const MAX_CONTEXT_WINDOW_K = Math.floor(MAX_CONTEXT_WINDOW_TOKENS / CONTEXT_WINDOW_TOKENS_PER_K);
const CODEBUDDY_MODEL_TOKEN_MAX = 2_147_483_647;

type PricingFieldKey = keyof ModelPricing;

interface PricingFieldConfig {
  key: PricingFieldKey;
  labelKey: string;
  shortLabelKey: string;
  placeholder: string;
}

const PRICING_FIELDS: PricingFieldConfig[] = [
  {
    key: 'inputCostPer1M',
    labelKey: 'settings.pluginModels.pricing.inputLabel',
    shortLabelKey: 'settings.pluginModels.pricing.inputShort',
    placeholder: '3.00',
  },
  {
    key: 'outputCostPer1M',
    labelKey: 'settings.pluginModels.pricing.outputLabel',
    shortLabelKey: 'settings.pluginModels.pricing.outputShort',
    placeholder: '15.00',
  },
  {
    key: 'cacheWriteCostPer1M',
    labelKey: 'settings.pluginModels.pricing.cacheWriteLabel',
    shortLabelKey: 'settings.pluginModels.pricing.cacheWriteShort',
    placeholder: '3.75',
  },
  {
    key: 'cacheReadCostPer1M',
    labelKey: 'settings.pluginModels.pricing.cacheReadLabel',
    shortLabelKey: 'settings.pluginModels.pricing.cacheReadShort',
    placeholder: '0.30',
  },
];

const EMPTY_PRICING_INPUTS: Record<PricingFieldKey, string> = {
  inputCostPer1M: '',
  outputCostPer1M: '',
  cacheWriteCostPer1M: '',
  cacheReadCostPer1M: '',
};

interface CustomModelDialogProps {
  isOpen: boolean;
  models: CodexCustomModel[];
  onModelsChange: (models: CodexCustomModel[]) => void;
  /** Models from Claude provider/settings mappings. They are already selectable; only pricing is editable here. */
  configuredModels?: CodexCustomModel[];
  onConfiguredModelPricingChange?: (modelId: string, pricing?: ModelPricing) => void;
  onClose: () => void;
  /** Enables Codex-only context-window metadata editing. */
  contextWindowEnabled?: boolean;
  /** Enables CodeBuddy models.json LanguageModel fields. */
  codeBuddyConfigEnabled?: boolean;
  /** If provided, opens in add-model mode directly */
  initialAddMode?: boolean;
}

/**
 * Sanitize user input by stripping control characters and collapsing whitespace.
 * React JSX auto-escapes HTML entities, but this provides defense-in-depth
 * for values persisted to localStorage which may be consumed by non-React code.
 */
function sanitizeInput(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ');
}

function parsePricingInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return Number(trimmed);
}

function isInvalidPricingValue(value: string): boolean {
  const parsed = parsePricingInput(value);
  return parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0);
}

function parseContextWindowKInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const contextWindowK = Number(trimmed);
  return Number.isSafeInteger(contextWindowK)
    ? contextWindowK * CONTEXT_WINDOW_TOKENS_PER_K
    : undefined;
}

function isInvalidContextWindowValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const contextWindowK = Number(trimmed);
  return !Number.isSafeInteger(contextWindowK)
    || contextWindowK < 1
    || contextWindowK > MAX_CONTEXT_WINDOW_K;
}

function hasPricing(pricing?: ModelPricing): boolean {
  return !!pricing && PRICING_FIELDS.some(({ key }) => pricing[key] !== undefined);
}

function formatPricingValue(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function buildPricing(inputs: Record<PricingFieldKey, string>): ModelPricing | undefined {
  const pricing = PRICING_FIELDS.reduce<ModelPricing>((acc, { key }) => {
    const parsed = parsePricingInput(inputs[key]);
    if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) {
      return acc;
    }
    return {
      ...acc,
      [key]: parsed,
    };
  }, {});

  return hasPricing(pricing) ? pricing : undefined;
}

function parseOptionalInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= CODEBUDDY_MODEL_TOKEN_MAX
    ? parsed
    : undefined;
}

/**
 * Custom Model Management Dialog
 * Full CRUD for plugin-level custom models in a modal dialog
 */
export function CustomModelDialog({
  isOpen,
  models,
  onModelsChange,
  configuredModels = [],
  onConfiguredModelPricingChange,
  onClose,
  contextWindowEnabled = false,
  codeBuddyConfigEnabled = false,
  initialAddMode = false,
}: CustomModelDialogProps) {
  const { t } = useTranslation();

  // Form state
  const [isAdding, setIsAdding] = useState(false);
  const [editingModel, setEditingModel] = useState<CodexCustomModel | null>(null);
  const [editingConfiguredModel, setEditingConfiguredModel] = useState<CodexCustomModel | null>(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelLabel, setNewModelLabel] = useState('');
  const [newModelDesc, setNewModelDesc] = useState('');
  const [newVendor, setNewVendor] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newMaxInputTokens, setNewMaxInputTokens] = useState('');
  const [newMaxOutputTokens, setNewMaxOutputTokens] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newSupportsToolCall, setNewSupportsToolCall] = useState(false);
  const [newSupportsImages, setNewSupportsImages] = useState(false);
  const [newSupportsReasoning, setNewSupportsReasoning] = useState(false);
  const [newContextWindowK, setNewContextWindowK] = useState('');
  const [newPricingInputs, setNewPricingInputs] = useState<Record<PricingFieldKey, string>>({ ...EMPTY_PRICING_INPUTS });
  const [modelIdError, setModelIdError] = useState<string | null>(null);
  const [contextWindowError, setContextWindowError] = useState<string | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [codeBuddyConfigError, setCodeBuddyConfigError] = useState<string | null>(null);
  // Pricing is optional — collapsed by default to keep the form lightweight.
  const [pricingCollapsed, setPricingCollapsed] = useState(true);

  const resetForm = useCallback(() => {
    setIsAdding(false);
    setEditingModel(null);
    setEditingConfiguredModel(null);
    setNewModelId('');
    setNewModelLabel('');
    setNewModelDesc('');
    setNewVendor('');
    setNewApiKey('');
    setNewMaxInputTokens('');
    setNewMaxOutputTokens('');
    setNewUrl('');
    setNewSupportsToolCall(false);
    setNewSupportsImages(false);
    setNewSupportsReasoning(false);
    setNewContextWindowK('');
    setNewPricingInputs({ ...EMPTY_PRICING_INPUTS });
    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
    setCodeBuddyConfigError(null);
    setPricingCollapsed(true);
  }, []);

  // Auto-open add form when initialAddMode is true
  useEffect(() => {
    if (isOpen && initialAddMode) {
      resetForm();
      setIsAdding(true);
    }
  }, [isOpen, initialAddMode, resetForm]);

  // Reset form state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  // ESC key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // A pricing validation error only surfaces on submit — make sure the
  // collapsed section expands so the user can see what went wrong.
  useEffect(() => {
    if (pricingError) {
      setPricingCollapsed(false);
    }
  }, [pricingError]);

  const validateModelId = useCallback((id: string): string | null => {
    const trimmedId = sanitizeInput(id).trim();
    if (!trimmedId || trimmedId.length > 256) {
      return t('settings.codexProvider.dialog.modelIdRequired') || 'Model ID is required';
    }
    const isDuplicate = models.some(m =>
      m.id === trimmedId && (!editingModel || m.id !== editingModel.id)
    );
    if (isDuplicate) {
      return t('settings.codexProvider.dialog.modelIdDuplicate') || 'Model ID already exists';
    }
    return null;
  }, [models, editingModel, t]);

  const validatePricingInputs = useCallback((): string | null => {
    const hasInvalidPrice = PRICING_FIELDS.some(({ key }) => isInvalidPricingValue(newPricingInputs[key]));
    if (!hasInvalidPrice) {
      return null;
    }
    return t('settings.pluginModels.pricing.invalidValue', {
      defaultValue: 'Pricing must be a non-negative number',
    });
  }, [newPricingInputs, t]);

  const validateContextWindowInput = useCallback((): string | null => {
    if (!isInvalidContextWindowValue(newContextWindowK)) {
      return null;
    }
    return t('settings.pluginModels.contextWindow.invalidValue', {
      defaultValue: 'Maximum context must be a positive integer in K units',
    });
  }, [newContextWindowK, t]);

  const validateCodeBuddyConfig = useCallback((): string | null => {
    if (!codeBuddyConfigEnabled) return null;
    const invalidInteger = [newMaxInputTokens, newMaxOutputTokens].some((value) =>
      value.trim() !== '' && parseOptionalInteger(value) === undefined);
    if (invalidInteger) {
      return t('settings.codebuddyProvider.invalidModelConfig', {
        defaultValue: 'Check token limits.',
      });
    }
    return null;
  }, [codeBuddyConfigEnabled, newMaxInputTokens, newMaxOutputTokens, t]);

  const buildModelFromForm = useCallback((): CodexCustomModel => {
    const sanitizedId = sanitizeInput(newModelId).trim();
    const sanitizedLabel = sanitizeInput(newModelLabel).trim();
    const sanitizedDescription = sanitizeInput(newModelDesc).trim();
    const contextWindowTokens = parseContextWindowKInput(newContextWindowK);
    const pricing = buildPricing(newPricingInputs);
    const model: CodexCustomModel = {
      id: sanitizedId,
      label: sanitizedLabel || sanitizedId,
      description: sanitizedDescription || undefined,
    };

    if (codeBuddyConfigEnabled) {
      const maxInputTokens = parseOptionalInteger(newMaxInputTokens);
      const maxOutputTokens = parseOptionalInteger(newMaxOutputTokens);
      Object.assign(model, {
        vendor: newVendor.trim() || undefined,
        apiKey: newApiKey.trim() || undefined,
        maxInputTokens,
        maxOutputTokens,
        url: newUrl.trim() || undefined,
        supportsToolCall: newSupportsToolCall,
        supportsImages: newSupportsImages,
        supportsReasoning: newSupportsReasoning,
      });
    }

    if (contextWindowEnabled && contextWindowTokens !== undefined) {
      model.contextWindowTokens = contextWindowTokens;
    }

    return pricing ? { ...model, pricing } : model;
  }, [codeBuddyConfigEnabled, contextWindowEnabled, newApiKey, newContextWindowK, newMaxInputTokens, newMaxOutputTokens, newModelDesc, newModelId, newModelLabel, newPricingInputs, newSupportsImages, newSupportsReasoning, newSupportsToolCall, newUrl, newVendor]);

  const validateForm = useCallback((): boolean => {
    if (editingConfiguredModel) {
      const priceError = validatePricingInputs();
      if (priceError) {
        setModelIdError(null);
        setContextWindowError(null);
        setPricingError(priceError);
        setCodeBuddyConfigError(null);
        return false;
      }
      setModelIdError(null);
      setContextWindowError(null);
      setPricingError(null);
      setCodeBuddyConfigError(null);
      return true;
    }

    const idError = validateModelId(newModelId);
    if (idError) {
      setModelIdError(idError);
      setContextWindowError(null);
      setPricingError(null);
      setCodeBuddyConfigError(null);
      return false;
    }

    const contextError = contextWindowEnabled ? validateContextWindowInput() : null;
    if (contextError) {
      setModelIdError(null);
      setContextWindowError(contextError);
      setPricingError(null);
      setCodeBuddyConfigError(null);
      return false;
    }

    const codeBuddyError = validateCodeBuddyConfig();
    if (codeBuddyError) {
      setModelIdError(null);
      setContextWindowError(null);
      setPricingError(null);
      setCodeBuddyConfigError(codeBuddyError);
      return false;
    }

    const priceError = validatePricingInputs();
    if (priceError) {
      setModelIdError(null);
      setContextWindowError(null);
      setPricingError(priceError);
      setCodeBuddyConfigError(null);
      return false;
    }

    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
    setCodeBuddyConfigError(null);
    return true;
  }, [contextWindowEnabled, editingConfiguredModel, newModelId, validateCodeBuddyConfig, validateContextWindowInput, validateModelId, validatePricingInputs]);

  const handleAddModel = useCallback(() => {
    if (!validateForm()) {
      return;
    }

    onModelsChange([...models, buildModelFromForm()]);
    resetForm();
  }, [models, onModelsChange, buildModelFromForm, resetForm, validateForm]);

  const handleSaveEdit = useCallback(() => {
    if (!editingModel || !validateForm()) return;

    // Preserve the original scope when renaming: buildModelFromForm() produces a
    // fresh object without __ccguiScope, so without copying it here a renamed
    // project-scope model would fall back to 'user' in useCodeBuddyModelsConfig.
    const updatedModel = {
      ...buildModelFromForm(),
      __ccguiScope: editingModel.__ccguiScope,
    };
    const updatedModels = models.map(m => (m.id === editingModel.id ? updatedModel : m));
    onModelsChange(updatedModels);
    resetForm();
  }, [models, editingModel, onModelsChange, buildModelFromForm, resetForm, validateForm]);

  const handleSaveConfiguredPricing = useCallback(() => {
    if (!editingConfiguredModel || !validateForm()) return;

    onConfiguredModelPricingChange?.(editingConfiguredModel.id, buildPricing(newPricingInputs));
    resetForm();
  }, [editingConfiguredModel, newPricingInputs, onConfiguredModelPricingChange, resetForm, validateForm]);

  const handleEditModel = useCallback((model: CodexCustomModel) => {
    setEditingConfiguredModel(null);
    setEditingModel(model);
    setNewModelId(model.id);
    setNewModelLabel(model.label);
    setNewModelDesc(model.description || '');
    setNewVendor(model.vendor || '');
    setNewApiKey(model.apiKey || '');
    setNewMaxInputTokens(model.maxInputTokens === undefined ? '' : String(model.maxInputTokens));
    setNewMaxOutputTokens(model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens));
    setNewUrl(model.url || '');
    setNewSupportsToolCall(model.supportsToolCall ?? false);
    setNewSupportsImages(model.supportsImages ?? false);
    setNewSupportsReasoning(model.supportsReasoning ?? false);
    setNewContextWindowK(!contextWindowEnabled || model.contextWindowTokens === undefined
      ? ''
      : String(model.contextWindowTokens / CONTEXT_WINDOW_TOKENS_PER_K));
    setNewPricingInputs({
      inputCostPer1M: formatPricingValue(model.pricing?.inputCostPer1M),
      outputCostPer1M: formatPricingValue(model.pricing?.outputCostPer1M),
      cacheWriteCostPer1M: formatPricingValue(model.pricing?.cacheWriteCostPer1M),
      cacheReadCostPer1M: formatPricingValue(model.pricing?.cacheReadCostPer1M),
    });
    // Reveal pricing only when the model already has rates to edit.
    setPricingCollapsed(!hasPricing(model.pricing));
    setIsAdding(true);
    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
    setCodeBuddyConfigError(null);
  }, [contextWindowEnabled]);

  const handleEditConfiguredModelPricing = useCallback((model: CodexCustomModel) => {
    setEditingModel(null);
    setEditingConfiguredModel(model);
    setNewModelId(model.id);
    setNewModelLabel(model.label || model.id);
    setNewModelDesc(model.description || '');
    setNewContextWindowK('');
    setNewPricingInputs({
      inputCostPer1M: formatPricingValue(model.pricing?.inputCostPer1M),
      outputCostPer1M: formatPricingValue(model.pricing?.outputCostPer1M),
      cacheWriteCostPer1M: formatPricingValue(model.pricing?.cacheWriteCostPer1M),
      cacheReadCostPer1M: formatPricingValue(model.pricing?.cacheReadCostPer1M),
    });
    // For provider-configured models pricing is the only editable field.
    setPricingCollapsed(false);
    setIsAdding(true);
    setModelIdError(null);
    setContextWindowError(null);
    setPricingError(null);
  }, []);

  const handleRemoveModel = useCallback((id: string) => {
    onModelsChange(models.filter(m => m.id !== id));
  }, [models, onModelsChange]);

  const handleCancelEdit = useCallback(() => {
    resetForm();
  }, [resetForm]);

  const getPricingSummary = useCallback((pricing?: ModelPricing): string => {
    if (!hasPricing(pricing)) {
      return '';
    }
    return PRICING_FIELDS
      .flatMap(({ key, shortLabelKey }) => {
        const value = pricing?.[key];
        return value === undefined ? [] : [`${t(shortLabelKey)} $${value}/1M`];
      })
      .join(' | ');
  }, [t]);

  const isEditingConfiguredModel = !!editingConfiguredModel;
  const isEditingAnyModel = !!editingModel || isEditingConfiguredModel;

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog provider-dialog" style={DIALOG_STYLE}>
        <div className="dialog-header">
          <h3>{t('settings.pluginModels.dialogTitle')}</h3>
          <button type="button" className="close-btn" onClick={onClose} title={t('common.close')}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">{t('settings.pluginModels.description')}</p>

          {configuredModels.length > 0 && (
            <section className={styles.configuredModelsSection} aria-labelledby="configured-models-heading">
              <h4 id="configured-models-heading" className={styles.sectionHeader}>
                {t('settings.pluginModels.configuredSectionTitle')}
              </h4>
              <p className={styles.sectionHint}>
                {t('settings.pluginModels.configuredSectionDesc')}
              </p>
              <div className={styles.modelList} role="list" aria-label={t('settings.pluginModels.configuredSectionTitle')}>
                {configuredModels.map((model) => (
                  <div key={model.id} className={styles.modelItem} role="listitem">
                    <div className={styles.modelItemContent}>
                      <div className={styles.modelItemId}>{model.id}</div>
                      {model.label && model.label !== model.id && (
                        <span className={styles.modelItemLabel}>
                          ({model.label})
                        </span>
                      )}
                      {model.description && (
                        <div className={styles.modelItemDesc}>
                          {model.description}
                        </div>
                      )}
                      {codeBuddyConfigEnabled && (model.vendor || model.url) && (
                        <div className={styles.modelItemMetadata}>
                          {[model.vendor, model.url].filter(Boolean).join(' · ')}
                        </div>
                      )}
                      <div className={styles.modelItemPricing}>
                        {hasPricing(model.pricing)
                          ? getPricingSummary(model.pricing)
                          : t('settings.pluginModels.pricing.defaultPricing')}
                      </div>
                    </div>
                    <div className={styles.modelItemActions}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => handleEditConfiguredModelPricing(model)}
                        title={t('settings.pluginModels.editPricing')}
                        aria-label={`${t('settings.pluginModels.editPricing')} ${model.id}`}
                      >
                        <span className="codicon codicon-edit" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="custom-models-heading">
            <h4 id="custom-models-heading" className={styles.sectionHeader}>
              {t('settings.pluginModels.customSectionTitle')}
            </h4>
            <div className={styles.modelList} role="list" aria-label={t('settings.pluginModels.customSectionTitle')}>
              {models.length === 0 && !isAdding ? (
                <div className={styles.emptyState} role="status">
                  {t('settings.codexProvider.dialog.noCustomModels')}
                </div>
              ) : (
                models.map((model) => (
                  <div key={model.id} className={styles.modelItem} role="listitem">
                    <div className={styles.modelItemContent}>
                      <div className={styles.modelItemId}>{model.id}</div>
                      {model.label !== model.id && (
                        <span className={styles.modelItemLabel}>
                          ({model.label})
                        </span>
                      )}
                      {model.description && (
                        <div className={styles.modelItemDesc}>
                          {model.description}
                        </div>
                      )}
                      {contextWindowEnabled && model.contextWindowTokens !== undefined && (
                        <div className={styles.modelItemMetadata}>
                          {t('settings.pluginModels.contextWindow.summary', {
                            value: model.contextWindowTokens.toLocaleString(),
                            defaultValue: 'Context: {{value}} tokens',
                          })}
                        </div>
                      )}
                      {hasPricing(model.pricing) && (
                        <div className={styles.modelItemPricing}>
                          {getPricingSummary(model.pricing)}
                        </div>
                      )}
                    </div>
                    <div className={styles.modelItemActions}>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => handleEditModel(model)}
                        title={t('common.edit')}
                        aria-label={`${t('common.edit')} ${model.id}`}
                      >
                        <span className="codicon codicon-edit" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtnDanger}
                        onClick={() => handleRemoveModel(model.id)}
                        title={t('common.delete')}
                        aria-label={`${t('common.delete')} ${model.id}`}
                      >
                        <span className="codicon codicon-trash" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Add/edit form */}
          {isAdding ? (
            <div className={styles.addEditForm} role="form" aria-label={isEditingAnyModel ? t('common.edit') : t('common.add')}>
              {isEditingConfiguredModel && (
                <p className={styles.sectionHint}>
                  {t('settings.pluginModels.configuredEditHint')}
                </p>
              )}
              <div className={styles.formRow}>
                <label htmlFor="model-id-input" className="sr-only">
                  {t('settings.codexProvider.dialog.modelIdPlaceholder')}
                </label>
                <input
                  id="model-id-input"
                  type="text"
                  className={`form-input ${modelIdError ? 'input-error' : ''}`}
                  placeholder={t('settings.codexProvider.dialog.modelIdPlaceholder')}
                  value={newModelId}
                  onChange={(e) => { setNewModelId(e.target.value); if (modelIdError) setModelIdError(null); }}
                  style={FLEX_1_STYLE}
                  autoFocus={!isEditingConfiguredModel}
                  disabled={isEditingConfiguredModel}
                  aria-invalid={!!modelIdError}
                  aria-describedby={modelIdError ? 'model-id-error' : undefined}
                />
                <label htmlFor="model-label-input" className="sr-only">
                  {t('settings.codexProvider.dialog.modelLabelPlaceholder')}
                </label>
                <input
                  id="model-label-input"
                  type="text"
                  className="form-input"
                  placeholder={t('settings.codexProvider.dialog.modelLabelPlaceholder')}
                  value={newModelLabel}
                  onChange={(e) => setNewModelLabel(e.target.value)}
                  style={FLEX_1_STYLE}
                  disabled={isEditingConfiguredModel}
                />
              </div>
              {modelIdError && (
                <div id="model-id-error" className={styles.validationError} role="alert">
                  {modelIdError}
                </div>
              )}
              <label htmlFor="model-desc-input" className="sr-only">
                {t('settings.codexProvider.dialog.modelDescPlaceholder')}
              </label>
              <input
                id="model-desc-input"
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.modelDescPlaceholder')}
                value={newModelDesc}
                onChange={(e) => setNewModelDesc(e.target.value)}
                style={DESC_INPUT_STYLE}
                disabled={isEditingConfiguredModel}
              />

              {codeBuddyConfigEnabled && !isEditingConfiguredModel && (
                <div className={styles.codeBuddyConfigSection}>
                  <input
                    type="text"
                    className="form-input"
                    placeholder={t('settings.codebuddyProvider.vendorPlaceholder', { defaultValue: '供应商' })}
                    value={newVendor}
                    onChange={(e) => setNewVendor(e.target.value)}
                  />
                  <input
                    type="url"
                    className="form-input"
                    placeholder={t('settings.codebuddyProvider.urlPlaceholder', { defaultValue: 'BASE URL (OpenAI 兼容)' })}
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                  />
                  <input
                    type="password"
                    className="form-input"
                    placeholder={t('settings.codebuddyProvider.apiKeyPlaceholder', { defaultValue: 'API KEY' })}
                    value={newApiKey}
                    onChange={(e) => setNewApiKey(e.target.value)}
                  />
                  <div className={styles.checkboxGrid}>
                    <label><input type="checkbox" checked={newSupportsToolCall} onChange={(e) => setNewSupportsToolCall(e.target.checked)} /> {t('settings.codebuddyProvider.supportsToolCall', { defaultValue: '工具调用' })}</label>
                    <label><input type="checkbox" checked={newSupportsImages} onChange={(e) => setNewSupportsImages(e.target.checked)} /> {t('settings.codebuddyProvider.supportsImages', { defaultValue: '图片输入' })}</label>
                    <label><input type="checkbox" checked={newSupportsReasoning} onChange={(e) => setNewSupportsReasoning(e.target.checked)} /> {t('settings.codebuddyProvider.supportsReasoning', { defaultValue: '推理' })}</label>
                  </div>
                  <div className={styles.formRow}>
                    <input
                      type="number"
                      min="1"
                      className="form-input"
                      placeholder={t('settings.codebuddyProvider.maxInputTokensPlaceholder', { defaultValue: '输入（context）' })}
                      value={newMaxInputTokens}
                      onChange={(e) => setNewMaxInputTokens(e.target.value)}
                    />
                    <input
                      type="number"
                      min="1"
                      className="form-input"
                      placeholder={t('settings.codebuddyProvider.maxOutputTokensPlaceholder', { defaultValue: '输出（max output）' })}
                      value={newMaxOutputTokens}
                      onChange={(e) => setNewMaxOutputTokens(e.target.value)}
                    />
                  </div>
                  <p className={styles.fieldHint}>
                    {t('settings.codebuddyProvider.modelsJsonHint', { defaultValue: 'Saved directly to CodeBuddy models.json. API key may use ${ENV_VAR}.' })}
                  </p>
                  {codeBuddyConfigError && (
                    <div className={styles.validationError} role="alert">{codeBuddyConfigError}</div>
                  )}
                </div>
              )}

              {contextWindowEnabled && !isEditingConfiguredModel && (
                <div className={styles.contextWindowField}>
                  <label htmlFor="model-context-window-input">
                    {t('settings.pluginModels.contextWindow.label')}
                  </label>
                  <input
                    id="model-context-window-input"
                    type="number"
                    min="1"
                    max={MAX_CONTEXT_WINDOW_K}
                    step="1"
                    inputMode="numeric"
                    className={`form-input ${contextWindowError ? 'input-error' : ''}`}
                    placeholder={t('settings.pluginModels.contextWindow.placeholder')}
                    value={newContextWindowK}
                    onChange={(e) => {
                      setNewContextWindowK(e.target.value);
                      if (contextWindowError) setContextWindowError(null);
                    }}
                    aria-invalid={!!contextWindowError}
                    aria-describedby={contextWindowError
                      ? 'model-context-window-hint model-context-window-error'
                      : 'model-context-window-hint'}
                  />
                  <p id="model-context-window-hint" className={styles.fieldHint}>
                    {t('settings.pluginModels.contextWindow.hint')}
                  </p>
                  {contextWindowError && (
                    <div id="model-context-window-error" className={styles.validationError} role="alert">
                      {contextWindowError}
                    </div>
                  )}
                </div>
              )}

              <div className={styles.pricingSection}>
                <button
                  type="button"
                  className={styles.pricingToggle}
                  onClick={() => setPricingCollapsed(prev => !prev)}
                  aria-expanded={!pricingCollapsed}
                  aria-controls="model-pricing-content"
                >
                  <span
                    className={`codicon ${pricingCollapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'}`}
                    aria-hidden="true"
                  />
                  <span className={styles.pricingToggleLabel}>
                    {t('settings.pluginModels.pricing.title')}
                  </span>
                  <span className={styles.optionalBadge}>
                    {t('settings.pluginModels.pricing.optionalLabel')}
                  </span>
                </button>
                {!pricingCollapsed && (
                  <div id="model-pricing-content" className={styles.pricingContent}>
                    <p id="model-pricing-hint" className={styles.pricingHint}>
                      {t('settings.pluginModels.pricing.hint')}
                    </p>
                    <div className={styles.pricingGrid}>
                      {PRICING_FIELDS.map((field) => {
                        const value = newPricingInputs[field.key];
                        const invalid = isInvalidPricingValue(value);
                        return (
                          <div key={field.key} className={styles.pricingField}>
                            <label htmlFor={`model-pricing-${field.key}`}>
                              {t(field.labelKey)}
                            </label>
                            <input
                              id={`model-pricing-${field.key}`}
                              type="number"
                              min="0"
                              step="0.000001"
                              inputMode="decimal"
                              className={`form-input ${invalid ? 'input-error' : ''}`}
                              placeholder={field.placeholder}
                              value={value}
                              onChange={(e) => {
                                setNewPricingInputs(prev => ({ ...prev, [field.key]: e.target.value }));
                                if (pricingError) setPricingError(null);
                              }}
                              aria-invalid={invalid}
                              aria-describedby={pricingError ? 'model-pricing-hint model-pricing-error' : 'model-pricing-hint'}
                            />
                          </div>
                        );
                      })}
                    </div>
                    {pricingError && (
                      <div id="model-pricing-error" className={styles.validationError} role="alert">
                        {pricingError}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className={styles.formActions}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleCancelEdit}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={isEditingConfiguredModel ? handleSaveConfiguredPricing : editingModel ? handleSaveEdit : handleAddModel}
                  disabled={!newModelId.trim()}
                >
                  {isEditingAnyModel ? t('common.save') : t('common.add')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={`btn btn-secondary btn-sm ${styles.addBtn}`}
              onClick={() => setIsAdding(true)}
              aria-label={t('settings.codexProvider.dialog.addModel')}
            >
              <span className="codicon codicon-add" aria-hidden="true" style={ADD_ICON_STYLE} />
              {t('settings.codexProvider.dialog.addModel')}
            </button>
          )}
        </div>

        <div className="dialog-footer">
          <div className={styles.dialogFooterSpacer} />
          <div className="footer-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CustomModelDialog;
