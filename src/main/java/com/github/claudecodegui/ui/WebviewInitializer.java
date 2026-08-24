package com.github.claudecodegui.ui;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import java.util.Map;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.JBCefBrowserFactory;
import com.github.claudecodegui.util.LanguageConfigService;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.ThemeConfigService;
import com.google.gson.JsonArray;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefOSRHandlerFactory;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefJSQuery;
import org.cef.CefClient;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.Transferable;
import java.awt.dnd.DnDConstants;
import java.awt.dnd.DropTarget;
import java.awt.dnd.DropTargetAdapter;
import java.awt.dnd.DropTargetDropEvent;
import java.io.File;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.IntPredicate;
import java.util.function.Supplier;

/**
 * Handles webview (JCEF browser) creation, configuration, error panels,
 * and webview lifecycle (reload, recreate, recovery).
 */
public class WebviewInitializer {

    private static final Logger LOG = Logger.getInstance(WebviewInitializer.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";
    private static final int BRIDGE_INJECTION_FAST_RETRY_INTERVAL_MS = 100;
    private static final int BRIDGE_INJECTION_SLOW_RETRY_INTERVAL_MS = 1000;
    private static final int BRIDGE_INJECTION_FAST_RETRY_ATTEMPTS = 50;

    /** Identifies which side owns provider/model boot synchronization for a page load. */
    enum PageLoadKind {
        INITIAL_LOAD("initial_load", false),
        STARTUP_RETRY("startup_retry", false),
        RUNTIME_RECOVERY("runtime_recovery", true);

        private final String wireName;
        private final boolean authoritativeRecovery;

        PageLoadKind(String wireName, boolean authoritativeRecovery) {
            this.wireName = wireName;
            this.authoritativeRecovery = authoritativeRecovery;
        }
    }

    /**
     * Host interface providing access to window-level dependencies.
     */
    public interface WebviewHost {
        Project getProject();
        ClaudeSDKBridge getClaudeSDKBridge();
        CodexSDKBridge getCodexSDKBridge();
        Map<String, MarkerCliBridge> getCliBridges();
        JPanel getMainPanel();
        HtmlLoader getHtmlLoader();
        HandlerContext getHandlerContext();
        JBCefBrowser getBrowser();
        JBCefOSRHandlerFactory getOsrHandlerFactory();
        void setBrowser(JBCefBrowser browser);
        boolean isDisposed();
        void activatePageGeneration(int pageGeneration);
        void handleJavaScriptMessage(int pageGeneration, String message);
        WebviewWatchdog getWebviewWatchdog();
        boolean isFrontendReady();
        boolean hasEverBeenFrontendReady();
        boolean isWebviewActive();
        void setFrontendReady(boolean ready);
    }

    private final WebviewHost host;

    private final Object bridgeLock = new Object();

    private static void applyNodePathToCliBridges(Map<String, MarkerCliBridge> cliBridges, String path) {
        if (cliBridges == null) {
            return;
        }
        for (MarkerCliBridge bridge : cliBridges.values()) {
            if (bridge != null) {
                bridge.setNodeExecutable(path);
            }
        }
    }

    /**
     * JCEF JS bridges for the current browser. Keeping each browser's queries
     * together prevents a stale load callback from using a replacement browser's
     * native callback handles during a watchdog recreation.
     */
    private volatile BrowserBridges bridges;
    private int pageGeneration;
    private PageLoadKind nextBrowserPageLoadKind = PageLoadKind.INITIAL_LOAD;

    public WebviewInitializer(WebviewHost host) {
        this.host = host;
    }

    /**
     * Create and configure UI components (browser, JS bridge, drag-and-drop).
     */
    public void createUIComponents() {
        if (this.host.isDisposed()) {
            return;
        }
        JBCefBrowser existingBrowser = this.host.getBrowser();
        if (existingBrowser != null) {
            // Browser lifecycle is owned by this initializer. Remote JCEF can
            // report isClosed() for an active proxy, so a non-null host browser
            // is the authoritative signal that initialization already ran.
            LOG.debug("Skip duplicate webview initialization: browser is already active");
            return;
        }

        // Use the shared resolver from BridgePreloader for consistent state
        com.github.claudecodegui.bridge.BridgeDirectoryResolver sharedResolver = BridgePreloader.getSharedResolver();

        // Check if bridge extraction is in progress (non-blocking check)
        if (sharedResolver.isExtractionInProgress()) {
            LOG.info("[ClaudeSDKToolWindow] Bridge extraction in progress, showing loading panel...");
            showLoadingPanel();

            // Register async callback to reinitialize when extraction completes
            sharedResolver.getExtractionFuture().thenAcceptAsync(ready -> {
                if (ready) {
                    reinitializeAfterExtraction();
                } else {
                    invokeLaterForToolWindow(this::showErrorPanel);
                }
            });
            return;
        }

        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        Map<String, MarkerCliBridge> cliBridges = host.getCliBridges();

        PropertiesComponent props = PropertiesComponent.getInstance();
        String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);

        if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
            String trimmed = savedNodePath.trim();
            claudeSDKBridge.setNodeExecutable(trimmed);
            codexSDKBridge.setNodeExecutable(trimmed);
            applyNodePathToCliBridges(cliBridges, trimmed);
            NodeDetectionResult nodeResult = claudeSDKBridge.verifyAndCacheNodePath(trimmed);
            if (nodeResult == null || !nodeResult.isFound()) {
                showInvalidNodePathPanel(trimmed, nodeResult != null ? nodeResult.getErrorMessage() : null);
                return;
            }
            continueCreateUIComponentsAfterNodeSetup(nodeResult);
            return;
        }

        // No saved path: auto-detection spawns shell probes that block the calling
        // thread for several seconds per attempt (and may hang instead of exiting in
        // VM/container environments), so it must never run on the EDT. Detect on a
        // pooled thread, then continue initialization back on the EDT.
        LOG.info("No saved Node.js path found, scheduling auto-detection on background thread...");
        showLoadingPanel();
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            NodeDetectionResult detected;
            try {
                detected = claudeSDKBridge.detectNodeWithDetails();
            } catch (Exception e) {
                LOG.error("Failed to auto-detect Node.js path: " + e.getMessage(), e);
                detected = null;
            }

            if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                props.setValue(NODE_PATH_PROPERTY_KEY, detected.getNodePath());
                claudeSDKBridge.setNodeExecutable(detected.getNodePath());
                codexSDKBridge.setNodeExecutable(detected.getNodePath());
                applyNodePathToCliBridges(cliBridges, detected.getNodePath());
                claudeSDKBridge.verifyAndCacheNodePath(detected.getNodePath());
                LOG.info("Auto-detected Node.js: " + detected.getNodePath()
                    + " (" + detected.getNodeVersion() + ")");
            } else {
                // Fall back to invoking "node" by name (the same fallback
                // NodeDetector.findNodeExecutable uses) so checkEnvironment can
                // still pass when node is reachable on PATH but the probes failed.
                LOG.warn("Failed to auto-detect Node.js path. Error: " +
                    (detected != null ? detected.getErrorMessage() : "Unknown error"));
                claudeSDKBridge.setNodeExecutable("node");
                codexSDKBridge.setNodeExecutable("node");
                applyNodePathToCliBridges(cliBridges, "node");
            }

            final NodeDetectionResult nodeResult = detected;
            invokeLaterForToolWindow(() -> {
                if (host.isDisposed()) {
                    return;
                }
                continueCreateUIComponentsAfterNodeSetup(nodeResult);
            });
        });
    }

    /**
     * Continue UI initialization once the Node.js path has been resolved: environment
     * check, version gate, then browser creation. Must be called on the EDT.
     */
    private void continueCreateUIComponentsAfterNodeSetup(NodeDetectionResult nodeResult) {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        JPanel mainPanel = host.getMainPanel();
        JBCefBrowser browser = null;

        // The async detection path shows a loading panel while probing; clear it so
        // it cannot linger next to the browser component added below (BorderLayout
        // keeps only CENTER in its map, it does not remove stale children).
        mainPanel.removeAll();

        // Use the shared resolver from BridgePreloader for consistent state
        com.github.claudecodegui.bridge.BridgeDirectoryResolver sharedResolver = BridgePreloader.getSharedResolver();

        if (!claudeSDKBridge.checkEnvironment()) {
            if (sharedResolver.isExtractionInProgress()) {
                LOG.info("[ClaudeSDKToolWindow] checkEnvironment failed but extraction in progress, showing loading panel...");
                showLoadingPanel();
                sharedResolver.getExtractionFuture().thenAcceptAsync(ready -> {
                    if (ready) {
                        reinitializeAfterExtraction();
                    } else {
                        invokeLaterForToolWindow(this::showErrorPanel);
                    }
                });
                return;
            }

            if (sharedResolver.isExtractionComplete()) {
                LOG.info("[ClaudeSDKToolWindow] checkEnvironment failed but extraction just completed, retrying initialization with exponential backoff...");
                retryCheckEnvironmentWithBackoff(0);
                showLoadingPanel();
                return;
            }

            showErrorPanel();
            return;
        }

        // nodeResult is always the resolved verify/detection result here; a failure
        // result (or null) simply skips the version gate, matching prior behavior.
        if (nodeResult != null && nodeResult.isFound() && nodeResult.getNodeVersion() != null) {
            if (!NodeDetector.isVersionSupported(nodeResult.getNodeVersion())) {
                showVersionErrorPanel(nodeResult.getNodeVersion());
                return;
            }
        }

        // Prewarm daemon in background so first user message starts faster.
        // Bind the warm runtime to the current logical session epoch so future new-session
        // transitions cannot accidentally reuse stale anonymous runtime ownership.
        com.github.claudecodegui.session.ClaudeSession currentSession = host.getHandlerContext().getSession();
        if (currentSession != null) {
            if ("claude".equals(currentSession.getProvider())) {
                claudeSDKBridge.prewarmDaemonAsync(host.getProject().getBasePath(), currentSession.getRuntimeSessionEpoch());
            }
        } else {
            // Default to prewarming Claude if no session exists yet (e.g., first startup before session is loaded)
            claudeSDKBridge.prewarmDaemonAsync(host.getProject().getBasePath(), null);
        }

        // Check JCEF support before creating browser. Keep the precise status
        // so the fallback panel can distinguish a disabled registry flag from
        // a missing runtime or Android Studio's optional JCEF plugin.
        JBCefBrowserFactory.JcefSupportStatus jcefStatus = JBCefBrowserFactory.getJcefSupportStatus();
        if (jcefStatus != JBCefBrowserFactory.JcefSupportStatus.SUPPORTED) {
            LOG.warn("JCEF is not supported in this environment: " + jcefStatus);
            showJcefNotSupportedPanel(jcefStatus);
            return;
        }

        try {
            browser = JBCefBrowserFactory.create(host.getOsrHandlerFactory());
            JBCefBrowser createdBrowser = browser;
            host.setBrowser(createdBrowser);
            host.getHandlerContext().setBrowser(createdBrowser);

            createdBrowser.getJBCefClient().addRequestHandler(
                    new UiFontResourceRequestHandler(),
                    createdBrowser.getCefBrowser()
            );

            // JCEF JS bridges must be created and registered before loadHTML,
            // because the window.sendToJava / shortcut / clipboard handlers
            // injected in onLoadEnd depend on these JSQuery inject() handles.
            BrowserBridges currentBridges = new BrowserBridges(createdBrowser);
            synchronized (this.bridgeLock) {
                this.bridges = currentBridges;
            }
            currentBridges.jsQuery.addHandler((msg) -> {
                boolean dispatch;
                int pageGeneration;
                String message;
                synchronized (this.bridgeLock) {
                    pageGeneration = currentBridges.getPageGeneration();
                    message = unwrapBridgeMessage(msg, pageGeneration);
                    dispatch = message != null && !host.isDisposed()
                            && this.bridges == currentBridges
                            && currentBridges.isCurrentPage(createdBrowser, pageGeneration);
                }
                // Dispatch outside bridgeLock: handleJavaScriptMessage serializes on the dispatch
                // gate (MessageDispatchGate), not the host window, and dispose() runs
                // disposeBridges() outside that gate. Keeping bridgeLock and the gate un-nested -
                // bridgeLock is released before dispatch acquires the gate, and dispose acquires
                // the gate only for its short check-and-set (beginTeardown) before releasing it
                // for heavy teardown - avoids any lock-order inversion between the two. A teardown
                // that races this gap is caught by the gate: runInDispatch refuses once
                // beginTeardown has flipped disposed.
                if (dispatch) {
                    host.handleJavaScriptMessage(pageGeneration, message);
                }
                return new JBCefJSQuery.Response(dispatch ? "ok" : "stale");
            });

            currentBridges.clipboardPathQuery.addHandler((msg) -> {
                synchronized (this.bridgeLock) {
                    if (host.isDisposed() || this.bridges != currentBridges
                            || !currentBridges.isCurrentFor(createdBrowser)) {
                        return new JBCefJSQuery.Response("closed");
                    }
                }
                // Clipboard reads can stall on remote/slow clipboards (X11
                // selection IPC). Keep them outside bridgeLock so the message
                // dispatcher and sibling handlers are not blocked behind one
                // slow paste. handleClipboardPathRequest is a pure read and
                // never touches the browser or bridges, so racing a teardown
                // here is harmless — the response is dropped if the browser is
                // gone by the time it returns.
                return handleClipboardPathRequest();
            });

            // Create a dedicated JSQuery for hiding the CCG panel via Shift+Esc
            currentBridges.hidePanelQuery.addHandler((msg) -> {
                synchronized (this.bridgeLock) {
                    if (host.isDisposed() || this.bridges != currentBridges
                            || !currentBridges.isCurrentFor(createdBrowser)) {
                        return new JBCefJSQuery.Response("closed");
                    }
                }
                // Route through the project-aware invoker rather than
                // ApplicationManager.invokeLater: getInstance(project) throws
                // AlreadyDisposedException once the project closes, and the gap
                // between the isDisposed() check above and the EDT callback is
                // exactly when a project teardown can slip in. The helper uses
                // ToolWindowManager.invokeLater, which drops the callback when
                // the project is disposed.
                invokeLaterForToolWindow(() -> {
                    if (host.isDisposed()) {
                        return;
                    }
                    Project project = host.getProject();
                    if (project == null || project.isDisposed()) {
                        return;
                    }
                    ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                    if (toolWindow != null && toolWindow.isVisible()) {
                        toolWindow.hide();
                    }
                });
                return new JBCefJSQuery.Response("ok");
            });

            PageLoadKind initialPageLoadKind = consumeNextBrowserPageLoadKind();
            int initialPageGeneration = beginPageLoad(currentBridges, initialPageLoadKind);
            host.activatePageGeneration(initialPageGeneration);
            host.setFrontendReady(false);
            String htmlContent = loadChatHtmlWithInitialTabState();

            // LoadHandler must be registered before loadHTML, otherwise the
            // first frame's onLoadEnd is missed and the JS bridge injection
            // never runs, leaving the frontend without a sendToJava channel.
            // Register directly on the browser's dedicated native client. The
            // JBCefClient convenience overload filters callbacks through a map
            // keyed by CefBrowser objects, which is not reliable with Android
            // Studio's remote JCEF proxies and can silently drop onLoadEnd.
            CefLoadHandlerAdapter bridgeLoadHandler = new CefLoadHandlerAdapter() {
                @Override
                public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                    LOG.debug("onLoadEnd called, isMain=" + frame.isMain() + ", url=" + cefBrowser.getURL());

                    if (!frame.isMain() || host.isDisposed()) {
                        return;
                    }

                    String injection;
                    String shiftEscInjection;
                    String clipboardPathInjection;
                    String pageContextInjection;
                    int pageGeneration;
                    PageLoadKind pageLoadKind;
                    synchronized (WebviewInitializer.this.bridgeLock) {
                        if (WebviewInitializer.this.bridges != currentBridges
                                || !currentBridges.isCurrentFor(createdBrowser)) {
                            return;
                        }
                        pageGeneration = currentBridges.getPageGeneration();
                        pageLoadKind = currentBridges.getPageLoadKind();
                        pageContextInjection = buildPageContextInjection(pageGeneration, pageLoadKind);
                        injection = guardPageScript(pageGeneration,
                                buildBridgeInjection(currentBridges.jsQuery.inject(
                                        buildBridgeMessageExpression(pageGeneration))));
                        shiftEscInjection = guardPageScript(pageGeneration,
                                buildShiftEscInjection(
                                        currentBridges.hidePanelQuery.inject("''",
                                                "function() {}",
                                                "function() {}")));
                        clipboardPathInjection = guardPageScript(pageGeneration,
                            "window.getClipboardFilePath = function() {" +
                            "  return new Promise((resolve) => {" +
                            "    " + currentBridges.clipboardPathQuery.inject("''",
                                "function(response) { resolve(response); }",
                                "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                            "  });" +
                            "};");
                    }

                    try {
                        String runtimeBootstrap = joinRuntimePageBootstrap(
                                pageContextInjection,
                                injection,
                                shiftEscInjection,
                                clipboardPathInjection
                        );
                        cefBrowser.executeJavaScript(runtimeBootstrap, cefBrowser.getURL(), 0);
                    } catch (Exception | LinkageError e) {
                        LOG.debug("Skipping webview bridge injection after browser disposal: " + e.getMessage(), e);
                        return;
                    }

                    try {
                        // Forward console logs to IDEA console (dev mode only — IPC overhead hurts scroll FPS in production)
                        if (PlatformUtils.isPluginDevMode()) {
                            String consoleForward =
                            "const originalLog = console.log;" +
                            "const originalError = console.error;" +
                            "const originalWarn = console.warn;" +
                            "console.log = function(...args) {" +
                            "  originalLog.apply(console, args);" +
                            "  window.sendToJava(JSON.stringify({type: 'console.log', args: args}));" +
                            "};" +
                            "console.error = function(...args) {" +
                            "  originalError.apply(console, args);" +
                            "  window.sendToJava(JSON.stringify({type: 'console.error', args: args}));" +
                            "};" +
                            "console.warn = function(...args) {" +
                            "  originalWarn.apply(console, args);" +
                            "  window.sendToJava(JSON.stringify({type: 'console.warn', args: args}));" +
                            "};";
                            cefBrowser.executeJavaScript(consoleForward, cefBrowser.getURL(), 0);
                        }

                        injectFrontendConfiguration(cefBrowser, currentBridges, pageGeneration);

                        LOG.debug("onLoadEnd completed, waiting for frontend_ready signal");
                    } catch (Exception | LinkageError e) {
                        LOG.debug("Skipping webview initialization after browser disposal: " + e.getMessage(), e);
                    }
                }
            };
            CefClient nativeClient = createdBrowser.getJBCefClient().getCefClient();
            nativeClient.addLoadHandler(bridgeLoadHandler);

            // At this point the JSQuery bridges and the LoadHandler are both
            // registered, so it is safe to load the HTML - the first frame's
            // onLoadEnd will fire and inject the sendToJava bridge as expected.
            createdBrowser.loadHTML(htmlContent);
            scheduleBridgeInjectionRetries(createdBrowser, currentBridges, initialPageGeneration);

            JComponent browserComponent = createdBrowser.getComponent();

            // Set webview container background color to prevent white flash before HTML loads.
            browserComponent.setBackground(ThemeConfigService.getBackgroundColor());

            // Add drag-and-drop support - get full file paths
            new DropTarget(browserComponent, new DropTargetAdapter() {
                @Override
                public void drop(DropTargetDropEvent dtde) {
                    try {
                        dtde.acceptDrop(DnDConstants.ACTION_COPY);
                        Transferable transferable = dtde.getTransferable();

                        if (transferable.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                            @SuppressWarnings("unchecked")
                            List<File> files = (List<File>) transferable.getTransferData(DataFlavor.javaFileListFlavor);

                            if (!files.isEmpty()) {
                                JsonArray jsonArray = new JsonArray();
                                for (File file : files) {
                                    jsonArray.add(file.getAbsolutePath());
                                }

                                LOG.debug("Dropped " + files.size() + " file(s)");

                                String jsCode = String.format(
                                    "if (window.handleFilePathFromJava) { window.handleFilePathFromJava(%s); }",
                                    jsonArray.toString()
                                );
                                createdBrowser.getCefBrowser().executeJavaScript(
                                        jsCode, createdBrowser.getCefBrowser().getURL(), 0);
                            }
                            dtde.dropComplete(true);
                            return;
                        }
                    } catch (Exception ex) {
                        LOG.warn("Drop error: " + ex.getMessage(), ex);
                    }
                    dtde.dropComplete(false);
                }
            });

            mainPanel.add(browserComponent, BorderLayout.CENTER);
            mainPanel.revalidate();
            mainPanel.repaint();
            host.getWebviewWatchdog().resetTimestamps();
            host.getWebviewWatchdog().start();

        } catch (IllegalStateException e) {
            this.disposeFailedBrowser(browser);
            if (e.getMessage() != null && e.getMessage().contains("JCEF")) {
                LOG.error("JCEF initialization failed: " + e.getMessage(), e);
                showJcefNotSupportedPanel(JBCefBrowserFactory.JcefSupportStatus.UNAVAILABLE);
            } else {
                LOG.error("Failed to create UI components: " + e.getMessage(), e);
                showErrorPanel();
            }
        } catch (NullPointerException e) {
            this.disposeFailedBrowser(browser);
            String msg = e.getMessage();
            if (msg != null && msg.contains("isNull") && msg.contains("robj")) {
                LOG.error("JCEF remote mode incompatibility: " + e.getMessage(), e);
                showJcefRemoteModeErrorPanel();
            } else {
                LOG.error("Failed to create UI components (NPE): " + e.getMessage(), e);
                showErrorPanel();
            }
        } catch (Exception e) {
            this.disposeFailedBrowser(browser);
            LOG.error("Failed to create UI components: " + e.getMessage(), e);
            showErrorPanel();
        } catch (LinkageError e) {
            this.disposeFailedBrowser(browser);
            // Platform/JBR binary mismatch (e.g. Android Studio 2026.x whose
            // bundled JBR lacks JCefAppConfig.isRemoteEnabled()) throws Error,
            // not Exception - it must not crash the EDT with a blank panel.
            LOG.error("JCEF binary incompatibility: " + e.getMessage(), e);
            JBCefBrowserFactory.JcefSupportStatus status = JBCefBrowserFactory.isJbrMissingJcefRemoteApi()
                    ? JBCefBrowserFactory.JcefSupportStatus.OUTDATED_JBR
                    : JBCefBrowserFactory.JcefSupportStatus.UNAVAILABLE;
            showJcefNotSupportedPanel(status);
        }
    }

    private void scheduleBridgeInjectionRetries(
            JBCefBrowser browser,
            BrowserBridges currentBridges,
            int pageGeneration
    ) {
        boolean scheduled = currentBridges.startBridgeInjectionRetriesIfAbsent(
                pageGeneration,
                () -> shouldRunBridgeInjectionRetries(
                        host.isDisposed(), host.isFrontendReady(), host.isWebviewActive()),
                attempt -> injectBridgeFallback(browser, currentBridges, pageGeneration, attempt));
        if (!scheduled) {
            if (!host.isFrontendReady() && !host.isWebviewActive()) {
                LOG.debug("[JCEF] Bridge injection retries paused while webview is inactive");
            }
            return;
        }
        LOG.info("[JCEF] Scheduled fallback bridge injection retries until frontend readiness");
    }

    static boolean shouldRunBridgeInjectionRetries(
            boolean disposed,
            boolean frontendReady,
            boolean webviewActive
    ) {
        return !disposed && !frontendReady && webviewActive;
    }

    /** Resume startup bridge fallback when a previously hidden tab becomes active. */
    public void onTabActivated() {
        if (host.isDisposed() || host.isFrontendReady() || !host.isWebviewActive()) {
            return;
        }

        JBCefBrowser currentBrowser;
        BrowserBridges currentBridges;
        int currentPageGeneration;
        synchronized (this.bridgeLock) {
            currentBrowser = host.getBrowser();
            currentBridges = this.bridges;
            if (currentBrowser == null || currentBridges == null
                    || !currentBridges.isCurrentFor(currentBrowser)) {
                return;
            }
            currentPageGeneration = currentBridges.getPageGeneration();
        }
        scheduleBridgeInjectionRetries(currentBrowser, currentBridges, currentPageGeneration);
    }

    private int beginPageLoad(BrowserBridges expectedBridges, PageLoadKind pageLoadKind) {
        synchronized (this.bridgeLock) {
            if (this.bridges != expectedBridges) {
                throw new IllegalStateException("Cannot load a page for stale browser bridges");
            }
            int nextPageGeneration = nextPageGeneration();
            expectedBridges.beginPageLoad(nextPageGeneration, pageLoadKind);
            return nextPageGeneration;
        }
    }

    private int invalidateCurrentPage() {
        synchronized (this.bridgeLock) {
            int nextPageGeneration = nextPageGeneration();
            if (this.bridges != null) {
                this.bridges.beginPageLoad(nextPageGeneration, PageLoadKind.INITIAL_LOAD);
            }
            return nextPageGeneration;
        }
    }

    int nextPageGeneration() {
        synchronized (this.bridgeLock) {
            this.pageGeneration += 1;
            return this.pageGeneration;
        }
    }

    static int bridgeInjectionRetryDelayMs(int attempt) {
        return attempt <= BRIDGE_INJECTION_FAST_RETRY_ATTEMPTS
                ? BRIDGE_INJECTION_FAST_RETRY_INTERVAL_MS
                : BRIDGE_INJECTION_SLOW_RETRY_INTERVAL_MS;
    }

    /**
     * Android Studio's remote JCEF can render loadHTML without delivering the
     * browser-scoped onLoadEnd callback. Retry the minimum bootstrap directly
     * in the active page so the frontend can establish its Java bridge and
     * request dependency status. The timer stops as soon as frontend_ready is
     * received. Retries slow down after the initial five-second startup window.
     */
    private boolean injectBridgeFallback(
            JBCefBrowser browser,
            BrowserBridges currentBridges,
            int pageGeneration,
            int attempt
    ) {
        String bridgeInjection;
        String shiftEscInjection;
        String clipboardPathInjection;
        String pageContextInjection;
        PageLoadKind pageLoadKind;
        synchronized (this.bridgeLock) {
            if (this.bridges != currentBridges
                    || !currentBridges.isCurrentPage(browser, pageGeneration)) {
                return false;
            }
            pageLoadKind = currentBridges.getPageLoadKind();
            pageContextInjection = buildPageContextInjection(pageGeneration, pageLoadKind);
            bridgeInjection = guardPageScript(pageGeneration,
                    buildBridgeInjection(currentBridges.jsQuery.inject(
                            buildBridgeMessageExpression(pageGeneration))));
            shiftEscInjection = guardPageScript(pageGeneration,
                    buildShiftEscInjection(
                            currentBridges.hidePanelQuery.inject("''",
                                    "function() {}",
                                    "function() {}")));
            clipboardPathInjection = guardPageScript(pageGeneration,
                    "window.getClipboardFilePath = function() {" +
                    "  return new Promise((resolve) => {" +
                    "    " + currentBridges.clipboardPathQuery.inject("''",
                            "function(response) { resolve(response); }",
                            "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                    "  });" +
                    "};");
        }

        try {
            CefBrowser cefBrowser = browser.getCefBrowser();
            String url = cefBrowser.getURL();
            String runtimeBootstrap = joinRuntimePageBootstrap(
                    pageContextInjection,
                    bridgeInjection,
                    shiftEscInjection,
                    clipboardPathInjection
            );
            cefBrowser.executeJavaScript(runtimeBootstrap, url, 0);

            injectFrontendConfiguration(cefBrowser, currentBridges, pageGeneration);
            if (attempt == 1) {
                LOG.info("[JCEF] Executed first fallback bridge injection for remote-mode startup");
            }
            return true;
        } catch (Exception e) {
            LOG.debug("Fallback bridge injection failed on attempt " + attempt + ": " + e.getMessage(), e);
            return true;
        } catch (LinkageError e) {
            LOG.warn("Fallback bridge injection is unavailable: " + e.getMessage(), e);
            return false;
        }
    }

    static String buildShiftEscInjection(String hidePanelInvocation) {
        return "if (!window.__ccgShiftEscInstalled) {" +
                "  window.__ccgShiftEscInstalled = true;" +
                "  document.addEventListener('keydown', function(e) {" +
                "    if (e.key === 'Escape' && e.shiftKey) {" +
                "      e.preventDefault();" +
                "      e.stopPropagation();" +
                "      " + hidePanelInvocation +
                "    }" +
                "  }, true);" +
                "}";
    }

    static String buildBridgeInjection(String queryInvocation) {
        return "window.sendToJava = function(msg) { " + queryInvocation + " };"
                + "if (typeof window.__ccgOnBridgeReady === 'function') {"
                + "  window.__ccgOnBridgeReady();"
                + "}";
    }

    static String buildBridgeMessageExpression(int pageGeneration) {
        return "'__CCG_PAGE_GENERATION__:" + pageGeneration + ":' + String(msg)";
    }

    /**
     * Establishes the Java-owned runtime page context before any bridge function is exposed.
     * Repeated fallback injections for the same generation are idempotent so they cannot reset
     * the recovery-applied marker after React consumes the authoritative backend state.
     */
    static String buildPageContextInjection(int pageGeneration, PageLoadKind pageLoadKind) {
        boolean authoritativeRecovery = pageLoadKind.authoritativeRecovery;
        return "if (window.__CCG_PAGE_GENERATION__ !== " + pageGeneration
                + " || window.__CCGUI_PAGE_CONTEXT_READY__ !== true) {"
                + "window.__CCG_PAGE_GENERATION__ = " + pageGeneration + ";"
                + "window.__CCGUI_PAGE_LOAD_KIND__ = '" + pageLoadKind.wireName + "';"
                + "window.__CCGUI_RECOVERY_RELOAD__ = " + authoritativeRecovery + ";"
                + "window.__CCGUI_RECOVERY_STATE_APPLIED__ = " + !authoritativeRecovery + ";"
                + "window.__CCGUI_PAGE_CONTEXT_READY__ = true;"
                + "};";
    }

    /**
     * Joins runtime context and guarded bridge scripts into one renderer invocation so the
     * bridge can never become visible before its generation and recovery context.
     */
    static String joinRuntimePageBootstrap(String pageContext, String... guardedScripts) {
        return pageContext + String.join("", guardedScripts);
    }

    private PageLoadKind consumeNextBrowserPageLoadKind() {
        synchronized (this.bridgeLock) {
            PageLoadKind pageLoadKind = this.nextBrowserPageLoadKind;
            this.nextBrowserPageLoadKind = PageLoadKind.INITIAL_LOAD;
            return pageLoadKind;
        }
    }

    private PageLoadKind recoveryPageLoadKind() {
        return recoveryPageLoadKind(host.hasEverBeenFrontendReady());
    }

    static PageLoadKind recoveryPageLoadKind(boolean hasEverBeenFrontendReady) {
        return hasEverBeenFrontendReady
                ? PageLoadKind.RUNTIME_RECOVERY
                : PageLoadKind.STARTUP_RETRY;
    }

    /** Returns whether the active page is recovering state after having reached frontend readiness. */
    public boolean isRuntimeRecoveryPage() {
        synchronized (this.bridgeLock) {
            return this.bridges != null
                    && this.bridges.getPageLoadKind() == PageLoadKind.RUNTIME_RECOVERY;
        }
    }

    static String unwrapBridgeMessage(String message, int expectedPageGeneration) {
        String prefix = "__CCG_PAGE_GENERATION__:" + expectedPageGeneration + ":";
        if (message == null || !message.startsWith(prefix)) {
            return null;
        }
        return message.substring(prefix.length());
    }

    static String guardPageScript(int pageGeneration, String script) {
        return "if (window.__CCG_PAGE_GENERATION__ === " + pageGeneration + ") {"
                + script
                + "}";
    }

    static List<String> buildConfigurationInjections(
            String editorFontConfig,
            String uiFontConfig,
            String codeFontConfig,
            String languageConfig
    ) {
        String escapedUiFontConfig = JsUtils.escapeJs(uiFontConfig);
        String escapedCodeFontConfig = JsUtils.escapeJs(codeFontConfig);
        return List.of(
                String.format(
                        "if (window.applyIdeaFontConfig) { window.applyIdeaFontConfig(%s); } " +
                                "else { window.__pendingFontConfig = %s; }",
                        editorFontConfig, editorFontConfig),
                String.format(
                        "(function(){ var c = JSON.parse('%s'); " +
                                "if (window.applyUiFontConfig) { window.applyUiFontConfig(c); } " +
                                "else { window.__pendingUiFontConfig = c; } })()",
                        escapedUiFontConfig),
                String.format(
                        "(function(){ var c = JSON.parse('%s'); " +
                                "if (window.applyCodeFontConfig) { window.applyCodeFontConfig(c); } " +
                                "else { window.__pendingCodeFontConfig = c; } })()",
                        escapedCodeFontConfig),
                String.format(
                        "if (window.applyIdeaLanguageConfig) { window.applyIdeaLanguageConfig(%s); } " +
                                "else { window.__pendingLanguageConfig = %s; }",
                        languageConfig, languageConfig)
        );
    }

    private void injectFrontendConfiguration(
            CefBrowser cefBrowser,
            BrowserBridges currentBridges,
            int pageGeneration
    ) {
        String idempotentConfigurationScript = currentBridges.getOrCreateConfigurationScript(
                pageGeneration,
                () -> buildFrontendConfigurationScript(pageGeneration));
        if (idempotentConfigurationScript == null) {
            return;
        }
        cefBrowser.executeJavaScript(
                guardPageScript(pageGeneration, idempotentConfigurationScript),
                cefBrowser.getURL(),
                0);
        LOG.debug("[WebviewConfigSync] Frontend configuration injected");
    }

    private String buildFrontendConfigurationScript(int pageGeneration) {
        String editorFontConfig = FontConfigService.getEditorFontConfigJson();
        String uiFontConfig = FontConfigService.getResolvedUiFontConfigJson(
                host.getHandlerContext().getSettingsService());
        String codeFontConfig = FontConfigService.getResolvedCodeFontConfigJson(
                host.getHandlerContext().getSettingsService());
        String languageConfig = LanguageConfigService.getLanguageConfigJson(
                host.getHandlerContext().getSettingsService());

        String configurationScript = joinConfigurationInjections(buildConfigurationInjections(
                editorFontConfig, uiFontConfig, codeFontConfig, languageConfig));
        return
                "if (window.__CCG_CONFIG_GENERATION__ !== " + pageGeneration + ") {"
                + configurationScript
                + "window.__CCG_CONFIG_GENERATION__ = " + pageGeneration + ";"
                + "}";
    }

    static String joinConfigurationInjections(List<String> injections) {
        return String.join(";", injections) + ";";
    }

    private JBCefJSQuery.Response handleClipboardPathRequest() {
        try {
            LOG.debug("Clipboard path request received");
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            Transferable contents = clipboard.getContents(null);

            if (contents != null && contents.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                @SuppressWarnings("unchecked")
                List<File> files = (List<File>) contents.getTransferData(DataFlavor.javaFileListFlavor);

                if (!files.isEmpty()) {
                    File file = files.get(0);
                    String filePath = file.getAbsolutePath();
                    LOG.debug("Returning file path from clipboard: " + filePath);
                    return new JBCefJSQuery.Response(filePath);
                }
            }
            LOG.debug("No file in clipboard");
            return new JBCefJSQuery.Response("");
        } catch (Exception ex) {
            LOG.warn("Error getting clipboard path: " + ex.getMessage());
            return new JBCefJSQuery.Response("");
        }
    }

    private void disposeFailedBrowser(JBCefBrowser browser) {
        if (browser == null) {
            return;
        }

        BrowserBridges currentBridges;
        synchronized (this.bridgeLock) {
            currentBridges = this.bridges;
            if (currentBridges != null && currentBridges.belongsTo(browser)) {
                this.bridges = null;
            } else {
                currentBridges = null;
            }
        }
        if (currentBridges != null) {
            currentBridges.dispose();
        }
        if (this.host.getBrowser() == browser) {
            this.host.setBrowser(null);
            this.host.getHandlerContext().setBrowser(null);
        }
        try {
            browser.dispose();
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to dispose browser after webview initialization error: " + e.getMessage(), e);
        }
    }

    /**
     * Replace the main panel's CENTER content, then force a layout refresh.
     * All show*Panel helpers must go through this to avoid stale loading/error panels
     * lingering when called from async callbacks (invokeLater).
     */
    private void replaceMainContent(JPanel newPanel) {
        JPanel mainPanel = host.getMainPanel();
        mainPanel.removeAll();
        mainPanel.add(newPanel, BorderLayout.CENTER);
        mainPanel.revalidate();
        mainPanel.repaint();
    }

    public void showErrorPanel() {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        String message = ClaudeCodeGuiBundle.message(
            "error.nodeNotFound.message", claudeSDKBridge.getNodeExecutable());

        JPanel errorPanel = ErrorPanelBuilder.build(
            ClaudeCodeGuiBundle.message("error.nodeNotFound.title"),
            message,
            claudeSDKBridge.getNodeExecutable(),
            this::handleNodePathSave
        );
        replaceMainContent(errorPanel);
    }

    private void showVersionErrorPanel(String currentVersion) {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        int minVersion = NodeDetector.MIN_NODE_MAJOR_VERSION;
        String message = ClaudeCodeGuiBundle.message(
            "error.nodeVersionTooOld.message",
            currentVersion, String.valueOf(minVersion), claudeSDKBridge.getNodeExecutable());

        JPanel errorPanel = ErrorPanelBuilder.build(
            ClaudeCodeGuiBundle.message("error.nodeVersionTooOld.title"),
            message,
            claudeSDKBridge.getNodeExecutable(),
            this::handleNodePathSave
        );
        replaceMainContent(errorPanel);
    }

    private void showInvalidNodePathPanel(String path, String errMsg) {
        String message = "Saved Node.js path is not available: " + path + "\n\n" +
            (errMsg != null ? errMsg + "\n\n" : "") +
            "Please save a valid Node.js path below.";

        JPanel errorPanel = ErrorPanelBuilder.build(
            "Node.js Path Unavailable",
            message,
            path,
            this::handleNodePathSave
        );
        replaceMainContent(errorPanel);
    }

    private void showJcefNotSupportedPanel(JBCefBrowserFactory.JcefSupportStatus status) {
        // Terminal state: JCEF is unavailable, so the watchdog has no webview to
        // monitor. Stop it to avoid spurious recovery cycles after the user
        // enables JCEF (which requires a restart anyway).
        host.getWebviewWatchdog().stop();
        String title;
        String solution;
        switch (status) {
            case DISABLED_BY_REGISTRY:
                JPanel disabledPanel = ErrorPanelBuilder.buildCenteredPanel(
                        "⚠️",
                        ClaudeCodeGuiBundle.message("toolwindow.jcefDisabled"),
                        ClaudeCodeGuiBundle.message("toolwindow.jcefDisabledSolution"),
                        ClaudeCodeGuiBundle.message("toolwindow.jcefEnableAction"),
                        this::enableJcefAndShowRestartPanel
                );
                replaceMainContent(disabledPanel);
                return;
            case OUTDATED_JBR:
                title = ClaudeCodeGuiBundle.message("toolwindow.jcefOutdatedJbr");
                solution = ClaudeCodeGuiBundle.message("toolwindow.jcefOutdatedJbrSolution");
                break;
            case ANDROID_STUDIO_PLUGIN_MISSING:
                title = ClaudeCodeGuiBundle.message("toolwindow.jcefPluginMissing");
                solution = ClaudeCodeGuiBundle.message("toolwindow.jcefPluginMissingSolution");
                break;
            default:
                title = ClaudeCodeGuiBundle.message("toolwindow.jcefNotInstalled");
                solution = ClaudeCodeGuiBundle.message("toolwindow.jcefNotInstalledSolution");
                break;
        }
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel("⚠️", title, solution);
        replaceMainContent(panel);
    }

    private void enableJcefAndShowRestartPanel() {
        if (!JBCefBrowserFactory.enableJcefInRegistry()) {
            LOG.warn("Could not enable JCEF in the IDE registry");
            return;
        }
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
                "✓",
                ClaudeCodeGuiBundle.message("toolwindow.jcefRestartRequired"),
                ClaudeCodeGuiBundle.message("toolwindow.jcefRestartRequiredSolution")
        );
        replaceMainContent(panel);
    }

    private void showJcefRemoteModeErrorPanel() {
        // Terminal state: the remote CefServer process is unhealthy, so every
        // reload/recreate against it will keep throwing the same NPE (JBR-9234,
        // out-of-process JCEF on IntelliJ 2025.2+ / JCEF 144). Stop the watchdog
        // so it does not loop back into recreate every cooldown and re-flash this
        // panel. The offered action disables out-of-process JCEF in the Registry
        // — the documented workaround — after which an IDE restart initialises
        // JCEF in-process and the message router stops throwing.
        host.getWebviewWatchdog().stop();
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
            "⚠️",
            ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteError"),
            ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteSolution"),
            ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteAction"),
            this::disableOutOfProcessJcefAndShowRestartPanel
        );
        replaceMainContent(panel);
    }

    private void disableOutOfProcessJcefAndShowRestartPanel() {
        if (!JBCefBrowserFactory.disableOutOfProcessJcefInRegistry()) {
            LOG.warn("Could not disable out-of-process JCEF in the IDE registry");
            // The button must not appear to do nothing: show the manual
            // VM-option fallback so the user can still apply the workaround.
            JPanel failedPanel = ErrorPanelBuilder.buildCenteredPanel(
                    "⚠️",
                    ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteActionFailedTitle"),
                    ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteActionFailed")
            );
            replaceMainContent(failedPanel);
            return;
        }
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
                "✓",
                ClaudeCodeGuiBundle.message("toolwindow.jcefOutOfProcessDisabled"),
                ClaudeCodeGuiBundle.message("toolwindow.jcefOutOfProcessDisabledSolution")
        );
        replaceMainContent(panel);
    }

    /**
     * Show a generic restart-required panel when webview recovery failed
     * for non-JCEF-specific reasons (e.g., panel removal, dispose errors).
     */
    private void showWebviewRecoveryFailedPanel() {
        host.getWebviewWatchdog().stop();
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
            "⚠️",
            ClaudeCodeGuiBundle.message("toolwindow.jcefRestartRequired"),
            ClaudeCodeGuiBundle.message("toolwindow.jcefRestartRequiredSolution")
        );
        replaceMainContent(panel);
    }

    private void showLoadingPanel() {
        JPanel panel = ErrorPanelBuilder.buildLoadingPanel(
            "⏳",
            ClaudeCodeGuiBundle.message("toolwindow.extractingTitle"),
            ClaudeCodeGuiBundle.message("toolwindow.extractingDesc")
        );
        replaceMainContent(panel);
        LOG.info("[ClaudeSDKToolWindow] Showing loading panel while bridge extracts...");
    }

    private void invokeLaterForToolWindow(@NotNull Runnable runnable) {
        Project project = this.host.getProject();
        if (project != null && !project.isDisposed()) {
            ToolWindowManager.getInstance(project).invokeLater(runnable);
            return;
        }
        ApplicationManager.getApplication().invokeLater(runnable);
    }

    /**
     * Reinitialize UI after bridge extraction completes.
     */
    private void reinitializeAfterExtraction() {
        invokeLaterForToolWindow(() -> {
            LOG.info("[ClaudeSDKToolWindow] Bridge extraction complete, reinitializing UI...");
            JPanel mainPanel = host.getMainPanel();
            mainPanel.removeAll();
            createUIComponents();
            mainPanel.revalidate();
            mainPanel.repaint();
        });
    }

    /**
     * Retry environment check with exponential backoff strategy.
     */
    private void retryCheckEnvironmentWithBackoff(int attempt) {
        final int MAX_RETRIES = 3;
        final int[] BACKOFF_DELAYS_MS = {100, 200, 400};

        if (attempt >= MAX_RETRIES) {
            LOG.warn("[ClaudeSDKToolWindow] All " + MAX_RETRIES + " retry attempts failed after extraction completion");
            invokeLaterForToolWindow(this::showErrorPanel);
            return;
        }

        int delayMs = BACKOFF_DELAYS_MS[attempt];
        LOG.info("[ClaudeSDKToolWindow] Retry attempt " + (attempt + 1) + "/" + MAX_RETRIES + ", waiting " + delayMs + "ms...");

        CompletableFuture.runAsync(() -> {
            try {
                Thread.sleep(delayMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }).thenRun(() -> {
            invokeLaterForToolWindow(() -> {
                if (host.getClaudeSDKBridge().checkEnvironment()) {
                    LOG.info("[ClaudeSDKToolWindow] Retry attempt " + (attempt + 1) + " succeeded after extraction completion");
                    reinitializeAfterExtraction();
                } else {
                    retryCheckEnvironmentWithBackoff(attempt + 1);
                }
            });
        });
    }

    /**
     * Handle Node.js path save from the error panel input.
     * Verification and auto-detection spawn subprocesses that can block for seconds
     * (or hang in VM/container environments), so they run on a pooled thread; all
     * UI updates are dispatched back to the EDT.
     */
    public void handleNodePathSave(String manualPath) {
        ClaudeSDKBridge claudeSDKBridge = this.host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = this.host.getCodexSDKBridge();
        Map<String, MarkerCliBridge> cliBridges = this.host.getCliBridges();
        JPanel mainPanel = this.host.getMainPanel();

        final boolean clearRequested = manualPath == null || manualPath.isEmpty();
        if (clearRequested) {
            // Clear the saved path up front so no bridge can use the stale path
            // while detection runs, and show a loading panel in the meantime.
            PropertiesComponent props = PropertiesComponent.getInstance();
            props.unsetValue(NODE_PATH_PROPERTY_KEY);
            claudeSDKBridge.setNodeExecutable(null);
            codexSDKBridge.setNodeExecutable(null);
            applyNodePathToCliBridges(cliBridges, null);
            LOG.info("Cleared manual Node.js path, scheduling auto-detection on background thread");
            showLoadingPanel();
        }

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();

                if (clearRequested) {
                    NodeDetectionResult detected = claudeSDKBridge.detectNodeWithDetails();
                    if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                        String detectedPath = detected.getNodePath();
                        props.setValue(NODE_PATH_PROPERTY_KEY, detectedPath);
                        claudeSDKBridge.verifyAndCacheNodePath(detectedPath);
                        codexSDKBridge.setNodeExecutable(detectedPath);
                        applyNodePathToCliBridges(cliBridges, detectedPath);
                        LOG.info("Auto-detected and saved Node.js path: " + detectedPath);
                    }
                    reinitializeUi(mainPanel);
                    return;
                }

                // Verify before saving to avoid caching invalid path
                NodeDetectionResult result = claudeSDKBridge.verifyAndCacheNodePath(manualPath);
                if (result != null && result.isFound()) {
                    // Only save if verification succeeds
                    props.setValue(NODE_PATH_PROPERTY_KEY, manualPath);
                    claudeSDKBridge.setNodeExecutable(manualPath);
                    codexSDKBridge.setNodeExecutable(manualPath);
                    applyNodePathToCliBridges(cliBridges, manualPath);
                    LOG.info("Saved manual Node.js path: " + manualPath);
                    reinitializeUi(mainPanel);
                } else {
                    // Verification failed, show error and don't save invalid path.
                    // Don't reinitialize UI, let user try again.
                    String errorMsg = result != null ? result.getErrorMessage() : "Unknown error";
                    LOG.warn("Node.js path verification failed: " + manualPath + " - " + errorMsg);
                    invokeLaterForToolWindow(() -> JOptionPane.showMessageDialog(mainPanel,
                            "Node.js path verification failed: " + errorMsg + "\n\nPath not saved.",
                            "Invalid Node.js Path", JOptionPane.WARNING_MESSAGE));
                }
            } catch (Exception ex) {
                invokeLaterForToolWindow(() -> JOptionPane.showMessageDialog(mainPanel,
                    "Error saving or applying Node.js path: " + ex.getMessage(),
                    "Error", JOptionPane.ERROR_MESSAGE));
            }
        });
    }

    /**
     * Rebuild the tool window UI on the EDT after the Node.js path changed.
     */
    private void reinitializeUi(JPanel mainPanel) {
        invokeLaterForToolWindow(() -> {
            if (host.isDisposed()) {
                return;
            }
            mainPanel.removeAll();
            createUIComponents();
            mainPanel.revalidate();
            mainPanel.repaint();
        });
    }

    /**
     * Reload the webview HTML content.
     */
    public void reloadWebview(String reason) {
        runOnEventDispatchThread(() -> {
            if (host.isDisposed()) { return; }
            JBCefBrowser browser = host.getBrowser();
            if (browser == null) {
                recreateWebview(reason + "_no_browser");
                return;
            }
            try {
                LOG.info("[WebviewWatchdog] Reloading webview (" + reason + ")");
                BrowserBridges currentBridges;
                int pageGeneration;
                synchronized (this.bridgeLock) {
                    currentBridges = this.bridges;
                    pageGeneration = currentBridges == null || !currentBridges.belongsTo(browser)
                            ? -1
                            : beginPageLoad(currentBridges, recoveryPageLoadKind());
                }
                if (pageGeneration < 0) {
                    recreateWebview(reason + "_stale_bridges");
                    return;
                }
                host.activatePageGeneration(pageGeneration);
                host.setFrontendReady(false);
                reloadCurrentPage(browser.getCefBrowser());
                scheduleBridgeInjectionRetries(browser, currentBridges, pageGeneration);
                host.getWebviewWatchdog().resetTimestamps();
                host.getMainPanel().revalidate();
                host.getMainPanel().repaint();
            } catch (Exception | LinkageError e) {
                LOG.warn("[WebviewWatchdog] Reload failed, escalating to recreate: " + e.getMessage(), e);
                recreateWebview(reason + "_reload_failed");
            }
        });
    }

    /**
     * Reloads the URL already registered for the JCEF browser instead of registering another
     * full HTML payload in the platform-wide {@code loadHTML} request map.
     */
    static void reloadCurrentPage(CefBrowser cefBrowser) {
        cefBrowser.reload();
    }

    private String loadChatHtmlWithInitialTabState() {
        HtmlLoader htmlLoader = host.getHtmlLoader();
        String htmlContent = htmlLoader.loadChatHtml();

        // Each tab reads the same localStorage snapshot. Preserve the session's
        // provider and model on both initial load and watchdog recovery.
        ClaudeSession session = host.getHandlerContext() != null
                ? host.getHandlerContext().getSession() : null;
        String tabProvider = session != null ? session.getProvider() : null;
        String tabModel = session != null ? session.getModel() : null;
        String htmlWithTabState = htmlLoader.injectInitialTabState(htmlContent, tabProvider, tabModel);
        String htmlWithDshPresets = htmlLoader.injectInitialDshPresets(
                htmlWithTabState,
                SessionState.discoverUserDshPresetIds());
        return htmlLoader.injectPageContextBootstrap(htmlWithDshPresets);
    }

    /**
     * Recreate the webview from scratch (dispose old, create new).
     */
    public void recreateWebview(String reason) {
        runOnEventDispatchThread(() -> {
            if (host.isDisposed()) { return; }

            synchronized (this.bridgeLock) {
                this.nextBrowserPageLoadKind = recoveryPageLoadKind();
            }
            int invalidationGeneration = invalidateCurrentPage();
            host.activatePageGeneration(invalidationGeneration);
            host.setFrontendReady(false);
            JPanel mainPanel = host.getMainPanel();
            JBCefBrowser browser = host.getBrowser();
            try {
                if (browser != null) {
                    try {
                        mainPanel.remove(browser.getComponent());
                    } catch (Exception ignored) {
                    }
                    // Release the JS bridges before the browser itself so the
                    // native callback handles do not outlive the browser.
                    this.disposeBridges();
                    host.getHandlerContext().setBrowser(null);
                    host.setBrowser(null);
                    try {
                        browser.dispose();
                    } catch (Exception | LinkageError e) {
                        LOG.debug("[WebviewWatchdog] Failed to dispose old browser: " + e.getMessage(), e);
                    }
                }

                LOG.info("[WebviewWatchdog] Recreating webview (" + reason + ")");
                mainPanel.removeAll();
                createUIComponents();
                mainPanel.revalidate();
                mainPanel.repaint();
            } catch (Exception e) {
                LOG.warn("[WebviewWatchdog] Recreate failed: " + e.getMessage(), e);
                // An exception reaching here escaped createUIComponents' internal
                // handler (which already routes JCEF remote NPEs to the restart
                // panel). mainPanel was already cleared above, so without a
                // terminal panel the tab would be left permanently blank.
                // Use a generic restart panel instead of JCEF-remote-specific,
                // since the error could be from remove/dispose/revalidate rather
                // than JCEF itself.
                showWebviewRecoveryFailedPanel();
            }
        });
    }

    private void runOnEventDispatchThread(Runnable action) {
        if (SwingUtilities.isEventDispatchThread()) {
            action.run();
        } else {
            ApplicationManager.getApplication().invokeLater(action);
        }
    }

    /**
     * Release the JBCefJSQuery bridges.
     * Must be called before the owning browser is disposed so the native
     * callback handles do not outlive the browser.
     */
    public void disposeBridges() {
        BrowserBridges currentBridges;
        synchronized (this.bridgeLock) {
            currentBridges = this.bridges;
            this.bridges = null;
        }
        // Dispose outside the lock so the JCEF native teardown each query
        // triggers does not stall other bridgeLock waiters (onLoadEnd, the
        // generation checks in sibling handlers). Bridges == null above
        // guarantees no new dispatch will race with the native query disposal
        // that follows, and message handlers no longer hold bridgeLock while
        // dispatching into the host.
        if (currentBridges != null) {
            currentBridges.dispose();
        }
    }

    private static final class BrowserBridges {
        private final JBCefBrowser browser;
        private final JBCefJSQuery jsQuery;
        private final JBCefJSQuery clipboardPathQuery;
        private final JBCefJSQuery hidePanelQuery;
        private int pageGeneration;
        private PageLoadKind pageLoadKind = PageLoadKind.INITIAL_LOAD;
        private final PageConfigurationCache configurationCache = new PageConfigurationCache();
        private final BridgeInjectionTimerLifecycle bridgeRetryLifecycle =
                new BridgeInjectionTimerLifecycle();

        private BrowserBridges(JBCefBrowser browser) {
            this.browser = browser;
            JBCefJSQuery createdJsQuery = null;
            JBCefJSQuery createdClipboardPathQuery = null;
            JBCefJSQuery createdHidePanelQuery = null;
            try {
                JBCefBrowserBase browserBase = browser;
                createdJsQuery = JBCefJSQuery.create(browserBase);
                createdClipboardPathQuery = JBCefJSQuery.create(browserBase);
                createdHidePanelQuery = JBCefJSQuery.create(browserBase);
            } catch (RuntimeException | LinkageError e) {
                disposeQueryQuietly(createdHidePanelQuery);
                disposeQueryQuietly(createdClipboardPathQuery);
                disposeQueryQuietly(createdJsQuery);
                throw e;
            }
            this.jsQuery = createdJsQuery;
            this.clipboardPathQuery = createdClipboardPathQuery;
            this.hidePanelQuery = createdHidePanelQuery;
        }

        private synchronized void beginPageLoad(int newPageGeneration, PageLoadKind newPageLoadKind) {
            this.pageGeneration = newPageGeneration;
            this.pageLoadKind = newPageLoadKind;
            this.configurationCache.reset(newPageGeneration);
            this.bridgeRetryLifecycle.beginPageLoad(newPageGeneration);
        }

        private synchronized int getPageGeneration() {
            return pageGeneration;
        }

        private synchronized PageLoadKind getPageLoadKind() {
            return pageLoadKind;
        }

        private boolean belongsTo(JBCefBrowser browser) {
            return this.browser == browser;
        }

        private boolean isCurrentFor(JBCefBrowser browser) {
            // Remote JCEF proxies used by Android Studio can report isClosed()
            // while their rendered page and JSQuery channel are still active.
            // The owning WebviewInitializer already clears its bridge generation
            // before browser disposal/recreation, so identity is the reliable
            // lifecycle guard for callbacks and fallback injection.
            return this.belongsTo(browser);
        }

        private synchronized boolean isCurrentPage(JBCefBrowser browser, int expectedPageGeneration) {
            return this.belongsTo(browser) && pageGeneration == expectedPageGeneration;
        }

        private boolean startBridgeInjectionRetriesIfAbsent(
                int expectedPageGeneration,
                BooleanSupplier retryAllowed,
                IntPredicate retryAction
        ) {
            return this.bridgeRetryLifecycle.startIfAbsent(
                    expectedPageGeneration, retryAllowed, retryAction);
        }

        private void stopBridgeInjectionTimer() {
            this.bridgeRetryLifecycle.stop();
        }

        private String getOrCreateConfigurationScript(
                int expectedPageGeneration,
                Supplier<String> scriptBuilder
        ) {
            return this.configurationCache.getOrCreate(expectedPageGeneration, scriptBuilder);
        }

        private void dispose() {
            stopBridgeInjectionTimer();
            disposeQueryQuietly(this.hidePanelQuery);
            disposeQueryQuietly(this.clipboardPathQuery);
            disposeQueryQuietly(this.jsQuery);
        }
    }

    /** Owns the single Swing retry timer associated with the current runtime page generation. */
    static final class BridgeInjectionTimerLifecycle {
        private int pageGeneration;
        private Timer timer;

        synchronized void beginPageLoad(int newPageGeneration) {
            stop();
            this.pageGeneration = newPageGeneration;
        }

        boolean startIfAbsent(
                int expectedPageGeneration,
                BooleanSupplier retryAllowed,
                IntPredicate retryAction
        ) {
            if (!retryAllowed.getAsBoolean()) {
                stopIfCurrentGeneration(expectedPageGeneration);
                return false;
            }

            AtomicInteger attempts = new AtomicInteger();
            Timer candidate = new Timer(BRIDGE_INJECTION_FAST_RETRY_INTERVAL_MS, null);
            candidate.addActionListener(event -> {
                int attempt = attempts.incrementAndGet();
                if (!retryAllowed.getAsBoolean()) {
                    stop(candidate);
                    return;
                }
                candidate.setDelay(bridgeInjectionRetryDelayMs(attempt + 1));
                if (!retryAction.test(attempt)) {
                    stop(candidate);
                }
            });
            candidate.setInitialDelay(BRIDGE_INJECTION_FAST_RETRY_INTERVAL_MS);

            synchronized (this) {
                if (this.pageGeneration != expectedPageGeneration || this.timer != null) {
                    return false;
                }
                this.timer = candidate;
            }
            candidate.start();
            return true;
        }

        synchronized void stop() {
            if (this.timer != null) {
                this.timer.stop();
                this.timer = null;
            }
        }

        private synchronized void stopIfCurrentGeneration(int expectedPageGeneration) {
            if (this.pageGeneration == expectedPageGeneration) {
                stop();
            }
        }

        private synchronized void stop(Timer expectedTimer) {
            expectedTimer.stop();
            if (this.timer == expectedTimer) {
                this.timer = null;
            }
        }

        synchronized Timer getTimer() {
            return this.timer;
        }
    }

    static final class PageConfigurationCache {
        private int pageGeneration;
        private String configurationScript;

        synchronized void reset(int newPageGeneration) {
            this.pageGeneration = newPageGeneration;
            this.configurationScript = null;
        }

        synchronized String getOrCreate(int expectedPageGeneration, Supplier<String> scriptBuilder) {
            if (this.pageGeneration != expectedPageGeneration) {
                return null;
            }
            if (this.configurationScript == null) {
                this.configurationScript = scriptBuilder.get();
            }
            return this.configurationScript;
        }
    }

    private static void disposeQueryQuietly(JBCefJSQuery query) {
        if (query == null) {
            return;
        }
        try {
            query.dispose();
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to dispose JBCefJSQuery: " + e.getMessage(), e);
        }
    }
}
