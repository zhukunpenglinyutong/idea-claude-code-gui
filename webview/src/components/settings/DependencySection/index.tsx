import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SdkId,
  SdkStatus,
  InstallProgress,
  InstallResult,
  UninstallResult,
  NodeEnvironmentStatus,
  UpdateCheckResult,
  DependencyVersionInfo,
  DependencyVersionResult,
} from '../../../types/dependency';
import {
  buildVersionOptions,
  getRequestedVersion,
  getVersionAction,
} from './versioning';
import {
  isDependencyStatusResponse,
  requestFreshDependencyStatus,
  requestDependencyStatusUntilSettled,
  retryDependencyStatusRequest,
  settleDependencyStatusRequest,
} from '../../../utils/bridgeStartup';
import styles from './style.module.less';

interface DependencySectionProps {
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  isActive: boolean;
}

interface VersionSelectProps {
  value: string;
  options: string[];
  disabled: boolean;
  label: string;
  valueLabel: string;
  onChange: (version: string) => void;
}

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

const mergeDependencyUpdates = (
  previousStatus: Record<SdkId, SdkStatus>,
  updatePayload: UpdateCheckResult,
): Record<SdkId, SdkStatus> => {
  const nextStatus = { ...previousStatus };

  Object.entries(updatePayload).forEach(([sdkId, updateInfo]) => {
    const typedSdkId = sdkId as SdkId;
    const currentStatus = nextStatus[typedSdkId];
    if (!currentStatus) {
      return;
    }

    nextStatus[typedSdkId] = {
      ...currentStatus,
      hasUpdate: updateInfo.hasUpdate,
      latestVersion: updateInfo.latestVersion,
      lastChecked: new Date().toISOString(),
      errorMessage: updateInfo.error ?? currentStatus.errorMessage,
    };
  });

  return nextStatus;
};

const SDK_DEFINITIONS = [
  {
    id: 'claude-sdk' as SdkId,
    nameKey: 'settings.dependency.claudeSdkName',
    description: 'settings.dependency.claudeSdkDescription',
    relatedProviders: ['anthropic', 'bedrock'],
  },
  {
    id: 'codex-sdk' as SdkId,
    nameKey: 'settings.dependency.codexSdkName',
    description: 'settings.dependency.codexSdkDescription',
    relatedProviders: ['openai'],
  },
  {
    id: 'codebuddy-sdk' as SdkId,
    nameKey: 'settings.dependency.codeBuddySdkName',
    description: 'settings.dependency.codeBuddySdkDescription',
    relatedProviders: ['codebuddy'],
  },
];

const VersionSelect = ({
  value,
  options,
  disabled,
  label,
  valueLabel,
  onChange,
}: VersionSelectProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const displayValue = value ? `v${value}` : '-';

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <div className={styles.versionSelect} ref={containerRef}>
      <button
        type="button"
        className={`${styles.versionSelectTrigger} ${open ? styles.open : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={valueLabel}
      >
        <span className={styles.versionSelectValue}>{displayValue}</span>
        <span className={`codicon codicon-chevron-down ${styles.versionSelectIcon}`} />
      </button>

      {open && (
        <div className={styles.versionDropdown} role="listbox" aria-label={label}>
          {options.map((version) => {
            const selected = version === value;

            return (
              <button
                key={version}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.versionOption} ${selected ? styles.selected : ''}`}
                onClick={() => {
                  onChange(version);
                  setOpen(false);
                }}
              >
                <span>{`v${version}`}</span>
                {selected && <span className="codicon codicon-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const DependencySection = ({ addToast, isActive }: DependencySectionProps) => {
  const { t } = useTranslation();
  const [sdkStatus, setSdkStatus] = useState<Record<SdkId, SdkStatus>>({} as Record<SdkId, SdkStatus>);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState(false);
  const [installingSdk, setInstallingSdk] = useState<SdkId | null>(null);
  const [uninstallingSdk, setUninstallingSdk] = useState<SdkId | null>(null);
  const [updatingSdk, setUpdatingSdk] = useState<SdkId | null>(null);
  const updatingSdkRef = useRef<SdkId | null>(null);
  const [installLogs, setInstallLogs] = useState<string>('');
  const [showLogs, setShowLogs] = useState(false);
  const [nodeAvailable, setNodeAvailable] = useState<boolean | null>(null);
  const [sdkVersions, setSdkVersions] = useState<Record<SdkId, DependencyVersionInfo>>({} as Record<SdkId, DependencyVersionInfo>);
  const [selectedVersions, setSelectedVersions] = useState<Record<SdkId, string>>({} as Record<SdkId, string>);
  const [loadingVersions, setLoadingVersions] = useState<Record<SdkId, boolean>>({
    'claude-sdk': false,
    'codex-sdk': false,
    'codebuddy-sdk': false,
  });
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isNodePathReadyRef = useRef(false);
  const sdkStatusRef = useRef<Record<SdkId, SdkStatus>>({} as Record<SdkId, SdkStatus>);

  // Use refs to store the latest callback and t function to avoid useEffect re-runs
  const addToastRef = useRef(addToast);
  const tRef = useRef(t);

  // Update refs when props change
  useEffect(() => {
    addToastRef.current = addToast;
    tRef.current = t;
  }, [addToast, t]);

  useEffect(() => {
    sdkStatusRef.current = sdkStatus;
  }, [sdkStatus]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logContainerRef.current && showLogs) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [installLogs, showLogs]);

  // Use a ref to track isActive so the mount-only effect can access the latest value
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Setup window callbacks - run once on mount only
  useEffect(() => {
    // Capture current callback references (may have been set by App.tsx)
    const savedUpdateDependencyStatus = window.updateDependencyStatus;
    const savedDependencyInstallProgress = window.dependencyInstallProgress;
    const savedDependencyInstallResult = window.dependencyInstallResult;
    const savedDependencyUninstallResult = window.dependencyUninstallResult;
    const savedDependencyUpdateAvailable = window.dependencyUpdateAvailable;
    const savedDependencyVersionsLoaded = window.dependencyVersionsLoaded;
    const savedNodeEnvironmentStatus = window.nodeEnvironmentStatus;
    const savedCheckNodeEnvironment = window.checkNodeEnvironment;
    const savedRunNodeEnvironmentStressTest = window.runNodeEnvironmentStressTest;

    window.updateDependencyStatus = (jsonStr: string) => {
      try {
        const status = JSON.parse(jsonStr);
        if (!isDependencyStatusResponse(status)) {
          setStatusError(true);
          setLoading(false);
          settleDependencyStatusRequest('error');
        } else {
          setSdkStatus(status);
          sdkStatusRef.current = status;
          setStatusError(false);
          setLoading(false);
          settleDependencyStatusRequest('ready');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency status:', error);
        setStatusError(true);
        setLoading(false);
        settleDependencyStatusRequest('error');
      }
      if (typeof savedUpdateDependencyStatus === 'function') {
        try { savedUpdateDependencyStatus(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained updateDependencyStatus:', e);
        }
      }
    };

    window.dependencyInstallProgress = (jsonStr: string) => {
      try {
        const progress: InstallProgress = JSON.parse(jsonStr);
        setInstallLogs((prev) => prev + progress.log + '\n');
      } catch (error) {
        console.error('[DependencySection] Failed to parse install progress:', error);
      }
      if (typeof savedDependencyInstallProgress === 'function') {
        try { savedDependencyInstallProgress(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyInstallProgress:', e);
        }
      }
    };

    window.dependencyInstallResult = (jsonStr: string) => {
      try {
        const result: InstallResult = JSON.parse(jsonStr);
        const wasUpdating = updatingSdkRef.current === result.sdkId;
        setInstallingSdk(null);
        setUpdatingSdk(null);
        updatingSdkRef.current = null;

        if (result.success) {
          const sdkDef = SDK_DEFINITIONS.find(d => d.id === result.sdkId);
          const sdkName = sdkDef ? tRef.current(sdkDef.nameKey) : result.sdkId;
          const msgKey = wasUpdating ? 'settings.dependency.updateSuccess' : 'settings.dependency.installSuccess';
          addToastRef.current?.(tRef.current(msgKey, { name: sdkName }), 'success');
          setStatusError(false);
          setLoading(true);
          requestFreshDependencyStatus();
          sendToJava(`check_dependency_updates:${JSON.stringify({ id: result.sdkId })}`);
          sendToJava(`get_dependency_versions:${JSON.stringify({ id: result.sdkId })}`);
        } else if (result.error === 'node_not_configured') {
          addToastRef.current?.(tRef.current('settings.dependency.nodeNotConfigured'), 'warning');
        } else {
          addToastRef.current?.(tRef.current('settings.dependency.installFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse install result:', error);
        setInstallingSdk(null);
        setUpdatingSdk(null);
        updatingSdkRef.current = null;
      }
      if (typeof savedDependencyInstallResult === 'function') {
        try { savedDependencyInstallResult(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyInstallResult:', e);
        }
      }
    };

    window.dependencyUninstallResult = (jsonStr: string) => {
      try {
        const result: UninstallResult = JSON.parse(jsonStr);
        setUninstallingSdk(null);

        if (result.success) {
          const sdkDef = SDK_DEFINITIONS.find(d => d.id === result.sdkId);
          const sdkName = sdkDef ? tRef.current(sdkDef.nameKey) : result.sdkId;
          addToastRef.current?.(tRef.current('settings.dependency.uninstallSuccess', { name: sdkName }), 'success');
          setSdkStatus((prev) => ({
            ...prev,
            [result.sdkId]: {
              ...prev[result.sdkId],
              hasUpdate: false,
              latestVersion: undefined,
              lastChecked: new Date().toISOString(),
              errorMessage: undefined,
            },
          }));
          sendToJava(`get_dependency_versions:${JSON.stringify({ id: result.sdkId })}`);
        } else {
          addToastRef.current?.(tRef.current('settings.dependency.uninstallFailed', { error: result.error }), 'error');
        }
      } catch (error) {
        console.error('[DependencySection] Failed to parse uninstall result:', error);
        setUninstallingSdk(null);
      }
      if (typeof savedDependencyUninstallResult === 'function') {
        try { savedDependencyUninstallResult(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyUninstallResult:', e);
        }
      }
    };

    window.dependencyUpdateAvailable = (jsonStr: string) => {
      try {
        const updatePayload: UpdateCheckResult = JSON.parse(jsonStr);
        setSdkStatus((prev) => mergeDependencyUpdates(prev, updatePayload));
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency update result:', error);
      }
      if (typeof savedDependencyUpdateAvailable === 'function') {
        try { savedDependencyUpdateAvailable(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyUpdateAvailable:', e);
        }
      }
    };

    window.dependencyVersionsLoaded = (jsonStr: string) => {
      try {
        const versionsPayload: DependencyVersionResult = JSON.parse(jsonStr);
        setSdkVersions((prev) => ({ ...prev, ...versionsPayload }));
        setLoadingVersions((prev) => {
          const next = { ...prev };
          Object.keys(versionsPayload).forEach((sdkId) => {
            next[sdkId as SdkId] = false;
          });
          return next;
        });
        setSelectedVersions((prev) => {
          const next = { ...prev };

          Object.entries(versionsPayload).forEach(([sdkId, versionInfo]) => {
            const typedSdkId = sdkId as SdkId;
            const installedVersion = sdkStatusRef.current[typedSdkId]?.installedVersion;
            const options = buildVersionOptions({
              availableVersions: versionInfo.versions,
              fallbackVersions: versionInfo.fallbackVersions,
              installedVersion,
            });
            const preferred = installedVersion ?? versionInfo.latestVersion ?? options[0];
            const current = getRequestedVersion(next[typedSdkId]);
            if (!current || !options.includes(current)) {
              next[typedSdkId] = preferred ?? '';
            }
          });

          return next;
        });
      } catch (error) {
        console.error('[DependencySection] Failed to parse dependency versions result:', error);
      }
      if (typeof savedDependencyVersionsLoaded === 'function') {
        try { savedDependencyVersionsLoaded(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained dependencyVersionsLoaded:', e);
        }
      }
    };

    window.nodeEnvironmentStatus = (jsonStr: string) => {
      try {
        const status: NodeEnvironmentStatus = JSON.parse(jsonStr);
        setNodeAvailable(status.available);
      } catch (error) {
        console.error('[DependencySection] Failed to parse node environment status:', error);
      }
      if (typeof savedNodeEnvironmentStatus === 'function') {
        try { savedNodeEnvironmentStatus(jsonStr); } catch (e) {
          console.error('[DependencySection] Error in chained nodeEnvironmentStatus:', e);
        }
      }
    };
    window.checkNodeEnvironment = () => {
      sendToJava('check_node_environment:');
      savedCheckNodeEnvironment?.();
    };
    if (import.meta.env.DEV) {
      window.runNodeEnvironmentStressTest = (count: number = 10) => {
        for (let i = 0; i < count; i += 1) {
          sendToJava('check_node_environment:');
        }
        savedRunNodeEnvironmentStressTest?.(count);
      };
    }

    if (window.__pendingDependencyUpdates) {
      window.dependencyUpdateAvailable(window.__pendingDependencyUpdates);
      window.__pendingDependencyUpdates = undefined;
    }
    if (window.__pendingDependencyVersions) {
      window.dependencyVersionsLoaded(window.__pendingDependencyVersions);
      window.__pendingDependencyVersions = undefined;
    }

    const handleNodePathReady = () => {
      isNodePathReadyRef.current = true;
      if (isActiveRef.current) {
        sendToJava('check_node_environment:');
      }
    };
    window.addEventListener('nodePathReady', handleNodePathReady);

    return () => {
      window.updateDependencyStatus = savedUpdateDependencyStatus;
      window.dependencyInstallProgress = savedDependencyInstallProgress;
      window.dependencyInstallResult = savedDependencyInstallResult;
      window.dependencyUninstallResult = savedDependencyUninstallResult;
      window.dependencyUpdateAvailable = savedDependencyUpdateAvailable;
      window.dependencyVersionsLoaded = savedDependencyVersionsLoaded;
      window.nodeEnvironmentStatus = savedNodeEnvironmentStatus;
      window.checkNodeEnvironment = savedCheckNodeEnvironment;
      window.runNodeEnvironmentStressTest = savedRunNodeEnvironmentStressTest;
      window.removeEventListener('nodePathReady', handleNodePathReady);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch data when tab becomes active
  useEffect(() => {
    if (!isActive) {
      return;
    }
    setLoadingVersions({
      'claude-sdk': true,
      'codex-sdk': true,
      'codebuddy-sdk': true,
    });
    setStatusError(false);
    setLoading(true);
    if (window.__dependencyStatusState === 'pending') {
      requestDependencyStatusUntilSettled();
    } else {
      retryDependencyStatusRequest();
    }
    sendToJava('check_dependency_updates:');
    sendToJava('get_dependency_versions:');
    if (isNodePathReadyRef.current) {
      sendToJava('check_node_environment:');
    }
  }, [isActive]);

  const handleInstall = (sdkId: SdkId) => {
    if (nodeAvailable === false) {
      addToast?.(t('settings.dependency.nodeNotConfigured'), 'warning');
      return;
    }

    setInstallingSdk(sdkId);
    setInstallLogs('');
    setShowLogs(true);
    sendToJava(`install_dependency:${JSON.stringify({ id: sdkId, version: getRequestedVersion(selectedVersions[sdkId]) })}`);
  };

  const handleUninstall = (sdkId: SdkId) => {
    setUninstallingSdk(sdkId);
    sendToJava(`uninstall_dependency:${JSON.stringify({ id: sdkId })}`);
  };

  const handleUpdate = (sdkId: SdkId) => {
    if (nodeAvailable === false) {
      addToast?.(t('settings.dependency.nodeNotConfigured'), 'warning');
      return;
    }

    setUpdatingSdk(sdkId);
    updatingSdkRef.current = sdkId;
    setInstallLogs('');
    setShowLogs(true);
    sendToJava(`update_dependency:${JSON.stringify({ id: sdkId, version: getRequestedVersion(selectedVersions[sdkId]) })}`);
  };

  const getSdkInfo = (sdkId: SdkId): SdkStatus | undefined => {
    return sdkStatus[sdkId];
  };

  const isInstalled = (sdkId: SdkId): boolean => {
    const info = getSdkInfo(sdkId);
    return info?.status === 'installed';
  };

  const getVersionInfo = (sdkId: SdkId): DependencyVersionInfo | undefined => sdkVersions[sdkId];

  const getTargetVersion = (sdkId: SdkId): string | undefined =>
    getRequestedVersion(selectedVersions[sdkId]);

  const getActionLabel = (sdkId: SdkId, installed: boolean, installedVersion?: string) => {
    const targetVersion = getTargetVersion(sdkId);
    const action = getVersionAction({
      installed,
      installedVersion,
      requestedVersion: targetVersion,
    });

    if (!installed) {
      return targetVersion
        ? t('settings.dependency.installVersion', { version: `v${targetVersion}` })
        : t('settings.dependency.install');
    }

    if (!targetVersion || action === 'current') {
      return t('settings.dependency.currentVersionAction');
    }

    if (action === 'rollback') {
      return t('settings.dependency.rollbackToVersion', { version: `v${targetVersion}` });
    }

    return t('settings.dependency.updateToVersion', { version: `v${targetVersion}` });
  };

  const handleRetryStatus = () => {
    setStatusError(false);
    setLoading(true);
    retryDependencyStatusRequest();
  };

  return (
    <div className={styles.dependencySection}>
      <h3 className={styles.sectionTitle}>{t('settings.dependency.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.dependency.description')}</p>

      {/* SDK Install Policy Tip */}
      <div className={styles.sdkWarningBar}>
        <span className="codicon codicon-info" />
        <span className={styles.warningText}>{t('settings.dependency.installPolicyTip')}</span>
      </div>

      {/* Node.js Environment Warning */}
      {nodeAvailable === false && (
        <div className={styles.warningBanner}>
          <span className="codicon codicon-warning" />
          <span>{t('settings.dependency.nodeNotConfigured')}</span>
        </div>
      )}

      {/* SDK List */}
      <div className={styles.sdkList}>
        {loading ? (
          <div className={styles.loadingState}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.dependency.loading')}</span>
          </div>
        ) : statusError ? (
          <div className={styles.loadingState}>
            <span className="codicon codicon-warning" />
            <span>{t('chat.sdkStatusUnavailable')}</span>
            <button type="button" className={styles.retryButton} onClick={handleRetryStatus}>
              <span className="codicon codicon-refresh" />
              <span>{t('chat.retrySdkStatus')}</span>
            </button>
          </div>
        ) : (
          SDK_DEFINITIONS.map((sdk) => {
            const info = getSdkInfo(sdk.id);
            const installed = isInstalled(sdk.id);
            const isInstalling = installingSdk === sdk.id;
            const isUninstalling = uninstallingSdk === sdk.id;
            const isUpdating = updatingSdk === sdk.id;
            const hasUpdate = info?.hasUpdate;
            const versionInfo = getVersionInfo(sdk.id);
            const versionOptions = buildVersionOptions({
              availableVersions: versionInfo?.versions,
              fallbackVersions: versionInfo?.fallbackVersions,
              installedVersion: info?.installedVersion,
            });
            const isVersionLoading = loadingVersions[sdk.id];
            const targetVersion = getTargetVersion(sdk.id);
            const targetVersionLabel = targetVersion
              ? t('settings.dependency.targetVersionValue', { version: `v${targetVersion}` })
              : t('settings.dependency.targetVersion');
            const action = getVersionAction({
              installed,
              installedVersion: info?.installedVersion,
              requestedVersion: targetVersion,
            });
            // Only allow one operation at a time (install, uninstall, or update)
            const isAnyOperationInProgress = installingSdk !== null || uninstallingSdk !== null || updatingSdk !== null;
            const updateDisabled = isAnyOperationInProgress || nodeAvailable === false || action === 'current';

            return (
              <div key={sdk.id} className={styles.sdkCard}>
                <div className={styles.sdkHeader}>
                  <div className={styles.sdkInfo}>
                    <div className={styles.sdkName}>
                      <span className={`codicon ${installed ? 'codicon-check' : 'codicon-package'}`} />
                      <span>{t(sdk.nameKey)}</span>
                      {installed && info?.installedVersion && (
                        <span className={styles.versionBadge}>v{info.installedVersion}</span>
                      )}
                      {installed && hasUpdate && info?.latestVersion && (
                        <span className={styles.versionBadge}>→ v{info.latestVersion}</span>
                      )}
                      {hasUpdate && (
                        <span className={styles.updateBadge}>
                          {t('settings.dependency.updateAvailable')}
                        </span>
                      )}
                    </div>
                    <div className={styles.sdkDescription}>{t(sdk.description)}</div>
                    <div className={styles.versionControls}>
                      <div className={styles.versionToolbar}>
                        <div className={styles.versionField}>
                          <span className={styles.versionLabelInline}>{t('settings.dependency.targetVersion')}</span>
                          <VersionSelect
                            value={selectedVersions[sdk.id] ?? ''}
                            options={versionOptions}
                            disabled={isAnyOperationInProgress || isVersionLoading || versionOptions.length === 0}
                            label={t('settings.dependency.targetVersion')}
                            valueLabel={targetVersionLabel}
                            onChange={(nextVersion) => {
                              setSelectedVersions((prev) => ({ ...prev, [sdk.id]: nextVersion }));
                            }}
                          />
                        </div>
                        <div className={styles.sdkActions}>
                          {!installed ? (
                            <button
                              className={`${styles.installBtn} ${isInstalling ? styles.installing : ''}`}
                              onClick={() => handleInstall(sdk.id)}
                              disabled={isAnyOperationInProgress || nodeAvailable === false}
                            >
                              {isInstalling ? (
                                <>
                                  <span className="codicon codicon-loading codicon-modifier-spin" />
                                  <span>{t('settings.dependency.installing')}</span>
                                </>
                              ) : (
                                <>
                                  <span className="codicon codicon-cloud-download" />
                                  <span>{getActionLabel(sdk.id, installed, info?.installedVersion)}</span>
                                </>
                              )}
                            </button>
                          ) : (
                            <>
                              <button
                                className={styles.updateBtn}
                                onClick={() => handleUpdate(sdk.id)}
                                disabled={updateDisabled}
                              >
                                {isUpdating ? (
                                  <>
                                    <span className="codicon codicon-loading codicon-modifier-spin" />
                                    <span>{t('settings.dependency.updating')}</span>
                                  </>
                                ) : (
                                  <>
                                    <span className="codicon codicon-sync" />
                                    <span>{getActionLabel(sdk.id, installed, info?.installedVersion)}</span>
                                  </>
                                )}
                              </button>
                              <button
                                className={styles.uninstallBtn}
                                onClick={() => handleUninstall(sdk.id)}
                                disabled={isAnyOperationInProgress}
                              >
                                {isUninstalling ? (
                                  <>
                                    <span className="codicon codicon-loading codicon-modifier-spin" />
                                    <span>{t('settings.dependency.uninstalling')}</span>
                                  </>
                                ) : (
                                  <>
                                    <span className="codicon codicon-trash" />
                                    <span>{t('settings.dependency.uninstall')}</span>
                                  </>
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {isVersionLoading && (
                        <div className={styles.versionLoadingHint}>
                          <span className="codicon codicon-loading codicon-modifier-spin" />
                          <span>{t('settings.dependency.loadingVersions')}</span>
                        </div>
                      )}
                      <div className={styles.versionMeta}>
                        {info?.installedVersion && (
                          <span>{t('settings.dependency.installedVersion', { version: `v${info.installedVersion}` })}</span>
                        )}
                        {versionInfo?.latestVersion && (
                          <span>{t('settings.dependency.latestStableVersion', { version: `v${versionInfo.latestVersion}` })}</span>
                        )}
                      </div>
                      {versionInfo?.source === 'fallback' && (
                        <div className={styles.versionHint}>
                          {t('settings.dependency.versionSourceFallback')}
                        </div>
                      )}
                      {installed && action === 'rollback' && (
                        <div className={styles.rollbackHint}>
                          {t('settings.dependency.rollbackWarning')}
                        </div>
                      )}
                    </div>
                  </div>

                </div>

                {/* Install path info */}
                {installed && info?.installPath && (
                  <div className={styles.installPath}>
                    <span className="codicon codicon-folder" />
                    <span>{info.installPath}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Install Logs */}
      {showLogs && (
        <div className={styles.logsSection}>
          <div className={styles.logsHeader}>
            <span>{t('settings.dependency.installLogs')}</span>
            <button className={styles.closeLogsBtn} onClick={() => setShowLogs(false)}>
              <span className="codicon codicon-close" />
            </button>
          </div>
          <div className={styles.logsContainer} ref={logContainerRef}>
            <pre>{installLogs || t('settings.dependency.waitingForLogs')}</pre>
          </div>
        </div>
      )}
    </div>
  );
};

export default DependencySection;
