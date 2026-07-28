package com.github.claudecodegui.ui;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.handler.AgentHandler;
import com.github.claudecodegui.handler.ClipboardHandler;
import com.github.claudecodegui.handler.ContextHandler;
import com.github.claudecodegui.handler.CodexMcpServerHandler;
import com.github.claudecodegui.handler.DependencyHandler;
import com.github.claudecodegui.handler.DiffHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.history.HistoryHandler;
import com.github.claudecodegui.handler.McpServerHandler;
import com.github.claudecodegui.handler.marketplace.McpMarketplaceHandler;
import com.github.claudecodegui.handler.importer.McpServerImportHandler;
import com.github.claudecodegui.handler.core.MessageDispatcher;
import com.github.claudecodegui.handler.NodeProcessHandler;
import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.handler.PromptEnhancerHandler;
import com.github.claudecodegui.handler.PromptHandler;
import com.github.claudecodegui.handler.provider.CustomModelPricingHandler;
import com.github.claudecodegui.handler.provider.ProviderHandler;
import com.github.claudecodegui.handler.RewindHandler;
import com.github.claudecodegui.handler.SessionHandler;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.handler.SkillHandler;
import com.github.claudecodegui.handler.TabHandler;
import com.github.claudecodegui.handler.WindowEventHandler;
import com.github.claudecodegui.handler.file.FileExportHandler;
import com.github.claudecodegui.handler.file.FileHandler;
import com.github.claudecodegui.handler.file.OpenClassHandler;
import com.github.claudecodegui.handler.file.UndoFileHandler;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.SessionLifecycleManager;
import com.github.claudecodegui.session.StreamMessageCoalescer;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.MessageJsonConverter;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.ui.content.Content;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.swing.*;
import java.util.List;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Delegates for initialization setup and runtime operations:
 * handler registration, permission setup, tab status, QuickFix, and frontend ready handling.
 */
public class ChatWindowDelegate {

    private static final Logger LOG = Logger.getInstance(ChatWindowDelegate.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";
    private static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";
    private static final int STATUS_RESET_DELAY_SECONDS = 5;

    public enum TabAnswerStatus {
        IDLE,
        ANSWERING,
        COMPLETED
    }

    public interface DelegateHost {
        Project getProject();
        ClaudeSDKBridge getClaudeSDKBridge();
        CodexSDKBridge getCodexSDKBridge();
        ClaudeSession getSession();
        CodemossSettingsService getSettingsService();
        JPanel getMainPanel();
        JBCefBrowser getBrowser();
        boolean isDisposed();
        void callJavaScript(String fn, String... args);
        Content getParentContent();
        String getOriginalTabName();
        void setOriginalTabName(String name);
        String getSessionId();
        HandlerContext getHandlerContext();
        void setHandlerContext(HandlerContext ctx);
        void setMessageDispatcher(MessageDispatcher d);
        void setPermissionHandler(PermissionHandler h);
        void setHistoryHandler(HistoryHandler h);
        SessionLifecycleManager getSessionLifecycleManager();
        StreamMessageCoalescer getStreamCoalescer();
        WebviewWatchdog getWebviewWatchdog();
        PermissionHandler getPermissionHandler();
        void interruptDueToPermissionDenial();
        boolean isFrontendReady();
        void setFrontendReady(boolean ready);
        void setSlashCommandsFetched(boolean fetched);
        void setFetchedSlashCommandsCount(int count);
        void persistTabSessionState();

        /**
         * Soft-reload the currently active session's transcript without interrupting
         * any in-flight turn.
         * <p>Invoked when the user re-opens the session that is already active —
         * refreshes the transcript from the server instead of tearing the session
         * down (interrupt + recreate). Safe to call while a turn is streaming: the
         * reload is deferred to stream end.</p>
         */
        void reloadActiveSessionMessages();
    }

    private final DelegateHost host;
    private TabAnswerStatus currentTabStatus = TabAnswerStatus.IDLE;
    private ScheduledFuture<?> statusResetTask;
    private volatile String pendingQuickFixPrompt = null;
    private volatile MessageCallback pendingQuickFixCallback = null;

    public ChatWindowDelegate(DelegateHost host) {
        this.host = host;
    }

    public void loadNodePathFromSettings() {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);

            if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                String path = savedNodePath.trim();
                claudeSDKBridge.setNodeExecutable(path);
                codexSDKBridge.setNodeExecutable(path);
                claudeSDKBridge.verifyAndCacheNodePath(path);
                LOG.info("Using manually configured Node.js path: " + path);
            } else {
                LOG.info("No saved Node.js path found, attempting auto-detection...");
                com.github.claudecodegui.model.NodeDetectionResult detected =
                    claudeSDKBridge.detectNodeWithDetails();

                if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                    String detectedPath = detected.getNodePath();
                    String detectedVersion = detected.getNodeVersion();

                    props.setValue(NODE_PATH_PROPERTY_KEY, detectedPath);
                    claudeSDKBridge.setNodeExecutable(detectedPath);
                    codexSDKBridge.setNodeExecutable(detectedPath);
                    claudeSDKBridge.verifyAndCacheNodePath(detectedPath);

                    LOG.info("Auto-detected Node.js: " + detectedPath + " (" + detectedVersion + ")");
                } else {
                    LOG.warn("Failed to auto-detect Node.js path. Error: " +
                        (detected != null ? detected.getErrorMessage() : "Unknown error"));
                }
            }
        } catch (Exception e) {
            LOG.error("Failed to load Node.js path: " + e.getMessage(), e);
        }
    }

    public void loadPermissionModeFromSettings() {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
            if (savedMode != null && !savedMode.trim().isEmpty()) {
                String mode = savedMode.trim();
                ClaudeSession session = host.getSession();
                if (session != null) {
                    session.setPermissionMode(mode);
                    host.persistTabSessionState();
                    LOG.info("Loaded permission mode from settings: " + mode);
                    com.github.claudecodegui.notifications.ClaudeNotifier.setMode(host.getProject(), mode);
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to load permission mode: " + e.getMessage());
        }
    }

    public void savePermissionModeToSettings(String mode) {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            props.setValue(PERMISSION_MODE_PROPERTY_KEY, mode);
            LOG.info("Saved permission mode to settings: " + mode);
        } catch (Exception e) {
            LOG.warn("Failed to save permission mode: " + e.getMessage());
        }
    }

    public void syncActiveProvider() {
        try {
            CodemossSettingsService settingsService = host.getSettingsService();
            if (settingsService.isLocalProviderActive()) {
                LOG.info("[ClaudeSDKToolWindow] Local provider active, skipping startup sync");
                return;
            }
            settingsService.applyActiveProviderToClaudeSettings();
        } catch (Exception e) {
            LOG.warn("Failed to sync active provider on startup: " + e.getMessage());
        }
    }

    public String setupPermissionService() {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        Project project = host.getProject();
        String sessionId = claudeSDKBridge.getSessionId();

        if ((sessionId == null || sessionId.isEmpty()) && codexSDKBridge != null) {
            sessionId = codexSDKBridge.getSessionId();
        }

        if (sessionId == null || sessionId.isEmpty()) {
            LOG.warn("Failed to get session ID from bridges, generating fallback UUID");
            sessionId = java.util.UUID.randomUUID().toString();
        }

        claudeSDKBridge.setSessionId(sessionId);
        if (codexSDKBridge != null) {
            codexSDKBridge.setSessionId(sessionId);
        }
        LOG.info("Unified bridge sessionId for PermissionService routing: " + sessionId);

        PermissionService permissionService = PermissionService.getInstance(project, sessionId);
        permissionService.start();
        permissionService.registerDialogShower(project, (toolName, inputs) ->
            host.getPermissionHandler().showFrontendPermissionDialog(toolName, inputs));
        permissionService.registerAskUserQuestionDialogShower(project, (requestId, questionsData) ->
            host.getPermissionHandler().showAskUserQuestionDialog(requestId, questionsData));
        permissionService.registerPlanApprovalDialogShower(project, (requestId, planData) ->
            host.getPermissionHandler().showPlanApprovalDialog(requestId, planData));
        LOG.info("Started permission service with frontend dialog, AskUserQuestion dialog, and PlanApproval dialog for project: " + project.getName());
        return sessionId;
    }

    public void initializeHandlers() {
        Project project = host.getProject();
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        CodemossSettingsService settingsService = host.getSettingsService();

        HandlerContext.JsCallback jsCallback = new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                host.callJavaScript(functionName, args);
            }
            @Override
            public String escapeJs(String str) {
                return JsUtils.escapeJs(str);
            }
        };

        HandlerContext handlerContext = new HandlerContext(project, claudeSDKBridge, codexSDKBridge, settingsService, jsCallback);
        handlerContext.setSession(host.getSession());
        host.setHandlerContext(handlerContext);

        MessageDispatcher messageDispatcher = new MessageDispatcher();
        host.setMessageDispatcher(messageDispatcher);

        messageDispatcher.registerHandler(new ProviderHandler(handlerContext));
        messageDispatcher.registerHandler(new CustomModelPricingHandler(handlerContext, settingsService));
        messageDispatcher.registerHandler(new McpServerHandler(handlerContext));
        messageDispatcher.registerHandler(new McpMarketplaceHandler(handlerContext));
        messageDispatcher.registerHandler(new McpServerImportHandler(handlerContext));
        messageDispatcher.registerHandler(new CodexMcpServerHandler(handlerContext, settingsService.getCodexMcpServerManager()));
        messageDispatcher.registerHandler(new SkillHandler(handlerContext));
        messageDispatcher.registerHandler(new FileHandler(handlerContext));
        messageDispatcher.registerHandler(new SettingsHandler(handlerContext));
        messageDispatcher.registerHandler(new SessionHandler(handlerContext));
        messageDispatcher.registerHandler(new ContextHandler(handlerContext));
        messageDispatcher.registerHandler(new FileExportHandler(handlerContext));
        messageDispatcher.registerHandler(new DiffHandler(handlerContext));
        messageDispatcher.registerHandler(new PromptEnhancerHandler(handlerContext));
        messageDispatcher.registerHandler(new AgentHandler(handlerContext));
        messageDispatcher.registerHandler(new PromptHandler(handlerContext));
        messageDispatcher.registerHandler(new TabHandler(handlerContext));
        messageDispatcher.registerHandler(new RewindHandler(handlerContext));
        messageDispatcher.registerHandler(new UndoFileHandler(handlerContext));
        messageDispatcher.registerHandler(new DependencyHandler(handlerContext));
        messageDispatcher.registerHandler(new ClipboardHandler(handlerContext));
        messageDispatcher.registerHandler(new NodeProcessHandler(handlerContext));

        messageDispatcher.registerHandler(new WindowEventHandler(handlerContext, new WindowEventHandler.Callback() {
            @Override public void onHeartbeat(String content) { host.getWebviewWatchdog().handleHeartbeat(content); }
            @Override public void onTabLoadingChanged(boolean loading) { updateTabLoadingState(loading); }
            @Override public void onTabStatusChanged(String statusStr) {
                TabAnswerStatus status;
                switch (statusStr) {
                    case "answering":
                        status = TabAnswerStatus.ANSWERING;
                        break;
                    case "completed":
                        status = TabAnswerStatus.COMPLETED;
                        break;
                    default:
                        status = TabAnswerStatus.IDLE;
                        break;
                }
                updateTabStatus(status);
            }
            @Override public void onCreateNewSession() {
                host.getSessionLifecycleManager().createNewSession();
            }
            @Override public void onFrontendReady() { handleFrontendReady(); }
            @Override public void onRefreshSlashCommands() {
                host.getSessionLifecycleManager().fetchSlashCommandsOnStartup();
            }
        }));

        PermissionHandler permissionHandler = new PermissionHandler(handlerContext);
        permissionHandler.setPermissionDeniedCallback(host::interruptDueToPermissionDenial);
        host.setPermissionHandler(permissionHandler);
        messageDispatcher.registerHandler(permissionHandler);

        HistoryHandler historyHandler = new HistoryHandler(handlerContext);
        historyHandler.setSessionLoadCallback((sessionId, projectPath, provider) -> {
            ClaudeSession current = host.getSession();
            boolean sameSession = current != null
                    && sessionId != null
                    && sessionId.equals(current.getSessionId())
                    && (provider == null || provider.trim().isEmpty()
                                || provider.equals(current.getProvider()));
            if (sameSession) {
                // Re-opening the very session already active: soft-reload its transcript
                // instead of interrupting the in-flight turn.
                LOG.info("[HistoryHandler] Same-session resume, soft-reloading transcript: " + sessionId);
                host.reloadActiveSessionMessages();
            } else {
                host.getSessionLifecycleManager().loadHistorySession(sessionId, projectPath, provider);
            }
        });
        host.setHistoryHandler(historyHandler);
        messageDispatcher.registerHandler(historyHandler);

        LOG.info("Registered " + messageDispatcher.getHandlerCount() + " message handlers");
    }

    public void initializeStatusBar() {
        ApplicationManager.getApplication().invokeLater(() -> {
            Project project = host.getProject();
            if (project == null || host.isDisposed()) { return; }

            ClaudeSession session = host.getSession();
            String mode = session != null ? session.getPermissionMode() : "default";
            com.github.claudecodegui.notifications.ClaudeNotifier.setMode(project, mode);

            String model = session != null ? session.getModel() : "claude-sonnet-4-6";
            com.github.claudecodegui.notifications.ClaudeNotifier.setModel(project, model);

            try {
                CodemossSettingsService settingsService = host.getSettingsService();
                String selectedId = settingsService.getSelectedAgentId();
                if (selectedId != null) {
                    JsonObject agent = settingsService.getAgent(selectedId);
                    if (agent != null) {
                        String agentName = agent.has("name") ? agent.get("name").getAsString() : "Agent";
                        com.github.claudecodegui.notifications.ClaudeNotifier.setAgent(project, agentName);
                    }
                }
            } catch (Exception e) {
                LOG.warn("Failed to set initial agent in status bar: " + e.getMessage());
            }
        });
    }

    public void updateTabStatus(TabAnswerStatus status) {
        Content parentContent = host.getParentContent();
        String originalTabName = host.getOriginalTabName();
        if (parentContent == null || originalTabName == null) {
            LOG.warn("[TabStatus] Cannot update - parentContent or originalTabName is null");
            return;
        }

        if (status == currentTabStatus) {
            LOG.debug("[TabStatus] Skipping redundant update for tab: " + originalTabName);
            return;
        }

        currentTabStatus = status;

        if (statusResetTask != null && !statusResetTask.isDone()) {
            statusResetTask.cancel(false);
            statusResetTask = null;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            String tabName = originalTabName;
            String currentDisplayName = parentContent.getDisplayName();
            if (currentDisplayName != null && !currentDisplayName.startsWith(tabName)) {
                tabName = currentDisplayName.endsWith("...")
                    ? currentDisplayName.substring(0, currentDisplayName.length() - 3)
                    : currentDisplayName;
                host.setOriginalTabName(tabName);
                LOG.debug("[TabStatus] Detected external rename, updated originalTabName to: " + tabName);
            }

            String displayName;
            switch (status) {
                case ANSWERING:
                    displayName = tabName + "...";
                    LOG.debug("[TabStatus] Set answering state for tab: " + displayName);
                    break;
                case COMPLETED:
                    String completedText = ClaudeCodeGuiBundle.message("tab.status.completed");
                    displayName = tabName + " (" + completedText + ")";
                    LOG.debug("[TabStatus] Set completed state for tab: " + displayName);

                    statusResetTask = AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            updateTabStatus(TabAnswerStatus.IDLE);
                        });
                    }, STATUS_RESET_DELAY_SECONDS, TimeUnit.SECONDS);
                    break;
                case IDLE:
                default:
                    displayName = tabName;
                    LOG.debug("[TabStatus] Restored idle state for tab: " + displayName);
                    break;
            }
            parentContent.setDisplayName(displayName);
        });
    }

    @Deprecated
    public void updateTabLoadingState(boolean loading) {
        updateTabStatus(loading ? TabAnswerStatus.ANSWERING : TabAnswerStatus.IDLE);
    }

    public void sendQuickFixMessage(String prompt, boolean isQuickFix, MessageCallback callback) {
        ClaudeSession session = host.getSession();
        if (session == null) {
            LOG.warn("QuickFix: Session is null, cannot send message");
            ApplicationManager.getApplication().invokeLater(() -> {
                callback.onError("Session not initialized. Please wait for the tool window to fully load.");
            });
            return;
        }

        session.getContextCollector().setQuickFix(isQuickFix);

        if (!host.isFrontendReady()) {
            LOG.info("QuickFix: Frontend not ready, queuing message for later");
            pendingQuickFixPrompt = prompt;
            pendingQuickFixCallback = callback;
            return;
        }

        executeQuickFixInternal(prompt, callback);
    }

    private void executePendingQuickFix(String prompt, MessageCallback callback) {
        ClaudeSession session = host.getSession();
        if (session == null || host.isDisposed()) {
            ApplicationManager.getApplication().invokeLater(() -> {
                callback.onError("Session not available");
            });
            return;
        }
        executeQuickFixInternal(prompt, callback);
    }

    private void executeQuickFixInternal(String prompt, MessageCallback callback) {
        String escapedPrompt = JsUtils.escapeJs(prompt);
        host.callJavaScript("addUserMessage", escapedPrompt);
        host.callJavaScript("showLoading", "true");

        host.getSession().send(prompt, null, (String) null).thenRun(() -> {
            List<ClaudeSession.Message> messages = host.getSession().getMessages();
            if (!messages.isEmpty()) {
                ClaudeSession.Message last = messages.get(messages.size() - 1);
                if (last.type == ClaudeSession.Message.Type.ASSISTANT && last.content != null) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callback.onComplete(SDKResult.success(last.content));
                    });
                }
            }
        }).exceptionally(ex -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                callback.onError(ex.getMessage());
            });
            return null;
        });
    }

    public void handleFrontendReady() {
        LOG.info("Received frontend_ready signal, frontend is now ready to receive data");
        host.setFrontendReady(true);

        host.callJavaScript(
            "window.updateLinkifyCapabilities",
            JsUtils.escapeJs(OpenClassHandler.buildCapabilitiesJson())
        );
        host.getSessionLifecycleManager().sendCurrentPermissionMode();
        replayCurrentSessionStateToFrontend();
        host.persistTabSessionState();

        if (pendingQuickFixPrompt != null && pendingQuickFixCallback != null) {
            LOG.info("Processing pending QuickFix message after frontend ready");
            String prompt = pendingQuickFixPrompt;
            MessageCallback callback = pendingQuickFixCallback;
            pendingQuickFixPrompt = null;
            pendingQuickFixCallback = null;
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                executePendingQuickFix(prompt, callback);
            });
        }

        host.getStreamCoalescer().flush(null);
    }

    private void replayCurrentSessionStateToFrontend() {
        ClaudeSession session = host.getSession();
        if (session == null || host.isDisposed()) {
            return;
        }

        try {
            String sessionId = session.getSessionId();
            if (sessionId != null && !sessionId.trim().isEmpty()) {
                host.callJavaScript("setSessionId", JsUtils.escapeJs(sessionId));
            }

            List<ClaudeSession.Message> messages = session.getMessages();
            if (!messages.isEmpty()) {
                String messagesJson = MessageJsonConverter.convertMessagesToJson(messages);
                host.callJavaScript("updateMessages", JsUtils.escapeJs(messagesJson));
            }

            host.callJavaScript("showLoading", String.valueOf(session.isLoading()));
            host.callJavaScript("showThinkingStatus", String.valueOf(false));

            String summary = session.getSummary();
            if (summary != null && !summary.trim().isEmpty()) {
                host.callJavaScript("showSummary", JsUtils.escapeJs(summary));
            }

            // FIX: Restore streaming state after webview reload.
            // When the watchdog reloads the webview during active streaming, the frontend's
            // isStreamingRef is reset to false, causing all onContentDelta callbacks to be
            // silently dropped.  Re-sending onStreamStart ensures the frontend accepts
            // subsequent streaming deltas and the stall watchdog is properly initialized.
            boolean streamActive = host.getStreamCoalescer().isStreamActive();
            if (streamActive) {
                LOG.debug("Replaying streaming state to frontend (session was actively streaming during reload)");
                host.callJavaScript("onStreamStart", "replay");
            }

            LOG.info("Replayed current session state to frontend: sessionId="
                    + (sessionId != null ? sessionId : "(none)")
                    + ", messages=" + messages.size()
                    + ", loading=" + session.isLoading()
                    + ", streaming=" + streamActive);
        } catch (Exception e) {
            LOG.warn("Failed to replay current session state to frontend: " + e.getMessage(), e);
        }
    }

    public void dispose() {
        if (statusResetTask != null && !statusResetTask.isDone()) {
            statusResetTask.cancel(false);
            statusResetTask = null;
            LOG.debug("[TabStatus] Cancelled pending status reset task");
        }
    }
}
