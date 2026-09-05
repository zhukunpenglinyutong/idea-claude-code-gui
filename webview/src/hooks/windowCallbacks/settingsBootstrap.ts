/**
 * settingsBootstrap.ts
 *
 * Handles initial configuration requests sent to the Java backend and the
 * processing of any values that arrived before the callbacks were registered
 * (stored in window.__pending* slots by main.tsx).
 */

import { sendBridgeEvent } from '../../utils/bridge';

const MAX_RETRIES = 30;

/**
 * Fire the three settings queries to the backend.  Retries up to MAX_RETRIES
 * times (at 100 ms intervals) if window.sendToJava is not yet available.
 */
export const startInitialSettingsRequest = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  let settingsRetryCount = 0;
  const requestInitialSettings = () => {
    if (typeof window === 'undefined') {
      return;
    }
    if (window.sendToJava) {
      window.sendToJava('get_streaming_enabled:');
      window.sendToJava('get_send_shortcut:');
      window.sendToJava('get_chat_font_size:');
      window.sendToJava('get_auto_open_file_enabled:');
      window.sendToJava('get_permission_dialog_timeout:');
    } else {
      settingsRetryCount++;
      if (settingsRetryCount < MAX_RETRIES) {
        setTimeout(requestInitialSettings, 100);
      }
    }
  };
  setTimeout(requestInitialSettings, 200);
};

/**
 * Request the active provider configuration.  Retries until sendToJava is
 * available.
 */
export const startActiveProviderRequest = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  let retryCount = 0;
  const requestActiveProvider = () => {
    if (typeof window === 'undefined') {
      return;
    }
    if (window.sendToJava) {
      sendBridgeEvent('get_active_provider');
    } else {
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        setTimeout(requestActiveProvider, 100);
      }
    }
  };
  setTimeout(requestActiveProvider, 200);
};

/**
 * Request the current permission mode from the backend.
 */
export const startModeRequest = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  let modeRetryCount = 0;
  const requestMode = () => {
    if (typeof window === 'undefined') {
      return;
    }
    if (window.sendToJava) {
      sendBridgeEvent('get_mode');
    } else {
      modeRetryCount++;
      if (modeRetryCount < MAX_RETRIES) {
        setTimeout(requestMode, 100);
      }
    }
  };
  setTimeout(requestMode, 200);
};

/**
 * Request the thinking-enabled setting from the backend.
 */
export const startThinkingEnabledRequest = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  let thinkingRetryCount = 0;
  const requestThinkingEnabled = () => {
    if (typeof window === 'undefined') {
      return;
    }
    if (window.sendToJava) {
      sendBridgeEvent('get_thinking_enabled');
    } else {
      thinkingRetryCount++;
      if (thinkingRetryCount < MAX_RETRIES) {
        setTimeout(requestThinkingEnabled, 100);
      }
    }
  };
  setTimeout(requestThinkingEnabled, 200);
};

/**
 * Drain any pending window.__pending* values captured by main.tsx before
 * the React callbacks were registered.  Must be called after the corresponding
 * window.updateXxx / window.onXxx callbacks have been assigned.
 */
export const drainPendingSettings = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const w = window as unknown as Record<string, unknown>;

  if (w.__pendingStreamingEnabled) {
    const pending = w.__pendingStreamingEnabled as string;
    delete w.__pendingStreamingEnabled;
    window.updateStreamingEnabled?.(pending);
  }

  if (w.__pendingSendShortcut) {
    const pending = w.__pendingSendShortcut as string;
    delete w.__pendingSendShortcut;
    window.updateSendShortcut?.(pending);
  }

  if (w.__pendingChatFontSize) {
    const pending = w.__pendingChatFontSize as string;
    delete w.__pendingChatFontSize;
    // The main-app handler already applied the CSS variable when the payload
    // first arrived; this drain only feeds the settings page state.
    window.updateChatFontSize?.(pending);
  }

  if (w.__pendingAutoOpenFileEnabled) {
    const pending = w.__pendingAutoOpenFileEnabled as string;
    delete w.__pendingAutoOpenFileEnabled;
    window.updateAutoOpenFileEnabled?.(pending);
  }

  if (w.__pendingPermissionDialogTimeout) {
    const pending = w.__pendingPermissionDialogTimeout as string;
    delete w.__pendingPermissionDialogTimeout;
    window.updatePermissionDialogTimeout?.(pending);
  }

  if (w.__pendingModeReceived) {
    const pending = w.__pendingModeReceived as string;
    delete w.__pendingModeReceived;
    window.onModeReceived?.(pending);
  }
};

/**
 * Drain any dependency-status payload that arrived before the callback was
 * registered. The startup poller in main.tsx owns the initial request so this
 * callback registration cannot create a duplicate in-flight query.
 */
export const drainPendingDependencyStatus = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const w = window as unknown as Record<string, unknown>;

  if (w.__pendingDependencyStatus) {
    const pending = w.__pendingDependencyStatus as string;
    delete w.__pendingDependencyStatus;
    window.updateDependencyStatus?.(pending);
  }
};
