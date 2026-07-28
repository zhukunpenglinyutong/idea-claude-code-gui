import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../types/provider';
import { CLAUDE_MODEL_MAPPING_ENV_KEYS, PROVIDER_PRESETS } from '../types/provider';
import { ProviderModelIcon } from './shared/ProviderModelIcon';

const INFO_ICON_STYLE: React.CSSProperties = { fontSize: '12px', marginRight: '4px' };
const NOTICE_MT_STYLE: React.CSSProperties = { marginTop: '8px' };
const SECTION_DESC_STYLE: React.CSSProperties = { marginBottom: '12px', fontSize: '12px', color: '#999' };
const FOOTER_ACTIONS_STYLE: React.CSSProperties = { marginLeft: 'auto' };

const OFFICIAL_DIRECT_PRESET_ID = 'official_direct';
const OFFICIAL_ANTHROPIC_URL = 'https://api.anthropic.com';
const CUSTOM_PRESET_ID = 'custom';
const CUSTOM_PROXY_PRESET_ID = 'custom_proxy';

const isOfficialAnthropicEndpoint = (baseUrl?: string) => {
  const normalized = (baseUrl || '').trim().toLowerCase();
  if (normalized === '') return true;
  try {
    const url = new URL(normalized);
    return url.hostname === 'api.anthropic.com';
  } catch {
    // Invalid URL cannot be an official endpoint
    return false;
  }
};

interface BuildConfigOptions {
  envOverrides?: Record<string, string>;
  defaultBaseUrl?: string;
  includeModelMapping?: boolean;
}

const trimString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const readHaikuModel = (env: Record<string, unknown>): string => (
  trimString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
);

const readFableModel = (env: Record<string, unknown>): string => (
  trimString(env.ANTHROPIC_DEFAULT_FABLE_MODEL)
);

export function normalizeProviderEnvForSave(
  env: Record<string, unknown>,
  options: { stripAllModelMappings?: boolean } = {}
): Record<string, unknown> {
  const nextEnv = { ...env };

  if (options.stripAllModelMappings) {
    for (const key of CLAUDE_MODEL_MAPPING_ENV_KEYS) {
      delete nextEnv[key];
    }
    return nextEnv;
  }

  const mainModel = trimString(nextEnv.ANTHROPIC_MODEL);
  if (!mainModel) {
    delete nextEnv.ANTHROPIC_MODEL;
    return nextEnv;
  }

  const specificModels = [
    trimString(nextEnv.ANTHROPIC_DEFAULT_FABLE_MODEL),
    trimString(nextEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    trimString(nextEnv.ANTHROPIC_DEFAULT_SONNET_MODEL),
    trimString(nextEnv.ANTHROPIC_DEFAULT_OPUS_MODEL),
  ].filter(Boolean);

  if (specificModels.length === 0 || specificModels.every(model => model === mainModel)) {
    delete nextEnv.ANTHROPIC_MODEL;
  }

  return nextEnv;
}

export function sanitizeProviderJsonConfig(
  rawJsonConfig: string,
  options: { stripAllModelMappings?: boolean } = {}
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = rawJsonConfig ? JSON.parse(rawJsonConfig) : {};
  } catch {
    return rawJsonConfig;
  }
  const prevEnv = parsed.env && typeof parsed.env === 'object'
    ? parsed.env as Record<string, unknown>
    : {};
  const nextEnv = normalizeProviderEnvForSave(prevEnv, options);

  const nextConfig = Object.keys(nextEnv).length > 0
    ? { ...parsed, env: nextEnv }
    : Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'env'));

  return JSON.stringify(nextConfig, null, 2);
}

interface ProviderDialogProps {
  isOpen: boolean;
  provider?: ProviderConfig | null; // null indicates add mode
  onClose: () => void;
  onSave: (data: {
    providerName: string;
    remark: string;
    apiKey: string;
    apiUrl: string;
    jsonConfig: string;
  }) => void;
  onDelete?: (provider: ProviderConfig) => void;
  canDelete?: boolean;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function ProviderDialog({
  isOpen,
  provider,
  onClose,
  onSave,
  onDelete: _onDelete,
  canDelete: _canDelete = true,
  addToast: _addToast,
}: ProviderDialogProps) {
  const { t } = useTranslation();
  const isAdding = !provider;
  
  const [providerName, setProviderName] = useState('');
  const [remark, setRemark] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [activePreset, setActivePreset] = useState<string>('custom');

  const [haikuModel, setHaikuModel] = useState('');
  const [fableModel, setFableModel] = useState('');
  const [sonnetModel, setSonnetModel] = useState('');
  const [opusModel, setOpusModel] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState('');
  const thirdPartyPresets = PROVIDER_PRESETS;
  const isOfficialDirectMode = activePreset === OFFICIAL_DIRECT_PRESET_ID;
  // Model mapping should always be shown – the 'custom' preset button was removed
  // from the UI, so users can never explicitly opt out of model mapping.
  const showModelMappingSection = true;

  const buildConfig = ({
    envOverrides = {},
    defaultBaseUrl = OFFICIAL_ANTHROPIC_URL,
    includeModelMapping = true,
  }: BuildConfigOptions = {}) => {
    const normalizedEnv = normalizeProviderEnvForSave(envOverrides, {
      stripAllModelMappings: !includeModelMapping,
    });

    return {
      env: {
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: defaultBaseUrl,
        ...(includeModelMapping ? {
          ANTHROPIC_DEFAULT_FABLE_MODEL: '',
          ANTHROPIC_DEFAULT_SONNET_MODEL: '',
          ANTHROPIC_DEFAULT_OPUS_MODEL: '',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
        } : {}),
        ...normalizedEnv,
      }
    };
  };

  const updateEnvField = (key: string, value: string) => {
    try {
      const parsed = jsonConfig ? JSON.parse(jsonConfig) : {};
      const prevEnv = (parsed.env || {}) as Record<string, any>;
      const trimmed = typeof value === 'string' ? value.trim() : value;

      let nextEnv: Record<string, any>;
      if (!trimmed) {
        const { [key]: _, ...rest } = prevEnv;
        nextEnv = rest;
      } else {
        nextEnv = { ...prevEnv, [key]: value };
      }

      const normalizedEnv = normalizeProviderEnvForSave(nextEnv, {
        stripAllModelMappings: activePreset === CUSTOM_PRESET_ID,
      });

      const nextConfig = Object.keys(normalizedEnv).length > 0
        ? { ...parsed, env: normalizedEnv }
        : Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'env'));

      setJsonConfig(JSON.stringify(nextConfig, null, 2));
      setJsonError('');
    } catch (err) {
      // silently ignore – the JSON textarea will show a validation error
    }
  };

  // Apply preset configuration
  const handlePresetClick = (presetId: string) => {
    setActivePreset(presetId);

    if (presetId === OFFICIAL_DIRECT_PRESET_ID) {
      const config = buildConfig();
      setJsonConfig(JSON.stringify(config, null, 2));
      setApiKey('');
      setApiUrl(OFFICIAL_ANTHROPIC_URL);
      setFableModel('');
      setHaikuModel('');
      setSonnetModel('');
      setOpusModel('');
      setJsonError('');
      return;
    }

    if (presetId === CUSTOM_PRESET_ID) {
      const config = buildConfig({
        defaultBaseUrl: '',
        includeModelMapping: false,
      });
      setJsonConfig(JSON.stringify(config, null, 2));
      setApiKey('');
      setApiUrl('');
      setFableModel('');
      setHaikuModel('');
      setSonnetModel('');
      setOpusModel('');
      setJsonError('');
      return;
    }

    const preset = PROVIDER_PRESETS.find(p => p.id === presetId);
    if (!preset) return;

    // Apply preset configuration
    const config = buildConfig({ envOverrides: preset.env });
    setJsonConfig(JSON.stringify(config, null, 2));

    // Sync form fields with preset values
    const env = preset.env;
    setApiUrl(env.ANTHROPIC_BASE_URL || '');
    setApiKey(env.ANTHROPIC_AUTH_TOKEN || '');
    setFableModel(readFableModel(env));
    setHaikuModel(readHaikuModel(env));
    setSonnetModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL || '');
    setOpusModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL || '');
    setJsonError('');
  };

  // Auto-detect matching preset based on environment variables
  const detectMatchingPreset = (env: Record<string, string | undefined>): string => {
    const baseUrl = env.ANTHROPIC_BASE_URL || '';

    if (isOfficialAnthropicEndpoint(baseUrl)) {
      return OFFICIAL_DIRECT_PRESET_ID;
    }

    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === 'custom') continue;
      const presetBaseUrl = preset.env.ANTHROPIC_BASE_URL || '';
      if (baseUrl && presetBaseUrl && baseUrl === presetBaseUrl) {
        return preset.id;
      }
    }
    // Unrecognized URL: treat as a custom third-party proxy.
    // Return a non-'custom' value so model mapping stays enabled.
    return CUSTOM_PROXY_PRESET_ID;
  };

  // Format JSON
  const handleFormatJson = () => {
    try {
      setJsonConfig(sanitizeProviderJsonConfig(jsonConfig, {
        stripAllModelMappings: activePreset === CUSTOM_PRESET_ID,
      }));
      setJsonError('');
    } catch (err) {
      setJsonError(t('settings.provider.dialog.jsonError'));
    }
  };

  // Initialize form
  useEffect(() => {
    if (isOpen) {
      if (provider) {
        // Edit mode
        setProviderName(provider.name || '');
        setRemark(provider.remark || provider.websiteUrl || '');
        setApiKey(provider.settingsConfig?.env?.ANTHROPIC_AUTH_TOKEN || provider.settingsConfig?.env?.ANTHROPIC_API_KEY || '');
        // In edit mode, do not populate default values to avoid overwriting the user's third-party proxy URL
        setApiUrl(provider.settingsConfig?.env?.ANTHROPIC_BASE_URL || '');
        const env = provider.settingsConfig?.env || {};

        // Auto-detect matching preset
        setActivePreset(detectMatchingPreset(env));

        setFableModel(readFableModel(env));
        setHaikuModel(readHaikuModel(env));
        setSonnetModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL || '');
        setOpusModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL || '');

        const config = provider.settingsConfig || buildConfig();
        setJsonConfig(JSON.stringify(config, null, 2));
      } else {
        // Add mode
        setActivePreset(OFFICIAL_DIRECT_PRESET_ID);
        setProviderName('');
        setRemark('');
        setApiKey('');
        setApiUrl(OFFICIAL_ANTHROPIC_URL);

        setFableModel('');
        setHaikuModel('');
        setSonnetModel('');
        setOpusModel('');
        const config = buildConfig();
        setJsonConfig(JSON.stringify(config, null, 2));
      }
      setShowApiKey(false);
      setJsonError('');
    }
  }, [isOpen, provider]);

  // Close on ESC key press
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newApiKey = e.target.value;
    setApiKey(newApiKey);
    updateEnvField('ANTHROPIC_AUTH_TOKEN', newApiKey);
  };

  const handleApiUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newApiUrl = e.target.value;
    setApiUrl(newApiUrl);
    updateEnvField('ANTHROPIC_BASE_URL', newApiUrl);
    setActivePreset(detectMatchingPreset({ ANTHROPIC_BASE_URL: newApiUrl }));
  };

  const handleHaikuModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHaikuModel(value);
    updateEnvField('ANTHROPIC_DEFAULT_HAIKU_MODEL', value);
  };

  const handleFableModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setFableModel(value);
    updateEnvField('ANTHROPIC_DEFAULT_FABLE_MODEL', value);
  };

  const handleSonnetModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSonnetModel(value);
    updateEnvField('ANTHROPIC_DEFAULT_SONNET_MODEL', value);
  };

  const handleOpusModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setOpusModel(value);
    updateEnvField('ANTHROPIC_DEFAULT_OPUS_MODEL', value);
  };

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newJson = e.target.value;
    setJsonConfig(newJson);
    
    try {
      const config = JSON.parse(newJson);
      const env = config.env || {};

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_AUTH_TOKEN')) {
        setApiKey(env.ANTHROPIC_AUTH_TOKEN || '');
      } else if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY')) {
        setApiKey(env.ANTHROPIC_API_KEY || '');
      } else {
        setApiKey('');
      }

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_BASE_URL')) {
        setApiUrl(env.ANTHROPIC_BASE_URL || '');
      } else {
        setApiUrl('');
      }

      setActivePreset(detectMatchingPreset(env));

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL')) {
        setFableModel(readFableModel(env));
      } else {
        setFableModel('');
      }

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')) {
        setHaikuModel(readHaikuModel(env));
      } else {
        setHaikuModel('');
      }

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL')) {
        setSonnetModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL || '');
      } else {
        setSonnetModel('');
      }

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL')) {
        setOpusModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL || '');
      } else {
        setOpusModel('');
      }
      setJsonError('');
    } catch (err) {
      setJsonError(t('settings.provider.dialog.jsonError'));
    }
  };

  const handleSave = () => {
    let finalJsonConfig = jsonConfig;
    let finalApiUrl = apiUrl;

    if (isOfficialDirectMode) {
      try {
        const parsed = jsonConfig ? JSON.parse(jsonConfig) : {};
        const env = { ...(parsed.env || {}), ANTHROPIC_BASE_URL: OFFICIAL_ANTHROPIC_URL };
        finalJsonConfig = JSON.stringify({ ...parsed, env }, null, 2);
      } catch {
        finalJsonConfig = JSON.stringify(buildConfig({
          envOverrides: {
            ANTHROPIC_AUTH_TOKEN: apiKey,
            ANTHROPIC_DEFAULT_FABLE_MODEL: fableModel,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
            ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
            ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
          },
        }), null, 2);
      }
      finalApiUrl = OFFICIAL_ANTHROPIC_URL;
    }

    try {
      finalJsonConfig = sanitizeProviderJsonConfig(finalJsonConfig, {
        stripAllModelMappings: activePreset === CUSTOM_PRESET_ID,
      });
    } catch {
      finalJsonConfig = JSON.stringify(buildConfig({
        envOverrides: {
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: finalApiUrl,
          ANTHROPIC_DEFAULT_FABLE_MODEL: fableModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
          ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
        },
        defaultBaseUrl: activePreset === CUSTOM_PRESET_ID ? '' : finalApiUrl,
        includeModelMapping: activePreset !== CUSTOM_PRESET_ID,
      }), null, 2);
    }

    onSave({
      providerName,
      remark,
      apiKey,
      apiUrl: finalApiUrl,
      jsonConfig: finalJsonConfig,
    });
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog provider-dialog">
        <div className="dialog-header">
          <h3>{isAdding ? t('settings.provider.dialog.addTitle') : t('settings.provider.dialog.editTitle', { name: provider?.name })}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            {isAdding ? t('settings.provider.dialog.addDescription') : t('settings.provider.dialog.editDescription')}
          </p>

          <div className="notice-box notice-box--info">
            <span className="codicon codicon-shield" />
            {t('settings.provider.dialog.securityNotice')}
          </div>

          <div className="form-group">
            <label>{t('settings.provider.dialog.officialSectionTitle')}</label>
            <div className="preset-buttons" role="radiogroup" aria-label={t('settings.provider.dialog.officialSectionTitle')}>
              <button
                type="button"
                role="radio"
                aria-checked={activePreset === OFFICIAL_DIRECT_PRESET_ID}
                className={`preset-btn ${activePreset === OFFICIAL_DIRECT_PRESET_ID ? 'active' : ''}`}
                onClick={() => handlePresetClick(OFFICIAL_DIRECT_PRESET_ID)}
              >
                <span aria-hidden="true" className="preset-btn-icon">
                  <ProviderModelIcon providerId="claude" size={16} colored />
                </span>
                {t('settings.provider.dialog.officialPreset')}
              </button>
            </div>
            <small className="form-hint">{t('settings.provider.dialog.officialSectionHint')}</small>
          </div>

          <div className="form-group">
            <label>{t('settings.provider.dialog.proxySectionTitle')}</label>
            <div className="preset-buttons" role="radiogroup" aria-label={t('settings.provider.dialog.proxySectionTitle')}>
              {thirdPartyPresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={activePreset === preset.id}
                  className={`preset-btn ${activePreset === preset.id ? 'active' : ''}`}
                  onClick={() => handlePresetClick(preset.id)}
                >
                  <span aria-hidden="true" className="preset-btn-icon">
                    <ProviderModelIcon providerId={preset.id} size={16} colored />
                  </span>
                  {t(preset.nameKey)}
                </button>
              ))}
            </div>
            <small className="form-hint">{t('settings.provider.dialog.proxySectionHint')}</small>
          </div>

          <div className="form-group">
            <label htmlFor="providerName">
              {t('settings.provider.dialog.providerName')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <input
              id="providerName"
              type="text"
              className="form-input"
              placeholder={t('settings.provider.dialog.providerNamePlaceholder')}
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="remark">{t('settings.provider.dialog.remark')}</label>
            <input
              id="remark"
              type="text"
              className="form-input"
              placeholder={t('settings.provider.dialog.remarkPlaceholder')}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="apiKey">
              {t('settings.provider.dialog.apiKey')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <div className="input-with-visibility">
              <input
                id="apiKey"
                type={showApiKey ? 'text' : 'password'}
                className="form-input"
                placeholder={t('settings.provider.dialog.apiKeyPlaceholder')}
                value={apiKey}
                onChange={handleApiKeyChange}
              />
              <button
                type="button"
                className="visibility-toggle"
                onClick={() => setShowApiKey(!showApiKey)}
                title={showApiKey ? t('settings.provider.dialog.hideApiKey') : t('settings.provider.dialog.showApiKey')}
              >
                <span className={`codicon ${showApiKey ? 'codicon-eye-closed' : 'codicon-eye'}`} />
              </button>
            </div>
            <small className="form-hint">{t('settings.provider.dialog.apiKeyHint')}</small>
          </div>

          <div className="form-group">
            <label htmlFor="apiUrl">
              {t('settings.provider.dialog.apiUrl')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <input
              id="apiUrl"
              type="text"
              className="form-input"
              placeholder={t('settings.provider.dialog.apiUrlPlaceholder')}
              value={apiUrl}
              onChange={handleApiUrlChange}
              readOnly={isOfficialDirectMode}
            />
            <small className="form-hint">
              <span className="codicon codicon-info" style={INFO_ICON_STYLE} />
              {isOfficialDirectMode
                ? t('settings.provider.dialog.apiUrlLockedHint')
                : t('settings.provider.dialog.apiUrlHint')}
            </small>
            {!isOfficialAnthropicEndpoint(apiUrl) && (
              <div className="notice-box notice-box--warning" style={NOTICE_MT_STYLE}>
                <span className="codicon codicon-cloud" />
                {t('settings.provider.dialog.proxyEndpointWarning')}
              </div>
            )}
          </div>

          {showModelMappingSection && (
            <div className="form-group">
              <label>{t('settings.provider.dialog.modelMapping')}</label>
              <div className="model-mapping-grid">
                <div className="model-mapping-field">
                  <label htmlFor="fableModel">{t('settings.provider.dialog.fableModel')}</label>
                  <input
                    id="fableModel"
                    type="text"
                    className="form-input"
                    placeholder={t('settings.provider.dialog.fableModelPlaceholder')}
                    value={fableModel}
                    onChange={handleFableModelChange}
                  />
                </div>
                <div className="model-mapping-field">
                  <label htmlFor="sonnetModel">{t('settings.provider.dialog.sonnetModel')}</label>
                  <input
                    id="sonnetModel"
                    type="text"
                    className="form-input"
                    placeholder={t('settings.provider.dialog.sonnetModelPlaceholder')}
                    value={sonnetModel}
                    onChange={handleSonnetModelChange}
                  />
                </div>
                <div className="model-mapping-field">
                  <label htmlFor="opusModel">{t('settings.provider.dialog.opusModel')}</label>
                  <input
                    id="opusModel"
                    type="text"
                    className="form-input"
                    placeholder={t('settings.provider.dialog.opusModelPlaceholder')}
                    value={opusModel}
                    onChange={handleOpusModelChange}
                  />
                </div>
                <div className="model-mapping-field">
                  <label htmlFor="haikuModel">{t('settings.provider.dialog.haikuModel')}</label>
                  <input
                    id="haikuModel"
                    type="text"
                    className="form-input"
                    placeholder={t('settings.provider.dialog.haikuModelPlaceholder')}
                    value={haikuModel}
                    onChange={handleHaikuModelChange}
                  />
                </div>
              </div>
              <small className="form-hint">{t('settings.provider.dialog.modelMappingHint')}</small>
            </div>
          )}

          <details className="advanced-section" open>
            <summary className="advanced-toggle">
              <span className="codicon codicon-chevron-right" />
              {t('settings.provider.dialog.jsonConfig')}
            </summary>
            <div className="json-config-section">
              <p className="section-desc" style={SECTION_DESC_STYLE}>
                {t('settings.provider.dialog.jsonConfigDescription')}
              </p>

              {/* Toolbar */}
              <div className="json-toolbar">
                <button
                  type="button"
                  className="format-btn"
                  onClick={handleFormatJson}
                  title={t('settings.provider.dialog.formatJson') || '格式化 JSON'}
                >
                  <span className="codicon codicon-symbol-keyword" />
                  {t('settings.provider.dialog.formatJson') || '格式化'}
                </button>
              </div>

              <div className="json-editor-wrapper">
                <textarea
                  className="json-editor"
                  value={jsonConfig}
                  onChange={handleJsonChange}
                  placeholder={`{
  "env": {
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_MODEL": "",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": ""
  },
  "model": "sonnet",
  "alwaysThinkingEnabled": true,
  "ccSwitchProviderId": "default",
  "codemossProviderId": ""
}`}
                />
                {jsonError && (
                  <p className="json-error">
                    <span className="codicon codicon-error" />
                    {jsonError}
                  </p>
                )}
              </div>
            </div>
          </details>
        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={FOOTER_ACTIONS_STYLE}>
            <button className="btn btn-secondary" onClick={onClose}>
              <span className="codicon codicon-close" />
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              <span className="codicon codicon-save" />
              {isAdding ? t('settings.provider.dialog.confirmAdd') : t('settings.provider.dialog.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
