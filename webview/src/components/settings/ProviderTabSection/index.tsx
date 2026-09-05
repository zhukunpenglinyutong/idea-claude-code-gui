import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, CodexProviderConfig } from '../../../types/provider';
import { STORAGE_KEYS } from '../../../types/provider';
import ProviderManageSection from '../ProviderManageSection';
import CodexProviderSection from '../CodexProviderSection';
import CodeBuddyProviderSection from '../CodeBuddyProviderSection';
import CliSection from '../CliSection';
import CustomModelDialog from '../CustomModelDialog';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { usePluginModels } from '../hooks/usePluginModels';
import { useCodeBuddyModelsConfig } from '../hooks/useCodeBuddyModelsConfig';
import { useConfiguredClaudeModelPricing } from '../hooks/useConfiguredModelPricing';
import styles from './style.module.less';

const ICON_14_STYLE: React.CSSProperties = { fontSize: 14 };
const FLEX_1_STYLE: React.CSSProperties = { flex: 1 };

export type ProviderManageTab = 'claude' | 'codex' | 'codebuddy' | 'cli';
type ModelDialogTarget = 'claude' | 'codex' | 'codebuddy';

interface ProviderTabSectionProps {
  currentProvider: 'claude' | 'codex' | string;
  /** Deep-linked sub-tab (e.g. from the provider dropdown's CLI entry); wins over currentProvider inference */
  initialSubTab?: ProviderManageTab;
  // Claude provider props
  providers: ProviderConfig[];
  loading: boolean;
  onAddProvider: () => void;
  onEditProvider: (provider: ProviderConfig) => void;
  onDeleteProvider: (provider: ProviderConfig) => void;
  onSwitchProvider: (id: string) => void;
  // Codex provider props
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  onRevokeCodexLocalConfigAuthorization: (fallbackProviderId?: string) => void;
  // Shared
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

const ProviderTabSection = ({
  currentProvider,
  initialSubTab,
  providers,
  loading,
  onAddProvider,
  onEditProvider,
  onDeleteProvider,
  onSwitchProvider,
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  onRevokeCodexLocalConfigAuthorization,
  addToast,
}: ProviderTabSectionProps) => {
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<ProviderManageTab>(() => {
    if (initialSubTab) return initialSubTab;
    if (currentProvider === 'codex') return 'codex';
    if (currentProvider === 'codebuddy') return 'codebuddy';
    // Grok / Kimi / MiniMax / OpenCode / PI / OMP / DSH share the CLI management surface.
    if (currentProvider === 'grok' || currentProvider === 'kimi'
      || currentProvider === 'minimax'
      || currentProvider === 'opencode' || currentProvider === 'pi'
      || currentProvider === 'omp' || currentProvider === 'dsh') {
      return 'cli';
    }
    return 'claude';
  });

  // Plugin-level custom model management
  const claudeModels = usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
  const codexModels = usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS);
  const codeBuddyModels = useCodeBuddyModelsConfig(activeTab === 'codebuddy');
  const claudeConfiguredModelPricing = useConfiguredClaudeModelPricing(claudeModels.models);

  // Dialog state
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [modelDialogAddMode, setModelDialogAddMode] = useState(false);
  // Which plugin's models the dialog is editing
  const [dialogTarget, setDialogTarget] = useState<ModelDialogTarget>('claude');

  const openModelDialog = useCallback((target: ModelDialogTarget, addMode = false) => {
    setDialogTarget(target);
    setModelDialogAddMode(addMode);
    setModelDialogOpen(true);
  }, []);

  const closeModelDialog = useCallback(() => {
    setModelDialogOpen(false);
    setModelDialogAddMode(false);
  }, []);

  const activeModels = dialogTarget === 'claude'
    ? claudeModels
    : dialogTarget === 'codex'
      ? codexModels
      : codeBuddyModels;

  useEffect(() => {
    if (modelDialogOpen && dialogTarget === 'codebuddy') {
      codeBuddyModels.refresh();
    }
  }, [codeBuddyModels.refresh, dialogTarget, modelDialogOpen]);

  return (
    <div className={styles.providerTabSection}>
      <h3 className={styles.sectionTitle}>{t('settings.providers')}</h3>
      <p className={styles.sectionDesc}>{t('settings.providersDesc')}</p>

      <div className={styles.tabSelector} role="tablist" aria-label={t('settings.providers')}>
        <button
          role="tab"
          aria-selected={activeTab === 'claude'}
          aria-controls="panel-claude-providers"
          className={`${styles.tabBtn} ${activeTab === 'claude' ? styles.active : ''}`}
          onClick={() => setActiveTab('claude')}
        >
          <span className="codicon codicon-vm-connect" aria-hidden="true" />
          {t('settings.providerTab.claude')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'codex'}
          aria-controls="panel-codex-providers"
          className={`${styles.tabBtn} ${activeTab === 'codex' ? styles.active : ''}`}
          onClick={() => setActiveTab('codex')}
        >
          <span className="codicon codicon-terminal" aria-hidden="true" />
          {t('settings.providerTab.codex')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'codebuddy'}
          aria-controls="panel-codebuddy-providers"
          className={`${styles.tabBtn} ${activeTab === 'codebuddy' ? styles.active : ''}`}
          onClick={() => setActiveTab('codebuddy')}
        >
          <ProviderModelIcon providerId="codebuddy" size={16} colored />
          {t('settings.providerTab.codebuddy')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'cli'}
          aria-controls="panel-cli-tools"
          className={`${styles.tabBtn} ${activeTab === 'cli' ? styles.active : ''}`}
          onClick={() => setActiveTab('cli')}
        >
          <span className="codicon codicon-terminal-bash" aria-hidden="true" />
          {t('settings.providerTab.cli')}
        </button>
      </div>

      {/* Mount only the active sub-tab. Previously display:none kept CliSection
          mounted so get_cli_status ran as soon as the Providers tab opened. */}
      {activeTab === 'claude' && (
        <div id="panel-claude-providers" role="tabpanel">
          <div
            className={styles.pluginModelsRow}
            onClick={() => openModelDialog('claude')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openModelDialog('claude'); }}
          >
            <span className="codicon codicon-symbol-misc" style={ICON_14_STYLE} />
            <span className={styles.pluginModelsLabel}>
              {t('settings.pluginModels.title')}
            </span>
            {claudeModels.models.length > 0 && (
              <span className={styles.pluginModelsBadge}>{claudeModels.models.length}</span>
            )}
            <span style={FLEX_1_STYLE} />
            <button
              className={styles.pluginModelsManageBtn}
              onClick={(e) => { e.stopPropagation(); openModelDialog('claude'); }}
            >
              {t('settings.pluginModels.manage')}
            </button>
          </div>
          <ProviderManageSection
            providers={providers}
            loading={loading}
            onAddProvider={onAddProvider}
            onEditProvider={onEditProvider}
            onDeleteProvider={onDeleteProvider}
            onSwitchProvider={onSwitchProvider}
            addToast={addToast}
            showHeader={false}
          />
        </div>
      )}

      {activeTab === 'codex' && (
        <div id="panel-codex-providers" role="tabpanel">
          <div
            className={styles.pluginModelsRow}
            onClick={() => openModelDialog('codex')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openModelDialog('codex'); }}
          >
            <span className="codicon codicon-symbol-misc" style={ICON_14_STYLE} />
            <span className={styles.pluginModelsLabel}>
              {t('settings.pluginModels.title')}
            </span>
            {codexModels.models.length > 0 && (
              <span className={styles.pluginModelsBadge}>{codexModels.models.length}</span>
            )}
            <span style={FLEX_1_STYLE} />
            <button
              className={styles.pluginModelsManageBtn}
              onClick={(e) => { e.stopPropagation(); openModelDialog('codex'); }}
            >
              {t('settings.pluginModels.manage')}
            </button>
          </div>
          <CodexProviderSection
            codexProviders={codexProviders}
            codexLoading={codexLoading}
            onAddCodexProvider={onAddCodexProvider}
            onEditCodexProvider={onEditCodexProvider}
            onDeleteCodexProvider={onDeleteCodexProvider}
            onSwitchCodexProvider={onSwitchCodexProvider}
            onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
            addToast={addToast}
            showHeader={false}
          />
        </div>
      )}

      {activeTab === 'codebuddy' && (
        <div id="panel-codebuddy-providers" role="tabpanel">
          <div
            className={styles.pluginModelsRow}
            onClick={() => openModelDialog('codebuddy')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openModelDialog('codebuddy'); }}
          >
            <span className="codicon codicon-symbol-misc" style={ICON_14_STYLE} />
            <span className={styles.pluginModelsLabel}>
              {t('settings.codebuddyProvider.modelsTitle')}
            </span>
            {codeBuddyModels.models.length > 0 && (
              <span className={styles.pluginModelsBadge}>{codeBuddyModels.models.length}</span>
            )}
            <span style={FLEX_1_STYLE} />
            <button
              type="button"
              className={styles.pluginModelsManageBtn}
              onClick={(e) => { e.stopPropagation(); codeBuddyModels.refresh(); }}
            >
              {t('settings.codebuddyProvider.refreshModels')}
            </button>
            <button
              type="button"
              className={styles.pluginModelsManageBtn}
              onClick={(e) => { e.stopPropagation(); openModelDialog('codebuddy'); }}
            >
              {t('settings.pluginModels.manage')}
            </button>
          </div>
          <p className={styles.pluginModelsDescription}>
            {t('settings.codebuddyProvider.modelsDescription')}
          </p>
          <CodeBuddyProviderSection addToast={addToast} showHeader={false} />
        </div>
      )}

      {activeTab === 'cli' && (
        <div id="panel-cli-tools" role="tabpanel">
          <CliSection addToast={addToast} />
        </div>
      )}

      {/* Shared model management dialog */}
      <CustomModelDialog
        isOpen={modelDialogOpen}
        models={activeModels.models}
        onModelsChange={activeModels.updateModels}
        configuredModels={dialogTarget === 'claude' ? claudeConfiguredModelPricing.configuredModels : []}
        onConfiguredModelPricingChange={
          dialogTarget === 'claude'
            ? claudeConfiguredModelPricing.updateConfiguredModelPricing
            : undefined
        }
        onClose={closeModelDialog}
        contextWindowEnabled={dialogTarget === 'codex'}
        codeBuddyConfigEnabled={dialogTarget === 'codebuddy'}
        initialAddMode={modelDialogAddMode}
      />
    </div>
  );
};

export default ProviderTabSection;
