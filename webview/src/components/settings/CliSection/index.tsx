import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { copyToClipboard } from '../../../utils/copyUtils';
import { openBrowserExternal } from '../../../utils/bridge';
import DshConnectionCard from './DshConnectionCard';
import { useHiddenCliProviders } from '../../../hooks/useCliProviderVisibility';
import { setCliProviderHidden } from '../../../utils/cliProviderVisibility';
import {
  CLI_TOOL_DEFINITIONS,
  type CliStatusMap,
  type CliToolDefinition,
  type CliToolId,
  type CliToolStatus,
} from '../../../types/cliTool';
import styles from './style.module.less';

interface CliSectionProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

interface CliToolCardProps {
  tool: CliToolDefinition;
  status?: CliToolStatus;
  onOpenInstall: (id: CliToolId) => void;
  onOpenDocs: (url: string) => void;
  /** Hidden from the provider switcher dropdown */
  switcherHidden: boolean;
  onToggleSwitcherVisibility: (id: CliToolId, hidden: boolean) => void;
  /** Nested inside a product group — show a role label instead of repeating the product name. */
  nested?: boolean;
  displayName?: string;
}

const CliToolCard = ({
  tool,
  status,
  onOpenInstall,
  onOpenDocs,
  switcherHidden,
  onToggleSwitcherVisibility,
  nested = false,
  displayName,
}: CliToolCardProps) => {
  const { t } = useTranslation();
  const installed = status?.installed === true;
  const version = status?.version;
  const path = status?.path;
  const description = t(tool.descriptionKey);
  // Prefer path when installed; fall back to description for missing tools.
  const meta = installed && path ? path : description;
  const metaTitle = installed && path
    ? `${description}\n${path}`
    : description;
  const howToInstallLabel = t('settings.cli.howToInstall');
  const openDocsLabel = t('settings.cli.installDialog.openDocs');
  const name = displayName ?? t(tool.nameKey);
  const visibilityLabel = switcherHidden
    ? t('settings.cli.visibility.show', { defaultValue: 'Show in provider switcher' })
    : t('settings.cli.visibility.hide', { defaultValue: 'Hide in provider switcher' });

  return (
    <div
      className={`${styles.cliCard} ${installed ? styles.installed : styles.missing} ${nested ? styles.nestedCard : ''} ${switcherHidden ? styles.switcherHidden : ''}`}
    >
      <div className={styles.cliMain} title={metaTitle}>
        <div className={styles.cliIcon}>
          {nested ? (
            <span className="codicon codicon-terminal" aria-hidden="true" />
          ) : (
            <ProviderModelIcon providerId={tool.id} size={16} colored />
          )}
        </div>

        <span className={styles.cliName} title={name}>{name}</span>
        {installed && version && (
          <span className={styles.versionBadge}>v{version}</span>
        )}
        {!installed && (
          <span className={styles.binaryChip}>{tool.binaryName}</span>
        )}
        <span className={styles.cliMeta}>{meta}</span>
      </div>

      <div className={styles.cliActions}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => onToggleSwitcherVisibility(tool.id, !switcherHidden)}
          data-tooltip={visibilityLabel}
          title={visibilityLabel}
          aria-label={visibilityLabel}
          aria-pressed={switcherHidden}
        >
          <span className={`codicon ${switcherHidden ? 'codicon-eye-closed' : 'codicon-eye'}`} />
        </button>
        {installed ? (
          <>
            <span className={`${styles.statusBadge} ${styles.ok}`}>
              <span className="codicon codicon-check" aria-hidden="true" />
              {t('settings.cli.status.installed')}
            </span>
            <span className={styles.divider} aria-hidden="true" />
            <div className={styles.actionButtons}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => onOpenInstall(tool.id)}
                data-tooltip={howToInstallLabel}
                title={howToInstallLabel}
                aria-label={howToInstallLabel}
              >
                <span className="codicon codicon-book" />
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => onOpenDocs(tool.docsUrl)}
                data-tooltip={openDocsLabel}
                title={openDocsLabel}
                aria-label={openDocsLabel}
              >
                <span className="codicon codicon-link-external" />
              </button>
            </div>
          </>
        ) : (
          <>
            <span className={`${styles.statusBadge} ${styles.missing}`}>
              {t('settings.cli.status.notInstalled')}
            </span>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => onOpenInstall(tool.id)}
            >
              <span className="codicon codicon-desktop-download" aria-hidden="true" />
              {t('settings.cli.viewInstallGuide')}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

/** Java may not answer get_cli_status (handler absent) — show an error instead of spinning forever. */
const CLI_STATUS_TIMEOUT_MS = 15_000;

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

const isCliToolStatus = (value: unknown): value is CliToolStatus => {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.installed === 'boolean';
};

const parseCliStatusPayload = (json: string): CliStatusMap | null => {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.error === 'string') {
      return null;
    }
    const map: CliStatusMap = {};
    for (const def of CLI_TOOL_DEFINITIONS) {
      const entry = parsed[def.id];
      if (isCliToolStatus(entry)) {
        map[def.id] = entry;
      }
    }
    return map;
  } catch {
    return null;
  }
};

interface InstallDialogProps {
  tool: CliToolDefinition | null;
  onClose: () => void;
  onCopy: (text: string) => void;
  onOpenDocs: (url: string) => void;
}

const InstallDialog = ({ tool, onClose, onCopy, onOpenDocs }: InstallDialogProps) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (!tool) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, onClose]);

  if (!tool) return null;

  const name = t(tool.nameKey);

  return (
    <div className={styles.dialogOverlay} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-install-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.dialogHeader}>
          <span className="codicon codicon-terminal" aria-hidden="true" />
          <h4 id="cli-install-dialog-title" className={styles.dialogTitle}>
            {t('settings.cli.installDialog.title', { name })}
          </h4>
          <button
            type="button"
            className={styles.dialogClose}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className={styles.dialogBody}>
          <p className={styles.dialogLead}>
            {t('settings.cli.installDialog.lead', { name, binary: tool.binaryName })}
          </p>

          <ol className={styles.stepList}>
            <li>{t('settings.cli.installDialog.stepOpenTerminal')}</li>
            <li>{t('settings.cli.installDialog.stepRunCommand')}</li>
            <li>{t('settings.cli.installDialog.stepVerify', { binary: tool.binaryName })}</li>
            <li>{t('settings.cli.installDialog.stepReturn')}</li>
          </ol>

          <p className={styles.commandLabel}>{t('settings.cli.installDialog.primaryCommand')}</p>
          <div className={styles.commandBlock}>
            {tool.installCommand}
            <button
              type="button"
              className={styles.copyBtn}
              onClick={() => onCopy(tool.installCommand)}
              title={t('settings.cli.copy')}
              aria-label={t('settings.cli.copy')}
            >
              <span className="codicon codicon-copy" />
            </button>
          </div>

          {tool.installCommandWindows && (
            <>
              <p className={styles.commandLabel}>{t('settings.cli.installDialog.windowsCommand')}</p>
              <div className={styles.commandBlock}>
                {tool.installCommandWindows}
                <button
                  type="button"
                  className={styles.copyBtn}
                  onClick={() => onCopy(tool.installCommandWindows!)}
                  title={t('settings.cli.copy')}
                  aria-label={t('settings.cli.copy')}
                >
                  <span className="codicon codicon-copy" />
                </button>
              </div>
            </>
          )}

          {tool.altInstallCommand && (
            <>
              <p className={styles.commandLabel}>{t('settings.cli.installDialog.altCommand')}</p>
              <div className={styles.commandBlock}>
                {tool.altInstallCommand}
                <button
                  type="button"
                  className={styles.copyBtn}
                  onClick={() => onCopy(tool.altInstallCommand!)}
                  title={t('settings.cli.copy')}
                  aria-label={t('settings.cli.copy')}
                >
                  <span className="codicon codicon-copy" />
                </button>
              </div>
            </>
          )}

          <a
            className={styles.docsLink}
            href={tool.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => {
              // JCEF won't route target=_blank to the system browser — go through the bridge.
              e.preventDefault();
              onOpenDocs(tool.docsUrl);
            }}
          >
            <span className="codicon codicon-link-external" aria-hidden="true" />
            {t('settings.cli.installDialog.openDocs')}
          </a>
        </div>

        <div className={styles.dialogFooter}>
          <button type="button" className={styles.dialogPrimaryBtn} onClick={onClose}>
            {t('common.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
};

const CliSection = ({ addToast }: CliSectionProps) => {
  const { t } = useTranslation();
  const [statusMap, setStatusMap] = useState<CliStatusMap>({});
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [installTool, setInstallTool] = useState<CliToolDefinition | null>(null);
  const addToastRef = useRef(addToast);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenProviders = useHiddenCliProviders();

  useEffect(() => {
    addToastRef.current = addToast;
  }, [addToast]);

  const clearStatusTimeout = useCallback(() => {
    if (statusTimeoutRef.current) {
      clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = null;
    }
  }, []);

  const requestStatus = useCallback(() => {
    clearStatusTimeout();
    setLoading(true);
    setStatusError(false);
    sendToJava('get_cli_status:');
    statusTimeoutRef.current = setTimeout(() => {
      statusTimeoutRef.current = null;
      setStatusError(true);
      setLoading(false);
    }, CLI_STATUS_TIMEOUT_MS);
  }, [clearStatusTimeout]);

  useEffect(() => {
    const previous = window.updateCliStatus;
    window.updateCliStatus = (json: string) => {
      clearStatusTimeout();
      const parsed = parseCliStatusPayload(json);
      // A payload that parses but matches no known tool means the shape is
      // unknown — treat it as an error, not "everything not installed".
      if (!parsed || Object.keys(parsed).length === 0) {
        setStatusError(true);
        setLoading(false);
        return;
      }
      setStatusMap(parsed);
      setStatusError(false);
      setLoading(false);
    };

    requestStatus();

    return () => {
      window.updateCliStatus = previous;
      clearStatusTimeout();
    };
  }, [requestStatus, clearStatusTimeout]);

  const handleCopy = useCallback(async (text: string) => {
    const ok = await copyToClipboard(text);
    addToastRef.current?.(
      ok ? t('settings.cli.copied') : t('settings.cli.copyFailed'),
      ok ? 'success' : 'error',
    );
  }, [t]);

  const openInstallGuide = useCallback((id: CliToolId) => {
    const def = CLI_TOOL_DEFINITIONS.find((item) => item.id === id) ?? null;
    setInstallTool(def);
  }, []);

  const openDocs = useCallback((url: string) => {
    // CLI docs pages are SPAs that often render blank in the embedded JCEF
    // preview — open them in the system default browser instead.
    openBrowserExternal(url);
  }, []);
  const toggleSwitcherVisibility = useCallback((id: CliToolId, hidden: boolean) => {
    setCliProviderHidden(id, hidden);
  }, []);

  const { installedCount, totalCount, hasStatus } = useMemo(() => {
    const total = CLI_TOOL_DEFINITIONS.length;
    const known = CLI_TOOL_DEFINITIONS.filter((tool) => statusMap[tool.id] !== undefined);
    const installed = known.filter((tool) => statusMap[tool.id]?.installed).length;
    return {
      installedCount: installed,
      totalCount: total,
      hasStatus: known.length > 0,
    };
  }, [statusMap]);

  const summaryClass =
    hasStatus && installedCount === totalCount
      ? styles.ready
      : hasStatus && installedCount > 0
        ? styles.partial
        : undefined;

  return (
    <div className={styles.cliSection}>
      <div className={styles.header}>
        <div className={styles.headerTitleRow}>
          <div className={styles.headerTitleGroup}>
            <h4 className={styles.headerTitle}>{t('settings.cli.listTitle')}</h4>
            {hasStatus && !loading && (
              <span className={`${styles.summaryBadge} ${summaryClass ?? ''}`}>
                {t('settings.cli.summary', {
                  installed: installedCount,
                  total: totalCount,
                })}
              </span>
            )}
          </div>
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={requestStatus}
            disabled={loading}
          >
            <span className={`codicon codicon-refresh ${loading ? 'codicon-modifier-spin' : ''}`} />
            {t('settings.cli.refresh')}
          </button>
        </div>
        <p className={styles.headerHint}>{t('settings.cli.hint')}</p>
      </div>

      <div className={styles.cliList}>
        {loading && Object.keys(statusMap).length === 0 ? (
          <div className={styles.loadingState}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.cli.loading')}</span>
          </div>
        ) : statusError && Object.keys(statusMap).length === 0 ? (
          <div className={styles.errorState}>
            <span className="codicon codicon-warning" />
            <span>{t('settings.cli.loadFailed')}</span>
            <button type="button" className={styles.refreshBtn} onClick={requestStatus}>
              <span className="codicon codicon-refresh" />
              {t('settings.cli.retry')}
            </button>
          </div>
        ) : (
          CLI_TOOL_DEFINITIONS.map((tool) => {
            if (tool.id !== 'dsh') {
              return (
                <CliToolCard
                  key={tool.id}
                  tool={tool}
                  status={statusMap[tool.id]}
                  onOpenInstall={openInstallGuide}
                  onOpenDocs={openDocs}
                  switcherHidden={hiddenProviders.has(tool.id)}
                  onToggleSwitcherVisibility={toggleSwitcherVisibility}
                />
              );
            }

            const dshInstalled = statusMap.dsh?.installed === true;
            return (
              <div
                key={tool.id}
                className={`${styles.dshGroup} ${dshInstalled ? styles.installed : ''}`}
                data-testid="dsh-group"
                role="group"
                aria-labelledby="dsh-group-title"
              >
                <div className={styles.dshGroupHeader}>
                  <div className={styles.cliIcon}>
                    <ProviderModelIcon providerId={tool.id} size={16} colored />
                  </div>
                  <span
                    id="dsh-group-title"
                    className={styles.dshGroupTitle}
                    title={t('settings.cli.dsh.groupTitle')}
                  >
                    {t('settings.cli.dsh.groupTitle')}
                  </span>
                </div>
                <CliToolCard
                  tool={tool}
                  status={statusMap[tool.id]}
                  onOpenInstall={openInstallGuide}
                  onOpenDocs={openDocs}
                  switcherHidden={hiddenProviders.has(tool.id)}
                  onToggleSwitcherVisibility={toggleSwitcherVisibility}
                  nested
                  displayName={t('settings.cli.dsh.cliRowTitle')}
                />
                {dshInstalled && <DshConnectionCard nested />}
              </div>
            );
          })
        )}
      </div>

      {!loading && !statusError && Object.keys(statusMap).length > 0 && (
        <p className={styles.moreComing}>{t('settings.cli.moreComingSoon')}</p>
      )}

      <InstallDialog
        tool={installTool}
        onClose={() => setInstallTool(null)}
        onCopy={handleCopy}
        onOpenDocs={openDocs}
      />
    </div>
  );
};

export default CliSection;
