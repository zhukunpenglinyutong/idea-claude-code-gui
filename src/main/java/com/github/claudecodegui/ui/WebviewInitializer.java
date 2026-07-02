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

/**
 * Handles webview (JCEF browser) creation, configuration, error panels,
 * and webview lifecycle (reload, recreate, recovery).
 */
public class WebviewInitializer {

    private static final Logger LOG = Logger.getInstance(WebviewInitializer.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

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
        void setFrontendReady(boolean ready);
    }

    private final WebviewHost host;

    public WebviewInitializer(WebviewHost host) {
        this.host = host;
    }

    /**
     * Create and configure UI components (browser, JS bridge, drag-and-drop).
     */
    public void createUIComponents() {
        JPanel mainPanel = host.getMainPanel();

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

        // Check JCEF support before creating browser
        if (!JBCefBrowserFactory.isJcefSupported()) {
            LOG.warn("JCEF is not supported in this environment");
            showJcefNotSupportedPanel();
            return;
        }

        try {
            JBCefBrowser browser = JBCefBrowserFactory.create();
            host.setBrowser(browser);
            host.getHandlerContext().setBrowser(browser);

            browser.getJBCefClient().addRequestHandler(
                    new UiFontResourceRequestHandler(),
                    browser.getCefBrowser()
            );

            JBCefBrowserBase browserBase = browser;
            JBCefJSQuery jsQuery = JBCefJSQuery.create(browserBase);
            jsQuery.addHandler((msg) -> {
                host.handleJavaScriptMessage(msg);
                return new JBCefJSQuery.Response("ok");
            });

            // Create a dedicated JSQuery for getting clipboard file paths
            JBCefJSQuery getClipboardPathQuery = JBCefJSQuery.create(browserBase);
            getClipboardPathQuery.addHandler((msg) -> {
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
            });

            // Create a dedicated JSQuery for hiding the CCG panel via Shift+Esc
            JBCefJSQuery hidePanelQuery = JBCefJSQuery.create(browserBase);
            hidePanelQuery.addHandler((msg) -> {
                try {
                    Project project = host.getProject();
                    if (project != null && !project.isDisposed()) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                            if (toolWindow != null && toolWindow.isVisible()) {
                                toolWindow.hide();
                            }
                        });
                    }
                } catch (Exception ex) {
                    LOG.warn("Failed to hide CCG panel via shortcut: " + ex.getMessage());
                }
                return new JBCefJSQuery.Response("ok");
            });

            HtmlLoader htmlLoader = host.getHtmlLoader();
            String htmlContent = htmlLoader.loadChatHtml();

            // Per-tab provider/model injection: each tab's WebView reads the
            // same global localStorage snapshot, so without this every tab on
            // IDE startup overrides the per-tab provider that
            // ClaudeChatWindow.restorePersistedTabSessionState already wrote to
            // the session — see issue #1353.
            ClaudeSession session =
                    host.getHandlerContext() != null ? host.getHandlerContext().getSession() : null;
            String tabProvider = session != null ? session.getProvider() : null;
            String tabModel = session != null ? session.getModel() : null;
            htmlContent = htmlLoader.injectInitialTabState(htmlContent, tabProvider, tabModel);

            browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                @Override
                public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                    LOG.debug("onLoadEnd called, isMain=" + frame.isMain() + ", url=" + cefBrowser.getURL());

                    if (!frame.isMain()) {
                        return;
                    }

                    String injection = "window.sendToJava = function(msg) { " + jsQuery.inject("msg") + " };";
                    cefBrowser.executeJavaScript(injection, cefBrowser.getURL(), 0);

                    // Register Shift+Esc shortcut handler.
                    // Intercepted at the JavaScript level — JCEF forwards keydown events
                    // to the renderer before Chromium processes them for Task Manager.
                    String shiftEscInjection =
                        "document.addEventListener('keydown', function(e) {" +
                        "  if (e.key === 'Escape' && e.shiftKey) {" +
                        "    e.preventDefault();" +
                        "    e.stopPropagation();" +
                        "    " + hidePanelQuery.inject("''",
                            "function() {}",
                            "function() {}") +
                        "  }" +
                        "}, true);";
                    cefBrowser.executeJavaScript(shiftEscInjection, cefBrowser.getURL(), 0);

                    // Inject clipboard path retrieval function
                    String clipboardPathInjection =
                        "window.getClipboardFilePath = function() {" +
                        "  return new Promise((resolve) => {" +
                        "    " + getClipboardPathQuery.inject("''",
                            "function(response) { resolve(response); }",
                            "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                        "  });" +
                        "};";
                    cefBrowser.executeJavaScript(clipboardPathInjection, cefBrowser.getURL(), 0);

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

                    // Pass IDEA editor font configuration to the frontend
                    String fontConfig = FontConfigService.getEditorFontConfigJson();
                    LOG.info("[FontSync] Retrieved font config: " + fontConfig);
                    String fontConfigInjection = String.format(
                        "if (window.applyIdeaFontConfig) { window.applyIdeaFontConfig(%s); } " +
                        "else { window.__pendingFontConfig = %s; }",
                        fontConfig, fontConfig
                    );
                    cefBrowser.executeJavaScript(fontConfigInjection, cefBrowser.getURL(), 0);
                    LOG.info("[FontSync] Font config injected into frontend");

                    // Pass effective plugin UI font configuration to the frontend
                    String uiFontConfig = FontConfigService.getResolvedUiFontConfigJson(host.getHandlerContext().getSettingsService());
                    LOG.info("[UiFontSync] Retrieved UI font config");
                    String escapedUiFontConfig = JsUtils.escapeJs(uiFontConfig);
                    String uiFontConfigInjection = String.format(
                        "(function(){ var c = JSON.parse('%s'); " +
                        "if (window.applyUiFontConfig) { window.applyUiFontConfig(c); } " +
                        "else { window.__pendingUiFontConfig = c; } })()",
                        escapedUiFontConfig
                    );
                    cefBrowser.executeJavaScript(uiFontConfigInjection, cefBrowser.getURL(), 0);
                    LOG.info("[UiFontSync] UI font config injected into frontend");

                    // Pass effective code font configuration to the frontend
                    String codeFontConfig = FontConfigService.getResolvedCodeFontConfigJson(host.getHandlerContext().getSettingsService());
                    LOG.info("[CodeFontSync] Retrieved code font config");
                    String escapedCodeFontConfig = JsUtils.escapeJs(codeFontConfig);
                    String codeFontConfigInjection = String.format(
                        "(function(){ var c = JSON.parse('%s'); " +
                        "if (window.applyCodeFontConfig) { window.applyCodeFontConfig(c); } " +
                        "else { window.__pendingCodeFontConfig = c; } })()",
                        escapedCodeFontConfig
                    );
                    cefBrowser.executeJavaScript(codeFontConfigInjection, cefBrowser.getURL(), 0);
                    LOG.info("[CodeFontSync] Code font config injected into frontend");

                    // Pass IDEA language configuration to the frontend
                    String languageConfig = LanguageConfigService.getLanguageConfigJson(host.getHandlerContext().getSettingsService());
                    LOG.info("[LanguageSync] Retrieved language config: " + languageConfig);
                    String languageConfigInjection = String.format(
                        "if (window.applyIdeaLanguageConfig) { window.applyIdeaLanguageConfig(%s); } " +
                        "else { window.__pendingLanguageConfig = %s; }",
                        languageConfig, languageConfig
                    );
                    cefBrowser.executeJavaScript(languageConfigInjection, cefBrowser.getURL(), 0);
                    LOG.info("[LanguageSync] Language config injected into frontend");

                    LOG.debug("onLoadEnd completed, waiting for frontend_ready signal");
                }
            }, browser.getCefBrowser());

            browser.loadHTML(htmlContent);

            // Reset webview health markers and start watchdog once the browser is created.
            host.getWebviewWatchdog().resetTimestamps();
            host.getWebviewWatchdog().start();

            JComponent browserComponent = browser.getComponent();

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
                                browser.getCefBrowser().executeJavaScript(jsCode, browser.getCefBrowser().getURL(), 0);
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

        } catch (IllegalStateException e) {
            if (e.getMessage() != null && e.getMessage().contains("JCEF")) {
                LOG.error("JCEF initialization failed: " + e.getMessage(), e);
                showJcefNotSupportedPanel();
            } else {
                LOG.error("Failed to create UI components: " + e.getMessage(), e);
                showErrorPanel();
            }
        } catch (NullPointerException e) {
            String msg = e.getMessage();
            if (msg != null && msg.contains("isNull") && msg.contains("robj")) {
                LOG.error("JCEF remote mode incompatibility: " + e.getMessage(), e);
                showJcefRemoteModeErrorPanel();
            } else {
                LOG.error("Failed to create UI components (NPE): " + e.getMessage(), e);
                showErrorPanel();
            }
        } catch (Exception e) {
            LOG.error("Failed to create UI components: " + e.getMessage(), e);
            showErrorPanel();
        } catch (LinkageError e) {
            // Platform/JBR binary mismatch (e.g. Android Studio 2026.x whose
            // bundled JBR lacks JCefAppConfig.isRemoteEnabled()) throws Error,
            // not Exception - it must not crash the EDT with a blank panel.
            LOG.error("JCEF binary incompatibility: " + e.getMessage(), e);
            showJcefNotSupportedPanel();
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

    private void showJcefNotSupportedPanel() {
        String title;
        String solution;
        if (JBCefBrowserFactory.isJbrMissingJcefRemoteApi()) {
            // Known Android Studio 2026.x case: JCEF is present but the
            // bundled JBR is too old for the platform's JCEF API. Show a
            // targeted "upgrade your Boot JBR" guide instead of the generic
            // "JCEF not installed" message.
            title = ClaudeCodeGuiBundle.message("toolwindow.jcefOutdatedJbr");
            solution = ClaudeCodeGuiBundle.message("toolwindow.jcefOutdatedJbrSolution");
        } else {
            title = ClaudeCodeGuiBundle.message("toolwindow.jcefNotInstalled");
            solution = ClaudeCodeGuiBundle.message("toolwindow.jcefNotInstalledSolution");
        }
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel("⚠️", title, solution);
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
                browser.loadHTML(host.getHtmlLoader().loadChatHtml());
                host.getMainPanel().revalidate();
                host.getMainPanel().repaint();
            } catch (Exception e) {
                LOG.warn("[WebviewWatchdog] Reload failed: " + e.getMessage(), e);
            }
        });
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
                    try {
                        browser.dispose();
                    } catch (Exception e) {
                        LOG.debug("[WebviewWatchdog] Failed to dispose old browser: " + e.getMessage(), e);
                    }
                    host.setBrowser(null);
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
}
