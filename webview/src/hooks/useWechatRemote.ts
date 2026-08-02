import { useCallback, useEffect, useRef, useState } from 'react';
import { sendBridgeEvent } from '../utils/bridge';

export interface WechatLoginView {
  loginId: string;
  status: string;
  expiresAt: number;
  verifyCodeRequired: boolean;
  qrUrl?: string;
  qrDataUri?: string;
  botAccountId?: string;
}

export interface WechatStatusView {
  processState: string;
  uiState: string;
  authState: string;
  transportRunning?: boolean;
  login?: WechatLoginView;
  tabId?: string;
  error?: string;
}

/**
 * WeChat remote UI state (M9 §13).
 *
 * The webview only receives the sanitized per-tab view pushed by Java; it
 * sends intents through the existing bridge and never talks to the Adapter
 * control API directly.
 */
export function useWechatRemote() {
  const [view, setView] = useState<WechatStatusView | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const dialogOpenRef = useRef(false);

  useEffect(() => {
    const handler = (json: string): void => {
      try {
        const parsed = JSON.parse(json) as WechatStatusView;
        setView(parsed);
      } catch {
        // Malformed status is ignored; the previous view stays.
      }
    };
    window.onWechatStatus = handler;
    sendBridgeEvent('wechat_status');
    return () => {
      window.onWechatStatus = undefined;
    };
  }, []);

  const action = useCallback((type: string, payload?: Record<string, unknown>) => {
    sendBridgeEvent(type, payload === undefined ? '' : JSON.stringify(payload));
  }, []);

  const openDialog = useCallback(() => {
    dialogOpenRef.current = true;
    setOpen(true);
    sendBridgeEvent('wechat_connect');
    sendBridgeEvent('wechat_status');
  }, []);

  const closeDialog = useCallback(() => {
    // Closing the modal only hides it; explicit Cancel stops the login.
    dialogOpenRef.current = false;
    setOpen(false);
  }, []);

  return {
    view,
    open,
    openDialog,
    closeDialog,
    action,
  };
}
