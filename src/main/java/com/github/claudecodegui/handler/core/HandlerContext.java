package com.github.claudecodegui.handler.core;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.gemini.GeminiSDKBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;

import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * Handler context.
 * Provides all shared resources and callbacks needed by handlers.
 */
public class HandlerContext {

    public static final String DEFAULT_MODEL = "claude-sonnet-5";
    public static final String DEFAULT_PROVIDER = "claude";

    private final Project project;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final GeminiSDKBridge geminiSDKBridge;
    private final GrokSDKBridge grokSDKBridge;
    private final CodemossSettingsService settingsService;
    private final JsCallback jsCallback;
    private final BooleanSupplier activeContentSupplier;
    private final Supplier<String> contentTitleSupplier;
    private volatile Runnable contentActivator = () -> { };

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
        this(project, claudeSDKBridge, codexSDKBridge, null, null, settingsService, jsCallback, () -> true, () -> null);
    }

    public HandlerContext(
            Project project,
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            CodemossSettingsService settingsService,
            JsCallback jsCallback,
            BooleanSupplier activeContentSupplier,
            Supplier<String> contentTitleSupplier
    ) {
        this(project, claudeSDKBridge, codexSDKBridge, null, null, settingsService, jsCallback,
                activeContentSupplier, contentTitleSupplier);
    }

    public HandlerContext(
            Project project,
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            GeminiSDKBridge geminiSDKBridge,
            GrokSDKBridge grokSDKBridge,
            CodemossSettingsService settingsService,
            JsCallback jsCallback,
            BooleanSupplier activeContentSupplier,
            Supplier<String> contentTitleSupplier
    ) {
        this.project = project;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.geminiSDKBridge = geminiSDKBridge;
        this.grokSDKBridge = grokSDKBridge;
        this.settingsService = settingsService;
        this.jsCallback = jsCallback;
        this.activeContentSupplier = activeContentSupplier == null ? () -> true : activeContentSupplier;
        this.contentTitleSupplier = contentTitleSupplier == null ? () -> null : contentTitleSupplier;
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

    public GeminiSDKBridge getGeminiSDKBridge() {
        return geminiSDKBridge;
    }

    public GrokSDKBridge getGrokSDKBridge() {
        return grokSDKBridge;
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

    public boolean isActiveContent() {
        try {
            return activeContentSupplier.getAsBoolean();
        } catch (RuntimeException e) {
            return true;
        }
    }

    public String getContentTitle() {
        try {
            return contentTitleSupplier.get();
        } catch (RuntimeException e) {
            return null;
        }
    }

    public void activateContent() {
        if (!disposed) {
            contentActivator.run();
        }
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

    public void setContentActivator(Runnable contentActivator) {
        this.contentActivator = contentActivator == null ? () -> { } : contentActivator;
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
