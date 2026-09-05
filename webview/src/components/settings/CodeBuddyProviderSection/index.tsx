import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sendToJava } from '../../../utils/bridge';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import sharedStyles from '../ProviderList/style.module.less';
import styles from './style.module.less';

interface CodeBuddyStatus {
  authorized: boolean;
  authenticated: boolean;
  configAvailable: boolean;
  errorCode?: string;
  error?: string;
}

interface CodeBuddyProviderSectionProps {
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  showHeader?: boolean;
}

const EMPTY_STATUS: CodeBuddyStatus = {
  authorized: false,
  authenticated: false,
  configAvailable: false,
};

// The status probe checks the CodeBuddy CLI authentication state and may take
// 1–2 seconds. Keep the last successful result in memory so switching settings
// tabs renders immediately while an explicit refresh still gets fresh data.
let statusCache: CodeBuddyStatus | null = null;

const CodeBuddyProviderSection = ({ addToast, showHeader = true }: CodeBuddyProviderSectionProps) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodeBuddyStatus>(() => statusCache ?? EMPTY_STATUS);
  const [loading, setLoading] = useState(() => statusCache === null);
  const [authorizing, setAuthorizing] = useState(false);

  const requestStatus = useCallback(() => {
    if (statusCache) {
      setStatus(statusCache);
      setLoading(false);
    } else {
      setLoading(true);
    }
    // Keep cached content visible while Java refreshes the status in the
    // background. Java also has a short-lived cache, so this remains fast
    // without allowing authorization changes to become permanently stale.
    sendToJava('get_codebuddy_local_config_status');
  }, []);

  useEffect(() => {
    const handleStatus = (json: string) => {
      try {
        const next = JSON.parse(json) as CodeBuddyStatus;
        const normalized = { ...EMPTY_STATUS, ...next };
        statusCache = normalized;
        setStatus(normalized);
        setLoading(false);
        setAuthorizing(false);
        if (next.authorized) window.dispatchEvent(new Event('codebuddy-models-config-refresh'));
        if (next.errorCode === 'CODEBUDDY_LOGIN_REQUIRED') {
          addToast(t('settings.codebuddyProvider.loginRequired'), 'warning');
        }
      } catch {
        setLoading(false);
        setAuthorizing(false);
      }
    };

    window.updateCodeBuddyLocalConfigStatus = handleStatus;
    requestStatus();
    return () => {
      if (window.updateCodeBuddyLocalConfigStatus === handleStatus) {
        delete window.updateCodeBuddyLocalConfigStatus;
      }
    };
  }, [addToast, requestStatus, t]);

  const handleAuthorize = () => {
    statusCache = null;
    setAuthorizing(true);
    sendToJava('authorize_codebuddy_local_config');
  };

  const handleRevoke = () => {
    statusCache = { ...EMPTY_STATUS };
    setStatus(statusCache);
    setLoading(false);
    sendToJava('revoke_codebuddy_local_config');
  };

  return (
    <div className={styles.section}>
      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.codebuddyProvider.title')}</h3>
          <p className={styles.sectionDesc}>{t('settings.codebuddyProvider.description')}</p>
        </>
      )}

      <div className={`${sharedStyles.card} ${status.authorized ? sharedStyles.active : ''} ${styles.accessCard}`}>
        <div className={sharedStyles.cardInfo}>
          <div className={sharedStyles.name}>
            <ProviderModelIcon providerId="codebuddy" size={20} colored />
            <span className={sharedStyles.nameText}>{t('settings.codebuddyProvider.localConfig')}</span>
          </div>
          <div className={sharedStyles.website}>
            {loading
              ? t('settings.provider.loading')
              : status.authorized
                ? t('settings.codebuddyProvider.authorized')
                : t('settings.codebuddyProvider.notAuthorized')}
          </div>
        </div>
        <div className={sharedStyles.cardActions}>
          {status.authorized ? (
            <button className={sharedStyles.revokeButton} onClick={handleRevoke}>
              <span className="codicon codicon-circle-slash" />
              {t('settings.provider.revokeAuthorization')}
            </button>
          ) : (
            <button className={sharedStyles.useButton} onClick={handleAuthorize} disabled={authorizing || loading}>
              <span className="codicon codicon-key" />
              {authorizing ? t('settings.provider.loading') : t('settings.provider.authorizeAndEnable')}
            </button>
          )}
        </div>
      </div>

      {!status.authorized && !loading && (
        <div className={styles.notice}>
          <span className="codicon codicon-info" />
          <span>
            {status.errorCode === 'CODEBUDDY_LOGIN_REQUIRED'
              ? t('settings.codebuddyProvider.loginRequired')
              : t('settings.codebuddyProvider.authorizationRequired')}
          </span>
        </div>
      )}

    </div>
  );
};

export default CodeBuddyProviderSection;
