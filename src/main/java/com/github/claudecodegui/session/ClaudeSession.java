package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionManager;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Session management for Claude conversations.
 * Maintains state and message history for a single chat session.
 */
public class ClaudeSession {

    private static final Logger LOG = Logger.getInstance(ClaudeSession.class);

    /**
     * Maximum file size for Codex context injection (100KB)
     */
    private static final int MAX_FILE_SIZE_BYTES = 100 * 1024;

    private final Gson gson = new Gson();
    private final Project project;
    /** Start time of the latest submitted turn, retained across Webview rebuilds. */
    private volatile long lastTurnStartedAtMillis;

    // Session state manager
    private final com.github.claudecodegui.session.SessionState state;

    // Message processors
    private final com.github.claudecodegui.session.MessageParser messageParser;
    private final com.github.claudecodegui.session.MessageMerger messageMerger;

    // Context collector
    private final com.github.claudecodegui.session.EditorContextCollector contextCollector;
    private final SessionContextService contextService;
    private final SessionProviderRouter providerRouter;
    private final SessionSendService sendService;
    private final SessionMessageOrchestrator messageOrchestrator;

    // Callback facade
    private final SessionCallbackFacade callbackFacade;

    // SDK bridges
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;

    // Permission manager
    private final PermissionManager permissionManager = new PermissionManager();

    /**
     * Represents a single message in the conversation.
     */
    public static class Message {
        public enum Type {
            USER, ASSISTANT, SYSTEM, ERROR
        }

        public Type type;
        public String content;
        public long timestamp;
        public JsonObject raw; // Raw message data from SDK

        public Message(Type type, String content) {
            this.type = type;
            this.content = content;
            this.timestamp = System.currentTimeMillis();
        }

        public Message(Type type, String content, JsonObject raw) {
            this(type, content);
            this.raw = raw;
        }
    }

    /**
     * Callback interface for session events.
     */
    public interface SessionCallback {
        void onMessageUpdate(List<Message> messages);

        void onStateChange(boolean busy, boolean loading, String error);

        default void onStatusMessage(String message) {
        }

        void onSessionIdReceived(String sessionId);

        void onPermissionRequested(PermissionRequest request);

        void onThinkingStatusChanged(boolean isThinking);

        void onSlashCommandsReceived(List<String> slashCommands);

        void onNodeLog(String log);

        void onSummaryReceived(String summary);

        // Streaming callback methods (with default implementations for backward compatibility)
        default void onStreamStart() {
        }

        default void onStreamEnd() {
        }

        default void onContentDelta(String delta) {
        }

        default void onThinkingDelta(String delta) {
        }

        /**
         * Called when a block reset signal is received during streaming.
         * This indicates a new assistant message has started within the stream
         * (e.g., after a tool_use loop iteration), and the frontend should
         * clear its streaming content refs to prevent cross-turn content merging.
         */
        default void onBlockReset() {
        }

        default void onUsageUpdate(int usedTokens, int maxTokens) {
        }

        default void onUserMessageUuidPatched(String content, String uuid) {
        }
    }

    public ClaudeSession(Project project, ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.project = project;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;

        // Initialize managers
        this.state = new com.github.claudecodegui.session.SessionState();
        this.messageParser = new com.github.claudecodegui.session.MessageParser();
        this.messageMerger = new com.github.claudecodegui.session.MessageMerger();
        this.contextCollector = new com.github.claudecodegui.session.EditorContextCollector(project);
        this.callbackFacade = new SessionCallbackFacade(project);
        this.contextService = new SessionContextService(project, MAX_FILE_SIZE_BYTES);
        this.providerRouter = new SessionProviderRouter(claudeSDKBridge, codexSDKBridge);
        this.sendService = new SessionSendService(
                project,
                state,
                callbackFacade,
                messageParser,
                messageMerger,
                gson,
                claudeSDKBridge,
                codexSDKBridge,
                contextService
        );
        this.messageOrchestrator = new SessionMessageOrchestrator(
                project,
                state,
                messageParser,
                callbackFacade,
                new SessionMessageOrchestrator.SessionHistoryAccess() {
                    @Override
                    public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
                        return providerRouter.getSessionMessages(provider, sessionId, cwd);
                    }

                    @Override
                    public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
                        return claudeSDKBridge.getLatestClaudeUserMessage(sessionId, cwd);
                    }
                }
        );

        // Set up permission manager callback
        permissionManager.setOnPermissionRequestedCallback(request -> {
            callbackFacade.notifyPermissionRequested(request);
        });
    }

    public void setCallback(SessionCallback callback) {
        callbackFacade.setCallback(callback);
    }

    public com.github.claudecodegui.session.EditorContextCollector getContextCollector() {
        return contextCollector;
    }

    // Getters - delegated to SessionState
    public String getSessionId() {
        return state.getSessionId();
    }

    public String getChannelId() {
        return state.getChannelId();
    }

    public boolean isBusy() {
        return state.isBusy();
    }

    public boolean isLoading() {
        return state.isLoading();
    }

    public String getError() {
        return state.getError();
    }

    public List<Message> getMessages() {
        return state.getMessages();
    }

    /**
     * 提供底层会话状态访问，用于历史恢复等需要直接重建会话内存态的场景。
     */
    public SessionState getState() {
        return state;
    }

    public String getSummary() {
        return state.getSummary();
    }

    public long getLastModifiedTime() {
        return state.getLastModifiedTime();
    }

    /**
     * Set session ID and working directory (used for session restoration).
     */
    public void setSessionInfo(String sessionId, String cwd) {
        state.setSessionId(sessionId);
        if (sessionId != null && !sessionId.trim().isEmpty()) {
            callbackFacade.notifySessionIdReceived(sessionId);
        }
        if (cwd != null) {
            setCwd(cwd);
        } else {
            state.setCwd(null);
        }
    }

    /**
     * Get the current working directory.
     */
    public String getCwd() {
        return state.getCwd();
    }

    /**
     * Set the working directory.
     */
    public void setCwd(String cwd) {
        state.setCwd(cwd);
        LOG.info("Working directory updated to: " + cwd);
    }

    /**
     * Launch Claude agent.
     * Reuses existing channelId if available, otherwise creates a new one.
     */
    public CompletableFuture<String> launchClaude() {
        if (state.getChannelId() != null) {
            return CompletableFuture.completedFuture(state.getChannelId());
        }

        state.setError(null);
        state.setChannelId(UUID.randomUUID().toString());

        return CompletableFuture.supplyAsync(() -> {
                    try {
                        // Validate and clean invalid sessionId (e.g., path instead of UUID)
                        String currentSessionId = state.getSessionId();
                        if (currentSessionId != null && (currentSessionId.contains("/") || currentSessionId.contains("\\"))) {
                            LOG.warn("sessionId looks like a path, resetting: " + currentSessionId);
                            state.setSessionId(null);
                            currentSessionId = null;
                        }

                        // Select SDK based on provider
                        String currentProvider = state.getProvider();
                        String currentChannelId = state.getChannelId();
                        String currentCwd = state.getCwd();
                        JsonObject result = providerRouter.launchChannel(
                                currentProvider,
                                currentChannelId,
                                currentSessionId,
                                currentCwd
                        );

                        // Check if sessionId exists and is not null
                        if (result.has("sessionId") && !result.get("sessionId").isJsonNull()) {
                            String newSessionId = result.get("sessionId").getAsString();
                            // Validate sessionId format (should be UUID format)
                            if (!newSessionId.contains("/") && !newSessionId.contains("\\")) {
                                state.setSessionId(newSessionId);
                                callbackFacade.notifySessionIdReceived(newSessionId);
                            } else {
                                LOG.warn("Ignoring invalid sessionId: " + newSessionId);
                            }
                        }

                        return currentChannelId;
                    } catch (Exception e) {
                        state.setError(e.getMessage());
                        state.setChannelId(null);
                        callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
                        throw new RuntimeException("Failed to launch: " + e.getMessage(), e);
                    }
                }).orTimeout(com.github.claudecodegui.config.TimeoutConfig.QUICK_OPERATION_TIMEOUT,
                        com.github.claudecodegui.config.TimeoutConfig.QUICK_OPERATION_UNIT)
                .exceptionally(ex -> {
                    if (ex instanceof java.util.concurrent.TimeoutException) {
                        String timeoutMsg = "Channel launch timed out (" +
                                com.github.claudecodegui.config.TimeoutConfig.QUICK_OPERATION_TIMEOUT + "s), please retry";
                        LOG.warn(timeoutMsg);
                        state.setError(timeoutMsg);
                        state.setChannelId(null);
                        callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
                        throw new RuntimeException(timeoutMsg);
                    }
                    throw new RuntimeException(ex.getCause());
                });
    }

    /**
     * Send a message using global agent settings.
     *
     * @deprecated Use {@link #send(String, String)} with explicit agent prompt instead.
     */
    @Deprecated
    public CompletableFuture<Void> send(String input) {
        return send(input, (List<Attachment>) null, null);
    }

    /**
     * Send a message with a specific agent prompt.
     * Used for per-tab independent agent selection.
     */
    public CompletableFuture<Void> send(String input, String agentPrompt) {
        return send(input, null, agentPrompt, null, null);
    }

    /**
     * Send a message with a specific agent prompt and file tags.
     * Used for Codex context injection.
     */
    public CompletableFuture<Void> send(String input, String agentPrompt, List<String> fileTagPaths) {
        return send(input, null, agentPrompt, fileTagPaths, null);
    }

    /**
     * Send a message with a specific agent prompt, file tags and requested permission mode.
     * requestedPermissionMode priority: payload > sessionMode > default.
     */
    public CompletableFuture<Void> send(String input, String agentPrompt, List<String> fileTagPaths, String requestedPermissionMode) {
        return send(input, null, agentPrompt, fileTagPaths, requestedPermissionMode, null, null);
    }

    /**
     * Send a message with a specific agent prompt, file tags, requested permission mode,
     * and requested reasoning effort.
     */
    public CompletableFuture<Void> send(
            String input,
            String agentPrompt,
            List<String> fileTagPaths,
            String requestedPermissionMode,
            String requestedReasoningEffort
    ) {
        return send(input, null, agentPrompt, fileTagPaths, requestedPermissionMode, requestedReasoningEffort, null);
    }

    /**
     * Send a message with a specific agent prompt, file tags, requested permission mode,
     * requested reasoning effort, and Codex fast mode.
     * The Codex fast mode maps to the official service tier used by Codex CLI /fast.
     */
    public CompletableFuture<Void> send(
            String input,
            String agentPrompt,
            List<String> fileTagPaths,
            String requestedPermissionMode,
            String requestedReasoningEffort,
            String requestedCodexFastMode
    ) {
        return send(input, null, agentPrompt, fileTagPaths, requestedPermissionMode, requestedReasoningEffort, requestedCodexFastMode);
    }

    /**
     * Send a message with attachments using global agent settings.
     *
     * @deprecated Use {@link #send(String, List, String)} with explicit agent prompt instead.
     */
    @Deprecated
    public CompletableFuture<Void> send(String input, List<Attachment> attachments) {
        return send(input, attachments, null, null, null);
    }

    /**
     * Send a message with attachments and a specific agent prompt.
     * Used for per-tab independent agent selection.
     *
     * @param input       User input text
     * @param attachments List of attachments (nullable)
     * @param agentPrompt Agent prompt (falls back to global setting if null)
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments, String agentPrompt) {
        return send(input, attachments, agentPrompt, null, null);
    }

    /**
     * Send a message with attachments, agent prompt, and file tags.
     * Used for Codex context injection.
     *
     * @param input        User input text
     * @param attachments  List of attachments (nullable)
     * @param agentPrompt  Agent prompt (falls back to global setting if null)
     * @param fileTagPaths File tag paths for Codex context injection
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments, String agentPrompt, List<String> fileTagPaths) {
        return send(input, attachments, agentPrompt, fileTagPaths, null);
    }

    /**
     * Send a message with attachments, agent prompt, file tags, and a requested permission mode.
     * The effective mode is resolved with priority:
     * Priority: requestedPermissionMode > sessionMode > default.
     */
    public CompletableFuture<Void> send(
            String input,
            List<Attachment> attachments,
            String agentPrompt,
            List<String> fileTagPaths,
            String requestedPermissionMode
    ) {
        return send(input, attachments, agentPrompt, fileTagPaths, requestedPermissionMode, null, null);
    }

    /**
     * Send a message with attachments, agent prompt, file tags, requested permission mode,
     * requested reasoning effort, and Codex fast mode.
     * The effective mode is resolved with priority:
     * Priority: requestedPermissionMode > sessionMode > default.
     * The Codex fast mode maps to the official service tier used by Codex CLI /fast.
     */
    public CompletableFuture<Void> send(
            String input,
            List<Attachment> attachments,
            String agentPrompt,
            List<String> fileTagPaths,
            String requestedPermissionMode,
            String requestedReasoningEffort,
            String requestedCodexFastMode
    ) {
        lastTurnStartedAtMillis = System.currentTimeMillis();
        String normalizedInput = (input != null) ? input.trim() : "";
        Message userMessage = contextService.buildUserMessage(normalizedInput, attachments);
        sendService.updateSessionStateForSend(userMessage, normalizedInput);

        final String finalAgentPrompt = agentPrompt;
        final List<String> finalFileTagPaths = fileTagPaths;
        final String finalRequestedPermissionMode = requestedPermissionMode;
        final String finalRequestedReasoningEffort = requestedReasoningEffort;
        final String finalRequestedCodexFastMode = requestedCodexFastMode;

        return launchClaude().thenCompose(chId -> {
            sendService.prepareContextCollector(contextCollector);

            return contextCollector.collectContext().thenCompose(openedFilesJson ->
                    sendService.sendMessageToProvider(
                            chId,
                            userMessage.content,
                            attachments,
                            openedFilesJson,
                            finalAgentPrompt,
                            finalFileTagPaths,
                            finalRequestedPermissionMode,
                            finalRequestedReasoningEffort,
                            finalRequestedCodexFastMode
                    )
            ).thenCompose(v -> syncUserMessageUuidsAfterSend());
        }).exceptionally(ex -> {
            state.setError(ex.getMessage());
            state.setBusy(false);
            state.setLoading(false);
            callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
            return null;
        });
    }

    private CompletableFuture<Void> syncUserMessageUuidsAfterSend() {
        return messageOrchestrator.syncUserMessageUuidsAfterSend();
    }

    /**
     * Interrupt the current execution.
     */
    public CompletableFuture<Void> interrupt() {
        if (state.getChannelId() == null) {
            return CompletableFuture.completedFuture(null);
        }

        return CompletableFuture.runAsync(() -> {
            try {
                providerRouter.interruptChannel(state.getProvider(), state.getChannelId());
                state.setError(null);  // Clear previous error state
                state.setBusy(false);
                state.setLoading(false);  // Also reset loading state

                // Note: We intentionally don't call notifyStreamEnd() here because:
                // 1. The frontend's interruptSession() already cleans up streaming state directly
                // 2. Calling notifyStreamEnd() would trigger flushStreamMessageUpdates(),
                //    which might restore previous messages via lastMessagesSnapshot, interfering with clearMessages
                // 3. State reset is notified via callbackFacade.notifyStateChange()

                callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
            } catch (Exception e) {
                state.setError(e.getMessage());
                state.setLoading(false);  // Also reset loading on error
                callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
            }
        });
    }

    /**
     * Restart the Claude agent.
     */
    public CompletableFuture<Void> restart() {
        return interrupt().thenCompose(v -> {
            state.setChannelId(null);
            state.setBusy(false);
            callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
            return launchClaude().thenApply(chId -> null);
        });
    }

    /**
     * Load message history from the server.
     */
    public CompletableFuture<Void> loadFromServer() {
        return messageOrchestrator.loadFromServer();
    }

    /**
     * Represents a file attachment (e.g., image).
     */
    public static class Attachment {
        public String fileName;
        public String mediaType;
        public String data; // Base64 encoded data

        public Attachment(String fileName, String mediaType, String data) {
            this.fileName = fileName;
            this.mediaType = mediaType;
            this.data = data;
        }
    }

    /**
     * Get the permission manager.
     */
    public PermissionManager getPermissionManager() {
        return permissionManager;
    }

    /**
     * Set the permission mode.
     * Maps frontend permission mode strings to PermissionManager enum values.
     */
    public void setPermissionMode(String mode) {
        state.setPermissionMode(mode);

        // Sync PermissionManager mode with frontend mode:
        // - "default" -> DEFAULT (ask every time)
        // - "acceptEdits"/"autoEdit" -> ACCEPT_EDITS (agent mode, auto-accept file edits)
        // - "bypassPermissions" -> ALLOW_ALL (auto mode, bypass all permission checks)
        // - "plan" -> DENY_ALL (plan mode, not yet supported)
        PermissionManager.PermissionMode pmMode;
        if ("bypassPermissions".equals(mode)) {
            pmMode = PermissionManager.PermissionMode.ALLOW_ALL;
            LOG.info("Permission mode set to ALLOW_ALL for mode: " + mode);
        } else if ("acceptEdits".equals(mode) || "autoEdit".equals(mode)) {
            pmMode = PermissionManager.PermissionMode.ACCEPT_EDITS;
            LOG.info("Permission mode set to ACCEPT_EDITS for mode: " + mode);
        } else if ("plan".equals(mode)) {
            pmMode = PermissionManager.PermissionMode.DENY_ALL;
            LOG.info("Permission mode set to DENY_ALL for mode: " + mode);
        } else {
            // "default" or other unknown modes
            pmMode = PermissionManager.PermissionMode.DEFAULT;
            LOG.info("Permission mode set to DEFAULT for mode: " + mode);
        }

        permissionManager.setPermissionMode(pmMode);
    }

    /**
     * Get the permission mode.
     */
    public String getPermissionMode() {
        return state.getPermissionMode();
    }

    /**
     * Set the model.
     */
    public void setModel(String model) {
        state.setModel(model);
        LOG.info("Model updated to: " + model);
    }

    /**
     * Get the model.
     */
    public String getModel() {
        return state.getModel();
    }

    /**
     * Returns the start time of the latest submitted turn, or {@code 0} when
     * no turn has been submitted yet.
     */
    public long getLastTurnStartedAtMillis() {
        return lastTurnStartedAtMillis;
    }

    /**
     * Set the AI provider.
     */
    public void setProvider(String provider) {
        state.setProvider(provider);
        LOG.info("Provider updated to: " + provider);
    }

    /**
     * Get the AI provider.
     */
    public String getProvider() {
        return state.getProvider();
    }

    /**
     * Get the current runtime session epoch.
     */
    public String getRuntimeSessionEpoch() {
        return state.getRuntimeSessionEpoch();
    }

    /**
     * Rotate the runtime session epoch.
     */
    public String rotateRuntimeSessionEpoch() {
        String epoch = state.rotateRuntimeSessionEpoch();
        LOG.info("[Lifecycle] Rotated runtime session epoch to: " + epoch);
        return epoch;
    }

    /**
     * Set the reasoning effort level.
     */
    public void setReasoningEffort(String effort) {
        state.setReasoningEffort(effort);
        LOG.info("Reasoning effort updated to: " + effort);
    }

    /**
     * Get the reasoning effort level.
     */
    public String getReasoningEffort() {
        return state.getReasoningEffort();
    }

    /**
     * Set the Codex service tier. Null means use Codex defaults; "fast" matches Codex CLI /fast.
     */
    public void setCodexServiceTier(String serviceTier) {
        state.setCodexServiceTier(serviceTier);
        LOG.info("Codex service tier updated to: " + (serviceTier != null ? serviceTier : "standard"));
    }

    /**
     * Get the Codex service tier.
     */
    public String getCodexServiceTier() {
        return state.getCodexServiceTier();
    }

    /**
     * Get the list of available slash commands.
     */
    public List<String> getSlashCommands() {
        return state.getSlashCommands();
    }


    /**
     * Create a permission request (called by the SDK).
     */
    public PermissionRequest createPermissionRequest(String toolName, Map<String, Object> inputs, JsonObject suggestions, Project project) {
        return permissionManager.createRequest(state.getChannelId(), toolName, inputs, suggestions, project);
    }

    /**
     * Handle a permission decision.
     */
    public void handlePermissionDecision(String channelId, boolean allow, boolean remember, String rejectMessage) {
        permissionManager.handlePermissionDecision(channelId, allow, remember, rejectMessage);
    }

    /**
     * Handle an "always allow" permission decision.
     */
    public void handlePermissionDecisionAlways(String channelId, boolean allow) {
        permissionManager.handlePermissionDecisionAlways(channelId, allow);
    }
}
