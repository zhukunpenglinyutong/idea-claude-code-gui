import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig, EnvVarEntry } from '../types/provider';
import {
  CODEX_PROVIDER_PRESETS,
  DEFAULT_CODEX_AUTH_JSON,
  OFFICIAL_CODEX_CONFIG_TOML,
  OFFICIAL_CODEX_PROVIDER_NAME,
  validateEnvVarEntries,
  ENV_VAR_VALUE_MAX_LENGTH,
} from '../types/provider';
import EnvVarEditor from './EnvVarEditor';
import { ProviderModelIcon } from './shared/ProviderModelIcon';

const FORM_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
  flexWrap: 'wrap',
};
const FORMAT_BUTTON_STYLE: React.CSSProperties = {
  width: 'auto',
  minWidth: 'auto',
  flex: '0 0 auto',
  padding: '4px 10px',
  fontSize: '12px',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};
const CODE_TEXTAREA_STYLE: React.CSSProperties = {
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontSize: '12px',
  lineHeight: '1.5',
};
const FOOTER_ACTIONS_STYLE: React.CSSProperties = { marginLeft: 'auto' };
const OFFICIAL_DIRECT_PRESET_ID = 'official_direct';

interface CodexProviderDialogProps {
  isOpen: boolean;
  provider?: CodexProviderConfig | null;
  onClose: () => void;
  onSave: (provider: CodexProviderConfig) => void;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function CodexProviderDialog({
  isOpen,
  provider,
  onClose,
  onSave,
  addToast,
}: CodexProviderDialogProps) {
  const { t } = useTranslation();
  const isAdding = !provider;

  const [providerName, setProviderName] = useState('');
  const [configTomlJson, setConfigTomlJson] = useState('');
  const [authJson, setAuthJson] = useState('');
  const [messageEnvVars, setMessageEnvVars] = useState<EnvVarEntry[]>([]);
  const [mcpEnvVars, setMcpEnvVars] = useState<EnvVarEntry[]>([]);
  const [activePreset, setActivePreset] = useState('custom');

  // Initialize form
  useEffect(() => {
    if (isOpen) {
      if (provider) {
        // Edit mode - load existing data
        setProviderName(provider.name || '');
        setConfigTomlJson(provider.configToml || '');
        setAuthJson(provider.authJson || '');
        setMessageEnvVars(provider.messageEnvVars || []);
        setMcpEnvVars(provider.mcpEnvVars || []);
        setActivePreset('custom');
      } else {
        // Add mode - reset with default template
        setProviderName(OFFICIAL_CODEX_PROVIDER_NAME);
        setConfigTomlJson(OFFICIAL_CODEX_CONFIG_TOML);
        setAuthJson(DEFAULT_CODEX_AUTH_JSON);
        setMessageEnvVars([]);
        setMcpEnvVars([]);
        setActivePreset(OFFICIAL_DIRECT_PRESET_ID);
      }
    }
  }, [isOpen, provider]);

  const handlePresetClick = (presetId: string) => {
    if (presetId === OFFICIAL_DIRECT_PRESET_ID) {
      setActivePreset(OFFICIAL_DIRECT_PRESET_ID);
      setProviderName(OFFICIAL_CODEX_PROVIDER_NAME);
      setConfigTomlJson(OFFICIAL_CODEX_CONFIG_TOML);
      setAuthJson(DEFAULT_CODEX_AUTH_JSON);
      return;
    }

    const preset = CODEX_PROVIDER_PRESETS.find(item => item.id === presetId);
    if (!preset) return;

    setActivePreset(preset.id);
    setProviderName(preset.name);
    setConfigTomlJson(preset.configToml);
    setAuthJson(preset.authJson);
  };

  // Format JSON
  const handleFormatConfigJson = () => {
    try {
      const parsed = JSON.parse(configTomlJson);
      setConfigTomlJson(JSON.stringify(parsed, null, 2));
      addToast(t('settings.codexProvider.dialog.formatSuccess'), 'success');
    } catch (e) {
      addToast(t('settings.codexProvider.dialog.formatError'), 'error');
    }
  };

  const handleFormatAuthJson = () => {
    try {
      const parsed = JSON.parse(authJson);
      setAuthJson(JSON.stringify(parsed, null, 2));
      addToast(t('settings.codexProvider.dialog.formatSuccess'), 'success');
    } catch (e) {
      addToast(t('settings.codexProvider.dialog.formatError'), 'error');
    }
  };

  // ESC key to close
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

  const reportEnvVarIssue = (
    issue: { reason: string; key?: string },
    sectionLabel: string,
  ): boolean => {
    const reasonKey = (() => {
      switch (issue.reason) {
        case 'invalid':
          return 'settings.codexProvider.dialog.envKeyInvalid';
        case 'protected':
          return 'settings.codexProvider.dialog.envKeyProtected';
        case 'duplicate':
          return 'settings.codexProvider.dialog.envKeyDuplicate';
        case 'value_too_long':
          return 'settings.codexProvider.dialog.envValueTooLong';
        default:
          return null;
      }
    })();
    if (!reasonKey) return false;
    addToast(
      `${sectionLabel}: ${t(reasonKey, { key: issue.key, max: ENV_VAR_VALUE_MAX_LENGTH })}`,
      'error',
    );
    return true;
  };

  const handleSave = () => {
    if (!providerName.trim()) {
      addToast(t('settings.codexProvider.dialog.nameRequired'), 'error');
      return;
    }

    // Validate auth.json format (must be valid JSON)
    if (authJson.trim()) {
      try {
        JSON.parse(authJson);
      } catch (e) {
        addToast(t('settings.codexProvider.dialog.authJsonError'), 'error');
        return;
      }
    }

    // Validate env vars before saving
    const messageIssues = validateEnvVarEntries(messageEnvVars);
    if (messageIssues.length > 0) {
      reportEnvVarIssue(messageIssues[0], t('settings.codexProvider.dialog.messageEnvLabel'));
      return;
    }
    const mcpIssues = validateEnvVarEntries(mcpEnvVars);
    if (mcpIssues.length > 0) {
      reportEnvVarIssue(mcpIssues[0], t('settings.codexProvider.dialog.mcpEnvLabel'));
      return;
    }

    const providerData: CodexProviderConfig = {
      id: provider?.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()),
      name: providerName.trim(),
      createdAt: provider?.createdAt,
      configToml: configTomlJson.trim(),
      authJson: authJson.trim(),
      messageEnvVars: messageEnvVars.filter(e => e.key.trim() !== ''),
      mcpEnvVars: mcpEnvVars.filter(e => e.key.trim() !== ''),
    };

    onSave(providerData);
    onClose();
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog provider-dialog codex-provider-dialog">
        <div className="dialog-header">
          <h3>
            {isAdding
              ? t('settings.codexProvider.dialog.addTitle')
              : t('settings.codexProvider.dialog.editTitle', { name: provider?.name })}
          </h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            {isAdding
              ? t('settings.codexProvider.dialog.addDescription')
              : t('settings.codexProvider.dialog.editDescription')}
          </p>

          {isAdding && (
            <>
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
                      <ProviderModelIcon providerId="codex" size={16} colored />
                    </span>
                    {t('settings.codexProvider.dialog.officialPreset')}
                  </button>
                </div>
                <small className="form-hint">{t('settings.codexProvider.dialog.officialSectionHint')}</small>
              </div>
            </>
          )}

          {isAdding && (
            <div className="form-group">
              <label>{t('settings.provider.dialog.proxySectionTitle')}</label>
              <div className="preset-buttons" role="radiogroup" aria-label={t('settings.provider.dialog.proxySectionTitle')}>
                {CODEX_PROVIDER_PRESETS.map((preset) => (
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
              <small className="form-hint">{t('settings.codexProvider.dialog.presetHint')}</small>
            </div>
          )}

          {/* Provider Name */}
          <div className="form-group">
            <label htmlFor="providerName">
              {t('settings.codexProvider.dialog.providerName')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <input
              id="providerName"
              type="text"
              className="form-input"
              placeholder={t('settings.codexProvider.dialog.providerNamePlaceholder')}
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
            />
          </div>

          {/* config.toml JSON */}
          <div className="form-group">
            <div style={FORM_HEADER_STYLE}>
              <label htmlFor="configTomlJson">
                config.toml {t('settings.codexProvider.dialog.configJson')}
                <span className="required">{t('settings.provider.dialog.required')}</span>
              </label>
              <button
                type="button"
                className="btn-small"
                onClick={handleFormatConfigJson}
                style={FORMAT_BUTTON_STYLE}
                title={t('settings.codexProvider.dialog.formatJson')}
              >
                <span className="codicon codicon-symbol-namespace" />
                {t('settings.codexProvider.dialog.formatJson')}
              </button>
            </div>
            <textarea
              id="configTomlJson"
              className="form-input code-input"
              value={configTomlJson}
              onChange={(e) => setConfigTomlJson(e.target.value)}
              rows={15}
              style={CODE_TEXTAREA_STYLE}
            />
            <small className="form-hint">{t('settings.codexProvider.dialog.configJsonHint')}</small>
          </div>

          {/* auth.json */}
          <div className="form-group">
            <div style={FORM_HEADER_STYLE}>
              <label htmlFor="authJson">
                auth.json {t('settings.codexProvider.dialog.authJsonLabel')}
              </label>
              <button
                type="button"
                className="btn-small"
                onClick={handleFormatAuthJson}
                style={FORMAT_BUTTON_STYLE}
                title={t('settings.codexProvider.dialog.formatJson')}
              >
                <span className="codicon codicon-symbol-namespace" />
                {t('settings.codexProvider.dialog.formatJson')}
              </button>
            </div>
            <textarea
              id="authJson"
              className="form-input code-input"
              value={authJson}
              onChange={(e) => setAuthJson(e.target.value)}
              rows={6}
              style={CODE_TEXTAREA_STYLE}
            />
            <small className="form-hint">{t('settings.codexProvider.dialog.authJsonHint')}</small>
          </div>

          {/* Environment Variables */}
          <details className="advanced-section">
            <summary className="advanced-toggle">
              <span className="codicon codicon-chevron-right" />
              {t('settings.codexProvider.dialog.envVarsTitle')}
            </summary>

            {/* Message Environment Variables */}
            <div className="form-group" style={{ marginTop: '16px' }}>
              <label>{t('settings.codexProvider.dialog.messageEnvLabel')}</label>
              <small className="form-hint">{t('settings.codexProvider.dialog.messageEnvHint')}</small>
              <EnvVarEditor
                entries={messageEnvVars}
                onChange={setMessageEnvVars}
              />
            </div>

            {/* MCP Environment Variables */}
            <div className="form-group">
              <label>{t('settings.codexProvider.dialog.mcpEnvLabel')}</label>
              <small className="form-hint">{t('settings.codexProvider.dialog.mcpEnvHint')}</small>
              <EnvVarEditor
                entries={mcpEnvVars}
                onChange={setMcpEnvVars}
              />
            </div>
          </details>

        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={FOOTER_ACTIONS_STYLE}>
            <button className="btn btn-secondary" onClick={onClose}>
              <span className="codicon codicon-close" />
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!providerName.trim()}>
              <span className="codicon codicon-save" />
              {isAdding ? t('settings.provider.dialog.confirmAdd') : t('settings.provider.dialog.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
