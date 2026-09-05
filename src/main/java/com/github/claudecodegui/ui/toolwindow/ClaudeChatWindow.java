package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.action.SendShortcutSync;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.history.HistoryHandler;
import com.github.claudecodegui.handler.core.MessageDispatcher;
import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.dsh.DshCliBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.github.claudecodegui.provider.kimi.KimiCliBridge;
import com.github.claudecodegui.provider.minimax.MiniMaxCliBridge;
import com.github.claudecodegui.provider.opencode.OpenCodeCliBridge;
import com.github.claudecodegui.provider.pi.PiCliBridge;
import com.github.claudecodegui.provider.omp.OmpCliBridge;
import com.github.claudecodegui.provider.codebuddy.CodeBuddySDKBridge;
import com.github.claudecodegui.session.SessionProviderRouter;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionCallbackAdapter;
import com.github.claudecodegui.session.SessionLifecycleManager;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.session.StreamMessageCoalescer;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.ui.ChatWindowDelegate;
import com.github.claudecodegui.ui.EditorContextTracker;
import com.github.claudecodegui.ui.SurfaceFrameFence;
import com.github.claudecodegui.ui.WebviewInitializer;
import com.github.claudecodegui.ui.WebviewWatchdog;
import com.github.claudecodegui.ui.detached.DetachedChatFrame;
import com.github.claudecodegui.ui.detached.DetachedWindowManager;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.ThemeConfigService;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.Alarm;
import org.cef.browser.CefBrowser;

import javax.swing.*;
import java.awt.*;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.awt.event.HierarchyEvent;
import java.awt.event.HierarchyListener;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/**
 * Chat window instance. Coordinates UI components, session management,
 * and message dispatching. One instance per tab.
 */
public class ClaudeChatWindow {

    private static final Logger LOG = Logger.getInstance(ClaudeChatWindow.class);
    private final JPanel mainPanel;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final GrokSDKBridge grokSDKBridge;
    private final Map<String, MarkerCliBridge> cliBridges;
    private final KimiCliBridge kimiCliBridge;
    private final OpenCodeCliBridge openCodeCliBridge;
    private final PiCliBridge piCliBridge;
    private final OmpCliBridge ompCliBridge;
    private final MiniMaxCliBridge miniMaxCliBridge;
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

    private volatile JBCefBrowser browser;
    // volatile: read from the daemon reader thread by the session_updated listener
    // and its loadFromServer continuation, while reassigned on the EDT.
    private volatile ClaudeSession session;
    private final WebviewWatchdog webviewWatchdog;
    private final StreamMessageCoalescer streamCoalescer;
    private final WebviewEventQueue<JBCefBrowser> webviewEventQueue;

    private volatile boolean disposed = false;
    private volatile boolean initialized = false;
    private volatile boolean frontendReady = false;
    private final FrontendReadyTransitionTracker frontendReadyTransitions =
            new FrontendReadyTransitionTracker();
    private final SurfaceRefreshCoordinator surfaceRefreshCoordinator =
            new SurfaceRefreshCoordinator();
    private final SurfacePresentationCoordinator surfacePresentationCoordinator =
            new SurfacePresentationCoordinator();
    private static final int OSR_FRAME_FENCE_TIMEOUT_MS = 1000;
    private final SurfaceFrameFence surfaceFrameFence;
    private final Disposable surfaceRefreshAlarmDisposable =
            Disposer.newDisposable("ccgui-osr-frame-fence-timeout");
    private final Alarm surfaceRefreshAlarm =
            new Alarm(Alarm.ThreadToUse.SWING_THREAD, surfaceRefreshAlarmDisposable);
    private final SurfaceAttemptTimeoutOwner surfaceAttemptTimeoutOwner =
            new SurfaceAttemptTimeoutOwner();
    private final Map<SurfaceFrameFence.Attempt, SurfaceFrameFence.Attempt>
            surfaceDamageReplacementSources = new ConcurrentHashMap<>();
    private volatile int activePageGeneration;
    private final HierarchyListener surfaceRefreshHierarchyListener = this::handleSurfaceRefreshHierarchyChange;
    private final ComponentAdapter surfaceRefreshComponentListener = new ComponentAdapter() {
        @Override
        public void componentShown(ComponentEvent event) {
            resumePendingSurfaceWork("component_shown");
        }

        @Override
        public void componentResized(ComponentEvent event) {
            resumePendingSurfaceWork("component_resized");
        }
    };
    private final WindowAdapter surfaceRefreshWindowListener = new WindowAdapter() {
        @Override
        public void windowActivated(WindowEvent event) {
            resumePendingSurfaceWork("window_activated");
        }

        @Override
        public void windowDeiconified(WindowEvent event) {
            resumePendingSurfaceWork("window_deiconified");
        }
    };
    private Component observedBrowserComponent;
    private Component observedNativeSurfaceComponent;
    private Window observedSurfaceWindow;
    private volatile boolean hasEverBeenFrontendReady = false;
    private final PendingCodeSnippetBuffer pendingCodeSnippetBuffer = new PendingCodeSnippetBuffer();
    private final PendingFileReferencesBuffer pendingFileReferencesBuffer =
            new PendingFileReferencesBuffer();
    private volatile boolean slashCommandsFetched = false;
    private final AtomicBoolean restoredHistoryLoadStarted = new AtomicBoolean(false);

    // Shared serializer for structured bridges (Gson instances are thread-safe).
    private static final Gson GSON = new Gson();

    // Daemon event listener for AI title forwarding. Held so it can be removed on dispose.
    private DaemonBridge.DaemonEventListener titleEventListener;
    private volatile int fetchedSlashCommandsCount = 0;

    // Theme-change callback handle for updating Swing component backgrounds (mainPanel, browser).
    // Separate from the SettingsHandler's JS-notification callback: this one ensures the Java-side
    // Swing containers repaint with the new theme color, not just the webview's CSS.
    private ThemeConfigService.RegisteredCallback swingThemeCallbackHandle;

    // Coalesces session_updated reloads. SessionState's message list is not
    // thread-safe and loadFromServer() runs async, so concurrent background-task
    // completions must not reload at the same time. Guarded by sessionReloadLock.
    private final Object sessionReloadLock = new Object();
    private boolean sessionReloadInFlight = false;
    private boolean sessionReloadPending = false;
    // A session_updated reload that arrived while a turn was streaming is parked
    // here and drained at stream end (onStreamEnded). See {@link DeferredReload}.
    private final DeferredReload deferredReload = new DeferredReload();
    // Backstop for the parked reload. onStreamEnded is the fast drain path, but it
    // is edge-triggered: a defer that lands just after the stream-end edge (a
    // cross-thread check-then-act between the daemon reader's isStreamActive() read
    // and the stream reader's streamActive=false + drain), or the LAST background
    // answer of a fan-out with no following stream end, would otherwise never be
    // drained — the answer stays invisible forever. This alarm re-checks after a
    // short delay and drains the parked reload the moment the stream is idle,
    // without ever reloading mid-stream. Pooled thread: draining kicks off an async
    // loadFromServer() that reads JSONL, so it must not run on the EDT.
    private static final int DEFERRED_RELOAD_SAFETY_DRAIN_MS = 500;
    private final Disposable safetyAlarmDisposable =
            Disposer.newDisposable("ccgui-deferred-reload-safety");
    private final Alarm deferredReloadSafetyAlarm =
            new Alarm(Alarm.ThreadToUse.POOLED_THREAD, safetyAlarmDisposable);

    private HandlerContext handlerContext;
    // volatile: assigned once on the EDT during init, then read lock-free from the JCEF UI thread
    // in handleJavaScriptMessage. The read can no longer piggyback on the host monitor's visibility
    // now that handleJavaScriptMessage is unsynchronized, so the field carries its own happens-before.
    private volatile MessageDispatcher messageDispatcher;
    /**
     * Serializes webview message dispatch against {@link #dispose()}; see
     * {@link MessageDispatchGate} for the lifecycle contract.
     */
    private final MessageDispatchGate dispatchGate = new MessageDispatchGate();
    private PermissionHandler permissionHandler;
    private HistoryHandler historyHandler;
    private final SessionLifecycleManager sessionLifecycleManager;

    // Delegates
    private WebviewInitializer webviewInitializer;
    private final EditorContextTracker editorContextTracker;
    private final ChatWindowDelegate chatWindowDelegate;
    // volatile: read from the daemon reader thread by the task_event listener
    // (titleEventListener), while reassigned on the EDT in setupSessionCallbacks.
    // Without volatile a session switch could publish a new adapter on the EDT
    // that the daemon thread never observes, so a late task_notification would
    // route to the deactivated adapter and be dropped - leaving the subagent
    // stuck on "running".
    private volatile SessionCallbackAdapter sessionCallbackAdapter;

    public ClaudeChatWindow(Project project) {
        this(project, false);
    }

    public ClaudeChatWindow(Project project, boolean skipRegister) {
        this.project = project;
        this.claudeSDKBridge = new ClaudeSDKBridge();
        this.codexSDKBridge = new CodexSDKBridge();
        this.grokSDKBridge = new GrokSDKBridge();
        this.kimiCliBridge = new KimiCliBridge();
        this.openCodeCliBridge = new OpenCodeCliBridge();
        this.piCliBridge = new PiCliBridge();
        this.ompCliBridge = new OmpCliBridge();
        this.miniMaxCliBridge = new MiniMaxCliBridge();
        // Grok uses GrokSDKBridge (persistent ACP / grok agent stdio), not MarkerCliBridge.
        this.cliBridges = SessionProviderRouter.registerCliBridges(
                this.kimiCliBridge, this.openCodeCliBridge, this.piCliBridge,
                this.ompCliBridge, new DshCliBridge(), this.miniMaxCliBridge, new CodeBuddySDKBridge());
        this.settingsService = new CodemossSettingsService();
        this.htmlLoader = new HtmlLoader(getClass());
        this.mainPanel = new JPanel(new BorderLayout());
        this.surfaceFrameFence = new SurfaceFrameFence(new SurfaceFrameFence.Listener() {
            @Override
            public void onFirstFrameDrained(SurfaceFrameFence.Attempt attempt) {
                handleFirstOsrFrameDrained(attempt);
            }

            @Override
            public void onFinalFrameForwarded(SurfaceFrameFence.Attempt attempt) {
                handleFinalOsrFrameForwarded(attempt);
            }
        });

        this.mainPanel.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());
        this.mainPanel.addHierarchyListener(surfaceRefreshHierarchyListener);

        this.webviewEventQueue = new WebviewEventQueue<JBCefBrowser>(
                () -> this.browser,
                () -> this.disposed,
                this::executeQueuedWebviewScript
        );
        this.streamCoalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                ClaudeChatWindow.this.callJavaScript(functionName, args);
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
                () -> webviewInitializer.reloadWebview("watchdog_reload"),
                () -> webviewInitializer.recreateWebview("watchdog_recreate"),
                () -> disposed,
                () -> streamCoalescer.isStreamActive(),
                () -> frontendReady
        );

        this.session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge, cliBridges, grokSDKBridge);

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
            public GrokSDKBridge getGrokSDKBridge() {
                return grokSDKBridge;
            }

            @Override
            public Map<String, MarkerCliBridge> getCliBridges() {
                return cliBridges;
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

        // Register a Swing-level theme change callback to update the background color of
        // mainPanel and the browser component when the IDE theme changes. This ensures
        // Java-side containers repaint with the correct color, complementing the webview's
        // CSS theme update (handled by SettingsHandler). Fixes issue #1586.
        swingThemeCallbackHandle = ThemeConfigService.registerThemeChangeListener(themeConfig -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (disposed) {
                    return;
                }
                Color bgColor = ThemeConfigService.getBackgroundColor();
                mainPanel.setBackground(bgColor);
                JBCefBrowser currentBrowser = browser;
                if (currentBrowser != null) {
                    try {
                        java.awt.Component browserComp = currentBrowser.getComponent();
                        if (browserComp != null) {
                            browserComp.setBackground(bgColor);
                        }
                    } catch (Exception | LinkageError e) {
                        LOG.debug("Failed to update browser component background on theme change: " + e.getMessage());
                    }
                }
                mainPanel.repaint();
            });
        }, true);

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

    private boolean isActiveContent() {
        Content content = parentContent;
        ContentManager contentManager = content == null ? null : content.getManager();
        if (contentManager != null && contentManager.getIndexOfContent(content) >= 0) {
            return contentManager.getSelectedContent() == content;
        }
        DetachedChatFrame detachedFrame = DetachedWindowManager.getDetachedFrame(project, this);
        return detachedFrame == null || detachedFrame.isActive();
    }

    private void activateContent() {
        Runnable activation = () -> {
            if (disposed) {
                return;
            }
            Content content = parentContent;
            ContentManager contentManager = content == null ? null : content.getManager();
            if (contentManager != null && contentManager.getIndexOfContent(content) >= 0) {
                contentManager.setSelectedContent(content);
                ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                        .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
                if (toolWindow != null
                        && toolWindow.getContentManager() == contentManager
                        && !toolWindow.isActive()) {
                    toolWindow.activate(null);
                }
                return;
            }
            DetachedChatFrame detachedFrame = DetachedWindowManager.getDetachedFrame(project, this);
            if (detachedFrame != null) {
                detachedFrame.setVisible(true);
                detachedFrame.toFront();
                detachedFrame.requestFocus();
            }
        };
        if (SwingUtilities.isEventDispatchThread()) {
            activation.run();
        } else {
            ApplicationManager.getApplication().invokeLater(activation);
        }
    }

    public JPanel getContent() {
        return mainPanel;
    }

    /**
     * Restore the native JCEF surface after this content tab becomes active again.
     * Reloading is intentionally avoided so the tab keeps its in-memory React state.
     */
    public void onTabActivated() {
        Runnable repaint = () -> {
            if (disposed || !isSelectedContent()) {
                return;
            }
            webviewWatchdog.markTabActivated();
            webviewInitializer.onTabActivated();
            JBCefBrowser currentBrowser = browser;
            TabActivationSurfaceAction action = decideTabActivationSurfaceAction(
                    currentBrowser != null,
                    currentBrowser != null && currentBrowser.isOffScreenRendering(),
                    hasCurrentUnpublishedPublication());
            switch (action) {
                case PUBLISH_PENDING:
                    tryConsumePendingSurfaceRefresh("tab_activated");
                    break;
                case PRESENT_CACHED:
                    requestCachedSurfacePresentation(currentBrowser);
                    tryConsumeCachedSurfacePresentation("tab_activated");
                    break;
                case WINDOWED_REFRESH:
                    // Windowed JCEF keeps the established activation repaint path. It does not
                    // participate in the OSR publication fence or its sentinel pulse.
                    requestCurrentWindowedSurfaceRefresh("tab_activated");
                    callJavaScript("window.onTabActivated");
                    break;
                default:
                    break;
            }
        };

        // selectionChanged runs before ContentManager fully remaps the heavyweight
        // JCEF child. Waiting one EDT turn is essential for empty tabs because they
        // have no later DOM update that would incidentally repaint the native surface.
        ApplicationManager.getApplication().invokeLater(repaint);
    }

    /** Selects publication, cached presentation, or the legacy windowed activation path. */
    static TabActivationSurfaceAction decideTabActivationSurfaceAction(
            boolean browserAvailable,
            boolean offScreenRendering,
            boolean publicationOutstanding
    ) {
        if (!browserAvailable) {
            return TabActivationSurfaceAction.NONE;
        }
        if (!offScreenRendering) {
            return TabActivationSurfaceAction.WINDOWED_REFRESH;
        }
        return publicationOutstanding
                ? TabActivationSurfaceAction.PUBLISH_PENDING
                : TabActivationSurfaceAction.PRESENT_CACHED;
    }

    private boolean refreshCurrentWebviewSurface(JBCefBrowser expectedBrowser) {
        if (expectedBrowser == null || browser != expectedBrowser) {
            return false;
        }

        try {
            return refreshActivatedWebview(
                    mainPanel,
                    expectedBrowser.getComponent(),
                    expectedBrowser.getCefBrowser(),
                    expectedBrowser.isOffScreenRendering(),
                    () -> { }
            );
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to refresh active JCEF tab: " + e.getMessage(), e);
            return false;
        } finally {
            if (!disposed && browser == expectedBrowser) {
                rebindNativeSurfaceComponent(getNativeSurfaceComponent(expectedBrowser));
            }
        }
    }

    private void requestSurfaceRefresh(
            JBCefBrowser expectedBrowser,
            long readyEpoch,
            long contentRevision,
            String reason
    ) {
        if (expectedBrowser == null) {
            return;
        }
        if (expectedBrowser.isOffScreenRendering()) {
            surfaceFrameFence.request(
                    expectedBrowser,
                    expectedBrowser.getCefBrowser(),
                    activePageGeneration,
                    readyEpoch,
                    contentRevision,
                    reason);
        } else {
            surfaceRefreshCoordinator.request(expectedBrowser, readyEpoch, reason);
        }
    }

    private void requestCurrentWindowedSurfaceRefresh(String reason) {
        JBCefBrowser currentBrowser = browser;
        if (disposed || !frontendReady || currentBrowser == null
                || currentBrowser.isOffScreenRendering()) {
            return;
        }
        requestSurfaceRefresh(
                currentBrowser, frontendReadyTransitions.currentEpoch(), 0L, reason);
        tryConsumePendingSurfaceRefresh(reason);
    }

    private void tryConsumePendingSurfaceRefresh(String trigger) {
        tryConsumePendingSurfaceRefresh(trigger, null);
    }

    private boolean tryConsumePendingSurfaceRefresh(
            String trigger,
            SurfaceFrameFence.Attempt replacementSource
    ) {
        if (!SwingUtilities.isEventDispatchThread()) {
            ApplicationManager.getApplication().invokeLater(
                    () -> tryConsumePendingSurfaceRefresh(trigger, replacementSource));
            return false;
        }
        if (disposed) {
            surfaceRefreshCoordinator.invalidate();
            cancelScheduledOsrSurfaceRefresh();
            return false;
        }

        rebindSurfaceRefreshWindow();
        JBCefBrowser currentBrowser = browser;
        long currentReadyEpoch = frontendReadyTransitions.currentEpoch();
        if (currentBrowser != null && currentBrowser.isOffScreenRendering()) {
            return tryArmOsrSurfaceRefresh(
                    currentBrowser, currentReadyEpoch, trigger, replacementSource);
        }
        String pendingReason = surfaceRefreshCoordinator.pendingReason();
        boolean consumed = surfaceRefreshCoordinator.tryConsume(
                currentBrowser,
                currentReadyEpoch,
                () -> isSurfaceRefreshEligible(currentBrowser),
                () -> refreshCurrentWebviewSurface(currentBrowser));
        if (consumed) {
            LOG.info("[WebviewSurface] Consumed pending surface refresh"
                    + ", reason=" + pendingReason
                    + ", trigger=" + trigger
                    + ", project=" + project.getName());
        }
        return consumed;
    }

    private void resumePendingSurfaceWork(String trigger) {
        tryConsumePendingSurfaceRefresh(trigger);
        if (!hasCurrentUnpublishedPublication()) {
            tryConsumeCachedSurfacePresentation(trigger);
        }
    }

    private boolean hasCurrentUnpublishedPublication() {
        JBCefBrowser currentBrowser = browser;
        if (currentBrowser == null) {
            return false;
        }
        long readyEpoch = frontendReadyTransitions.currentEpoch();
        if (currentBrowser.isOffScreenRendering()) {
            try {
                return surfaceFrameFence.hasUnpublishedFor(
                        currentBrowser,
                        currentBrowser.getCefBrowser(),
                        activePageGeneration,
                        readyEpoch);
            } catch (Exception | LinkageError e) {
                return false;
            }
        }
        return surfaceRefreshCoordinator.hasPendingFor(currentBrowser, readyEpoch);
    }

    private void requestCachedSurfacePresentation(JBCefBrowser expectedBrowser) {
        if (disposed || !frontendReady || expectedBrowser == null
                || browser != expectedBrowser || !expectedBrowser.isOffScreenRendering()) {
            return;
        }
        try {
            surfacePresentationCoordinator.request(
                    expectedBrowser,
                    expectedBrowser.getCefBrowser(),
                    activePageGeneration,
                    frontendReadyTransitions.currentEpoch());
        } catch (Exception | LinkageError e) {
            LOG.debug("Cannot queue cached OSR presentation without a live browser", e);
        }
    }

    private boolean tryConsumeCachedSurfacePresentation(String trigger) {
        if (!SwingUtilities.isEventDispatchThread()) {
            ApplicationManager.getApplication().invokeLater(
                    () -> tryConsumeCachedSurfacePresentation(trigger));
            return false;
        }
        if (disposed) {
            surfacePresentationCoordinator.invalidate();
            return false;
        }
        JBCefBrowser currentBrowser = browser;
        if (currentBrowser == null || !currentBrowser.isOffScreenRendering()) {
            return false;
        }
        CefBrowser currentCefBrowser;
        try {
            currentCefBrowser = currentBrowser.getCefBrowser();
        } catch (Exception | LinkageError e) {
            return false;
        }
        boolean presented = surfacePresentationCoordinator.tryConsume(
                currentBrowser,
                currentCefBrowser,
                activePageGeneration,
                frontendReadyTransitions.currentEpoch(),
                () -> isSurfaceRefreshEligible(currentBrowser),
                () -> forceOsrSurfacePaint(
                        mainPanel,
                        currentBrowser.getComponent(),
                        getNativeSurfaceComponent(currentBrowser)));
        if (presented) {
            LOG.info("[WebviewSurface] Presented cached OSR surface"
                    + ", trigger=" + trigger
                    + ", project=" + project.getName());
        }
        return presented;
    }

    private boolean tryArmOsrSurfaceRefresh(
            JBCefBrowser expectedBrowser,
            long readyEpoch,
            String trigger,
            SurfaceFrameFence.Attempt replacementSource
    ) {
        if (!isSurfaceRefreshEligible(expectedBrowser)) {
            return false;
        }
        CefBrowser cefBrowser = expectedBrowser.getCefBrowser();
        SurfaceFrameFence.Attempt attempt = surfaceFrameFence.arm(
                expectedBrowser,
                cefBrowser,
                activePageGeneration,
                readyEpoch);
        if (attempt == null) {
            return false;
        }
        LOG.info("[WebviewSurface] Armed OSR full-frame fence"
                + ", serial=" + attempt.serial()
                + ", attempt=" + attempt.attemptId()
                + ", reason=" + attempt.reason()
                + ", trigger=" + trigger
                + ", project=" + project.getName());
        if (!scheduleOsrFrameFenceTimeout(attempt)) {
            releaseOsrAttempt(attempt, "timeout_owner_conflict");
            return false;
        }
        if (replacementSource == null) {
            triggerSurfaceDamage(attempt, "phaseA");
        } else {
            surfaceDamageReplacementSources.put(attempt, replacementSource);
            replaceSurfaceDamage(replacementSource, attempt);
        }
        return true;
    }

    private boolean isCurrentOsrSurfaceRefresh(SurfaceFrameFence.Attempt attempt) {
        return !disposed
                && attempt != null
                && browser == attempt.browser()
                && activePageGeneration == attempt.pageGeneration()
                && frontendReadyTransitions.isCurrentReady(attempt.readyEpoch())
                && surfaceFrameFence.isActive(attempt);
    }

    /**
     * Advances the native paint fence only after the exact frontend token confirms its DOM
     * mutation. This callback may arrive off the EDT, while SurfaceFrameFence serializes the
     * state transition against CEF OnPaint callbacks.
     */
    private void onSurfaceDamageApplied(String token, String phaseName, boolean applied) {
        SurfaceFrameFence.Attempt attempt = surfaceFrameFence.activeAttempt();
        if (attempt == null || !surfaceDamageToken(attempt).equals(token)) {
            return;
        }
        SurfaceFrameFence.DamagePhase phase;
        try {
            phase = SurfaceFrameFence.DamagePhase.valueOf(phaseName);
        } catch (IllegalArgumentException | NullPointerException e) {
            return;
        }
        if (!applied) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (surfaceFrameFence.isActive(attempt)) {
                    releaseOsrAttempt(attempt, "frontend_phase_rejected_" + phaseName);
                }
            });
            return;
        }
        if (!surfaceFrameFence.acknowledgePhaseApplied(attempt, phase)) {
            return;
        }
        if (phase == SurfaceFrameFence.DamagePhase.A) {
            surfaceDamageReplacementSources.remove(attempt);
        }
        LOG.info("[WebviewSurface] Frontend applied OSR damage phase"
                + ", phase=" + phase
                + ", serial=" + attempt.serial()
                + ", attempt=" + attempt.attemptId()
                + ", project=" + project.getName());
        if (phase == SurfaceFrameFence.DamagePhase.B) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (!isCurrentOsrSurfaceRefresh(attempt)) {
                    return;
                }
                if (!scheduleOsrFrameFenceTimeout(attempt)) {
                    releaseOsrAttempt(attempt, "final_timeout_owner_conflict");
                }
            });
        }
    }

    private void handleFirstOsrFrameDrained(SurfaceFrameFence.Attempt attempt) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!isCurrentOsrSurfaceRefresh(attempt)
                    || !isSurfaceRefreshEligible(attempt.browser())) {
                releaseOsrAttempt(attempt, "first_frame_ineligible");
                return;
            }
            if (!surfaceFrameFence.beginPhaseBApply(attempt)) {
                releaseOsrAttempt(attempt, "phase_b_gate_rejected");
                return;
            }
            if (!scheduleOsrFrameFenceTimeout(attempt)) {
                releaseOsrAttempt(attempt, "phase_b_timeout_owner_conflict");
                return;
            }
            triggerSurfaceDamage(attempt, "phaseB");
            LOG.info("[WebviewSurface] Drained phase-A OSR frame and requested phase-B damage"
                    + ", serial=" + attempt.serial()
                    + ", attempt=" + attempt.attemptId()
                    + ", project=" + project.getName());
        });
    }

    private void handleFinalOsrFrameForwarded(SurfaceFrameFence.Attempt attempt) {
        ApplicationManager.getApplication().invokeLater(() -> {
            boolean painted = false;
            boolean completed = false;
            boolean newerPending = false;
            try {
                if (!isCurrentOsrSurfaceRefresh(attempt)
                        || !isSurfaceRefreshEligible(attempt.browser())) {
                    return;
                }
                Component nativeComponent = getNativeSurfaceComponent(attempt.browser());
                painted = forceOsrSurfacePaint(
                        mainPanel, attempt.browser().getComponent(), nativeComponent);
                completed = painted && surfaceFrameFence.complete(attempt);
                if (completed) {
                    cancelOsrTimeoutIfOwned(attempt);
                    surfacePresentationCoordinator.invalidate();
                    newerPending = surfaceFrameFence.hasPending();
                    if (!newerPending) {
                        finishSurfaceDamage(attempt);
                    }
                    LOG.info("[WebviewSurface] Published final OSR full frame"
                            + ", serial=" + attempt.serial()
                            + ", attempt=" + attempt.attemptId()
                            + ", reason=" + attempt.reason()
                            + ", project=" + project.getName());
                }
            } catch (Exception | LinkageError e) {
                LOG.warn("Failed to publish final OSR frame: " + e.getMessage(), e);
            } finally {
                if (!painted && surfaceFrameFence.isActive(attempt)) {
                    releaseOsrAttempt(attempt, "final_paint_ineligible");
                }
            }
            if (completed && newerPending) {
                boolean handedOff = tryConsumePendingSurfaceRefresh(
                        "previous_frame_completed", attempt);
                if (!handedOff) {
                    finishSurfaceDamage(attempt);
                }
            }
        });
    }

    private void releaseTimedOutOsrAttempt(SurfaceFrameFence.Attempt attempt) {
        SurfaceFrameFence.ReleaseResult result =
                surfaceFrameFence.releaseAttempt(attempt);
        if (result.released()) {
            LOG.info("[WebviewSurface] OSR frame fence timed out; pending retained"
                    + ", serial=" + attempt.serial()
                    + ", attempt=" + attempt.attemptId()
                    + ", newerPending=" + result.newerPending()
                    + ", project=" + project.getName());
        }
        handOffOrCancelSurfaceDamage(
                result, attempt, "frame_fence_timeout_handoff");
    }

    private void releaseOsrAttempt(SurfaceFrameFence.Attempt attempt, String reason) {
        SurfaceFrameFence.ReleaseResult result =
                surfaceFrameFence.releaseAttempt(attempt);
        if (result.released()) {
            cancelOsrTimeoutIfOwned(attempt);
            LOG.info("[WebviewSurface] Released OSR frame-fence attempt"
                    + ", serial=" + attempt.serial()
                    + ", attempt=" + attempt.attemptId()
                    + ", reason=" + reason
                    + ", project=" + project.getName());
        }
        handOffOrCancelSurfaceDamage(
                result, attempt, "frame_fence_release_handoff");
    }

    private void handOffOrCancelSurfaceDamage(
            SurfaceFrameFence.ReleaseResult result,
            SurfaceFrameFence.Attempt releasedAttempt,
            String trigger
    ) {
        if (!result.released()) {
            return;
        }
        SurfaceFrameFence.Attempt frontendOwner =
                surfaceDamageReplacementSources.remove(releasedAttempt);
        if (frontendOwner == null) {
            frontendOwner = releasedAttempt;
        }
        AtomicBoolean armed = new AtomicBoolean(false);
        SurfaceFrameFence.Attempt replacementSource = frontendOwner;
        boolean handoffClaimed = result.handOffNewer(() -> armed.set(
                tryConsumePendingSurfaceRefresh(trigger, replacementSource)));
        if (!handoffClaimed || !armed.get()) {
            cancelSurfaceDamage(releasedAttempt, frontendOwner);
        }
    }

    private boolean scheduleOsrFrameFenceTimeout(SurfaceFrameFence.Attempt attempt) {
        SurfaceTimeoutTask timeoutTask = new SurfaceTimeoutTask(attempt);
        SurfaceAttemptTimeoutOwner.InstallResult installResult =
                surfaceAttemptTimeoutOwner.install(attempt, timeoutTask);
        if (!installResult.accepted()) {
            LOG.warn("Refusing to replace OSR timeout owned by another attempt"
                    + ", serial=" + attempt.serial()
                    + ", attempt=" + attempt.attemptId());
            return false;
        }
        if (installResult.previousTask() != null) {
            surfaceRefreshAlarm.cancelRequest(installResult.previousTask());
        }
        surfaceRefreshAlarm.addRequest(timeoutTask, OSR_FRAME_FENCE_TIMEOUT_MS);
        return true;
    }

    private void cancelOsrTimeoutIfOwned(SurfaceFrameFence.Attempt attempt) {
        Runnable timeoutTask = surfaceAttemptTimeoutOwner.remove(attempt);
        if (timeoutTask != null) {
            surfaceRefreshAlarm.cancelRequest(timeoutTask);
        }
    }

    private void triggerSurfaceDamage(SurfaceFrameFence.Attempt attempt, String phase) {
        String functionName = "phaseA".equals(phase)
                ? "window.__ccguiSurfaceDamagePhaseA"
                : "window.__ccguiSurfaceDamagePhaseB";
        callSurfaceDamageFunction(functionName, attempt);
    }

    private void replaceSurfaceDamage(
            SurfaceFrameFence.Attempt previousAttempt,
            SurfaceFrameFence.Attempt nextAttempt
    ) {
        callSurfaceDamageFunction(
                "window.__ccguiSurfaceDamageReplace",
                nextAttempt,
                true,
                surfaceDamageToken(previousAttempt),
                surfaceDamageToken(nextAttempt));
    }

    private void finishSurfaceDamage(SurfaceFrameFence.Attempt attempt) {
        callSurfaceDamageFunction("window.__ccguiSurfaceDamageFinish", attempt);
    }

    private void cancelSurfaceDamage(SurfaceFrameFence.Attempt attempt) {
        cancelSurfaceDamage(attempt, surfaceDamageReplacementSources.remove(attempt));
    }

    private void cancelSurfaceDamage(
            SurfaceFrameFence.Attempt attempt,
            SurfaceFrameFence.Attempt predecessor
    ) {
        String predecessorToken = predecessor == null
                ? ""
                : surfaceDamageToken(predecessor);
        callSurfaceDamageFunction(
                "window.__ccguiSurfaceDamageCancel",
                attempt,
                false,
                surfaceDamageToken(attempt),
                predecessorToken);
    }

    private void callSurfaceDamageFunction(
            String functionName,
            SurfaceFrameFence.Attempt attempt
    ) {
        callSurfaceDamageFunction(
                functionName,
                attempt,
                true,
                surfaceDamageToken(attempt));
    }

    private void callSurfaceDamageFunction(
            String functionName,
            SurfaceFrameFence.Attempt attempt,
            boolean requireCurrentGeneration,
            String... arguments
    ) {
        JBCefBrowser expectedBrowser = attempt.browser();
        Runnable invocation = () -> {
            if (disposed
                    || browser != expectedBrowser
                    || (requireCurrentGeneration
                    && activePageGeneration != attempt.pageGeneration())) {
                return;
            }
            try {
                CefBrowser expectedCefBrowser = attempt.cefBrowser();
                if (expectedBrowser.getCefBrowser() != expectedCefBrowser) {
                    return;
                }
                StringBuilder argumentScript = new StringBuilder();
                for (int index = 0; index < arguments.length; index++) {
                    if (index > 0) {
                        argumentScript.append(',');
                    }
                    argumentScript.append('\'')
                            .append(arguments[index])
                            .append('\'');
                }
                String script = "(function(){try{if(typeof " + functionName
                        + "==='function'){" + functionName + "(" + argumentScript
                        + ");}}catch(e){console.error('[WebviewSurface] pulse failed',e);}})();";
                expectedCefBrowser.executeJavaScript(script, expectedCefBrowser.getURL(), 0);
            } catch (Exception | LinkageError e) {
                LOG.warn("Failed to execute OSR surface-damage phase", e);
            }
        };
        if (SwingUtilities.isEventDispatchThread()) {
            invocation.run();
        } else {
            ApplicationManager.getApplication().invokeLater(invocation);
        }
    }

    private static String surfaceDamageToken(SurfaceFrameFence.Attempt attempt) {
        return attempt.pageGeneration()
                + ":" + attempt.readyEpoch()
                + ":" + attempt.serial()
                + ":" + attempt.attemptId();
    }

    private void cancelScheduledOsrSurfaceRefresh() {
        SurfaceFrameFence.Attempt activeAttempt = surfaceFrameFence.activeAttempt();
        if (activeAttempt != null) {
            cancelSurfaceDamage(activeAttempt);
        }
        surfaceDamageReplacementSources.clear();
        surfaceFrameFence.invalidate();
        surfacePresentationCoordinator.invalidate();
        surfaceAttemptTimeoutOwner.clear();
        surfaceRefreshAlarm.cancelAllRequests();
    }

    private boolean isSurfaceRefreshEligible(JBCefBrowser expectedBrowser) {
        if (disposed || expectedBrowser == null || browser != expectedBrowser || !isWebviewActive()) {
            return false;
        }
        Component browserComponent = expectedBrowser.getComponent();
        Component nativeComponent = getNativeSurfaceComponent(expectedBrowser);
        rebindNativeSurfaceComponent(nativeComponent);
        Window rootWindow = SwingUtilities.getWindowAncestor(mainPanel);
        boolean rootIconified = rootWindow instanceof Frame
                && ((((Frame) rootWindow).getExtendedState() & Frame.ICONIFIED) != 0);
        return isSurfaceRefreshEligible(
                mainPanel.isShowing(),
                browserComponent.isShowing(),
                browserComponent.isDisplayable(),
                nativeComponent != null && nativeComponent.isShowing(),
                nativeComponent != null && nativeComponent.isDisplayable(),
                rootWindow != null && rootWindow.isShowing(),
                rootIconified,
                nativeComponent == null ? 0 : nativeComponent.getWidth(),
                nativeComponent == null ? 0 : nativeComponent.getHeight());
    }

    static boolean isSurfaceRefreshEligible(
            boolean mainPanelShowing,
            boolean browserShowing,
            boolean browserDisplayable,
            boolean nativeSurfaceShowing,
            boolean nativeSurfaceDisplayable,
            boolean rootWindowShowing,
            boolean rootWindowIconified,
            int nativeSurfaceWidth,
            int nativeSurfaceHeight
    ) {
        return mainPanelShowing
                && browserShowing
                && browserDisplayable
                && nativeSurfaceShowing
                && nativeSurfaceDisplayable
                && rootWindowShowing
                && !rootWindowIconified
                && nativeSurfaceWidth > 0
                && nativeSurfaceHeight > 0;
    }

    private void handleSurfaceRefreshHierarchyChange(HierarchyEvent event) {
        long relevantChanges = HierarchyEvent.PARENT_CHANGED
                | HierarchyEvent.DISPLAYABILITY_CHANGED
                | HierarchyEvent.SHOWING_CHANGED;
        if ((event.getChangeFlags() & relevantChanges) == 0) {
            return;
        }
        rebindSurfaceRefreshWindow();
        if (mainPanel.isShowing()) {
            resumePendingSurfaceWork("hierarchy_showing");
        }
    }

    private void rebindSurfaceRefreshWindow() {
        Window nextWindow = SwingUtilities.getWindowAncestor(mainPanel);
        if (observedSurfaceWindow == nextWindow) {
            return;
        }
        if (observedSurfaceWindow != null) {
            observedSurfaceWindow.removeWindowListener(surfaceRefreshWindowListener);
        }
        observedSurfaceWindow = nextWindow;
        if (observedSurfaceWindow != null) {
            observedSurfaceWindow.addWindowListener(surfaceRefreshWindowListener);
        }
    }

    private void replaceBrowser(JBCefBrowser nextBrowser) {
        if (browser == nextBrowser) {
            return;
        }
        if (observedBrowserComponent != null) {
            observedBrowserComponent.removeComponentListener(surfaceRefreshComponentListener);
        }
        observedBrowserComponent = null;
        rebindNativeSurfaceComponent(null);
        cancelScheduledOsrSurfaceRefresh();
        surfaceRefreshCoordinator.invalidate();
        browser = nextBrowser;
        webviewEventQueue.browserChanged();
        streamCoalescer.resetDeliveryBaseline();
        if (nextBrowser != null) {
            observedBrowserComponent = nextBrowser.getComponent();
            observedBrowserComponent.addComponentListener(surfaceRefreshComponentListener);
            rebindNativeSurfaceComponent(getNativeSurfaceComponent(nextBrowser));
        }
        rebindSurfaceRefreshWindow();
    }

    private Component getNativeSurfaceComponent(JBCefBrowser expectedBrowser) {
        if (expectedBrowser == null) {
            return null;
        }
        try {
            CefBrowser cefBrowser = expectedBrowser.getCefBrowser();
            return cefBrowser == null ? null : cefBrowser.getUIComponent();
        } catch (Exception | LinkageError e) {
            LOG.debug("Native JCEF surface is not available yet: " + e.getMessage());
            return null;
        }
    }

    private void rebindNativeSurfaceComponent(Component nextComponent) {
        if (observedNativeSurfaceComponent == nextComponent) {
            return;
        }
        if (observedNativeSurfaceComponent != null) {
            if (observedNativeSurfaceComponent != observedBrowserComponent) {
                observedNativeSurfaceComponent.removeComponentListener(surfaceRefreshComponentListener);
            }
            observedNativeSurfaceComponent.removeHierarchyListener(surfaceRefreshHierarchyListener);
        }
        observedNativeSurfaceComponent = nextComponent;
        if (observedNativeSurfaceComponent != null) {
            if (observedNativeSurfaceComponent != observedBrowserComponent) {
                observedNativeSurfaceComponent.addComponentListener(surfaceRefreshComponentListener);
            }
            observedNativeSurfaceComponent.addHierarchyListener(surfaceRefreshHierarchyListener);
        }
    }

    private boolean isSelectedContent() {
        Content content = parentContent;
        ContentManager contentManager = content == null ? null : content.getManager();
        return contentManager != null && contentManager.getSelectedContent() == content;
    }

    private boolean isWebviewActive() {
        Content content = parentContent;
        ContentManager contentManager = content == null ? null : content.getManager();
        boolean managedContent = contentManager != null && contentManager.getIndexOfContent(content) >= 0;
        boolean selectedContent = managedContent && contentManager.getSelectedContent() == content;
        DetachedChatFrame detachedFrame = DetachedWindowManager.getDetachedFrame(project, this);
        return resolveWebviewActive(
                managedContent,
                selectedContent,
                detachedFrame != null,
                detachedFrame != null && detachedFrame.isVisible());
    }

    static boolean resolveWebviewActive(
            boolean managedContent,
            boolean selectedContent,
            boolean detachedWindowPresent,
            boolean detachedWindowVisible
    ) {
        if (managedContent) {
            return selectedContent;
        }
        return !detachedWindowPresent || detachedWindowVisible;
    }

    static boolean refreshActivatedWebview(
            JPanel mainPanel,
            JComponent browserComponent,
            CefBrowser cefBrowser,
            boolean offScreenRendering,
            Runnable frontendRepaint
    ) {
        mainPanel.revalidate();
        mainPanel.repaint();
        browserComponent.revalidate();
        browserComponent.repaint();

        boolean nativeRefreshPerformed = false;
        try {
            Component nativeComponent = cefBrowser.getUIComponent();
            if (nativeComponent != null) {
                Rectangle currentBounds = nativeComponent.getBounds();
                LOG.info("[WebviewSurface] Reapplying "
                        + (offScreenRendering ? "OSR" : "windowed")
                        + " native bounds"
                        + ", component=" + nativeComponent.getClass().getName()
                        + ", showing=" + nativeComponent.isShowing()
                        + ", displayable=" + nativeComponent.isDisplayable()
                        + ", bounds=" + currentBounds);
                if (nativeComponent.isShowing()
                        && nativeComponent.isDisplayable()
                        && currentBounds.width > 0
                        && currentBounds.height > 0) {
                    // Both JBCefOsrComponent and CefBrowserWr override the Swing bounds
                    // lifecycle. Reapplying the current bounds intentionally follows the
                    // same resize scheduling path as a real layout or window resize.
                    nativeComponent.setBounds(currentBounds);
                    if (offScreenRendering) {
                        // JBCefOsrComponent normally schedules this through its
                        // reshape() alarm. Calling it explicitly makes the bounded
                        // recovery independent from an already-coalesced resize.
                        cefBrowser.wasResized(0, 0);
                    }
                    nativeRefreshPerformed = true;
                }
                if (!nativeRefreshPerformed) {
                    return false;
                }
                nativeComponent.revalidate();
                Container parent = nativeComponent.getParent();
                if (parent != null) {
                    parent.validate();
                    parent.repaint();
                }
                nativeComponent.repaint();
            }
            cefBrowser.notifyScreenInfoChanged();
        } finally {
            frontendRepaint.run();
        }
        return nativeRefreshPerformed;
    }

    static boolean forceOsrSurfacePaint(
            JPanel mainPanel,
            JComponent browserComponent,
            Component nativeComponent
    ) {
        if (!(nativeComponent instanceof JComponent)
                || !nativeComponent.isShowing()
                || !nativeComponent.isDisplayable()
                || nativeComponent.getWidth() <= 0
                || nativeComponent.getHeight() <= 0) {
            return false;
        }

        JComponent nativeSurface = (JComponent) nativeComponent;
        mainPanel.revalidate();
        browserComponent.revalidate();
        nativeSurface.revalidate();
        RepaintManager.currentManager(nativeSurface).markCompletelyDirty(nativeSurface);
        browserComponent.repaint();
        nativeSurface.repaint();
        nativeSurface.paintImmediately(
                0, 0, nativeSurface.getWidth(), nativeSurface.getHeight());
        return true;
    }

    public ClaudeSDKBridge getClaudeSDKBridge() {
        return claudeSDKBridge;
    }

    public GrokSDKBridge getGrokSDKBridge() {
        return grokSDKBridge;
    }

    public CodexSDKBridge getCodexSDKBridge() {
        return codexSDKBridge;
    }

    public Map<String, MarkerCliBridge> getCliBridges() {
        return cliBridges;
    }

    public KimiCliBridge getKimiCliBridge() {
        return kimiCliBridge;
    }

    public OpenCodeCliBridge getOpenCodeCliBridge() {
        return openCodeCliBridge;
    }

    public PiCliBridge getPiCliBridge() {
        return piCliBridge;
    }

    public OmpCliBridge getOmpCliBridge() {
        return ompCliBridge;
    }

    public MiniMaxCliBridge getMiniMaxCliBridge() {
        return miniMaxCliBridge;
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

    /**
     * Copies provider-specific preferences into a newly-created tab without
     * carrying over the source tab's conversation or runtime channel.
     */
    public void inheritSessionPreferencesFrom(ClaudeChatWindow sourceWindow) {
        if (sourceWindow == null || sourceWindow.session == null || session == null) {
            return;
        }

        ClaudeSession sourceSession = sourceWindow.session;
        copySessionPreferences(sourceSession.getState(), session.getState());
        if (handlerContext != null) {
            handlerContext.setCurrentProvider(sourceSession.getProvider());
            handlerContext.setCurrentModel(sourceSession.getModel());
        }
        persistTabSessionState();
    }

    static void copySessionPreferences(SessionState source, SessionState target) {
        target.setProvider(source.getProvider());
        target.setModel(source.getModel());
        target.setPermissionMode(source.getPermissionMode());
        target.setReasoningEffort(source.getReasoningEffort());
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
            // ModelProviderHandler also reads the handler-owned model to detect
            // real transitions. Keep both authorities aligned before frontend
            // startup sync so a restored non-default model is not mistaken for
            // a switch that invalidates the freshly loaded usage snapshot.
            if (handlerContext != null) {
                handlerContext.setCurrentModel(savedState.model);
            }
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
        if (session == null || !frontendReady) {
            return;
        }

        TabStateService.TabSessionState currentState = new TabStateService.TabSessionState();
        currentState.sessionId = session.getSessionId();
        loadRestoredHistoryIfNeeded(currentState);
    }

    private void loadRestoredHistoryIfNeeded(TabStateService.TabSessionState savedState) {
        if (!TabSessionRestorePolicy.shouldStartHistoryLoad(savedState, frontendReady) || session == null) {
            return;
        }
        if (!restoredHistoryLoadStarted.compareAndSet(false, true)) {
            return;
        }

        ClaudeSession restoringSession = session;
        restoringSession.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
            if (!disposed && session == restoringSession) {
                callJavaScript("historyLoadComplete",
                        String.valueOf(restoringSession.getMessages().size()));
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

    /**
     * Add project-tree paths through the dedicated structured file-reference
     * bridge, buffering the batch until the WebView is ready when necessary.
     */
    public void addFileReferencesFromExternal(List<String> filePaths) {
        if (filePaths == null || filePaths.isEmpty()) {
            return;
        }
        List<String> toEmit = pendingFileReferencesBuffer.offer(filePaths, frontendReady);
        if (toEmit != null) {
            addFileReferences(toEmit);
        }
    }

    private void flushPendingCodeSnippet() {
        String snippet = pendingCodeSnippetBuffer.takePending();
        if (snippet != null) {
            addCodeSnippet(snippet);
        }
    }

    private void flushPendingFileReferences() {
        List<String> filePaths = pendingFileReferencesBuffer.takePending();
        if (filePaths != null) {
            addFileReferences(filePaths);
        }
    }

    private void updateFrontendReadyState(boolean ready) {
        FrontendReadyTransition transition = frontendReadyTransitions.update(ready);
        frontendReady = ready;
        if (!ready) {
            surfaceRefreshCoordinator.invalidate();
            cancelScheduledOsrSurfaceRefresh();
            return;
        }
        hasEverBeenFrontendReady = true;
        flushPendingCodeSnippet();
        flushPendingFileReferences();
        ApplicationManager.getApplication().invokeLater(() -> {
            completeFrontendReadyUiUpdate(
                    disposed,
                    transition.becameReady(),
                    () -> frontendReadyTransitions.isCurrentReady(transition.epoch()),
                    () -> requestSurfaceRefresh(
                            browser, transition.epoch(), 0L, "frontend_ready"),
                    this::isWebviewActive,
                    () -> tryConsumePendingSurfaceRefresh("frontend_ready"),
                    this::loadRestoredHistoryIfNeeded
            );
        });
    }

    /**
     * Starts native publication after React has committed a restored-history snapshot.
     * The event does not claim that Chromium or OSR has painted; the OSR frame fence establishes
     * that separately from real paint callbacks. The bridge generation gate rejects messages
     * from obsolete pages before this method runs, while the ready epoch rejects queued stale work.
     */
    private void onHistoryRenderComplete(long commitEpoch) {
        long readyEpoch = frontendReadyTransitions.currentEpoch();
        JBCefBrowser acknowledgingBrowser = browser;
        if (acknowledgingBrowser == null) {
            return;
        }
        CefBrowser acknowledgingCefBrowser;
        try {
            acknowledgingCefBrowser = acknowledgingBrowser.getCefBrowser();
        } catch (Exception | LinkageError e) {
            LOG.debug("Ignoring history DOM acknowledgment without a live CEF browser", e);
            return;
        }
        int acknowledgingGeneration = activePageGeneration;
        ApplicationManager.getApplication().invokeLater(() -> completeHistoryRenderUiUpdate(
                disposed,
                () -> isHistoryRenderOwnerCurrent(
                        acknowledgingBrowser,
                        acknowledgingCefBrowser,
                        acknowledgingGeneration,
                        readyEpoch),
                () -> {
                    LOG.info("[WebviewSurface] Queuing native surface refresh after history DOM commit");
                    requestSurfaceRefresh(
                            acknowledgingBrowser,
                            readyEpoch,
                            Math.max(1L, commitEpoch),
                            "history_dom_committed");
                    tryConsumePendingSurfaceRefresh("history_dom_committed");
                }
        ));
    }

    private boolean isHistoryRenderOwnerCurrent(
            JBCefBrowser acknowledgingBrowser,
            CefBrowser acknowledgingCefBrowser,
            int acknowledgingGeneration,
            long readyEpoch
    ) {
        if (disposed || !frontendReadyTransitions.isCurrentReady(readyEpoch)) {
            return false;
        }
        JBCefBrowser currentBrowser = browser;
        CefBrowser currentCefBrowser;
        try {
            currentCefBrowser = currentBrowser == null ? null : currentBrowser.getCefBrowser();
        } catch (Exception | LinkageError e) {
            return false;
        }
        return historyRenderOwnerMatches(
                acknowledgingBrowser,
                acknowledgingCefBrowser,
                acknowledgingGeneration,
                currentBrowser,
                currentCefBrowser,
                activePageGeneration);
    }

    /** Verifies browser, native browser and page-generation ownership of a queued history ack. */
    static boolean historyRenderOwnerMatches(
            Object acknowledgingBrowser,
            Object acknowledgingCefBrowser,
            int acknowledgingGeneration,
            Object currentBrowser,
            Object currentCefBrowser,
            int currentGeneration
    ) {
        return acknowledgingBrowser != null
                && acknowledgingBrowser == currentBrowser
                && acknowledgingCefBrowser != null
                && acknowledgingCefBrowser == currentCefBrowser
                && acknowledgingGeneration == currentGeneration;
    }

    /** Applies a history-render refresh only while the acknowledging page is still current. */
    static void completeHistoryRenderUiUpdate(
            boolean disposed,
            BooleanSupplier readyTransitionStillCurrent,
            Runnable requestRefresh
    ) {
        if (disposed || !readyTransitionStillCurrent.getAsBoolean()) {
            return;
        }
        requestRefresh.run();
    }

    /**
     * Applies deferred frontend-ready UI work using state re-sampled on the EDT.
     * Only the first still-active ready transition repaints the native JCEF surface.
     */
    static void completeFrontendReadyUiUpdate(
            boolean disposed,
            boolean becameReady,
            BooleanSupplier readyTransitionStillCurrent,
            Runnable requestPublication,
            BooleanSupplier webviewActive,
            Runnable tryPublish,
            Runnable loadRestoredHistory
    ) {
        if (disposed) {
            return;
        }
        if (becameReady && readyTransitionStillCurrent.getAsBoolean()) {
            requestPublication.run();
            if (webviewActive.getAsBoolean()) {
                tryPublish.run();
            }
        }
        loadRestoredHistory.run();
    }

    /**
     * Tracks frontend-ready transitions so deferred EDT work can reject an older page transition.
     * Repeated reports of the same state retain the current epoch.
     */
    static final class FrontendReadyTransitionTracker {
        private boolean ready;
        private long epoch;

        synchronized FrontendReadyTransition update(boolean nextReady) {
            boolean stateChanged = ready != nextReady;
            if (stateChanged) {
                ready = nextReady;
                epoch++;
            }
            return new FrontendReadyTransition(stateChanged && ready, epoch);
        }

        synchronized boolean isCurrentReady(long capturedEpoch) {
            return ready && capturedEpoch == epoch;
        }

        synchronized long currentEpoch() {
            return epoch;
        }
    }

    /** Surface action selected when an already-created chat Tab becomes active. */
    enum TabActivationSurfaceAction {
        NONE,
        PUBLISH_PENDING,
        PRESENT_CACHED,
        WINDOWED_REFRESH
    }

    /** Captures whether a transition became ready and the epoch that owns its deferred work. */
    static final class FrontendReadyTransition {
        private final boolean becameReady;
        private final long epoch;

        private FrontendReadyTransition(boolean becameReady, long epoch) {
            this.becameReady = becameReady;
            this.epoch = epoch;
        }

        boolean becameReady() {
            return becameReady;
        }

        long epoch() {
            return epoch;
        }
    }

    /**
     * Retains one native-surface refresh request until its browser and ready epoch can
     * complete a valid resize. Newer page requests replace obsolete pending work.
     */
    static final class SurfaceRefreshCoordinator {
        private PendingSurfaceRefresh pending;
        private boolean refreshInProgress;

        synchronized void request(Object browserIdentity, long readyEpoch, String reason) {
            if (browserIdentity == null) {
                return;
            }
            if (pending != null
                    && pending.browserIdentity == browserIdentity
                    && pending.readyEpoch == readyEpoch) {
                pending = new PendingSurfaceRefresh(
                        browserIdentity, readyEpoch, reason);
                return;
            }
            pending = new PendingSurfaceRefresh(browserIdentity, readyEpoch, reason);
        }

        boolean tryConsume(
                Object currentBrowserIdentity,
                long currentReadyEpoch,
                BooleanSupplier eligible,
                BooleanSupplier refreshAction
        ) {
            PendingSurfaceRefresh candidate;
            synchronized (this) {
                if (refreshInProgress) {
                    return false;
                }
                candidate = pending;
                if (candidate == null) {
                    return false;
                }
                if (candidate.browserIdentity != currentBrowserIdentity
                        || candidate.readyEpoch != currentReadyEpoch) {
                    pending = null;
                    return false;
                }
            }
            if (!eligible.getAsBoolean()) {
                return false;
            }
            synchronized (this) {
                if (refreshInProgress || pending != candidate) {
                    return false;
                }
                refreshInProgress = true;
            }

            boolean refreshed;
            try {
                refreshed = refreshAction.getAsBoolean();
            } finally {
                synchronized (this) {
                    refreshInProgress = false;
                }
            }
            synchronized (this) {
                if (!refreshed || pending != candidate) {
                    return false;
                }
                pending = null;
                return true;
            }
        }

        synchronized boolean hasPending() {
            return pending != null;
        }

        synchronized boolean hasPendingFor(Object browserIdentity, long readyEpoch) {
            if (pending == null) {
                return false;
            }
            if (pending.browserIdentity != browserIdentity
                    || pending.readyEpoch != readyEpoch) {
                pending = null;
                return false;
            }
            return true;
        }

        synchronized boolean completeCurrent(Object browserIdentity, long readyEpoch) {
            if (!hasPendingFor(browserIdentity, readyEpoch)) {
                return false;
            }
            pending = null;
            return true;
        }

        synchronized String pendingReason() {
            return pending == null ? null : pending.reason;
        }

        synchronized void invalidate() {
            pending = null;
        }
    }

    /**
     * Retains a lightweight request to present an already-published OSR backing image.
     * This state is intentionally independent from content publication serials: showing a
     * cached frame must never manufacture Chromium damage or advance SurfaceFrameFence.
     */
    static final class SurfacePresentationCoordinator {
        private PendingSurfacePresentation pending;
        private boolean presentationInProgress;

        synchronized void request(
                Object browserIdentity,
                Object cefBrowserIdentity,
                int pageGeneration,
                long readyEpoch
        ) {
            if (browserIdentity == null || cefBrowserIdentity == null) {
                return;
            }
            pending = new PendingSurfacePresentation(
                    browserIdentity, cefBrowserIdentity, pageGeneration, readyEpoch);
        }

        boolean tryConsume(
                Object currentBrowserIdentity,
                Object currentCefBrowserIdentity,
                int currentPageGeneration,
                long currentReadyEpoch,
                BooleanSupplier eligible,
                BooleanSupplier presentationAction
        ) {
            PendingSurfacePresentation candidate;
            synchronized (this) {
                if (presentationInProgress) {
                    return false;
                }
                candidate = pending;
                if (candidate == null) {
                    return false;
                }
                if (!candidate.matches(
                        currentBrowserIdentity,
                        currentCefBrowserIdentity,
                        currentPageGeneration,
                        currentReadyEpoch)) {
                    pending = null;
                    return false;
                }
            }
            if (!eligible.getAsBoolean()) {
                return false;
            }
            synchronized (this) {
                if (presentationInProgress || pending != candidate) {
                    return false;
                }
                presentationInProgress = true;
            }

            boolean presented;
            try {
                presented = presentationAction.getAsBoolean();
            } finally {
                synchronized (this) {
                    presentationInProgress = false;
                }
            }
            synchronized (this) {
                if (!presented || pending != candidate) {
                    return false;
                }
                pending = null;
                return true;
            }
        }

        synchronized boolean hasPending() {
            return pending != null;
        }

        synchronized void invalidate() {
            pending = null;
        }
    }

    /**
     * Owns exactly one timeout runnable for one concrete OSR attempt.
     * An obsolete callback can remove only its own timeout and can never cancel a newer attempt.
     */
    static final class SurfaceAttemptTimeoutOwner {
        private Object owner;
        private Runnable task;

        synchronized InstallResult install(Object expectedOwner, Runnable nextTask) {
            if (expectedOwner == null || nextTask == null) {
                return new InstallResult(false, null);
            }
            if (owner != null && owner != expectedOwner) {
                return new InstallResult(false, null);
            }
            Runnable previousTask = task;
            owner = expectedOwner;
            task = nextTask;
            return new InstallResult(true, previousTask);
        }

        synchronized boolean claim(Object expectedOwner, Runnable expectedTask) {
            if (owner != expectedOwner || task != expectedTask) {
                return false;
            }
            owner = null;
            task = null;
            return true;
        }

        synchronized Runnable remove(Object expectedOwner) {
            if (owner != expectedOwner) {
                return null;
            }
            Runnable removed = task;
            owner = null;
            task = null;
            return removed;
        }

        synchronized Runnable clear() {
            Runnable removed = task;
            owner = null;
            task = null;
            return removed;
        }

        synchronized boolean isOwnedBy(Object expectedOwner, Runnable expectedTask) {
            return owner == expectedOwner && task == expectedTask;
        }

        /** Result of installing or replacing the timeout for the same exact attempt. */
        static final class InstallResult {
            private final boolean accepted;
            private final Runnable previousTask;

            private InstallResult(boolean accepted, Runnable previousTask) {
                this.accepted = accepted;
                this.previousTask = previousTask;
            }

            boolean accepted() {
                return accepted;
            }

            Runnable previousTask() {
                return previousTask;
            }
        }
    }

    /** Timeout runnable that must atomically claim ownership before releasing its attempt. */
    private final class SurfaceTimeoutTask implements Runnable {
        private final SurfaceFrameFence.Attempt attempt;

        private SurfaceTimeoutTask(SurfaceFrameFence.Attempt attempt) {
            this.attempt = attempt;
        }

        @Override
        public void run() {
            if (surfaceAttemptTimeoutOwner.claim(attempt, this)) {
                releaseTimedOutOsrAttempt(attempt);
            }
        }
    }

    /** Identifies the browser page that owns a deferred surface refresh. */
    private static final class PendingSurfaceRefresh {
        private final Object browserIdentity;
        private final long readyEpoch;
        private final String reason;
        private PendingSurfaceRefresh(Object browserIdentity, long readyEpoch, String reason) {
            this.browserIdentity = browserIdentity;
            this.readyEpoch = readyEpoch;
            this.reason = reason;
        }
    }

    /** Identifies one cached-surface presentation without creating content publication work. */
    private static final class PendingSurfacePresentation {
        private final Object browserIdentity;
        private final Object cefBrowserIdentity;
        private final int pageGeneration;
        private final long readyEpoch;

        private PendingSurfacePresentation(
                Object browserIdentity,
                Object cefBrowserIdentity,
                int pageGeneration,
                long readyEpoch
        ) {
            this.browserIdentity = browserIdentity;
            this.cefBrowserIdentity = cefBrowserIdentity;
            this.pageGeneration = pageGeneration;
            this.readyEpoch = readyEpoch;
        }

        private boolean matches(
                Object currentBrowserIdentity,
                Object currentCefBrowserIdentity,
                int currentPageGeneration,
                long currentReadyEpoch
        ) {
            return browserIdentity == currentBrowserIdentity
                    && cefBrowserIdentity == currentCefBrowserIdentity
                    && pageGeneration == currentPageGeneration
                    && readyEpoch == currentReadyEpoch;
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

    /** Execute raw JavaScript through the same ordered webview queue as callback events. */
    public void executeJavaScriptCode(String jsCode) {
        webviewEventQueue.enqueueRaw(jsCode);
    }

    private void executeQueuedWebviewScript(JBCefBrowser targetBrowser, String jsCode) {
        if (this.disposed || this.browser != targetBrowser) {
            return;
        }
        try {
            org.cef.browser.CefBrowser cefBrowser = targetBrowser.getCefBrowser();
            cefBrowser.executeJavaScript(jsCode, cefBrowser.getURL(), 0);
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to execute queued webview JavaScript: " + e.getMessage(), e);
        }
    }

    // ==================== JavaScript Bridge ====================

    private static final java.util.regex.Pattern SAFE_JS_FUNCTION_NAME =
            java.util.regex.Pattern.compile("^[a-zA-Z_$][a-zA-Z0-9_$.]*$");

    void callJavaScript(String functionName, String... args) {
        if (functionName == null || !SAFE_JS_FUNCTION_NAME.matcher(functionName).matches()) {
            LOG.error("Invalid JavaScript function name rejected: " + functionName);
            return;
        }
        webviewEventQueue.enqueue(functionName, args);
    }

    void handleJavaScriptMessage(int pageGeneration, String message) {
        if (message == null) {
            return;
        }
        // Serialized against dispose() via the dispatch gate. dispose's beginTeardown() waits for
        // any in-flight dispatch to finish and blocks new ones, so no handler side effect (e.g.
        // SessionHandler scheduling an async session.send) can start after teardown has begun. The
        // gate monitor is held only across dispatch - dispose runs its heavy teardown (browser
        // disposal, process cleanup) outside it, so the JCEF thread never waits on the EDT. That
        // keeps the old dispatch/dispose lifecycle exclusion without the EDT<->JCEF deadlock.
        this.dispatchGate.runInDispatch(
                pageGeneration, () -> this.handleJavaScriptMessageLocked(message));
    }

    /**
     * Dispatch body, run under the {@link MessageDispatchGate} so it is serialized against
     * {@code dispose()}. The gate guarantees the window is not disposed for the whole call, so no
     * per-handler disposed re-check is needed here.
     */
    private void handleJavaScriptMessageLocked(String message) {
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

        MessageDispatcher dispatcher = this.messageDispatcher;
        if (dispatcher == null) {
            return;
        }
        if (dispatcher.dispatch(type, content)) {
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
                if (newSessionId == null || newSessionId.trim().isEmpty()
                        || newSessionId.equals(sessionId)) {
                    return;
                }
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

                    // If a turn is streaming, DON'T reload now (clearMessages() off
                    // the EDT would race the streaming append and disturb the live
                    // bubble). DON'T drop it either, or a background-turn answer would
                    // stay invisible until the user reopens the session. Park the id
                    // and drain it at stream end (onStreamEnded).
                    if (sessionCallbackAdapter != null && streamCoalescer != null && streamCoalescer.isStreamActive()) {
                        deferredReload.defer(updatedSessionId);
                        // onStreamEnded drains this at the next stream-end. Also arm the
                        // safety backstop so a defer that races the stream-end edge — or
                        // the last fan-out answer with no following stream end — is still
                        // drained once the stream goes idle (see deferredReloadSafetyTick).
                        scheduleDeferredReloadSafetyDrain();
                        LOG.info("[ClaudeChatWindow] session_updated during active turn, deferring reload to stream end");
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
                } else if ("task_event".equals(event)) {
                    // Async subagent (Agent/Task tool with run_in_background:true)
                    // lifecycle event forwarded by the
                    // ai-bridge perpetual reader. task_notification arrives inter-turn
                    // (after the turn's result), so it cannot ride the normal [MESSAGE]
                    // stream -- route it to the frontend via onTaskEvent so the subagent
                    // list reflects completion/usage instead of staying on "running".
                    String taskSessionId = data.has("sessionId") && data.get("sessionId").isJsonPrimitive()
                            ? data.get("sessionId").getAsString() : null;
                    if (taskSessionId == null) {
                        LOG.warn("[ClaudeChatWindow] task_event event missing sessionId");
                        return;
                    }
                    // Mirror session_updated's guard: drop events that do not match the
                    // active session so a stale background-agent completion cannot leak
                    // into a session the user has since navigated to. Capture the
                    // adapter into a local before the session check: session and
                    // sessionCallbackAdapter are both volatile and reassigned on the EDT,
                    // so reading them separately could route an old-session event to a
                    // newly activated adapter. The captured adapter's onTaskEvent
                    // re-checks isInactive(), so if the session switched after the
                    // snapshot the delivery is skipped.
                    var adapter = sessionCallbackAdapter;
                    String currentSessionId = session != null ? session.getSessionId() : null;
                    if (currentSessionId == null || !currentSessionId.equals(taskSessionId)) {
                        return;
                    }
                    if (adapter != null && data.has("taskEvent") && !data.get("taskEvent").isJsonNull()) {
                        adapter.onTaskEvent(data.get("taskEvent").toString());
                    }
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

    /**
     * Run a session_updated reload that was deferred because a turn was
     * streaming (see the session_updated handler). Called from the coalescer's
     * onStreamEnded hook when the stream goes inactive — the safe point to
     * reload, since SessionState is no longer being mutated by a streaming turn.
     * A no-op when nothing was deferred. The reload still validates the target
     * session before touching anything (driveSessionReload), so a session the
     * user has navigated away from is never reloaded.
     */
    private void drainDeferredReload() {
        String target = deferredReload.takeIfRunnable(disposed);
        if (target == null) {
            return;
        }
        LOG.info("[ClaudeChatWindow] draining deferred session_updated reload after stream end, sessionId=" + target);
        requestSessionReload(target);
    }

    /**
     * What the safety backstop should do on a tick. Pure function so the
     * park/stream/dispose state machine is unit-testable without a full
     * ClaudeChatWindow.
     *
     * <ul>
     *   <li>{@code DONE} — disposed, or nothing parked (the fast onStreamEnded
     *       path already drained it): stop polling.</li>
     *   <li>{@code RECHECK_LATER} — still parked but a stream is active:
     *       reloading now would race the streaming append, so wait and re-check.</li>
     *   <li>{@code DRAIN} — parked and the stream is idle: the safe point to
     *       drain, even though no onStreamEnded edge arrived for this defer.</li>
     * </ul>
     */
    enum SafetyDrainAction { DONE, RECHECK_LATER, DRAIN }

    static SafetyDrainAction decideDeferredReloadSafety(boolean disposed, boolean hasPending, boolean streamActive) {
        if (disposed || !hasPending) {
            return SafetyDrainAction.DONE;
        }
        return streamActive ? SafetyDrainAction.RECHECK_LATER : SafetyDrainAction.DRAIN;
    }

    static boolean shouldReconcileTranscriptAtStreamEnd(String provider, String sessionId) {
        return "grok".equals(provider) && sessionId != null && !sessionId.isBlank();
    }

    /** (Re)arm the safety backstop; overlapping arms collapse to one pending tick. */
    private void scheduleDeferredReloadSafetyDrain() {
        if (disposed) {
            return;
        }
        deferredReloadSafetyAlarm.cancelAllRequests();
        deferredReloadSafetyAlarm.addRequest(this::deferredReloadSafetyTick, DEFERRED_RELOAD_SAFETY_DRAIN_MS);
    }

    /**
     * Backstop tick: drain a still-parked reload once the stream is idle, or
     * re-check later while it is still streaming. Guarantees the last background
     * answer of a fan-out is never orphaned by a missed/raced onStreamEnded edge.
     * A no-op when the fast path already drained the parked reload.
     */
    private void deferredReloadSafetyTick() {
        boolean streamActive = streamCoalescer != null && streamCoalescer.isStreamActive();
        switch (decideDeferredReloadSafety(disposed, deferredReload.hasPending(), streamActive)) {
            case DRAIN:
                LOG.info("[ClaudeChatWindow] safety-draining deferred reload (no stream-end edge followed the defer)");
                drainDeferredReload();
                break;
            case RECHECK_LATER:
                scheduleDeferredReloadSafetyDrain();
                break;
            case DONE:
            default:
                break;
        }
    }

    /**
     * Coordinates a session_updated reload that arrived while a turn was
     * streaming. Reloading mid-stream is unsafe: {@code loadFromServer()} runs
     * {@code clearMessages()} on SessionState off the EDT, which would race the
     * streaming append and disturb the live streaming bubble. So the target
     * session id is parked here and drained at stream end (onStreamEnded),
     * making background-turn answers appear at the next turn boundary instead of
     * only after the user reopens the session.
     *
     * <p>Thread-safety: {@code defer} is called from the daemon event thread,
     * {@code takeIfRunnable} from the adapter's stream-end callback (ordered
     * after the final snapshot enters the webview queue); both are
     * fully synchronized so a defer/drain interleave never loses or duplicates a
     * pending reload. {@code take} atomically reads-clears-and-gates in one
     * critical section (no read/clear window). Coalescing is last-writer-wins:
     * overlapping background completions collapse into a single reload, which is
     * correct because a reload always reflects the latest JSONL. Extracted as a
     * static nested class so the coordination is unit-testable without a full
     * ClaudeChatWindow (which needs a Project, JBCefBrowser, etc.).
     */
    static final class DeferredReload {
        private String pendingSessionId;

        /** Park a reload for {@code sessionId} (last writer wins). */
        synchronized void defer(String sessionId) {
            this.pendingSessionId = sessionId;
        }

        /**
         * Atomically take-and-clear the parked reload, returning its target only
         * when it should actually run: something was deferred AND the window is
         * still alive. Returns {@code null} otherwise (and still clears, so a
         * stale parked id from a disposed window is not left behind). The target
         * is re-validated against the active session later in
         * driveSessionReload(), so this only gates the coarse "is there anything
         * to drain" question.
         */
        synchronized String takeIfRunnable(boolean disposed) {
            String target = pendingSessionId;
            pendingSessionId = null;
            return (target != null && !disposed) ? target : null;
        }

        /** Visible for testing: whether a reload is currently parked. */
        synchronized boolean hasPending() {
            return pendingSessionId != null;
        }
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
        // Runs as the adapter's stream-end callback, already ordered after the
        // final snapshot and the onStreamEnd signal have entered the webview
        // queue — the safe point to reconcile and drain a deferred reload.
        ClaudeSession current = this.session;
        if (current != null && shouldReconcileTranscriptAtStreamEnd(
                current.getProvider(), current.getSessionId())) {
            // Grok's live ACP stream can omit file-tool blocks that are present
            // in chat_history.jsonl. Reuse the proven same-session reload path
            // once the turn is idle so derived edit statistics use final data.
            this.deferredReload.defer(current.getSessionId());
        }
        this.drainDeferredReload();

        if (session == null) {
            return;
        }
        // Suppress the task-completion notification (sound + toast) when the user
        // manually stopped the turn. Only natural completions should produce a sound.
        if (session.isManuallyInterrupted()) {
            LOG.debug("Stream ended after manual interrupt - suppressing completion sound");
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

    private void addFileReferences(List<String> filePaths) {
        if (filePaths == null || filePaths.isEmpty()) {
            return;
        }

        // Gson emits a JavaScript array literal, preserving each complete path
        // (including spaces) as one typed callback argument.
        String pathsJson = GSON.toJson(filePaths);
        // This method can run on a bridge callback thread (frontend-ready
        // flush), so touch the Swing component on the EDT.
        ApplicationManager.getApplication().invokeLater(() -> {
            JBCefBrowser targetBrowser = this.browser;
            if (!this.disposed && targetBrowser != null) {
                targetBrowser.getComponent().requestFocus();
            }
        });
        executeJavaScriptCode("window.insertFileReferencesAtCursor?.(" + pathsJson + ");");
    }

    /**
     * Focus the chat input field in the frontend.
     * Called when Ctrl+Alt+K activates the panel without a selection.
     */
    public void focusInputPane() {
        JBCefBrowser targetBrowser = this.browser;
        if (this.disposed || targetBrowser == null) {
            return;
        }
        try {
            if (this.browser != targetBrowser) {
                return;
            }
            targetBrowser.getComponent().requestFocus();
        } catch (Exception | LinkageError e) {
            LOG.debug("Skip focus input pane: webview is unavailable", e);
            return;
        }
        executeJavaScriptCode("window.focusChatInput?.()");
    }

    // ==================== Dispose ====================

    public void dispose() {
        // Begin teardown under the dispatch gate: this waits for any in-flight dispatch to finish
        // (so no handler side effect - e.g. an async session.send - can start after this point) and
        // blocks new dispatch from entering. The gate monitor is released before the heavy teardown
        // below, so the JCEF thread never waits on the EDT - that was the original EDT<->JCEF
        // deadlock. beginTeardown() is idempotent; a repeat dispose returns immediately.
        if (!this.dispatchGate.beginTeardown()) {
            return;
        }
        this.disposed = true;
        this.webviewEventQueue.dispose();
        JBCefBrowser targetBrowser = this.browser;
        cancelScheduledOsrSurfaceRefresh();
        surfaceRefreshCoordinator.invalidate();
        mainPanel.removeHierarchyListener(surfaceRefreshHierarchyListener);
        if (observedBrowserComponent != null) {
            observedBrowserComponent.removeComponentListener(surfaceRefreshComponentListener);
            observedBrowserComponent = null;
        }
        rebindNativeSurfaceComponent(null);
        if (observedSurfaceWindow != null) {
            observedSurfaceWindow.removeWindowListener(surfaceRefreshWindowListener);
            observedSurfaceWindow = null;
        }
        this.browser = null;
        if (this.handlerContext != null) {
            this.handlerContext.setDisposed(true);
            this.handlerContext.setBrowser(null);
        }
        webviewWatchdog.stop();

        try {
            if (this.webviewInitializer != null) {
                this.webviewInitializer.disposeBridges();
            }
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to dispose webview bridges: " + e.getMessage(), e);
        }

        chatWindowDelegate.dispose();
        editorContextTracker.dispose();
        streamCoalescer.dispose();
        // Unregister the Swing-level theme change callback to prevent background updates
        // on a disposed panel. The SettingsHandler's callback is cleaned up via chatWindowDelegate.dispose().
        if (swingThemeCallbackHandle != null) {
            ThemeConfigService.unregisterThemeChangeListener(swingThemeCallbackHandle);
            swingThemeCallbackHandle = null;
        }
        Disposer.dispose(surfaceRefreshAlarmDisposable);
        deferredReloadSafetyAlarm.cancelAllRequests();
        Disposer.dispose(safetyAlarmDisposable);
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
            if (grokSDKBridge != null) {
                int activeCount = grokSDKBridge.getActiveProcessCount();
                if (activeCount > 0) {
                    LOG.info("Cleaning up " + activeCount + " active Grok process(es)...");
                }
                grokSDKBridge.cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.warn("Failed to clean up Grok processes: " + e.getMessage());
        }

        try {
            if (targetBrowser != null) {
                targetBrowser.dispose();
            }
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to clean up browser: " + e.getMessage(), e);
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
            public Map<String, MarkerCliBridge> getCliBridges() {
                return cliBridges;
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
            public com.intellij.ui.jcef.JBCefOSRHandlerFactory getOsrHandlerFactory() {
                return surfaceFrameFence.createHandlerFactory();
            }

            @Override
            public void setBrowser(JBCefBrowser b) {
                replaceBrowser(b);
            }

            @Override
            public boolean isDisposed() {
                return disposed;
            }

            @Override
            public void activatePageGeneration(int pageGeneration) {
                if (activePageGeneration != pageGeneration) {
                    surfaceRefreshCoordinator.invalidate();
                    cancelScheduledOsrSurfaceRefresh();
                    activePageGeneration = pageGeneration;
                }
                dispatchGate.activatePageGeneration(pageGeneration);
            }

            @Override
            public void handleJavaScriptMessage(int pageGeneration, String msg) {
                ClaudeChatWindow.this.handleJavaScriptMessage(pageGeneration, msg);
            }

            @Override
            public WebviewWatchdog getWebviewWatchdog() {
                return webviewWatchdog;
            }

            @Override
            public boolean isFrontendReady() {
                return frontendReady;
            }

            @Override
            public boolean hasEverBeenFrontendReady() {
                return hasEverBeenFrontendReady;
            }

            @Override
            public boolean isWebviewActive() {
                return ClaudeChatWindow.this.isWebviewActive();
            }

            @Override
            public void setFrontendReady(boolean ready) {
                updateFrontendReadyState(ready);
            }
        };
    }

    /**
     * Soft-reload the active session's transcript from the server without
     * interrupting any in-flight turn.
     * <p>Used when the user re-opens the session that is already active: instead
     * of tearing it down (interrupt + recreate), we merely refresh the transcript
     * so the latest on-disk state is reflected. Reuses the {@code session_updated}
     * reload path (coalescing + isSessionActive guard), and defers to stream end
     * when a turn is live so the streaming bubble is never disturbed.</p>
     */
    void reloadActiveSessionMessages() {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (disposed) {
                return;
            }
            ClaudeSession current = session;
            if (current == null) {
                callJavaScript("historyLoadComplete", "0");
                return;
            }
            String currentId = current.getSessionId();
            if (currentId == null) {
                callJavaScript("historyLoadComplete", "0");
                return;
            }
            if (streamCoalescer != null && streamCoalescer.isStreamActive()) {
                deferredReload.defer(currentId);
                LOG.info("[ClaudeChatWindow] Same-session resume deferred — "
                        + "turn streaming, will reload at stream end, sessionId=" + currentId);
                // Frontend may have begun a transition (cleared the list). Release the
                // guard now so a later deferred reload can paint; if the list is empty
                // the stream-end drain will repopulate it.
                callJavaScript("historyLoadComplete", String.valueOf(current.getMessages().size()));
                return;
            }
            LOG.info("[ClaudeChatWindow] Same-session resume soft reload (no interrupt), sessionId=" + currentId);
            // Do not only requestSessionReload: that path never signals historyLoadComplete,
            // so a frontend that cleared the list under __sessionTransitioning stays blank.
            ClaudeSession restoring = current;
            restoring.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
                if (disposed || session != restoring) {
                    callJavaScript("historyLoadComplete", "0");
                    return;
                }
                int count = restoring.getMessages().size();
                if (streamCoalescer != null) {
                    streamCoalescer.flush(seq -> {
                        if (!disposed) {
                            callJavaScript("historyLoadComplete", String.valueOf(count));
                        }
                    });
                } else {
                    callJavaScript("historyLoadComplete", String.valueOf(count));
                }
            })).exceptionally(ex -> {
                LOG.warn("[ClaudeChatWindow] Same-session soft reload failed: " + ex.getMessage(), ex);
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (!disposed) {
                        callJavaScript("historyLoadComplete");
                        callJavaScript("addErrorMessage",
                                JsUtils.escapeJs("Failed to reload session: " + ex.getMessage()));
                    }
                });
                return null;
            });
        });
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
            public GrokSDKBridge getGrokSDKBridge() {
                return grokSDKBridge;
            }

            @Override
            public Map<String, MarkerCliBridge> getCliBridges() {
                return cliBridges;
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
            public boolean isActiveContent() {
                return ClaudeChatWindow.this.isActiveContent();
            }

            @Override
            public void activateContent() {
                ClaudeChatWindow.this.activateContent();
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
            public void executeJavaScriptCode(String jsCode) {
                ClaudeChatWindow.this.executeJavaScriptCode(jsCode);
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
            public boolean isRuntimeRecoveryPage() {
                return webviewInitializer.isRuntimeRecoveryPage();
            }

            @Override
            public void setFrontendReady(boolean ready) {
                updateFrontendReadyState(ready);
            }

            @Override
            public void onHistoryRenderComplete(long commitEpoch) {
                ClaudeChatWindow.this.onHistoryRenderComplete(commitEpoch);
            }

            @Override
            public void onSurfaceDamageApplied(String token, String phase, boolean applied) {
                ClaudeChatWindow.this.onSurfaceDamageApplied(token, phase, applied);
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

            @Override
            public void reloadActiveSessionMessages() {
                ClaudeChatWindow.this.reloadActiveSessionMessages();
            }
        };
    }
}
