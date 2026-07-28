import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import { useDragSort } from '../hooks/useDragSort';
import sharedStyles from '../ProviderList/style.module.less';
import styles from './style.module.less';

const ICON_MR_8_STYLE: React.CSSProperties = { marginRight: '8px' };

interface CodexProviderSectionProps {
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  onAuthorizeCodexLocalConfig: () => void;
  onRevokeCodexLocalConfigAuthorization: (fallbackProviderId?: string) => void;
  showHeader?: boolean;
}

const CodexProviderSection = ({
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  onAuthorizeCodexLocalConfig,
  onRevokeCodexLocalConfigAuthorization,
  showHeader = true,
}: CodexProviderSectionProps) => {
  const { t } = useTranslation();

  const [showCliLoginConfirm, setShowCliLoginConfirm] = useState(false);
  const [showCliLoginDisableConfirm, setShowCliLoginDisableConfirm] = useState(false);

  const onSort = useCallback((orderedIds: string[]) => {
    sendToJava('sort_codex_providers', { orderedIds });
  }, []);

  // Filter out CLI Login provider from drag-sort list
  const regularProviders = useMemo(
    () => codexProviders.filter((p) => p.id !== SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );

  const {
    localItems: localProviders,
    draggedId: draggedProviderId,
    dragOverId: dragOverProviderId,
    handlePointerDown,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
  } = useDragSort({
    items: regularProviders,
    onSort,
  });

  const cliLoginProvider = useMemo(
    () => codexProviders.find((p) => p.id === SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );
  const isCliLoginActive = cliLoginProvider?.isActive === true;
  const isCliLoginAuthorized = cliLoginProvider?.localConfigAuthorized === true;

  return (
    <div className={styles.configSection}>
      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.codexProvider.title')}</h3>
          <p className={styles.sectionDesc}>{t('settings.codexProvider.description')}</p>
        </>
      )}

      {/* CLI Login authorize confirm dialog */}
      {showCliLoginConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-key" />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginAuthorizeMessage')}
              <br />
              <br />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeDetail')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => setShowCliLoginConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnPrimary}
                onClick={() => {
                  setShowCliLoginConfirm(false);
                  onAuthorizeCodexLocalConfig();
                }}
              >
                {t('settings.codexProvider.dialog.cliLoginAuthorizeAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLI Login disable confirm dialog */}
      {showCliLoginDisableConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-circle-slash" />
              {t('settings.codexProvider.dialog.cliLoginDisableTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginDisableMessage')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => setShowCliLoginDisableConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnDanger}
                onClick={() => {
                  setShowCliLoginDisableConfirm(false);
                  const firstRegular = regularProviders[0];
                  onRevokeCodexLocalConfigAuthorization(firstRegular?.id);
                }}
              >
                {t('settings.provider.revokeAuthorization')}
              </button>
            </div>
          </div>
        </div>
      )}

      {codexLoading && (
        <div className={styles.tempNotice}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('settings.provider.loading')}</p>
        </div>
      )}

      {!codexLoading && (
        <div className={styles.providerListContainer}>
          <div className={sharedStyles.header}>
            <h4 className={sharedStyles.title}>{t('settings.provider.allProviders')}</h4>
            <div className={sharedStyles.actions}>
              <button
                className={sharedStyles.btnPrimary}
                onClick={onAddCodexProvider}
              >
                <span className="codicon codicon-add" />
                {t('common.add')}
              </button>
            </div>
          </div>

          <div className={sharedStyles.list}>
            {/* CLI Login virtual provider card (pinned at top) */}
            {cliLoginProvider && (
              <div
                className={`${sharedStyles.card} ${isCliLoginActive ? sharedStyles.active : ''} ${sharedStyles.localProviderCard}`}
              >
                <div className={sharedStyles.cardInfo}>
                  <div className={sharedStyles.name}>
                    <span className="codicon codicon-key" style={ICON_MR_8_STYLE} />
                    {t('settings.codexProvider.dialog.cliLoginProviderName')}
                  </div>
                  <div className={sharedStyles.website} title={t('settings.codexProvider.dialog.cliLoginProviderDescription')}>
                    {t('settings.codexProvider.dialog.cliLoginProviderDescription')}
                  </div>
                </div>

                <div className={sharedStyles.cardActions}>
                  {!isCliLoginAuthorized ? (
                    <button
                      className={sharedStyles.useButton}
                      onClick={() => setShowCliLoginConfirm(true)}
                    >
                      <span className="codicon codicon-key" />
                      {t('settings.codexProvider.dialog.cliLoginAuthorizeAction')}
                    </button>
                  ) : (
                    <>
                      {isCliLoginActive ? (
                        <span className={sharedStyles.activeBadge}>
                          <span className="codicon codicon-check" />
                          {t('settings.provider.inUse')}
                        </span>
                      ) : (
                        <button
                          className={sharedStyles.useButton}
                          onClick={() => onSwitchCodexProvider(SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN)}
                        >
                          <span className="codicon codicon-play" />
                          {t('settings.provider.enable')}
                        </button>
                      )}
                      <button
                        className={sharedStyles.revokeButton}
                        onClick={() => setShowCliLoginDisableConfirm(true)}
                      >
                        <span className="codicon codicon-circle-slash" />
                        {t('settings.provider.revokeAuthorization')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Regular providers (drag-sortable) */}
            {localProviders.length > 0 ? (
              localProviders.map((provider) => (
                <div
                  key={provider.id}
                  className={[
                    sharedStyles.card,
                    provider.isActive && sharedStyles.active,
                    draggedProviderId === provider.id && styles.dragging,
                    dragOverProviderId === provider.id && styles.dragOver,
                  ].filter(Boolean).join(' ')}
                  data-drag-sort-id={provider.id}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, provider.id)}
                  onDragOver={(e) => handleDragOver(e, provider.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, provider.id)}
                  onDragEnd={handleDragEnd}
                >
                  <div
                    className={sharedStyles.dragHandle}
                    title={t('settings.provider.dragToSort')}
                    onPointerDown={(e) => handlePointerDown(e, provider.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
                  >
                    <span className="codicon codicon-gripper" />
                  </div>
                  <div className={sharedStyles.cardInfo}>
                    <div className={sharedStyles.name}>{provider.name}</div>
                    {provider.remark && (
                      <div className={sharedStyles.website}>{provider.remark}</div>
                    )}
                  </div>

                  <div className={sharedStyles.cardActions}>
                    {provider.isActive ? (
                      <div className={sharedStyles.activeBadge}>
                        <span className="codicon codicon-check" />
                        {t('settings.provider.inUse')}
                      </div>
                    ) : (
                      <button
                        className={sharedStyles.useButton}
                        onClick={() => onSwitchCodexProvider(provider.id)}
                      >
                        <span className="codicon codicon-play" />
                        {t('settings.provider.enable')}
                      </button>
                    )}

                    <div className={sharedStyles.divider} />

                    <div className={sharedStyles.actionButtons}>
                      <button
                        className={sharedStyles.iconBtn}
                        onClick={() => onEditCodexProvider(provider)}
                        title={t('common.edit')}
                      >
                        <span className="codicon codicon-edit" />
                      </button>
                      <button
                        className={sharedStyles.iconBtn}
                        onClick={() => onDeleteCodexProvider(provider)}
                        title={t('common.delete')}
                      >
                        <span className="codicon codicon-trash" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : !cliLoginProvider ? (
              <div className={sharedStyles.emptyState}>
                <span className="codicon codicon-info" />
                <p>{t('settings.codexProvider.emptyProvider')}</p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default CodexProviderSection;
