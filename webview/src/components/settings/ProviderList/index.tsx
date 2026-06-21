import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import { useDragSort } from '../hooks/useDragSort';
import ImportConfirmDialog from './ImportConfirmDialog';
import styles from './style.module.less';

const ICON_MR_8_STYLE: React.CSSProperties = { marginRight: '8px' };
const CLI_ACCOUNT_INFO_STYLE: React.CSSProperties = { marginTop: '4px', opacity: 0.8 };

interface ProviderListProps {
  providers: ProviderConfig[];
  onAdd: () => void;
  onEdit: (provider: ProviderConfig) => void;
  onDelete: (provider: ProviderConfig) => void;
  onSwitch: (id: string) => void;
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  emptyState?: React.ReactNode;
}

export default function ProviderList({
  providers,
  onAdd,
  onEdit,
  onDelete,
  onSwitch,
  addToast,
  emptyState,
}: ProviderListProps) {
  const { t } = useTranslation();
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<any[]>([]);
  const [editingCcSwitchProvider, setEditingCcSwitchProvider] = useState<ProviderConfig | null>(null);
  const [convertingProvider, setConvertingProvider] = useState<ProviderConfig | null>(null);
  const [showLocalProviderConfirm, setShowLocalProviderConfirm] = useState(false);
  const [showLocalProviderDisableConfirm, setShowLocalProviderDisableConfirm] = useState(false);
  const [showCliLoginConfirm, setShowCliLoginConfirm] = useState(false);
  const [showCliLoginDisableConfirm, setShowCliLoginDisableConfirm] = useState(false);
  const [cliLoginAccountEmail, setCliLoginAccountEmail] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const onSort = useCallback((orderedIds: string[]) => {
    sendToJava('sort_providers', { orderedIds });
  }, []);

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
    items: providers,
    onSort,
    pinnedIds: [
      SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS,
      SPECIAL_PROVIDER_IDS.CLI_LOGIN,
      ...providers.filter((provider) => provider.isCliAccountProvider).map((provider) => provider.id),
    ],
  });

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };

    // Register CLI login account info callback
    window.updateCliLoginAccountInfo = (email: string) => {
      if (mountedRef.current) {
        setCliLoginAccountEmail(email);
      }
    };

    // Register global callback functions for Java invocation
    window.import_preview_result = (dataOrStr) => {
        let data: unknown = dataOrStr;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                console.error('Failed to parse import_preview_result data:', e);
            }
        }
        const event = new CustomEvent('import_preview_result', { detail: data });
        window.dispatchEvent(event);
    };

    window.backend_notification = (...args: unknown[]) => {
        let data: any = {};
        
        // Support multi-argument invocation (type, title, message) to avoid JSON parsing issues
        if (args.length >= 3 && typeof args[0] === 'string' && typeof args[2] === 'string') {
            data = {
                type: args[0],
                title: args[1],
                message: args[2]
            };
        } else if (args.length > 0) {
            // Backward compatible with legacy single-argument JSON format
            let dataOrStr = args[0];
            data = dataOrStr;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch (e) {
                    console.error('Failed to parse backend_notification data:', e);
                }
            }
        }
        
        const event = new CustomEvent('backend_notification', { detail: data });
        window.dispatchEvent(event);
    };

    const handleImportPreview = (event: CustomEvent) => {
      setIsImporting(false); // Received result, hide loading
      const data = event.detail;
      if (data && data.providers) {
        setImportPreviewData(data.providers);
        setShowImportDialog(true);
      }
    };

    const handleBackendNotification = (event: CustomEvent) => {
      setIsImporting(false); // Received notification (possibly an error), hide loading
      const data = event.detail;
      if (data && data.message) {
        addToast(data.message, data.type || 'info');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('import_preview_result', handleImportPreview as EventListener);
    window.addEventListener('backend_notification', handleBackendNotification as EventListener);
    
    return () => {
      mountedRef.current = false;
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('import_preview_result', handleImportPreview as EventListener);
      window.removeEventListener('backend_notification', handleBackendNotification as EventListener);
      
      // Clean up global functions
      delete window.updateCliLoginAccountInfo;
      delete window.import_preview_result;
      delete window.backend_notification;
    };
  }, [addToast]);

  const handleEditClick = (provider: ProviderConfig) => {
    if (provider.source === 'cc-switch') {
      setEditingCcSwitchProvider(provider);
    } else {
      onEdit(provider);
    }
  };

  const handleConvert = () => {
    if (convertingProvider) {
      // 1. Generate a new ID (e.g., append _custom or _local to the original ID, or keep the original ID but remove the source field)
      // The user wants to "disconnect the ID link", meaning cc-switch imports match by ID.
      // If we keep the original ID and only remove the source field:
      //   - The next cc-switch import would still match by ID and prompt an "update".
      //   - After overwriting, the source field would come back.
      // Therefore, to fully "disconnect", we need to change the ID.

      const oldId = convertingProvider.id;
      const newId = `${oldId}_local`; // Or use uuid; appending suffix here for simplicity

      // 2. Build the new configuration
      const newProvider = {
          ...convertingProvider,
          id: newId,
          name: convertingProvider.name + ' (Local)', // Optional: rename to avoid confusion
      };
      delete newProvider.source;

      // 3. Save the new configuration (as an addition)
      sendToJava('add_provider', newProvider);

      // 4. Delete the old configuration
      sendToJava('delete_provider', { id: oldId });

      setConvertingProvider(null);
      addToast(t('settings.provider.convertSuccess'), 'success');

      if (editingCcSwitchProvider && editingCcSwitchProvider.id === convertingProvider.id) {
          setEditingCcSwitchProvider(null);
          // Continue editing the new provider
          onEdit(newProvider);
      }
    }
  };

  const handleSelectFileClick = () => {
    setImportMenuOpen(false);
    setIsImporting(true);
    // Let the backend open the system file chooser to get the correct absolute path
    sendToJava('open_file_chooser_for_cc_switch');
  };

  return (
    <div className={styles.container}>
      {/* Import dialog */}
      {showImportDialog && (
        <ImportConfirmDialog
          providers={importPreviewData}
          existingProviders={providers}
          onConfirm={(selectedProviders) => {
            sendToJava('save_imported_providers', { providers: selectedProviders });
            setShowImportDialog(false);
          }}
          onCancel={() => setShowImportDialog(false)}
        />
      )}

      {/* Import loading */}
      {isImporting && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingContent}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.provider.readingCcSwitch')}</span>
          </div>
        </div>
      )}

      {/* Edit warning dialog */}
      {editingCcSwitchProvider && (
          <div className={styles.warningOverlay}>
              <div className={styles.warningDialog}>
                  <div className={styles.warningTitle}>
                      <span className="codicon codicon-warning" />
                      {t('settings.provider.editCcSwitchTitle')}
                  </div>
                  <div className={styles.warningContent}>
                      {t('settings.provider.editCcSwitchWarning')}
                  </div>
                  <div className={styles.warningActions}>
                      <button
                          className={styles.btnSecondary}
                          onClick={() => setEditingCcSwitchProvider(null)}
                      >
                          {t('common.cancel')}
                      </button>
                      <button
                          className={styles.btnSecondary}
                          onClick={() => {
                              const p = editingCcSwitchProvider;
                              setEditingCcSwitchProvider(null);
                              onEdit(p);
                          }}
                      >
                          {t('settings.provider.continueEdit')}
                      </button>
                      <button
                          className={styles.btnWarning}
                          onClick={() => {
                              setConvertingProvider(editingCcSwitchProvider);
                              // setEditingCcSwitchProvider(null); // Keep null to handle after conversion
                          }}
                      >
                          {t('settings.provider.convertAndEdit')}
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Conversion confirmation dialog */}
      {convertingProvider && (
          <div className={styles.warningOverlay}>
              <div className={styles.warningDialog}>
                  <div className={styles.warningTitle}>
                      <span className="codicon codicon-arrow-swap" />
                      {t('settings.provider.convertToPlugin')}
                  </div>
                  <div className={styles.warningContent}>
                      {t('settings.provider.convertConfirmMessage', { name: convertingProvider.name })}<br/><br/>
                      {t('settings.provider.convertDetailMessage')}
                  </div>
                  <div className={styles.warningActions}>
                      <button
                          className={styles.btnSecondary}
                          onClick={() => {
                              setConvertingProvider(null);
                              // If triggered from editing, canceling conversion also cancels editing
                              if (editingCcSwitchProvider) {
                                  setEditingCcSwitchProvider(null);
                              }
                          }}
                      >
                          {t('common.cancel')}
                      </button>
                      <button
                          className={styles.btnPrimary}
                          onClick={handleConvert}
                      >
                          {t('settings.provider.confirmConvert')}
                      </button>
                  </div>
              </div>
          </div>
      )}

      {showLocalProviderConfirm && (
        <div className={styles.warningOverlay}>
          <div className={styles.warningDialog}>
            <div className={styles.warningTitle}>
              <span className="codicon codicon-shield" />
              {t('settings.provider.localProviderAuthorizeTitle')}
            </div>
            <div className={styles.warningContent}>
              {t('settings.provider.localProviderAuthorizeMessage')}
              <br />
              <br />
              {t('settings.provider.localProviderAuthorizeDetail')}
            </div>
            <div className={styles.warningActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowLocalProviderConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => {
                  setShowLocalProviderConfirm(false);
                  onSwitch(SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS);
                }}
              >
                {t('settings.provider.authorizeAndEnable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLocalProviderDisableConfirm && (
        <div className={styles.warningOverlay}>
          <div className={styles.warningDialog}>
            <div className={styles.warningTitle}>
              <span className="codicon codicon-circle-slash" />
              {t('settings.provider.localProviderDisableTitle')}
            </div>
            <div className={styles.warningContent}>
              {t('settings.provider.localProviderDisableMessage')}
            </div>
            <div className={styles.warningActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowLocalProviderDisableConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={styles.btnDanger}
                onClick={() => {
                  setShowLocalProviderDisableConfirm(false);
                  onSwitch(SPECIAL_PROVIDER_IDS.DISABLED);
                }}
              >
                {t('settings.provider.revokeAuthorization')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCliLoginConfirm && (
        <div className={styles.warningOverlay}>
          <div className={styles.warningDialog}>
            <div className={styles.warningTitle}>
              <span className="codicon codicon-key" />
              {t('settings.provider.cliLoginAuthorizeTitle')}
            </div>
            <div className={styles.warningContent}>
              {t('settings.provider.cliLoginAuthorizeMessage')}
              <br />
              <br />
              {t('settings.provider.cliLoginAuthorizeDetail')}
            </div>
            <div className={styles.warningActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowCliLoginConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => {
                  setShowCliLoginConfirm(false);
                  onSwitch(SPECIAL_PROVIDER_IDS.CLI_LOGIN);
                }}
              >
                {t('settings.provider.authorizeAndEnable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCliLoginDisableConfirm && (
        <div className={styles.warningOverlay}>
          <div className={styles.warningDialog}>
            <div className={styles.warningTitle}>
              <span className="codicon codicon-circle-slash" />
              {t('settings.provider.cliLoginDisableTitle')}
            </div>
            <div className={styles.warningContent}>
              {t('settings.provider.cliLoginDisableMessage')}
            </div>
            <div className={styles.warningActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setShowCliLoginDisableConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={styles.btnDanger}
                onClick={() => {
                  setShowCliLoginDisableConfirm(false);
                  setCliLoginAccountEmail(null);
                  onSwitch(SPECIAL_PROVIDER_IDS.DISABLED);
                }}
              >
                {t('settings.provider.revokeAuthorization')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h4 className={styles.title}>{t('settings.provider.allProviders')}</h4>

        <div className={styles.actions}>
          <div className={styles.importMenuWrapper} ref={importMenuRef}>
            <button
              className={styles.btnSecondary}
              onClick={() => setImportMenuOpen(!importMenuOpen)}
            >
              <span className="codicon codicon-cloud-download" />
              {t('settings.provider.import')}
            </button>
            
            {importMenuOpen && (
              <div className={styles.importMenu}>
                <div
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    setIsImporting(true); // Start loading
                    sendToJava('preview_cc_switch_import');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  {t('settings.provider.importFromCcSwitchUpdate')}
                </div>
                <div
                  className={styles.importMenuItem}
                  onClick={handleSelectFileClick}
                >
                  <span className="codicon codicon-file" />
                  {t('settings.provider.importFromCcSwitchFile')}
                </div>
                {/* <div
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast(t('settings.provider.featureComingSoon'), 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  {t('settings.provider.importFromCcSwitchCli')}
                </div>
                <div
                  className={styles.importMenuItem}
                  onClick={() => {
                    setImportMenuOpen(false);
                    addToast(t('settings.provider.featureComingSoon'), 'info');
                  }}
                >
                  <span className="codicon codicon-arrow-swap" />
                  {t('settings.provider.importFromClaudeRouter')}
                </div> */}
              </div>
            )}
          </div>

          <button
            className={styles.btnPrimary}
            onClick={onAdd}
          >
            <span className="codicon codicon-add" />
            {t('common.add')}
          </button>
        </div>
      </div>

      <div className={styles.list}>
        <>
          <div
            key={SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS}
            className={`${styles.card} ${localProviders.some(p => p.id === SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS && p.isActive) ? styles.active : ''} ${styles.localProviderCard}`}
          >
            <div className={styles.cardInfo}>
              <div className={styles.name}>
                <span className="codicon codicon-file" style={ICON_MR_8_STYLE} />
                {t('settings.provider.localProviderName')}
              </div>
              <div className={styles.website} title={t('settings.provider.localProviderDescription')}>
                {t('settings.provider.localProviderDescription')}
              </div>
            </div>

            <div className={styles.cardActions}>
              {localProviders.some(p => p.id === SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS && p.isActive) ? (
                <button
                  className={styles.revokeButton}
                  onClick={() => setShowLocalProviderDisableConfirm(true)}
                >
                  <span className="codicon codicon-circle-slash" />
                  {t('settings.provider.revokeAuthorization')}
                </button>
              ) : (
                <button
                  className={styles.useButton}
                  onClick={() => setShowLocalProviderConfirm(true)}
                >
                  <span className="codicon codicon-play" />
                  {t('settings.provider.authorizeAndEnable')}
                </button>
              )}
            </div>
          </div>

          <div
            key={SPECIAL_PROVIDER_IDS.CLI_LOGIN}
            className={`${styles.card} ${localProviders.some(p => p.id === SPECIAL_PROVIDER_IDS.CLI_LOGIN && p.isActive) ? styles.active : ''} ${styles.localProviderCard}`}
          >
            <div className={styles.cardInfo}>
              <div className={styles.name}>
                <span className="codicon codicon-key" style={ICON_MR_8_STYLE} />
                {t('settings.provider.cliLoginProviderName')}
              </div>
              <div className={styles.website} title={t('settings.provider.cliLoginProviderDescription')}>
                {t('settings.provider.cliLoginProviderDescription')}
              </div>
              <div className={styles.website} style={CLI_ACCOUNT_INFO_STYLE}>
                {t('settings.provider.multiAccountHint')}
              </div>
              {cliLoginAccountEmail && localProviders.some(p => p.id === SPECIAL_PROVIDER_IDS.CLI_LOGIN && p.isActive) && (
                <div className={styles.website} style={CLI_ACCOUNT_INFO_STYLE}>
                  {t('settings.provider.cliLoginAccountInfo', { email: cliLoginAccountEmail })}
                </div>
              )}
            </div>

            <div className={styles.cardActions}>
              <button
                className={styles.useButton}
                onClick={() => sendToJava('save_current_claude_account', {})}
                title={t('settings.provider.saveCurrentAccountHint')}
              >
                <span className="codicon codicon-account" />
                {t('settings.provider.saveCurrentAccount')}
              </button>

              {localProviders.some(p => p.id === SPECIAL_PROVIDER_IDS.CLI_LOGIN && p.isActive) ? (
                <button
                  className={styles.revokeButton}
                  onClick={() => setShowCliLoginDisableConfirm(true)}
                >
                  <span className="codicon codicon-circle-slash" />
                  {t('settings.provider.revokeAuthorization')}
                </button>
              ) : (
                <button
                  className={styles.useButton}
                  onClick={() => setShowCliLoginConfirm(true)}
                >
                  <span className="codicon codicon-play" />
                  {t('settings.provider.authorizeAndEnable')}
                </button>
              )}
            </div>
          </div>

          {localProviders
            .filter((provider) => provider.isCliAccountProvider)
            .map((account) => (
              <div
                key={account.id}
                className={`${styles.card} ${account.isActive ? styles.active : ''} ${styles.localProviderCard}`}
              >
                <div className={styles.cardInfo}>
                  <div className={styles.name}>
                    <span className="codicon codicon-account" style={ICON_MR_8_STYLE} />
                    {account.name}
                  </div>
                  <div className={styles.website}>
                    {account.emailAddress || t('settings.provider.oauthAccount')}
                  </div>
                </div>

                <div className={styles.cardActions}>
                  {account.isActive ? (
                    <div className={styles.activeBadge}>
                      <span className="codicon codicon-check" />
                      {t('settings.provider.inUse')}
                    </div>
                  ) : (
                    <button
                      className={styles.useButton}
                      disabled={!account.isAuthenticated}
                      onClick={() => onSwitch(account.id)}
                    >
                      <span className="codicon codicon-arrow-swap" />
                      {t('settings.provider.enable')}
                    </button>
                  )}
                  <div className={styles.divider} />
                  <button
                    className={styles.iconBtn}
                    onClick={() => onDelete(account)}
                    title={t('common.delete')}
                  >
                    <span className="codicon codicon-trash" />
                  </button>
                </div>
              </div>
            ))}

          {(() => {
            const regularProviders = localProviders.filter(
              p => p.id !== SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS
                && p.id !== SPECIAL_PROVIDER_IDS.CLI_LOGIN
                && !p.isCliAccountProvider
            );
            return regularProviders.length > 0 ? (
              regularProviders.map((provider) => (
            <div
              key={provider.id}
              className={[
                styles.card,
                provider.isActive && styles.active,
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
                className={styles.dragHandle}
                title={t('settings.provider.dragToSort')}
                onPointerDown={(e) => handlePointerDown(e, provider.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
              >
                <span className="codicon codicon-gripper" />
              </div>
              <div className={styles.cardInfo}>
                <div className={styles.name}>
                  {provider.name}
                </div>
                {(provider.remark || provider.websiteUrl) && (
                  <div className={styles.website} title={provider.remark || provider.websiteUrl}>
                    {provider.remark || provider.websiteUrl}
                  </div>
                )}
                {provider.source === 'cc-switch' && (
                    <div className={styles.ccSwitchBadge}>
                        cc-switch
                    </div>
                )}
              </div>
              
              <div className={styles.cardActions}>
                {provider.isActive ? (
                  <div className={styles.activeBadge}>
                    <span className="codicon codicon-check" />
                    {t('settings.provider.inUse')}
                  </div>
                ) : (
                  <button
                    className={styles.useButton}
                    onClick={() => onSwitch(provider.id)}
                  >
                    <span className="codicon codicon-play" />
                    {t('settings.provider.enable')}
                  </button>
                )}

                <div className={styles.divider}></div>

                <div className={styles.actionButtons}>
                  {!provider.isLocalProvider && (
                    <>
                      {provider.source === 'cc-switch' && (
                        <button
                          className={styles.iconBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConvertingProvider(provider);
                          }}
                          title={t('settings.provider.convertToPlugin')}
                        >
                          <span className="codicon codicon-arrow-swap" />
                        </button>
                      )}
                      <button
                        className={styles.iconBtn}
                        onClick={() => handleEditClick(provider)}
                        title={t('common.edit')}
                      >
                        <span className="codicon codicon-edit" />
                      </button>
                      <button
                        className={styles.iconBtn}
                        onClick={() => onDelete(provider)}
                        title={t('common.delete')}
                      >
                        <span className="codicon codicon-trash" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : null;
          })()}

          {(() => {
            const regularProviders = localProviders.filter(p => p.id !== SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS);
            return regularProviders.length === 0 && emptyState ? (
              <div className={styles.emptyState}>
                {emptyState}
              </div>
            ) : null;
          })()}
        </>
      </div>
    </div>
  );
}
