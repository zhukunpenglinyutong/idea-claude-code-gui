package com.github.claudecodegui.ui;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
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

/**
 * Handles webview (JCEF browser) creation, configuration, error panels,
 * and webview lifecycle (reload, recreate, recovery).
 */
public class WebviewInitializer {

    private static final Logger LOG = Logger.getInstance(WebviewInitializer.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";
    private static final int BRIDGE_INJECTION_RETRY_INTERVAL_MS = 100;
    private static final int BRIDGE_INJECTION_MAX_ATTEMPTS = 50;

    /**
     * Host interface providing access to window-level dependencies.
     */
    public interface WebviewHost {
        Project getProject();
        ClaudeSDKBridge getClaudeSDKBridge();
        CodexSDKBridge getCodexSDKBridge();
        JPanel getMainPanel();
        HtmlLoader getHtmlLoader();
        HandlerContext getHandlerContext();
        JBCefBrowser getBrowser();
        void setBrowser(JBCefBrowser browser);
        boolean isDisposed();
        void handleJavaScriptMessage(String message);
        WebviewWatchdog getWebviewWatchdog();
        boolean isFrontendReady();
        void setFrontendReady(boolean ready);
    }

    private final WebviewHost host;

    private final Object bridgeLock = new Object();

    /**
     * JCEF JS bridges for the current browser. Keeping each browser's queries
     * together prevents a stale load callback from using a replacement browser's
     * native callback handles during a watchdog recreation.
     */
    private volatile BrowserBridges bridges;

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

        JPanel mainPanel = host.getMainPanel();
        JBCefBrowser browser = null;

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

        PropertiesComponent props = PropertiesComponent.getInstance();
        String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);
        com.github.claudecodegui.model.NodeDetectionResult nodeResult = null;

        if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
            String trimmed = savedNodePath.trim();
            claudeSDKBridge.setNodeExecutable(trimmed);
            codexSDKBridge.setNodeExecutable(trimmed);
            nodeResult = claudeSDKBridge.verifyAndCacheNodePath(trimmed);
            if (nodeResult == null || !nodeResult.isFound()) {
                showInvalidNodePathPanel(trimmed, nodeResult != null ? nodeResult.getErrorMessage() : null);
                return;
            }
        } else {
            nodeResult = claudeSDKBridge.detectNodeWithDetails();
            if (nodeResult != null && nodeResult.isFound() && nodeResult.getNodePath() != null) {
                props.setValue(NODE_PATH_PROPERTY_KEY, nodeResult.getNodePath());
                claudeSDKBridge.setNodeExecutable(nodeResult.getNodePath());
                codexSDKBridge.setNodeExecutable(nodeResult.getNodePath());
                claudeSDKBridge.verifyAndCacheNodePath(nodeResult.getNodePath());
            }
        }

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

        if (nodeResult == null) {
            nodeResult = claudeSDKBridge.detectNodeWithDetails();
        }
        if (nodeResult != null && nodeResult.isFound() && nodeResult.getNodeVersion() != null) {
            if (!NodeDetector.isVersionSupported(nodeResult.getNodeVersion())) {
                showVersionErrorPanel(nodeResult.getNodeVersion());
                return;
            }
        }

        // Prewarm daemon in background so first user message starts faster.
        // Bind the warm runtime to the current logical session epoch so future new-session
        // transitions cannot accidentally reuse stale anonymous runtime ownership.
        claudeSDKBridge.prewarmDaemonAsync(host.getProject().getBasePath(), host.getHandlerContext().getSession() != null
                ? host.getHandlerContext().getSession().getRuntimeSessionEpoch()
                : null);

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
            browser = JBCefBrowserFactory.create();
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
                synchronized (this.bridgeLock) {
                    dispatch = !host.isDisposed() && this.bridges == currentBridges
                            && currentBridges.isCurrentFor(createdBrowser);
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
                    host.handleJavaScriptMessage(msg);
                }
                return new JBCefJSQuery.Response(dispatch ? "ok" : "closed");
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
                    synchronized (WebviewInitializer.this.bridgeLock) {
                        if (WebviewInitializer.this.bridges != currentBridges
                                || !currentBridges.isCurrentFor(createdBrowser)) {
                            return;
                        }
                        injection = "window.sendToJava = function(msg) { "
                                + currentBridges.jsQuery.inject("msg") + " };";
                        shiftEscInjection = buildShiftEscInjection(
                                currentBridges.hidePanelQuery.inject("''",
                                        "function() {}",
                                        "function() {}"));
                        clipboardPathInjection =
                            "window.getClipboardFilePath = function() {" +
                            "  return new Promise((resolve) => {" +
                            "    " + currentBridges.clipboardPathQuery.inject("''",
                                "function(response) { resolve(response); }",
                                "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                            "  });" +
                            "};";
                    }

                    try {
                        cefBrowser.executeJavaScript(injection, cefBrowser.getURL(), 0);
                        cefBrowser.executeJavaScript(shiftEscInjection, cefBrowser.getURL(), 0);
                        cefBrowser.executeJavaScript(clipboardPathInjection, cefBrowser.getURL(), 0);
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

                        injectFrontendConfiguration(cefBrowser);

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
            scheduleBridgeInjectionRetries(createdBrowser, currentBridges);

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
            BrowserBridges currentBridges
    ) {
        AtomicInteger attempts = new AtomicInteger();
        Timer timer = new Timer(BRIDGE_INJECTION_RETRY_INTERVAL_MS, null);
        timer.addActionListener(event -> {
            int attempt = attempts.incrementAndGet();
            if (host.isDisposed() || host.isFrontendReady()
                    || attempt > BRIDGE_INJECTION_MAX_ATTEMPTS) {
                currentBridges.stopBridgeInjectionTimer();
                return;
            }
            if (!injectBridgeFallback(browser, currentBridges, attempt)) {
                currentBridges.stopBridgeInjectionTimer();
            }
        });
        timer.setInitialDelay(BRIDGE_INJECTION_RETRY_INTERVAL_MS);
        currentBridges.setBridgeInjectionTimer(timer);
        LOG.info("[JCEF] Scheduled fallback bridge injection retries for remote-mode startup");
        timer.start();
    }

    /**
     * Android Studio's remote JCEF can render loadHTML without delivering the
     * browser-scoped onLoadEnd callback. Retry the minimum bootstrap directly
     * in the active page so the frontend can establish its Java bridge and
     * request dependency status. The timer stops as soon as frontend_ready is
     * received, or after a bounded five-second startup window.
     */
    private boolean injectBridgeFallback(
            JBCefBrowser browser,
            BrowserBridges currentBridges,
            int attempt
    ) {
        String bridgeInjection;
        String shiftEscInjection;
        String clipboardPathInjection;
        synchronized (this.bridgeLock) {
            if (this.bridges != currentBridges || !currentBridges.isCurrentFor(browser)) {
                return false;
            }
            bridgeInjection = "window.sendToJava = function(msg) { "
                    + currentBridges.jsQuery.inject("msg") + " };";
            shiftEscInjection = buildShiftEscInjection(
                    currentBridges.hidePanelQuery.inject("''",
                            "function() {}",
                            "function() {}"));
            clipboardPathInjection =
                    "window.getClipboardFilePath = function() {" +
                    "  return new Promise((resolve) => {" +
                    "    " + currentBridges.clipboardPathQuery.inject("''",
                            "function(response) { resolve(response); }",
                            "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                    "  });" +
                    "};";
        }

        try {
            CefBrowser cefBrowser = browser.getCefBrowser();
            String url = cefBrowser.getURL();
            cefBrowser.executeJavaScript(bridgeInjection, url, 0);
            cefBrowser.executeJavaScript(shiftEscInjection, url, 0);
            cefBrowser.executeJavaScript(clipboardPathInjection, url, 0);

            injectFrontendConfiguration(cefBrowser);
            if (attempt == 1) {
                LOG.info("[JCEF] Executed first fallback bridge injection for remote-mode startup");
            }
            return true;
        } catch (Exception | LinkageError e) {
            LOG.debug("Fallback bridge injection failed on attempt " + attempt + ": " + e.getMessage(), e);
            return attempt < BRIDGE_INJECTION_MAX_ATTEMPTS;
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

    private void injectFrontendConfiguration(CefBrowser cefBrowser) {
        String editorFontConfig = FontConfigService.getEditorFontConfigJson();
        String uiFontConfig = FontConfigService.getResolvedUiFontConfigJson(
                host.getHandlerContext().getSettingsService());
        String codeFontConfig = FontConfigService.getResolvedCodeFontConfigJson(
                host.getHandlerContext().getSettingsService());
        String languageConfig = LanguageConfigService.getLanguageConfigJson(
                host.getHandlerContext().getSettingsService());
        String url = cefBrowser.getURL();

        for (String injection : buildConfigurationInjections(
                editorFontConfig, uiFontConfig, codeFontConfig, languageConfig)) {
            cefBrowser.executeJavaScript(injection, url, 0);
        }
        LOG.info("[WebviewConfigSync] Frontend configuration injected");
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
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
            "⚠️",
            ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteError"),
            ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteSolution")
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
     */
    public void handleNodePathSave(String manualPath) {
        ClaudeSDKBridge claudeSDKBridge = this.host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = this.host.getCodexSDKBridge();
        JPanel mainPanel = this.host.getMainPanel();

        try {
            PropertiesComponent props = PropertiesComponent.getInstance();

            if (manualPath == null || manualPath.isEmpty()) {
                // Clear saved path and trigger auto-detection
                props.unsetValue(NODE_PATH_PROPERTY_KEY);
                claudeSDKBridge.setNodeExecutable(null);
                codexSDKBridge.setNodeExecutable(null);
                LOG.info("Cleared manual Node.js path, triggering auto-detection");

                NodeDetectionResult detected = claudeSDKBridge.detectNodeWithDetails();
                if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                    String detectedPath = detected.getNodePath();
                    props.setValue(NODE_PATH_PROPERTY_KEY, detectedPath);
                    claudeSDKBridge.verifyAndCacheNodePath(detectedPath);
                    codexSDKBridge.setNodeExecutable(detectedPath);
                    LOG.info("Auto-detected and saved Node.js path: " + detectedPath);
                }
            } else {
                // Verify before saving to avoid caching invalid path
                NodeDetectionResult result = claudeSDKBridge.verifyAndCacheNodePath(manualPath);
                if (result != null && result.isFound()) {
                    // Only save if verification succeeds
                    props.setValue(NODE_PATH_PROPERTY_KEY, manualPath);
                    claudeSDKBridge.setNodeExecutable(manualPath);
                    codexSDKBridge.setNodeExecutable(manualPath);
                    LOG.info("Saved manual Node.js path: " + manualPath);
                } else {
                    // Verification failed, show error and don't save invalid path
                    String errorMsg = result != null ? result.getErrorMessage() : "Unknown error";
                    LOG.warn("Node.js path verification failed: " + manualPath + " - " + errorMsg);
                    JOptionPane.showMessageDialog(mainPanel,
                        "Node.js path verification failed: " + errorMsg + "\n\nPath not saved.",
                        "Invalid Node.js Path", JOptionPane.WARNING_MESSAGE);
                    return; // Don't reinitialize UI, let user try again
                }
            }

            invokeLaterForToolWindow(() -> {
                mainPanel.removeAll();
                createUIComponents();
                mainPanel.revalidate();
                mainPanel.repaint();
            });

        } catch (Exception ex) {
            JOptionPane.showMessageDialog(mainPanel,
                "Error saving or applying Node.js path: " + ex.getMessage(),
                "Error", JOptionPane.ERROR_MESSAGE);
        }
    }

    /**
     * Reload the webview HTML content.
     */
    public void reloadWebview(String reason) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (host.isDisposed()) { return; }
            JBCefBrowser browser = host.getBrowser();
            if (browser == null) {
                recreateWebview(reason + "_no_browser");
                return;
            }
            host.setFrontendReady(false);
            try {
                LOG.info("[WebviewWatchdog] Reloading webview (" + reason + ")");
                browser.loadHTML(loadChatHtmlWithInitialTabState());
                BrowserBridges currentBridges;
                synchronized (this.bridgeLock) {
                    currentBridges = this.bridges;
                }
                if (currentBridges != null && currentBridges.belongsTo(browser)) {
                    scheduleBridgeInjectionRetries(browser, currentBridges);
                }
                host.getWebviewWatchdog().resetTimestamps();
                host.getMainPanel().revalidate();
                host.getMainPanel().repaint();
            } catch (Exception e) {
                LOG.warn("[WebviewWatchdog] Reload failed: " + e.getMessage(), e);
            }
        });
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
        return htmlLoader.injectInitialTabState(htmlContent, tabProvider, tabModel);
    }

    /**
     * Recreate the webview from scratch (dispose old, create new).
     */
    public void recreateWebview(String reason) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (host.isDisposed()) { return; }

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
            }
        });
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
        private Timer bridgeInjectionTimer;

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

        private synchronized void setBridgeInjectionTimer(Timer timer) {
            stopBridgeInjectionTimer();
            this.bridgeInjectionTimer = timer;
        }

        private synchronized void stopBridgeInjectionTimer() {
            if (this.bridgeInjectionTimer != null) {
                this.bridgeInjectionTimer.stop();
                this.bridgeInjectionTimer = null;
            }
        }

        private void dispose() {
            stopBridgeInjectionTimer();
            disposeQueryQuietly(this.hidePanelQuery);
            disposeQueryQuietly(this.clipboardPathQuery);
            disposeQueryQuietly(this.jsQuery);
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
