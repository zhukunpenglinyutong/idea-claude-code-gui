package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.action.SendShortcutSync;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.history.HistoryHandler;
import com.github.claudecodegui.handler.core.MessageDispatcher;
import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionCallbackAdapter;
import com.github.claudecodegui.session.SessionLifecycleManager;
import com.github.claudecodegui.session.StreamMessageCoalescer;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.ui.ChatWindowDelegate;
import com.github.claudecodegui.ui.EditorContextTracker;
import com.github.claudecodegui.ui.WebviewInitializer;
import com.github.claudecodegui.ui.WebviewWatchdog;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.jcef.JBCefBrowser;

import javax.swing.*;
import java.awt.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Chat window instance. Coordinates UI components, session management,
 * and message dispatching. One instance per tab.
 */
public class ClaudeChatWindow {

    private static final Logger LOG = Logger.getInstance(ClaudeChatWindow.class);

    private final JPanel mainPanel;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final Project project;
    private final CodemossSettingsService settingsService;
    private final HtmlLoader htmlLoader;

    private Content parentContent;
    private String originalTabName;
    private volatile String sessionId = null;
    // Stable PermissionService routing key, assigned once at construction.
    // Kept separate from sessionId, which is overwritten with AI session IDs
    // (onSessionIdReceived) and would otherwise break dispose-time cleanup and
    // clearPermissionDecisionMemory(), both of which must reach the instance
    // the bridges actually route permission requests to.
    private String permissionServiceKey = null;

    private JBCefBrowser browser;
    // volatile: read from the daemon reader thread by the session_updated listener
    // and its loadFromServer continuation, while reassigned on the EDT.
    private volatile ClaudeSession session;
    private final WebviewWatchdog webviewWatchdog;
    private final StreamMessageCoalescer streamCoalescer;

    private volatile boolean disposed = false;
    private volatile boolean initialized = false;
    private volatile boolean frontendReady = false;
    private final PendingCodeSnippetBuffer pendingCodeSnippetBuffer = new PendingCodeSnippetBuffer();
    private volatile boolean slashCommandsFetched = false;
    private final AtomicBoolean restoredHistoryLoadStarted = new AtomicBoolean(false);

    // Daemon event listener for AI title forwarding. Held so it can be removed on dispose.
    private DaemonBridge.DaemonEventListener titleEventListener;
    private volatile int fetchedSlashCommandsCount = 0;

    // Coalesces session_updated reloads. SessionState's message list is not
    // thread-safe and loadFromServer() runs async, so concurrent background-task
    // completions must not reload at the same time. Guarded by sessionReloadLock.
    private final Object sessionReloadLock = new Object();
    private boolean sessionReloadInFlight = false;
    private boolean sessionReloadPending = false;

    private HandlerContext handlerContext;
    private MessageDispatcher messageDispatcher;
    private PermissionHandler permissionHandler;
    private HistoryHandler historyHandler;
    private final SessionLifecycleManager sessionLifecycleManager;

    // Delegates
    private WebviewInitializer webviewInitializer;
    private final EditorContextTracker editorContextTracker;
    private final ChatWindowDelegate chatWindowDelegate;
    private SessionCallbackAdapter sessionCallbackAdapter;

    public ClaudeChatWindow(Project project) {
        this(project, false);
    }

    public ClaudeChatWindow(Project project, boolean skipRegister) {
        this.project = project;
        this.claudeSDKBridge = new ClaudeSDKBridge();
        this.codexSDKBridge = new CodexSDKBridge();
        this.settingsService = new CodemossSettingsService();
        this.htmlLoader = new HtmlLoader(getClass());
        this.mainPanel = new JPanel(new BorderLayout());

        this.mainPanel.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());

        this.streamCoalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                ClaudeChatWindow.this.callJavaScript(functionName, args);
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }
        });

        this.webviewWatchdog = new WebviewWatchdog(
                mainPanel,
                () -> browser,
                htmlLoader,
                () -> webviewInitializer.recreateWebview("watchdog_recreate"),
                () -> disposed,
                () -> streamCoalescer.isStreamActive()
        );

        this.session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);

        this.chatWindowDelegate = new ChatWindowDelegate(createDelegateHost());
        chatWindowDelegate.loadPermissionModeFromSettings();
        chatWindowDelegate.loadNodePathFromSettings();
        chatWindowDelegate.syncActiveProvider();
        chatWindowDelegate.initializeHandlers();
        this.permissionServiceKey = chatWindowDelegate.setupPermissionService();
        this.sessionId = this.permissionServiceKey;

        this.sessionLifecycleManager = new SessionLifecycleManager(new SessionLifecycleManager.SessionHost() {
            @Override
            public Project getProject() {
                return project;
            }

            @Override
            public ClaudeSDKBridge getClaudeSDKBridge() {
                return claudeSDKBridge;
            }

            @Override
            public CodexSDKBridge getCodexSDKBridge() {
                return codexSDKBridge;
            }

            @Override
            public ClaudeSession getSession() {
                return session;
            }

            @Override
            public void setSession(ClaudeSession s) {
                session = s;
                persistTabSessionState();
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }

            @Override
            public StreamMessageCoalescer getStreamCoalescer() {
                return streamCoalescer;
            }

            @Override
            public void clearPendingPermissionRequests() {
                permissionHandler.clearPendingRequests();
            }

            @Override
            public void clearPermissionDecisionMemory() {
                try {
                    if (permissionServiceKey != null && !permissionServiceKey.isEmpty()) {
                        PermissionService permissionService = PermissionService.getInstance(project, permissionServiceKey);
                        permissionService.clearDecisionMemory();
                    }
                } catch (Exception e) {
                    LOG.warn("Failed to clear permission decision memory: " + e.getMessage());
                }
            }

            @Override
            public void callJavaScript(String fn, String... args) {
                ClaudeChatWindow.this.callJavaScript(fn, args);
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public void setupSessionCallbacks() {
                ClaudeChatWindow.this.setupSessionCallbacks();
            }

            @Override
            public void invalidateSessionCallbacks() {
                if (sessionCallbackAdapter != null) {
                    sessionCallbackAdapter.deactivate();
                }
            }

            @Override
            public void setSlashCommandsFetched(boolean fetched) {
                slashCommandsFetched = fetched;
            }

            @Override
            public void setFetchedSlashCommandsCount(int count) {
                fetchedSlashCommandsCount = count;
            }
        });

        this.editorContextTracker = new EditorContextTracker(project, new EditorContextTracker.ContextCallback() {
            @Override
            public void addSelectionInfo(String info) {
                callJavaScript("addSelectionInfo", info);
            }

            @Override
            public void clearSelectionInfo() {
                callJavaScript("clearSelectionInfo");
            }
        });
        editorContextTracker.registerListeners();

        this.webviewInitializer = new WebviewInitializer(createWebviewHost());

        setupSessionCallbacks();
        initializeSessionInfo();

        // Delay JCEF browser creation to avoid service initialization conflicts
        // during JBCefApp$Holder class init (ProxyMigrationService dependency).
        // Operations that depend on browser readiness are also deferred.
        ToolWindowManager.getInstance(this.project).invokeLater(() -> {
            if (!this.disposed) {
                this.webviewInitializer.createUIComponents();
                this.initialized = true;
                LOG.info("Window instance fully initialized, project: " + this.project.getName());
            }
        });

        if (!skipRegister) {
            registerInstance();
        }
        chatWindowDelegate.initializeStatusBar();
        SendShortcutSync.syncFromSettings();
    }

    // ==================== Public API ====================

    public void setParentContent(Content content) {
        if (this.parentContent != null && this.parentContent != content) {
            ClaudeSDKToolWindow.unregisterContentMapping(this.parentContent);
            LOG.debug("[MultiTab] Unregistered old Content -> ClaudeChatWindow mapping");
        }

        this.parentContent = content;
        if (content != null) {
            ClaudeSDKToolWindow.registerContentMapping(content, this);
            LOG.debug("[MultiTab] Registered Content -> ClaudeChatWindow mapping for: " + content.getDisplayName());

            if (this.originalTabName == null) {
                String displayName = content.getDisplayName();
                this.originalTabName = displayName.endsWith("...")
                        ? displayName.substring(0, displayName.length() - 3)
                        : displayName;
                LOG.debug("[TabLoading] Auto-initialized original tab name: " + this.originalTabName);
            }

            persistTabSessionState();
        }
    }

    public void setOriginalTabName(String name) {
        this.originalTabName = (name != null && name.endsWith("..."))
                ? name.substring(0, name.length() - 3)
                : name;
        LOG.debug("[TabLoading] Set original tab name: " + this.originalTabName);
    }

    public boolean isDisposed() {
        return disposed;
    }

    public boolean isInitialized() {
        return initialized;
    }

    public Content getParentContent() {
        return parentContent;
    }

    public JPanel getContent() {
        return mainPanel;
    }

    public ClaudeSDKBridge getClaudeSDKBridge() {
        return claudeSDKBridge;
    }

    public CodexSDKBridge getCodexSDKBridge() {
        return codexSDKBridge;
    }

    /**
     * Get the project associated with this chat window.
     *
     * @return the current project.
     */
    public Project getProject() {
        return this.project;
    }

    public String getSessionId() {
        return sessionId;
    }

    /**
     * Returns the provider this tab is currently using ("claude" or "codex").
     * Used by NodeProcessRegistry to label processes with the user-facing provider
     * rather than the underlying SDK type (a Claude daemon may still be alive
     * after the user switched the tab to Codex — the panel reflects the tab's
     * intent, not the lingering SDK).
     */
    public String getCurrentProvider() {
        HandlerContext ctx = this.handlerContext;
        return ctx != null ? ctx.getCurrentProvider() : "claude";
    }

    public ClaudeSession getSession() {
        return session;
    }

    public SessionLifecycleManager getSessionLifecycleManager() {
        return sessionLifecycleManager;
    }

    public void restorePersistedTabSessionState(TabStateService.TabSessionState savedState) {
        if (savedState == null || session == null) {
            return;
        }

        if (savedState.permissionMode != null && !savedState.permissionMode.trim().isEmpty()) {
            session.setPermissionMode(savedState.permissionMode);
        }
        if (savedState.provider != null && !savedState.provider.trim().isEmpty()) {
            session.setProvider(savedState.provider);
            // HandlerContext keeps its own currentProvider (read by
            // getCurrentProvider() and by handlers that don't go through the
            // session). Sync it here so the backend stays consistent until the
            // webview echoes its own provider selection — without this, the
            // very first message in a restored Codex tab still routes to the
            // Claude bridge until the frontend's localStorage hydration sends
            // set_provider, which itself can be wrong on multi-tab restarts
            // (issue #1353).
            if (handlerContext != null) {
                handlerContext.setCurrentProvider(savedState.provider);
            }
        }
        if (savedState.model != null && !savedState.model.trim().isEmpty()) {
            session.setModel(savedState.model);
        }
        if (savedState.reasoningEffort != null && !savedState.reasoningEffort.trim().isEmpty()) {
            session.setReasoningEffort(savedState.reasoningEffort);
        }

        String restoredSessionId = isNonEmpty(savedState.sessionId) ? savedState.sessionId : null;
        String restoredCwd = isNonEmpty(savedState.cwd) ? savedState.cwd : session.getCwd();
        session.setSessionInfo(restoredSessionId, restoredCwd);
        persistTabSessionState();

        LOG.info("[TabRestore] Restored tab session state: provider=" + savedState.provider
                + ", sessionId=" + savedState.sessionId + ", cwd=" + savedState.cwd + ")");
    }

    public void restorePersistedTabSessionState(TabStateService.TabSessionState savedState, boolean loadImmediately) {
        restorePersistedTabSessionState(savedState);
        if (TabSessionRestorePolicy.shouldLoadImmediately(savedState, loadImmediately)) {
            loadRestoredHistoryIfNeeded(savedState);
        }
    }

    public void loadRestoredHistoryIfNeeded() {
        if (session == null) {
            return;
        }

        TabStateService.TabSessionState currentState = new TabStateService.TabSessionState();
        currentState.sessionId = session.getSessionId();
        loadRestoredHistoryIfNeeded(currentState);
    }

    private void loadRestoredHistoryIfNeeded(TabStateService.TabSessionState savedState) {
        if (!TabSessionRestorePolicy.shouldLoadHistory(savedState) || session == null) {
            return;
        }
        if (!restoredHistoryLoadStarted.compareAndSet(false, true)) {
            return;
        }

        session.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
            if (!disposed) {
                callJavaScript("historyLoadComplete");
            }
        })).exceptionally(ex -> {
            LOG.warn("[TabRestore] Failed to load persisted tab history: " + ex.getMessage(), ex);
            ApplicationManager.getApplication().invokeLater(() -> {
                if (!disposed) {
                    callJavaScript("historyLoadComplete");
                    callJavaScript("addErrorMessage",
                            JsUtils.escapeJs("Failed to restore session history: " + ex.getMessage()));
                }
            });
            return null;
        });
    }

    public void addCodeSnippetFromExternal(String selectionInfo) {
        if (selectionInfo == null || selectionInfo.isEmpty()) {
            return;
        }
        // offer() returns the snippet to emit now, or null when it was deferred
        // until the frontend signals readiness (see flushPendingCodeSnippet).
        String toEmit = pendingCodeSnippetBuffer.offer(selectionInfo, frontendReady);
        if (toEmit != null) {
            addCodeSnippet(toEmit);
        }
    }

    private void flushPendingCodeSnippet() {
        String snippet = pendingCodeSnippetBuffer.takePending();
        if (snippet != null) {
            addCodeSnippet(snippet);
        }
    }

    public void updateTabStatus(ChatWindowDelegate.TabAnswerStatus status) {
        chatWindowDelegate.updateTabStatus(status);
    }

    @Deprecated
    public void updateTabLoadingState(boolean loading) {
        chatWindowDelegate.updateTabLoadingState(loading);
    }

    public void sendQuickFixMessage(String prompt, boolean isQuickFix, MessageCallback callback) {
        chatWindowDelegate.sendQuickFixMessage(prompt, isQuickFix, callback);
    }

    public void executeJavaScriptCode(String jsCode) {
        if (this.disposed || this.browser == null) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!this.disposed && this.browser != null) {
                this.browser.getCefBrowser().executeJavaScript(jsCode, this.browser.getCefBrowser().getURL(), 0);
            }
        });
    }

    // ==================== JavaScript Bridge ====================

    private static final java.util.regex.Pattern SAFE_JS_FUNCTION_NAME =
            java.util.regex.Pattern.compile("^[a-zA-Z_$][a-zA-Z0-9_$.]*$");

    void callJavaScript(String functionName, String... args) {
        if (disposed || browser == null) {
            LOG.warn("Cannot call JS function " + functionName + ": disposed=" + disposed + ", browser=" + (browser == null ? "null" : "exists"));
            return;
        }

        if (functionName == null || !SAFE_JS_FUNCTION_NAME.matcher(functionName).matches()) {
            LOG.error("Invalid JavaScript function name rejected: " + functionName);
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            if (disposed || browser == null) {
                return;
            }
            try {
                String callee = functionName;
                if (!functionName.contains(".")) {
                    callee = "window." + functionName;
                }

                StringBuilder argsJs = new StringBuilder();
                if (args != null) {
                    for (int i = 0; i < args.length; i++) {
                        if (i > 0) { argsJs.append(", "); }
                        String arg = args[i] == null ? "" : args[i];
                        argsJs.append("'").append(arg).append("'");
                    }
                }

                String checkAndCall =
                        "(function() {" +
                                "  try {" +
                                "    if (typeof " + callee + " === 'function') {" +
                                "      " + callee + "(" + argsJs + ");" +
                                "    }" +
                                "  } catch (e) {" +
                                "    console.error('[Backend->Frontend] Failed to call " + functionName + ":', e);" +
                                "  }" +
                                "})();";

                browser.getCefBrowser().executeJavaScript(checkAndCall, browser.getCefBrowser().getURL(), 0);
            } catch (Exception e) {
                LOG.warn("Failed to call JS function: " + functionName + ", error: " + e.getMessage(), e);
            }
        });
    }

    void handleJavaScriptMessage(String message) {
        if (message.startsWith("{\"type\":\"console.")) {
            try {
                JsonObject json = new Gson().fromJson(message, JsonObject.class);
                String logType = json.get("type").getAsString();
                JsonArray args = json.getAsJsonArray("args");

                StringBuilder logMessage = new StringBuilder("[Webview] ");
                for (int i = 0; i < args.size(); i++) {
                    if (i > 0) { logMessage.append(" "); }
                    logMessage.append(args.get(i).toString());
                }

                if ("console.error".equals(logType)) {
                    LOG.warn(logMessage.toString());
                } else if ("console.warn".equals(logType)) {
                    LOG.info(logMessage.toString());
                } else {
                    LOG.debug(logMessage.toString());
                }
            } catch (Exception e) {
                LOG.warn("Failed to parse console log: " + e.getMessage());
            }
            return;
        }

        String[] parts = message.split(":", 2);
        if (parts.length < 1) {
            LOG.error("Invalid message format");
            return;
        }

        String type = parts[0];
        String content = parts.length > 1 ? parts[1] : "";

        if (messageDispatcher.dispatch(type, content)) {
            return;
        }

        LOG.warn("Unknown message type: " + type);
    }

    // ==================== Session Delegates ====================

    private void setupSessionCallbacks() {
        // Re-sync the exposed sessionId with the freshly bound session so a stale
        // AI session ID from a previous session is not exposed via getSessionId().
        // Falling back to permissionServiceKey (never null after construction)
        // keeps the exposed ID stable for consumers like DetachTabAction, which
        // skips DetachedWindowManager registration on a null ID.
        this.sessionId = resolveExposedSessionId(session.getSessionId(), this.permissionServiceKey);

        if (this.sessionCallbackAdapter != null) {
            this.sessionCallbackAdapter.deactivate();
        }
        this.sessionCallbackAdapter = new SessionCallbackAdapter(
                streamCoalescer,
                new SessionCallbackAdapter.JsTarget() {
                    @Override
                    public void callJavaScript(String functionName, String... args) {
                        ClaudeChatWindow.this.callJavaScript(functionName, args);
                    }
                },
                permissionHandler,
                () -> slashCommandsFetched,
                this::onStreamEnded
        ) {
            @Override
            public void onSessionIdReceived(String newSessionId) {
                super.onSessionIdReceived(newSessionId);
                sessionId = newSessionId;
                persistTabSessionState();
            }
        };
        session.setCallback(sessionCallbackAdapter);

        // Wire daemon events directly to frontend (bypasses adapter lifecycle).
        // Calling through sessionCallbackAdapter would silently drop the event
        // if setupSessionCallbacks() is invoked again before the title arrives
        // (adapter.deactivate() → isInactive() → event discarded).
        // Register only once per ClaudeChatWindow; subsequent setupSessionCallbacks()
        // calls reuse the existing listener so the bridge keeps a single registration
        // per window. The listener is removed in dispose().
        if (this.titleEventListener == null) {
            this.titleEventListener = (event, data) -> {
                if ("title_generated".equals(event)) {
                    String genSessionId = data.has("sessionId") ? data.get("sessionId").getAsString() : null;
                    String title = data.has("title") ? data.get("title").getAsString() : null;
                    if (genSessionId != null && title != null) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            if (!disposed) {
                                callJavaScript("updateSessionTitle",
                                        JsUtils.escapeJs(genSessionId), JsUtils.escapeJs(title));
                            }
                        });
                    }
                } else if ("session_updated".equals(event)) {
                    // Handle inter-turn session updates (background task completion)
                    String updatedSessionId = data.has("sessionId") ? data.get("sessionId").getAsString() : null;
                    if (updatedSessionId == null) {
                        LOG.warn("[ClaudeChatWindow] session_updated event missing sessionId");
                        return;
                    }

                    // Compare with current active session
                    String currentSessionId = session != null ? session.getSessionId() : null;
                    if (currentSessionId == null || !currentSessionId.equals(updatedSessionId)) {
                        // Event is for a different session, ignore
                        return;
                    }

                    // Check if session has active turn in progress; skip reload if true
                    if (sessionCallbackAdapter != null && streamCoalescer != null && streamCoalescer.isStreamActive()) {
                        LOG.info("[ClaudeChatWindow] session_updated event received during active turn, skipping reload");
                        return;
                    }

                    LOG.info("[ClaudeChatWindow] session_updated for sessionId=" + updatedSessionId + ", reloading from server");

                    // Reuse the canonical reload path (same as history-load / rewind):
                    // loadFromServer() reads the session via the bridge, converts each
                    // record with MessageParser.parseServerMessage(), and pushes a full
                    // refresh through the callback facade. Coalesced so overlapping
                    // background-task completions never reload concurrently.
                    //
                    // Pass updatedSessionId as the reload target: the session field can
                    // be reassigned on the EDT (new-session / restart flows) between the
                    // currentSessionId check above and the reload actually running.
                    // driveSessionReload() re-validates the id at entry and after
                    // loadFromServer() returns, so a reload never lands on a session
                    // that the user has navigated away from.
                    requestSessionReload(updatedSessionId);
                }
            };
            this.claudeSDKBridge.addDaemonEventListener(this.titleEventListener);
        }

        persistTabSessionState();
    }

    /**
     * Request a reload of the current session from the server, coalescing
     * concurrent requests. Multiple session_updated events (e.g. several
     * background tasks finishing at once) must not run loadFromServer()
     * concurrently — SessionState's message list is not thread-safe and the
     * reload runs on a background thread. At most one reload is in flight;
     * requests arriving during a reload collapse into a single follow-up reload
     * that reflects the latest JSONL.
     *
     * @param targetSessionId the session id this reload is bound to. Carried
     *     through the whole coalesced chain and re-validated at every step so a
     *     reload never runs against a session the user has navigated away from
     *     (the session field is reassigned on the EDT by new-session / restart).
     */
    private void requestSessionReload(String targetSessionId) {
        synchronized (sessionReloadLock) {
            if (sessionReloadInFlight) {
                sessionReloadPending = true;
                return;
            }
            sessionReloadInFlight = true;
        }
        driveSessionReload(targetSessionId);
    }

    private void driveSessionReload(String targetSessionId) {
        // Re-validate at entry: the session may have been replaced on the EDT
        // between the listener's sessionId check and this call.
        if (disposed || !isSessionActive(targetSessionId)) {
            synchronized (sessionReloadLock) {
                sessionReloadInFlight = false;
                sessionReloadPending = false;
            }
            return;
        }
        // A narrow window remains: the EDT can reassign `session` between the
        // isSessionActive() check above and the `current = session` read below,
        // so `current` may be a session the user has navigated away from. This is
        // safe by design: loadFromServer() pushes its result through `current`'s
        // own callbackFacade → SessionCallbackAdapter, and that adapter is
        // deactivated by setupSessionCallbacks() when the new session is bound
        // (volatile `active` flag, checked in every on* callback). So a stale
        // reload's onMessageUpdate/onStateChange are silently dropped, and the
        // isSessionActive() check in the continuation additionally blocks any
        // follow-up reload. Two independent guards; neither alone is sufficient.
        ClaudeSession current = session;
        current.loadFromServer().whenComplete((v, ex) -> {
            if (ex != null) {
                LOG.warn("[ClaudeChatWindow] session reload failed", ex);
            }
            boolean runAgain;
            synchronized (sessionReloadLock) {
                runAgain = decideReloadCompletion(
                        sessionReloadPending, disposed, isSessionActive(targetSessionId));
                // Always clear sessionReloadPending: on the runAgain path the
                // pending request is consumed; on the finish path any stale flag
                // (possibly bound to a session the user navigated away from) must
                // be dropped so the next same-session reload does not inherit it.
                sessionReloadPending = false;
                if (!runAgain) {
                    sessionReloadInFlight = false;
                }
            }
            if (runAgain) {
                driveSessionReload(targetSessionId);
            }
        });
    }

    /**
     * Pure decision function for what to do when an in-flight
     * {@code loadFromServer()} reload completes. Extracted so the coalescing
     * state machine is unit-testable without constructing a full
     * ClaudeChatWindow (which needs a Project, JBCefBrowser, etc.).
     *
     * <p>Returns {@code true} (run another reload) only when ALL of:
     * <ul>
     *   <li>a follow-up is pending ({@code sessionReloadPending}), AND</li>
     *   <li>the window is still alive ({@code !disposed}), AND</li>
     *   <li>the session the reload was started for is still active
     *       ({@code sessionMatches}). If the user navigated to a different
     *       session, the pending flag belongs to the old session and must not
     *       trigger a reload against the new one — the new session drives its
     *       own lifecycle.</li>
     * </ul>
     *
     * <p>Either way the caller clears {@code sessionReloadPending}; this
     * function only decides whether to re-run.
     *
     * @param pending        current value of {@code sessionReloadPending}
     * @param disposed       whether the window has been disposed
     * @param sessionMatches whether {@code session} still identifies the
     *                       session this reload was bound to
     * @return {@code true} to collapse the pending request into another reload;
     *         {@code false} to finish (the in-flight flag is cleared by the
     *         caller)
     */
    static boolean decideReloadCompletion(
            boolean pending, boolean disposed, boolean sessionMatches) {
        return pending && !disposed && sessionMatches;
    }

    /**
     * Returns true iff the window currently holds the session identified by
     * {@code sessionId} (i.e. it has not been replaced by a new-session /
     * restart flow on the EDT). The session field is volatile, so this read is
     * safe from the daemon-reader and loadFromServer() continuation threads.
     */
    private boolean isSessionActive(String sessionId) {
        ClaudeSession current = session;
        if (current == null || sessionId == null) {
            return false;
        }
        String currentId = current.getSessionId();
        return sessionId.equals(currentId);
    }

    private void onStreamEnded() {
        if (session == null) {
            return;
        }
        if ("claude".equals(session.getProvider()) && session.getError() == null) {
            com.github.claudecodegui.notifications.ClaudeNotifier.showSuccess(
                project,
                com.github.claudecodegui.notifications.ClaudeNotifier.buildTitleFromSession(session),
                com.github.claudecodegui.notifications.ClaudeNotifier.buildPreviewFromSession(session, "Task completed"));
        }
    }

    private void initializeSessionInfo() {
        String workingDirectory = sessionLifecycleManager.determineWorkingDirectory();
        session.setSessionInfo(null, workingDirectory);
        persistTabSessionState();
        LOG.info("Initialized with working directory: " + workingDirectory);
    }

    private void registerInstance() {
        ClaudeSDKToolWindow.registerWindow(project, this);
    }

    private void interruptDueToPermissionDenial() {
        this.session.interrupt().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onPermissionDenied");
            callJavaScript("onStreamEnd");
            callJavaScript("showLoading", "false");
            com.github.claudecodegui.notifications.ClaudeNotifier.clearStatus(project);
        }));
    }

    private int getTabIndex() {
        Content content = this.parentContent;
        if (content == null) {
            return -1;
        }
        ContentManager contentManager = content.getManager();
        if (contentManager == null) {
            return -1;
        }
        return contentManager.getIndexOfContent(content);
    }

    private void persistTabSessionState() {
        if (project == null || project.isDisposed() || session == null) {
            return;
        }

        int tabIndex = getTabIndex();
        if (tabIndex < 0) {
            return;
        }

        TabStateService.TabSessionState snapshot = new TabStateService.TabSessionState();
        snapshot.provider = session.getProvider();
        snapshot.sessionId = session.getSessionId();
        snapshot.cwd = session.getCwd();
        snapshot.model = session.getModel();
        snapshot.permissionMode = session.getPermissionMode();
        snapshot.reasoningEffort = session.getReasoningEffort();

        TabStateService.getInstance(project).saveTabSessionState(tabIndex, snapshot);
    }

    private boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }

    /**
     * Decide what {@link #getSessionId()} exposes after session callbacks are
     * (re-)bound: the bound session's own ID when it has one (history load),
     * otherwise the stable permission-service key (fresh session) — never a
     * stale ID left over from a previously bound session.
     */
    static String resolveExposedSessionId(String boundSessionId, String permissionServiceKey) {
        return boundSessionId != null && !boundSessionId.trim().isEmpty()
                ? boundSessionId
                : permissionServiceKey;
    }

    // ==================== Code Snippets ====================

    private void addCodeSnippet(String selectionInfo) {
        if (selectionInfo != null && !selectionInfo.isEmpty()) {
            // Ensure the browser has focus so the frontend can focus the input field
            if (browser != null) {
                browser.getComponent().requestFocus();
            }
            callJavaScript("addCodeSnippet", JsUtils.escapeJs(selectionInfo));
        }
    }

    /**
     * Focus the chat input field in the frontend.
     * Called when Ctrl+Alt+K activates the panel without a selection.
     */
    public void focusInputPane() {
        if (disposed || browser == null) {
            return;
        }
        browser.getComponent().requestFocus();
        executeJavaScriptCode("window.focusChatInput?.()");
    }

    // ==================== Dispose ====================

    public synchronized void dispose() {
        if (this.disposed) { return; }
        this.disposed = true;

        chatWindowDelegate.dispose();
        editorContextTracker.dispose();
        streamCoalescer.dispose();
        if (sessionCallbackAdapter != null) {
            sessionCallbackAdapter.dispose();
        }
        if (titleEventListener != null && claudeSDKBridge != null) {
            try {
                claudeSDKBridge.removeDaemonEventListener(titleEventListener);
            } catch (Exception e) {
                LOG.warn("Failed to remove daemon event listener: " + e.getMessage());
            }
            titleEventListener = null;
        }
        webviewWatchdog.stop();

        try {
            if (this.permissionServiceKey != null && !this.permissionServiceKey.isEmpty()) {
                PermissionService permissionService = PermissionService.getInstance(project, this.permissionServiceKey);
                permissionService.unregisterDialogShower(project);
                permissionService.unregisterAskUserQuestionDialogShower(project);
                permissionService.unregisterPlanApprovalDialogShower(project);
                PermissionService.removeInstance(this.permissionServiceKey);
                LOG.info("Removed PermissionService instance for key: " + this.permissionServiceKey);
            }
        } catch (Exception e) {
            LOG.warn("Failed to unregister dialog showers or remove session instance: " + e.getMessage());
        }

        LOG.info("Starting window resource cleanup, project: " + project.getName());

        handlerContext.setDisposed(true);

        if (parentContent != null) {
            ClaudeSDKToolWindow.unregisterContentMapping(parentContent);
            LOG.debug("[MultiTab] Removed Content -> ClaudeChatWindow mapping during dispose");
        }

        ClaudeSDKToolWindow.unregisterWindow(project, this);

        try {
            if (session != null) { session.interrupt(); }
        } catch (Exception e) {
            LOG.warn("Failed to clean up session: " + e.getMessage());
        }

        try {
            if (claudeSDKBridge != null) {
                int activeCount = claudeSDKBridge.getActiveProcessCount();
                if (activeCount > 0) {
                    LOG.info("Cleaning up " + activeCount + " active Claude process(es)...");
                }
                claudeSDKBridge.cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.warn("Failed to clean up Claude processes: " + e.getMessage());
        }

        try {
            if (codexSDKBridge != null) {
                int activeCount = codexSDKBridge.getActiveProcessCount();
                if (activeCount > 0) {
                    LOG.info("Cleaning up " + activeCount + " active Codex process(es)...");
                }
                codexSDKBridge.cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.warn("Failed to clean up Codex processes: " + e.getMessage());
        }

        try {
            if (browser != null) {
                browser.dispose();
                browser = null;
            }
        } catch (Exception e) {
            LOG.warn("Failed to clean up browser: " + e.getMessage());
        }

        if (messageDispatcher != null) {
            messageDispatcher.clear();
        }

        LOG.info("Window resources fully cleaned up, project: " + project.getName());
    }

    // ==================== Host Interface Factories ====================

    private WebviewInitializer.WebviewHost createWebviewHost() {
        return new WebviewInitializer.WebviewHost() {
            @Override
            public Project getProject() {
                return project;
            }

            @Override
            public ClaudeSDKBridge getClaudeSDKBridge() {
                return claudeSDKBridge;
            }

            @Override
            public CodexSDKBridge getCodexSDKBridge() {
                return codexSDKBridge;
            }

            @Override
            public JPanel getMainPanel() {
                return mainPanel;
            }

            @Override
            public HtmlLoader getHtmlLoader() {
                return htmlLoader;
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public void setBrowser(JBCefBrowser b) {
                browser = b;
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public void handleJavaScriptMessage(String msg) {
                ClaudeChatWindow.this.handleJavaScriptMessage(msg);
            }

            @Override
            public WebviewWatchdog getWebviewWatchdog() {
                return webviewWatchdog;
            }

            @Override
            public void setFrontendReady(boolean ready) {
                frontendReady = ready;
                if (ready) {
                    flushPendingCodeSnippet();
                }
            }
        };
    }

    private ChatWindowDelegate.DelegateHost createDelegateHost() {
        return new ChatWindowDelegate.DelegateHost() {
            @Override
            public Project getProject() {
                return project;
            }

            @Override
            public ClaudeSDKBridge getClaudeSDKBridge() {
                return claudeSDKBridge;
            }

            @Override
            public CodexSDKBridge getCodexSDKBridge() {
                return codexSDKBridge;
            }

            @Override
            public ClaudeSession getSession() {
                return session;
            }

            @Override
            public CodemossSettingsService getSettingsService() {
                return settingsService;
            }

            @Override
            public JPanel getMainPanel() {
                return mainPanel;
            }

            @Override
            public JBCefBrowser getBrowser() {
                return browser;
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public Content getParentContent() {
                return parentContent;
            }

            @Override
            public String getOriginalTabName() {
                return originalTabName;
            }

            @Override
            public void setOriginalTabName(String name) {
                ClaudeChatWindow.this.setOriginalTabName(name);
            }

            @Override
            public String getSessionId() {
                return sessionId;
            }

            @Override
            public HandlerContext getHandlerContext() {
                return handlerContext;
            }

            @Override
            public void setHandlerContext(HandlerContext ctx) {
                handlerContext = ctx;
            }

            @Override
            public void setMessageDispatcher(MessageDispatcher d) {
                messageDispatcher = d;
            }

            @Override
            public void setPermissionHandler(PermissionHandler h) {
                permissionHandler = h;
            }

            @Override
            public void setHistoryHandler(HistoryHandler h) {
                historyHandler = h;
            }

            @Override
            public SessionLifecycleManager getSessionLifecycleManager() {
                return sessionLifecycleManager;
            }

            @Override
            public StreamMessageCoalescer getStreamCoalescer() {
                return streamCoalescer;
            }

            @Override
            public WebviewWatchdog getWebviewWatchdog() {
                return webviewWatchdog;
            }

            @Override
            public PermissionHandler getPermissionHandler() {
                return permissionHandler;
            }

            @Override
            public void callJavaScript(String fn, String... args) {
                ClaudeChatWindow.this.callJavaScript(fn, args);
            }

            @Override
            public void interruptDueToPermissionDenial() {
                ClaudeChatWindow.this.interruptDueToPermissionDenial();
            }

            @Override
            public boolean isFrontendReady() {
                return frontendReady;
            }

            @Override
            public void setFrontendReady(boolean ready) {
                frontendReady = ready;
                if (ready) {
                    flushPendingCodeSnippet();
                }
            }

            @Override
            public void setSlashCommandsFetched(boolean fetched) {
                slashCommandsFetched = fetched;
            }

            @Override
            public void setFetchedSlashCommandsCount(int count) {
                fetchedSlashCommandsCount = count;
            }

            @Override
            public void persistTabSessionState() {
                ClaudeChatWindow.this.persistTabSessionState();
            }
        };
    }
}
