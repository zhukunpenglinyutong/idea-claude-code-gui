import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../ConfirmDialog';
import {
  aiDataStorageBridge,
  type AiDataDirectoryOperation,
  type AiDataDirectoryStatus,
} from './aiDataStorageBridge';
import styles from './style.module.less';

interface AiDataStorageSectionProps {
  addToast: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
}

type Confirmation =
  | { operation: 'migrate'; targetRoot: string }
  | { operation: 'cleanup' }
  | null;

function comparablePath(path: string, platform?: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'windows' ? normalized.toLowerCase() : normalized;
}

export default function AiDataStorageSection({ addToast }: AiDataStorageSectionProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AiDataDirectoryStatus | null>(null);
  const [targetRoot, setTargetRoot] = useState('');
  const [pending, setPending] = useState<AiDataDirectoryOperation['operation'] | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  useEffect(() => {
    const unsubscribeStatus = aiDataStorageBridge.subscribeStatus((nextStatus) => {
      setStatus(nextStatus);
      setTargetRoot((current) => current || nextStatus.storageRoot || '');
      if (nextStatus.recovered) addToast(t('settings.storage.recovered'), 'warning');
    });
    const unsubscribeRoot = aiDataStorageBridge.subscribeRoot(setTargetRoot);
    const unsubscribeOperation = aiDataStorageBridge.subscribeOperation((operation) => {
      setPending(null);
      if (operation.status) setStatus(operation.status);
      if (operation.success) {
        if (operation.operation === 'migrate') addToast(t('settings.storage.migrateSuccess'), 'success');
        if (operation.operation === 'cleanup') addToast(t('settings.storage.cleanupSuccess'), 'success');
      } else {
        addToast(t('settings.storage.operationFailed', {
          error: operation.error ?? 'AI_DATA_DIRECTORY_OPERATION_FAILED',
        }), 'error');
      }
    });
    aiDataStorageBridge.getStatus();
    return () => {
      unsubscribeStatus();
      unsubscribeRoot();
      unsubscribeOperation();
    };
  }, [addToast, t]);

  const requestMigration = () => {
    const normalized = targetRoot.trim();
    if (!normalized || pending !== null) return;
    setConfirmation({ operation: 'migrate', targetRoot: normalized });
  };

  const requestCleanup = () => {
    if (pending !== null) return;
    setConfirmation({ operation: 'cleanup' });
  };

  const confirmOperation = () => {
    if (!confirmation || pending !== null) return;
    setConfirmation(null);
    setPending(confirmation.operation);
    if (confirmation.operation === 'migrate') {
      aiDataStorageBridge.migrate(confirmation.targetRoot);
    } else {
      aiDataStorageBridge.cleanupBackups();
    }
  };

  const directoryCount = status?.directories.length ?? 0;
  const linkedCount = status?.directories.filter((entry) => entry.state === 'linked').length ?? 0;
  const allLinked = directoryCount > 0 && linkedCount === directoryCount;
  const currentStorageSelected = allLinked
    && Boolean(status?.storageRoot)
    && comparablePath(targetRoot, status?.platform) === comparablePath(status?.storageRoot ?? '', status?.platform);
  const migrationTarget = confirmation?.operation === 'migrate' ? confirmation.targetRoot : null;
  const confirmationIsMigration = migrationTarget !== null;

  return (
    <div className={styles.section}>
      <h3 className={styles.title}>{t('settings.storage.title')}</h3>
      <p className={styles.description}>{t('settings.storage.description')}</p>

      {status?.wsl && (
        <div className={styles.warning}>
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('settings.storage.wslUnsupported')}</span>
        </div>
      )}
      <div className={styles.directoryListHeader}>
        <div className={styles.directorySummary}>
          <h4>{t('settings.storage.statusTitle')}</h4>
          {status && (
            <span>{t('settings.storage.statusSummary', { linked: linkedCount, total: directoryCount })}</span>
          )}
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={aiDataStorageBridge.getStatus}
          disabled={pending !== null}
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
        >
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </button>
      </div>
      <div className={styles.directoryList}>
        {status?.directories.map((entry) => (
          <div key={entry.id} className={styles.directoryRow}>
            <div className={styles.directoryIdentity}>
              <strong>.{entry.id}</strong>
              <span className={`${styles.state} ${styles[`state_${entry.state}`]}`}>
                {t(`settings.storage.states.${entry.state}`)}
              </span>
            </div>
            <div className={styles.pathList}>
              <div className={styles.pathLine} title={entry.canonicalPath}>
                <span>{t('settings.storage.canonicalPath')}</span>
                <code>{entry.canonicalPath}</code>
              </div>
              {entry.physicalPath && (
                <div className={styles.pathLine} title={entry.physicalPath}>
                  <span>{t('settings.storage.physicalPath')}</span>
                  <code>{entry.physicalPath}</code>
                </div>
              )}
            </div>
          </div>
        )) ?? <div className={styles.loading}>{t('common.loading')}</div>}
      </div>

      <label className={styles.targetField}>
        <span>{allLinked ? t('settings.storage.currentRoot') : t('settings.storage.targetRoot')}</span>
        <div className={styles.targetRow}>
          <input
            type="text"
            value={targetRoot}
            maxLength={2048}
            disabled={pending !== null || status?.supported === false}
            onChange={(event) => setTargetRoot(event.target.value)}
            placeholder={t('settings.storage.targetPlaceholder')}
          />
          <button
            type="button"
            className={styles.iconButton}
            onClick={aiDataStorageBridge.chooseRoot}
            disabled={pending !== null || status?.supported === false}
            title={t('settings.storage.chooseRoot')}
            aria-label={t('settings.storage.chooseRoot')}
          >
            <span className="codicon codicon-folder-opened" aria-hidden="true" />
          </button>
        </div>
      </label>

      <p className={styles.hint}>
        <span className="codicon codicon-info" aria-hidden="true" />
        <span>{t('settings.storage.migrationHint')}</span>
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={requestMigration}
          disabled={!targetRoot.trim() || pending !== null || status?.supported === false || currentStorageSelected}
        >
          <span className="codicon codicon-move" aria-hidden="true" />
          {pending === 'migrate'
            ? t('settings.storage.migrating')
            : currentStorageSelected
              ? t('settings.storage.alreadyMigrated')
              : t('settings.storage.migrate')}
        </button>
        {(status?.backupCount ?? 0) > 0 && (
          <button type="button" className={styles.dangerButton} onClick={requestCleanup} disabled={pending !== null}>
            <span className="codicon codicon-trash" aria-hidden="true" />
            {pending === 'cleanup'
              ? t('settings.storage.cleaning')
              : t('settings.storage.cleanupBackups', { count: status?.backupCount ?? 0 })}
          </button>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmation !== null}
        title={confirmationIsMigration
          ? t('settings.storage.migrateConfirmTitle')
          : t('settings.storage.cleanupConfirmTitle')}
        message={confirmationIsMigration
          ? t('settings.storage.migrateConfirm')
          : t('settings.storage.cleanupConfirm')}
        confirmText={confirmationIsMigration
          ? t('settings.storage.confirmMigration')
          : t('settings.storage.deleteBackups')}
        cancelText={t('common.cancel')}
        onConfirm={confirmOperation}
        onCancel={() => setConfirmation(null)}
      >
        {confirmationIsMigration && (
          <div className={styles.confirmDetails}>
            <span>{t('settings.storage.targetRoot')}</span>
            <code title={migrationTarget}>{migrationTarget}</code>
            <div className={styles.confirmWarning}>
              <span className="codicon codicon-warning" aria-hidden="true" />
              <span>{t('settings.storage.migrationWarning')}</span>
            </div>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
