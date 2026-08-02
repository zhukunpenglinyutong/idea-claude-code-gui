import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { WechatStatusView } from '../../hooks/useWechatRemote';
import './wechat.css';

export interface WechatDialogProps {
  open: boolean;
  view?: WechatStatusView;
  t: TFunction;
  onClose: () => void;
  onAction: (type: string, payload?: Record<string, unknown>) => void;
}

type ButtonKind = 'primary' | 'neutral' | 'danger';

interface DialogAction {
  label: string;
  kind: ButtonKind;
  onClick: () => void;
  disabled?: boolean;
  busyLabel?: string;
}

function formatCountdown(expiresAt: number): string {
  const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extractNodeVersion(error: string): string | null {
  const match = /当前检测版本\s*([^；;]+)/.exec(error);
  return match !== null ? match[1].trim() : null;
}

/**
 * WeChat connection modal — integrated lightweight layout.
 *
 * Closing the dialog (X / Esc / overlay click) while a QR login is active also
 * cancels that login session and stops polling; in connected states closing
 * only hides the modal. The QR state keeps a single primary "Refresh QR Code"
 * action. Logout confirmation closes the dialog after clearing credentials.
 */
export function WechatDialog({ open, view, t, onClose, onAction }: WechatDialogProps) {
  const [confirmRebind, setConfirmRebind] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [submittingVerify, setSubmittingVerify] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [qrUpdated, setQrUpdated] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [now, setNow] = useState(Date.now());
  const autoLoginSent = useRef(false);
  const previousQrUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      return;
    }
    autoLoginSent.current = false;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  // Auto-start one login when the dialog opens in LOGGED_OUT.
  useEffect(() => {
    if (open && view?.uiState === 'LOGGED_OUT' && !autoLoginSent.current) {
      autoLoginSent.current = true;
      onAction('wechat_login_start');
    }
  }, [open, view, onAction]);

  // A changed QR URL inside the same login session means the adapter rotated
  // the QR (auto-refresh after expiry). Surface a short secondary hint.
  useEffect(() => {
    const current = view?.login?.qrUrl;
    if (current !== undefined && previousQrUrl.current !== undefined && current !== previousQrUrl.current) {
      setQrUpdated(true);
      const timer = window.setTimeout(() => setQrUpdated(false), 5000);
      previousQrUrl.current = current;
      return () => window.clearTimeout(timer);
    }
    previousQrUrl.current = current;
  }, [view?.login?.qrUrl]);

  // Manual refresh feedback: keep the button disabled until a fresh loginId
  // arrives or a safety timeout expires.
  useEffect(() => {
    if (view?.login?.loginId !== undefined) {
      setRefreshing(false);
    }
  }, [view?.login?.loginId]);

  useEffect(() => {
    if (!refreshing) {
      return;
    }
    const timer = window.setTimeout(() => setRefreshing(false), 15000);
    return () => window.clearTimeout(timer);
  }, [refreshing]);

  // Node re-detection feedback.
  useEffect(() => {
    if (view?.uiState !== 'ADAPTER_OFFLINE') {
      setChecking(false);
    }
  }, [view?.uiState]);

  useEffect(() => {
    if (!checking) {
      return;
    }
    const timer = window.setTimeout(() => setChecking(false), 10000);
    return () => window.clearTimeout(timer);
  }, [checking]);

  // Verify-code submission feedback.
  useEffect(() => {
    if (view?.login?.status !== 'VERIFY_CODE_REQUIRED') {
      setSubmittingVerify(false);
    }
  }, [view?.login?.status]);

  useEffect(() => {
    if (!submittingVerify) {
      return;
    }
    const timer = window.setTimeout(() => setSubmittingVerify(false), 5000);
    return () => window.clearTimeout(timer);
  }, [submittingVerify]);

  // Generic async-action guard: any click sets a short pending window so the
  // action cannot be double-triggered before the next status push arrives.
  useEffect(() => {
    setPendingAction(null);
  }, [view]);

  useEffect(() => {
    if (pendingAction === null) {
      return;
    }
    const timer = window.setTimeout(() => setPendingAction(null), 3000);
    return () => window.clearTimeout(timer);
  }, [pendingAction]);

  if (!open) {
    return null;
  }

  const uiState = view?.uiState ?? 'ADAPTER_OFFLINE';
  const login = view?.login;
  const isNodeError = view?.error !== undefined && view.error.includes('Node.js');
  const busy = pendingAction !== null || refreshing || checking || submittingVerify;

  const countdown = login !== undefined ? formatCountdown(login.expiresAt ?? now) : '';
  const isQrState = uiState === 'LOGGED_OUT' || uiState === 'QR_PENDING'
    || uiState === 'SCANNED' || uiState === 'VERIFY_CODE_REQUIRED';
  const isConnectedState = uiState === 'CONNECTED_UNBOUND' || uiState === 'BOUND_CURRENT_TAB'
    || uiState === 'BOUND_OTHER_TAB' || uiState === 'TARGET_INVALID';

  let title = t('wechat.dialog.title');
  if (isNodeError) {
    title = t('wechat.node.title');
  } else if (isQrState) {
    title = t('wechat.qr.title');
  } else if (isConnectedState && confirmLogout) {
    title = t('wechat.logout.title');
  } else if (uiState === 'REAUTH_REQUIRED') {
    title = t('wechat.reauth.title');
  }

  const runAction = (type: string, payload?: Record<string, unknown>): void => {
    setPendingAction(type);
    if (payload === undefined) {
      onAction(type);
    } else {
      onAction(type, payload);
    }
  };

  const handleClose = (): void => {
    if (isQrState && login?.loginId !== undefined) {
      runAction('wechat_login_cancel', { loginId: login.loginId });
    }
    onClose();
  };

  const submitVerify = (): void => {
    if (login === undefined || verifyCode.trim().length === 0) {
      return;
    }
    setSubmittingVerify(true);
    onAction('wechat_login_verify', { loginId: login.loginId, code: verifyCode.trim() });
    setVerifyCode('');
  };

  const handleBind = (): void => {
    if (uiState === 'BOUND_OTHER_TAB' && !confirmRebind) {
      setConfirmRebind(true);
      return;
    }
    setConfirmRebind(false);
    runAction('wechat_bind_current');
  };

  const confirmLogoutAction = (): void => {
    setConfirmLogout(false);
    runAction('wechat_logout');
    onClose();
  };

  let actions: DialogAction[] = [];
  let body: ReactNode;

  if (uiState === 'ADAPTER_OFFLINE') {
    if (isNodeError) {
      const version = extractNodeVersion(view?.error ?? '');
      body = (
        <>
          <p className="wechat-text">{t('wechat.node.body')}</p>
          {version !== null && (
            <p className="wechat-text">{t('wechat.node.version', { version })}</p>
          )}
          <p className="wechat-text">{t('wechat.node.upgrade')}</p>
          <p className="wechat-aux">{t('wechat.node.noAuto')}</p>
        </>
      );
      actions = [{
        label: checking ? t('wechat.node.checking') : t('wechat.node.redetect'),
        kind: 'primary',
        disabled: checking,
        onClick: () => {
          setChecking(true);
          onAction('wechat_retry');
        },
      }];
    } else {
      body = <p className="wechat-text">{t('wechat.adapterOffline')}</p>;
      actions = [
        {
          label: t('wechat.retry'),
          kind: 'neutral',
          disabled: pendingAction !== null,
          onClick: () => runAction('wechat_retry'),
        },
        {
          label: t('wechat.connect'),
          kind: 'primary',
          disabled: pendingAction !== null,
          onClick: () => runAction('wechat_connect'),
        },
      ];
    }
  } else if (isQrState) {
    body = (
      <>
        <div className={`wechat-qr-box${uiState === 'SCANNED' ? ' wechat-qr-scanned' : ''}`}>
          {login?.qrDataUri !== undefined ? (
            <img src={login.qrDataUri} alt={t('wechat.qr.qrAlt')} width={220} height={220} />
          ) : (
            <div className="wechat-qr-placeholder">{t('wechat.qr.qrLoading')}</div>
          )}
        </div>
        <p className="wechat-status-text">
          {uiState === 'SCANNED' && t('wechat.qr.scanned')}
          {uiState === 'VERIFY_CODE_REQUIRED' && t('wechat.verify.prompt')}
          {uiState !== 'SCANNED' && uiState !== 'VERIFY_CODE_REQUIRED' && t('wechat.qr.scanPrompt')}
        </p>
        {(uiState === 'QR_PENDING' || uiState === 'LOGGED_OUT') && login !== undefined && countdown !== '' && (
          <p className="wechat-countdown">{t('wechat.qr.expiresIn', { time: countdown })}</p>
        )}
        {qrUpdated && <p className="wechat-countdown">{t('wechat.qr.updated')}</p>}
        {uiState === 'VERIFY_CODE_REQUIRED' && (
          <div className="wechat-verify-row">
            <input
              className="wechat-verify-input"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  submitVerify();
                }
              }}
              placeholder={t('wechat.verify.placeholder')}
              aria-label={t('wechat.verify.placeholder')}
            />
          </div>
        )}
      </>
    );

    if (uiState === 'VERIFY_CODE_REQUIRED') {
      actions.push({
        label: t('wechat.qr.refresh'),
        kind: 'neutral',
        disabled: refreshing || submittingVerify,
        onClick: () => {
          setRefreshing(true);
          onAction('wechat_login_refresh');
        },
      });
      actions.push({
        label: submittingVerify ? t('wechat.verify.submitting') : t('wechat.verify.submit'),
        kind: 'primary',
        disabled: submittingVerify,
        onClick: submitVerify,
      });
    } else {
      actions.push({
        label: refreshing ? t('wechat.qr.refreshing') : t('wechat.qr.refresh'),
        kind: 'primary',
        disabled: refreshing,
        onClick: () => {
          setRefreshing(true);
          onAction('wechat_login_refresh');
        },
      });
    }
  } else if (isConnectedState) {
    if (confirmLogout) {
      body = (
        <>
          <p className="wechat-text">{t('wechat.logout.body')}</p>
          <p className="wechat-text">{t('wechat.logout.chatSafe')}</p>
        </>
      );
      actions = [
        {
          label: t('wechat.logout.cancel'),
          kind: 'neutral',
          onClick: () => setConfirmLogout(false),
        },
        {
          label: t('wechat.logout.action'),
          kind: 'danger',
          disabled: pendingAction !== null,
          onClick: confirmLogoutAction,
        },
      ];
    } else if (uiState === 'BOUND_OTHER_TAB' && confirmRebind) {
      body = (
        <>
          <p className="wechat-text">{t('wechat.rebindBody')}</p>
          <p className="wechat-warning">{t('wechat.rebindWarn')}</p>
        </>
      );
      actions = [
        {
          label: t('wechat.logout.cancel'),
          kind: 'neutral',
          onClick: () => setConfirmRebind(false),
        },
        {
          label: t('wechat.rebindConfirm'),
          kind: 'primary',
          disabled: pendingAction !== null,
          onClick: handleBind,
        },
      ];
    } else {
      const bodyText =
        uiState === 'CONNECTED_UNBOUND'
          ? t('wechat.connectedUnbound')
          : uiState === 'BOUND_CURRENT_TAB'
            ? t('wechat.boundCurrent')
            : uiState === 'BOUND_OTHER_TAB'
              ? t('wechat.boundOther')
              : t('wechat.targetInvalid');
      body = (
        <p className="wechat-text" style={{ whiteSpace: 'pre-line' }}>
          {bodyText}
        </p>
      );
      actions.push({
        label: t('wechat.logout.action'),
        kind: 'neutral',
        disabled: pendingAction !== null,
        onClick: () => setConfirmLogout(true),
      });
      if (uiState === 'BOUND_CURRENT_TAB') {
        actions.push({
          label: t('wechat.unbind'),
          kind: 'neutral',
          disabled: pendingAction !== null,
          onClick: () => runAction('wechat_unbind'),
        });
      } else if (uiState === 'BOUND_OTHER_TAB') {
        actions.push({
          label: t('wechat.keepBinding'),
          kind: 'neutral',
          onClick: onClose,
        });
        actions.push({
          label: t('wechat.rebindToCurrent'),
          kind: 'primary',
          disabled: pendingAction !== null,
          onClick: handleBind,
        });
      } else {
        actions.push({
          label: t('wechat.bindCurrent'),
          kind: 'primary',
          disabled: pendingAction !== null,
          onClick: () => runAction('wechat_bind_current'),
        });
      }
    }
  } else if (uiState === 'REAUTH_REQUIRED') {
    body = <p className="wechat-text">{t('wechat.reauth.body')}</p>;
    actions = [{
      label: t('wechat.reauth.login'),
      kind: 'primary',
      disabled: pendingAction !== null,
      onClick: () => runAction('wechat_login_start'),
    }];
  }

  return (
    <div
      className="confirm-dialog-overlay"
      role="dialog"
      aria-label={title}
      onClick={handleClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          handleClose();
        }
      }}
    >
      <div className="wechat-dialog" aria-busy={busy} onClick={(e) => e.stopPropagation()}>
        <div className="wechat-dialog-header">
          <span className="wechat-dialog-title">{title}</span>
          <button
            type="button"
            className="icon-button wechat-close"
            onClick={handleClose}
            autoFocus
            aria-label={t('wechat.close')}
          >
            <span className="codicon codicon-close" />
          </button>
        </div>
        <div className="wechat-dialog-body">
          {view?.error !== undefined && !isNodeError && (
            <p className="wechat-error">{view.error}</p>
          )}
          {body}
        </div>
        {actions.length > 0 && (
          <div className="wechat-dialog-actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={[
                  'confirm-dialog-button',
                  action.kind === 'primary' ? 'confirm-button'
                    : action.kind === 'danger' ? 'wechat-danger-button' : 'cancel-button',
                ].join(' ')}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
