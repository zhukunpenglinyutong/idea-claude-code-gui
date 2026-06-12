import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { MessagesProvider } from './contexts/MessagesContext';
import { SessionProvider } from './contexts/SessionContext';
import { UIStateProvider } from './contexts/UIStateContext';
import { DialogProvider } from './contexts/DialogContext';
import './codicon.css';
import './styles/app.less';
import './i18n/config';
import i18n from './i18n/config';
import { setupSlashCommandsCallback } from './components/ChatInputBox/providers/slashCommandProvider';
import { setupDollarCommandsCallback } from './components/ChatInputBox/providers/dollarCommandProvider';
import { applyLinkifyCapabilitiesPayload } from './utils/linkifyCapabilities';
import { installRuntimeProviderDispatchers } from './utils/runtimeProviderCapabilities';
import { sendBridgeEvent } from './utils/bridge';
import { debugLog } from './utils/debug';
import type { UiFontConfig, CodeFontConfig } from './types/uiFontConfig';

// Silence noisy console output in production (including third-party libs).
// console.error is preserved so ErrorBoundary and unhandled exceptions still
// surface in the IDE's webview devtools — silencing it would hide regressions.
if (!import.meta.env.DEV) {
  const noop = () => {};
  console.log = noop;
  console.debug = noop;
  console.info = noop;
  console.warn = noop;
}

// Install the runtime provider dispatcher exactly once so that every
// consumer (Settings, RuntimeProviderSelect, …) receives provider events
// through a deterministic subscriber registry instead of overriding
// `window.update*Provider*` callbacks ad-hoc.
installRuntimeProviderDispatchers();

function createBridgeHeartbeatStarter() {
  let started = false;

  return () => {
    if (started) return;
    started = true;

    let lastRafAt = Date.now();
    let rafId: number | null = null;
    const rafLoop = () => {
      lastRafAt = Date.now();
      rafId = requestAnimationFrame(rafLoop);
    };
    rafId = requestAnimationFrame(rafLoop);

    let sequence = 0;
    const intervalMs = 5000;

    let intervalId: number | null = null;
    intervalId = window.setInterval(() => {
      sequence += 1;
      const payload = JSON.stringify({
        ts: Date.now(),
        raf: lastRafAt,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
        seq: sequence,
      });
      sendBridgeEvent('heartbeat', payload);
    }, intervalMs);

    const cleanup = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    // Explicitly cleanup timers on navigation/unload (best effort; helpful for long-running JCEF contexts).
    window.addEventListener('beforeunload', cleanup, { once: true });
    window.addEventListener('pagehide', cleanup, { once: true });

    // Cleanup on Vite HMR (dev only).
    if (import.meta.hot) {
      import.meta.hot.dispose(() => cleanup());
    }

    debugLog('[Main] Bridge heartbeat enabled');
  };
}

const startBridgeHeartbeat = createBridgeHeartbeatStarter();
// vConsole debugging tool
const enableVConsole =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_VCONSOLE === 'true';

if (enableVConsole) {
  void import('vconsole').then(({ default: VConsole }) => {
    new VConsole();
    // Move vConsole button to top-left corner to avoid blocking the send button in the bottom-right
    setTimeout(() => {
      const vcSwitch = document.getElementById('__vconsole') as HTMLElement;
      if (vcSwitch) {
        vcSwitch.style.left = '10px';
        vcSwitch.style.right = 'auto';
        vcSwitch.style.top = '10px';
        vcSwitch.style.bottom = 'auto';
      }
    }, 100);
  });
}

/**
 * Apply IDEA editor font configuration to CSS variables
 */
/**
 * JCEF (macOS) may occasionally render with an incorrect zoom/layout after the IDE
 * stays in background / screen-off for a while. The UI uses CSS `zoom` with an
 * inverse `vw/vh` container size to implement font scaling. If the zoom is not
 * applied correctly after resume, the container becomes smaller than the viewport,
 * leaving blank areas and causing "misalignment".
 *
 * This recovery nudges Chromium/JCEF to re-apply the expected zoom and triggers
 * a resize recalculation for components relying on window size.
 */
function setupScaleRecovery() {
  type CSSStyleDeclarationWithZoom = CSSStyleDeclaration & { zoom: string };

  const getExpectedScale = (): string => {
    const fromCss = getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim();
    if (fromCss) return fromCss;

    const savedLevel = localStorage.getItem('fontSizeLevel');
    const level = savedLevel ? parseInt(savedLevel, 10) : 3;
    const fontSizeLevel = level >= 1 && level <= 6 ? level : 3;
    const fontSizeMap: Record<number, number> = {
      1: 0.8,
      2: 0.9,
      3: 1.0,
      4: 1.1,
      5: 1.2,
      6: 1.4,
    };
    return String(fontSizeMap[fontSizeLevel] || 1.0);
  };

  let hiddenAt: number | null = null;
  let lastRecoveryAt = 0;
  let scheduled = false;
  const RECOVERY_COOLDOWN_MS = 1500;

  const forceReapply = (reason: string) => {
    const app = document.getElementById('app') as HTMLElement | null;
    const expected = getExpectedScale();

    // Re-set the CSS variable to ensure width/height calc(100vw/scale) is refreshed.
    document.documentElement.style.setProperty('--font-scale', expected);

    const computedZoom = app
      ? (getComputedStyle(app) as unknown as CSSStyleDeclarationWithZoom).zoom
      : null;
    const computedZoomNumber = typeof computedZoom === 'string' ? parseFloat(computedZoom) : Number.NaN;
    const expectedNumber = parseFloat(expected);

    const needsZoomNudge =
      !!app &&
      Number.isFinite(expectedNumber) &&
      (!Number.isFinite(computedZoomNumber) || Math.abs(computedZoomNumber - expectedNumber) > 0.01);

    if (app && needsZoomNudge) {
      const appStyle = app.style as unknown as CSSStyleDeclarationWithZoom;
      // Toggle inline zoom to ensure Chromium/JCEF re-applies scaling after resume.
      // Keep the final value aligned with the CSS variable.
      appStyle.zoom = '1';
      // Force a sync layout.
      void app.offsetHeight;
      appStyle.zoom = expected;
    }

    // Let components recompute layout (some rely on window resize).
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      if (app && needsZoomNudge) {
        const appStyle = app.style as unknown as CSSStyleDeclarationWithZoom;
        // One more tick to reduce flakiness on macOS/JCEF.
        appStyle.zoom = expected;
      }
      debugLog('[ScaleRecovery] Applied scale recovery:', {
        reason,
        expected,
        computedZoom,
        needsZoomNudge,
      });
      lastRecoveryAt = Date.now();
    });
  };

  const schedule = (reason: string) => {
    if (scheduled || Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      forceReapply(reason);
    });
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }

    const elapsed = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    // Only nudge after a meaningful pause to avoid unnecessary work during normal tab switches.
    if (elapsed > 1500) {
      schedule('visibilitychange-resume');
    }
  };

  const onWindowFocus = () => {
    // Focus can return without a visibilitychange in some IDE/window states.
    schedule('window-focus');
  };

  const onPageShow = () => {
    // Helps if the page is restored from bfcache-like behavior.
    schedule('pageshow');
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('pageshow', onPageShow);

  const cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('pageshow', onPageShow);
  };

  // Best-effort teardown to release listeners on navigation/unload, mirroring
  // the heartbeat cleanup pattern above.
  window.addEventListener('beforeunload', cleanup, { once: true });
  window.addEventListener('pagehide', cleanup, { once: true });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => cleanup());
  }
}

let latestEditorFontConfig: {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  fallbackFonts?: string[];
} | null = null;

let latestUiFontConfig: UiFontConfig | null = null;
let latestCodeFontConfig: CodeFontConfig | null = null;

const UI_FONT_STYLE_ELEMENT_ID = 'cc-gui-ui-font-face-style';
const CODE_FONT_STYLE_ELEMENT_ID = 'cc-gui-code-font-face-style';

function escapeCssFontName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildFontFamilyValue(
  config: { fontFamily: string; fallbackFonts?: string[] },
  options: { appendMonospaceFallback?: boolean; appendSansSerifFallback?: boolean } = {
    appendMonospaceFallback: true,
  },
) {
  const fontParts: string[] = [`'${escapeCssFontName(config.fontFamily)}'`];

  if (config.fallbackFonts && config.fallbackFonts.length > 0) {
    for (const fallback of config.fallbackFonts) {
      fontParts.push(`'${escapeCssFontName(fallback)}'`);
    }
  }

  if (options.appendSansSerifFallback) {
    // UI fonts fall back to a sans-serif stack so a failed custom-font load lands on a
    // sensible UI font instead of the browser default serif.
    fontParts.push("'Inter'", 'system-ui', 'sans-serif');
  } else if (options.appendMonospaceFallback !== false) {
    fontParts.push("'Consolas'", 'monospace');
  }
  return fontParts.join(', ');
}

let currentUiFontBlobUrl: string | null = null;
let currentCodeFontBlobUrl: string | null = null;

function escapeCssUrl(url: string): string {
  return url.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n|\r/g, '');
}

function createFontBlobUrl(base64: string, format: string): string {
  const mimeType = format === 'opentype' ? 'font/opentype' : 'font/truetype';
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

function setUiFontFaceStyle(config: UiFontConfig) {
  let styleElement = document.getElementById(UI_FONT_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = UI_FONT_STYLE_ELEMENT_ID;
    document.head.appendChild(styleElement);
  }

  // Revoke previous blob URL to free memory
  if (currentUiFontBlobUrl) {
    URL.revokeObjectURL(currentUiFontBlobUrl);
    currentUiFontBlobUrl = null;
  }

  if (!config.fontUrl && (!config.fontBase64 || !config.fontFormat)) {
    styleElement.textContent = '';
    return;
  }

  const fontFormat = config.fontFormat || 'truetype';
  let fontSourceUrl = config.fontUrl;
  if (!fontSourceUrl && config.fontBase64) {
    fontSourceUrl = createFontBlobUrl(config.fontBase64, fontFormat);
    currentUiFontBlobUrl = fontSourceUrl;
  }

  const familyName = escapeCssFontName(config.fontFamily);
  styleElement.textContent =
    `@font-face { font-family: '${familyName}'; font-style: normal; font-weight: 100 900;` +
    ` font-display: swap; src: url("${escapeCssUrl(fontSourceUrl || '')}") format('${fontFormat}'); }`;
}

function setCodeFontFaceStyle(config: CodeFontConfig) {
  let styleElement = document.getElementById(CODE_FONT_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = CODE_FONT_STYLE_ELEMENT_ID;
    document.head.appendChild(styleElement);
  }

  if (currentCodeFontBlobUrl) {
    URL.revokeObjectURL(currentCodeFontBlobUrl);
    currentCodeFontBlobUrl = null;
  }

  if (!config.fontUrl && (!config.fontBase64 || !config.fontFormat)) {
    styleElement.textContent = '';
    return;
  }

  const fontFormat = config.fontFormat || 'truetype';
  let fontSourceUrl = config.fontUrl;
  if (!fontSourceUrl && config.fontBase64) {
    fontSourceUrl = createFontBlobUrl(config.fontBase64, fontFormat);
    currentCodeFontBlobUrl = fontSourceUrl;
  }

  const familyName = escapeCssFontName(config.fontFamily);
  styleElement.textContent =
    `@font-face { font-family: '${familyName}'; font-style: normal; font-weight: 100 900;` +
    ` font-display: swap; src: url("${escapeCssUrl(fontSourceUrl || '')}") format('${fontFormat}'); }`;
}

function syncFontFamilies() {
  const root = document.documentElement;
  if (latestUiFontConfig) {
    root.style.setProperty('--cc-gui-ui-font-family', buildFontFamilyValue({
      fontFamily: latestUiFontConfig.fontFamily,
      fallbackFonts: latestUiFontConfig.fallbackFonts,
    }, { appendMonospaceFallback: false, appendSansSerifFallback: true }));
  }

  const codeSourceConfig = latestCodeFontConfig || latestEditorFontConfig;
  if (codeSourceConfig) {
    const codeFontFamilyValue = buildFontFamilyValue({
      fontFamily: codeSourceConfig.fontFamily,
      fallbackFonts: codeSourceConfig.fallbackFonts ?? latestEditorFontConfig?.fallbackFonts,
    });
    root.style.setProperty('--cc-gui-code-font-family', codeFontFamilyValue);
    // Keep legacy variable in sync so existing components continue to pick up the effective code font.
    root.style.setProperty('--idea-editor-font-family', codeFontFamilyValue);
  }
}

function applyEditorTypographyConfig(config: {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  fallbackFonts?: string[];
}) {
  const root = document.documentElement;
  latestEditorFontConfig = config;
  root.style.setProperty('--cc-gui-editor-font-family', buildFontFamilyValue(config));
  root.style.setProperty('--idea-editor-font-size', `${config.fontSize}px`);
  root.style.setProperty('--idea-editor-line-spacing', String(config.lineSpacing));
  syncFontFamilies();
}

function applyUiFontConfig(config: UiFontConfig | string) {
  const normalizedConfig: UiFontConfig =
    typeof config === 'string' ? JSON.parse(config) as UiFontConfig : config;

  latestUiFontConfig = normalizedConfig;
  setUiFontFaceStyle(normalizedConfig);
  syncFontFamilies();
}

function applyCodeFontConfig(config: CodeFontConfig | string) {
  const normalizedConfig: CodeFontConfig =
    typeof config === 'string' ? JSON.parse(config) as CodeFontConfig : config;

  latestCodeFontConfig = normalizedConfig;
  setCodeFontFaceStyle(normalizedConfig);
  syncFontFamilies();
}

// Register the applyIdeaFontConfig function
window.applyIdeaFontConfig = applyEditorTypographyConfig;
window.applyUiFontConfig = applyUiFontConfig;
window.applyCodeFontConfig = applyCodeFontConfig;

// Check for pending font config (Java side may execute before JS)
if (window.__pendingFontConfig) {
  debugLog('[Main] Found pending font config, applying...');
  applyEditorTypographyConfig(window.__pendingFontConfig);
  delete window.__pendingFontConfig;
}

if (window.__pendingUiFontConfig) {
  debugLog('[Main] Found pending UI font config, applying...');
  applyUiFontConfig(window.__pendingUiFontConfig);
  delete window.__pendingUiFontConfig;
}

if (window.__pendingCodeFontConfig) {
  debugLog('[Main] Found pending code font config, applying...');
  applyCodeFontConfig(window.__pendingCodeFontConfig);
  delete window.__pendingCodeFontConfig;
}

/**
 * Apply language configuration to i18n
 * Supports both direct objects (startup injection) and JSON strings (bridge callbacks).
 */
function applyLanguageConfig(rawConfig: { language: string; source?: string; ideaLocale?: string } | string) {
  let config: { language: string; source?: string; ideaLocale?: string };

  if (typeof rawConfig === 'string') {
    try {
      config = JSON.parse(rawConfig) as { language: string; source?: string; ideaLocale?: string };
    } catch (error) {
      console.error('[Main] Failed to parse language config:', error, rawConfig);
      return;
    }
  } else {
    config = rawConfig;
  }

  const { language, source } = config;

  // Validate that the language code is supported
  const supportedLanguages = ['zh', 'en', 'zh-TW', 'hi', 'es', 'fr', 'ja', 'ru', 'ko', 'pt-BR'];
  const targetLanguage = supportedLanguages.includes(language) ? language : 'en';

  debugLog('[Main] Applying language config:', config, 'target language:', targetLanguage, 'source:', source);

  const selectionMode = source === 'user' ? 'manual' : 'followIdea';

  i18n.changeLanguage(targetLanguage)
    .then(() => {
      localStorage.setItem('language', targetLanguage);
      localStorage.setItem('languageSelectionMode', selectionMode);
      // Migrate from legacy 'languageManuallySet' key to 'languageSelectionMode'
      localStorage.removeItem('languageManuallySet');
      // Notify subscribers (e.g. AppearanceTab) of the authoritative config so
      // they can resync even when i18n.language did not change.
      window.dispatchEvent(new CustomEvent('language-config-applied', {
        detail: { language: targetLanguage, selectionMode },
      }));
      debugLog('[Main] Applied language:', targetLanguage, 'source:', source ?? 'idea');
    })
    .catch((error) => {
      console.error('[Main] Failed to change language:', error);
    });
}

// Register the applyIdeaLanguageConfig function
window.applyIdeaLanguageConfig = applyLanguageConfig;

// Check for pending language config (Java side may execute before JS)
if (window.__pendingLanguageConfig) {
  debugLog('[Main] Found pending language config, applying...');
  applyLanguageConfig(window.__pendingLanguageConfig);
  delete window.__pendingLanguageConfig;
}

// Pre-register updateMessages to handle backend message snapshots that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateMessages) {
  debugLog('[Main] Pre-registering updateMessages placeholder');
  window.updateMessages = (json: string, sequence?: string | number) => {
    const parsedSequence =
      typeof sequence === 'number'
        ? sequence
        : typeof sequence === 'string' && sequence.trim().length > 0
          ? Number.parseInt(sequence, 10)
          : null;
    window.__pendingUpdateMessages = {
      json,
      sequence: Number.isFinite(parsedSequence) ? parsedSequence : null,
    };
  };
}

// Pre-register updateStatus to handle backend status text that arrives before React initializes
if (typeof window !== 'undefined' && !window.updateStatus) {
  debugLog('[Main] Pre-registering updateStatus placeholder');
  window.updateStatus = (text: string) => {
    window.__pendingStatusText = text;
  };
}

// Pre-register showLoading to handle backend loading state that arrives before React initializes
if (typeof window !== 'undefined' && !window.showLoading) {
  debugLog('[Main] Pre-registering showLoading placeholder');
  window.showLoading = (value: string | boolean) => {
    window.__pendingLoadingState = value === true || value === 'true';
  };
}

// Pre-register addUserMessage to handle backend-inserted user messages before React initializes
if (typeof window !== 'undefined' && !window.addUserMessage) {
  debugLog('[Main] Pre-registering addUserMessage placeholder');
  window.addUserMessage = (content: string) => {
    window.__pendingUserMessage = content;
  };
}

// Pre-register showSummary to handle backend summary text that arrives before React initializes
if (typeof window !== 'undefined' && !window.showSummary) {
  debugLog('[Main] Pre-registering showSummary placeholder');
  window.showSummary = (summary: string) => {
    window.__pendingSummaryText = summary;
  };
}

// Pre-register updateSlashCommands to handle backend calls that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateSlashCommands) {
  debugLog('[Main] Pre-registering updateSlashCommands placeholder');
  window.updateSlashCommands = (json: string) => {
    debugLog('[Main] Storing pending slash commands, length=' + json.length);
    window.__pendingSlashCommands = json;
  };
}

// Pre-register updateDollarCommands to handle backend calls that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateDollarCommands) {
  window.updateDollarCommands = (json: string) => {
    window.__pendingDollarCommands = json;
  };
}

// Pre-register setSessionId to handle backend calls that arrive before React initializes.
// This stores the session ID required by the rewind feature.
if (typeof window !== 'undefined' && !window.setSessionId) {
  debugLog('[Main] Pre-registering setSessionId placeholder');
  window.setSessionId = (sessionId: string) => {
    debugLog('[Main] Storing pending session ID:', sessionId);
    window.__pendingSessionId = sessionId;
  };
}

// Pre-register updateDependencyStatus to handle backend status responses that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateDependencyStatus) {
  debugLog('[Main] Pre-registering updateDependencyStatus placeholder');
  window.updateDependencyStatus = (json: string) => {
    debugLog('[Main] Storing pending dependency status, length=' + (json ? json.length : 0));
    window.__pendingDependencyStatus = json;
  };
}

// Pre-register dependencyUpdateAvailable to handle backend update checks that arrive before Settings/React initializes
if (typeof window !== 'undefined' && !window.dependencyUpdateAvailable) {
  debugLog('[Main] Pre-registering dependencyUpdateAvailable placeholder');
  window.dependencyUpdateAvailable = (json: string) => {
    debugLog('[Main] Storing pending dependency updates, length=' + (json ? json.length : 0));
    window.__pendingDependencyUpdates = json;
  };
}

// Pre-register updateStreamingEnabled to handle backend status responses that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateStreamingEnabled) {
  debugLog('[Main] Pre-registering updateStreamingEnabled placeholder');
  window.updateStreamingEnabled = (json: string) => {
    debugLog('[Main] Storing pending streaming enabled status, length=' + (json ? json.length : 0));
    window.__pendingStreamingEnabled = json;
  };
}

// Pre-register updateSendShortcut to handle backend status responses that arrive before React initializes
if (typeof window !== 'undefined' && !window.updateSendShortcut) {
  debugLog('[Main] Pre-registering updateSendShortcut placeholder');
  window.updateSendShortcut = (json: string) => {
    debugLog('[Main] Storing pending send shortcut status, length=' + (json ? json.length : 0));
    window.__pendingSendShortcut = json;
  };
}

// Pre-register updatePermissionDialogTimeout to handle backend responses that arrive before React initializes
if (typeof window !== 'undefined' && !window.updatePermissionDialogTimeout) {
  debugLog('[Main] Pre-registering updatePermissionDialogTimeout placeholder');
  window.updatePermissionDialogTimeout = (json: string) => {
    debugLog('[Main] Storing pending permission dialog timeout, length=' + (json ? json.length : 0));
    window.__pendingPermissionDialogTimeout = json;
  };
}

// Pre-register updateUsageStatistics to handle backend status responses that arrive before Settings/UsageStatisticsSection initializes
if (typeof window !== 'undefined' && !window.updateUsageStatistics) {
  debugLog('[Main] Pre-registering updateUsageStatistics placeholder');
  window.updateUsageStatistics = (json: string) => {
    debugLog('[Main] Storing pending usage statistics, length=' + (json ? json.length : 0));
    window.__pendingUsageStatistics = json;
  };
}

// Pre-register onModeReceived to avoid losing early backend push before React callbacks are ready.
if (typeof window !== 'undefined' && !window.onModeReceived) {
  debugLog('[Main] Pre-registering onModeReceived placeholder');
  window.onModeReceived = (mode: string) => {
    debugLog('[Main] Storing pending mode:', mode);
    window.__pendingModeReceived = mode;
  };
}

if (typeof window !== 'undefined' && !window.showPermissionDialog) {
  debugLog('[Main] Pre-registering showPermissionDialog placeholder');
  window.showPermissionDialog = (json: string) => {
    const pending = window.__pendingPermissionDialogRequests || [];
    pending.push(json);
    window.__pendingPermissionDialogRequests = pending;
  };
}

if (typeof window !== 'undefined' && !window.showAskUserQuestionDialog) {
  debugLog('[Main] Pre-registering showAskUserQuestionDialog placeholder');
  window.showAskUserQuestionDialog = (json: string) => {
    const pending = window.__pendingAskUserQuestionDialogRequests || [];
    pending.push(json);
    window.__pendingAskUserQuestionDialogRequests = pending;
  };
}

if (typeof window !== 'undefined' && !window.showPlanApprovalDialog) {
  debugLog('[Main] Pre-registering showPlanApprovalDialog placeholder');
  window.showPlanApprovalDialog = (json: string) => {
    const pending = window.__pendingPlanApprovalDialogRequests || [];
    pending.push(json);
    window.__pendingPlanApprovalDialogRequests = pending;
  };
}

if (typeof window !== 'undefined') {
  window.updateLinkifyCapabilities = (json: string) => {
    applyLinkifyCapabilitiesPayload(json);
  };
}

// Render the React application
ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <ErrorBoundary>
    <UIStateProvider>
      <SessionProvider>
        <MessagesProvider>
          <DialogProvider>
            <App />
          </DialogProvider>
        </MessagesProvider>
      </SessionProvider>
    </UIStateProvider>
  </ErrorBoundary>,
);

/**
 * Wait for the sendToJava bridge function to become available
 */
setupScaleRecovery();

function waitForBridge(callback: () => void, maxAttempts = 50, interval = 100) {
  let attempts = 0;

  const check = () => {
    attempts++;
    if (window.sendToJava) {
      debugLog('[Main] Bridge available after ' + attempts + ' attempts');
      callback();
    } else if (attempts < maxAttempts) {
      setTimeout(check, interval);
    } else {
      console.error('[Main] Bridge not available after ' + maxAttempts + ' attempts');
    }
  };

  check();
}

// Once the bridge is available, initialize slash commands
waitForBridge(() => {
  debugLog('[Main] Bridge ready, setting up slash commands');
  setupSlashCommandsCallback();
  setupDollarCommandsCallback();
  startBridgeHeartbeat();

  debugLog('[Main] Sending frontend_ready signal');
  sendBridgeEvent('frontend_ready');

  debugLog('[Main] Sending refresh_slash_commands request');
  sendBridgeEvent('refresh_slash_commands');

  // Ensure SDK dependency status is fetched on initial load (not only after opening Settings).
  debugLog('[Main] Requesting dependency status');
  sendBridgeEvent('get_dependency_status');

  sendBridgeEvent('get_linkify_capabilities');
});
