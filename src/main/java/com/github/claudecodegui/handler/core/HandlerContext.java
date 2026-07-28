package com.github.claudecodegui.handler.core;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;

/**
 * Handler context.
 * Provides all shared resources and callbacks needed by handlers.
 */
public class HandlerContext {

    public static final String DEFAULT_MODEL = "claude-sonnet-4-6";
    public static final String DEFAULT_PROVIDER = "claude";

    private final Project project;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final CodemossSettingsService settingsService;
    private final JsCallback jsCallback;

    // Mutable state accessed via getters/setters — volatile for thread safety
    private volatile ClaudeSession session;
    private volatile JBCefBrowser browser;
    private volatile String currentModel = DEFAULT_MODEL;
    private volatile String currentProvider = DEFAULT_PROVIDER;
    private volatile boolean disposed = false;

    /**
     * JavaScript callback interface.
     */
    public interface JsCallback {
        void callJavaScript(String functionName, String... args);
        String escapeJs(String str);
    }

    public HandlerContext(
            Project project,
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            CodemossSettingsService settingsService,
            JsCallback jsCallback
    ) {
        this.project = project;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.settingsService = settingsService;
        this.jsCallback = jsCallback;
    }

    // Getters
    public Project getProject() {
        return project;
    }

    public ClaudeSDKBridge getClaudeSDKBridge() {
        return claudeSDKBridge;
    }

    public CodexSDKBridge getCodexSDKBridge() {
        return codexSDKBridge;
    }

    public CodemossSettingsService getSettingsService() {
        return settingsService;
    }

    /**
     * Resolve the normalized effective working directory for the current project —
     * the custom working directory when configured and valid, otherwise the project
     * base path. This is the directory Claude runs in and the key history is stored
     * under, so history readers must use this instead of the raw base path.
     *
     * <p>Null-safe: returns the raw base path when no settings service is wired.
     */
    public String resolveEffectiveWorkingDirectory() {
        String basePath = project != null ? project.getBasePath() : null;
        if (settingsService == null) {
            return basePath;
        }
        return settingsService.getEffectiveWorkingDirectory(basePath);
    }

    public ClaudeSession getSession() {
        return session;
    }

    public JBCefBrowser getBrowser() {
        return browser;
    }

    public String getCurrentModel() {
        return currentModel;
    }

    public String getCurrentProvider() {
        return currentProvider;
    }

    public boolean isDisposed() {
        return disposed;
    }

    // Setters
    public void setSession(ClaudeSession session) {
        this.session = session;
    }

    public void setBrowser(JBCefBrowser browser) {
        this.browser = browser;
    }

    public void setCurrentModel(String currentModel) {
        this.currentModel = currentModel;
    }

    public void setCurrentProvider(String currentProvider) {
        this.currentProvider = currentProvider;
    }

    public void setDisposed(boolean disposed) {
        this.disposed = disposed;
    }

    // JavaScript callback proxy methods
    public void callJavaScript(String functionName, String... args) {
        jsCallback.callJavaScript(functionName, args);
    }

    public String escapeJs(String str) {
        return jsCallback.escapeJs(str);
    }

    /**
     * Execute JavaScript on the EDT (Event Dispatch Thread).
     */
    public void executeJavaScriptOnEDT(String jsCode) {
        JBCefBrowser targetBrowser = this.browser;
        if (targetBrowser == null || this.disposed) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (this.disposed || this.browser != targetBrowser) {
                return;
            }
            try {
                org.cef.browser.CefBrowser cefBrowser = targetBrowser.getCefBrowser();
                cefBrowser.executeJavaScript(jsCode, cefBrowser.getURL(), 0);
            } catch (Exception | LinkageError ignored) {
                // The webview may be disposed between the generation check and execution.
            }
        });
    }
}
