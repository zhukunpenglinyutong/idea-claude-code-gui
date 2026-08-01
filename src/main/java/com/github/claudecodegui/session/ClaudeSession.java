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
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/**
 * Session management for Claude conversations.
 * Maintains state and message history for a single chat session.
 */
public class ClaudeSession {

    private static final Logger LOG = Logger.getInstance(ClaudeSession.class);

    /**
     * Observer SPI fired whenever {@link #interrupt()} is invoked on a session
     * that actually has a live channel to interrupt. Installed by the Remote
     * gateway so that <em>any</em> interrupt &mdash; the desktop Stop button, a
     * tab switch, a Remote {@code /abort}, or any other caller &mdash; marks the
     * active Remote task abort-requested and cancels its pending interactions
     * (Phase 2C-C §21 shared interrupt observation). ClaudeSession itself does
     * not depend on the remote package; it only publishes the event.
     */
    public interface InterruptObserver {
        void onInterrupt(ClaudeSession session);
    }

    private static final java.util.concurrent.atomic.AtomicReference<InterruptObserver>
            interruptObserver = new java.util.concurrent.atomic.AtomicReference<>();

    /**
     * Install the process-wide interrupt observer. Returns the observer so the
     * caller can later uninstall it with {@link #uninstallInterruptObserver}
     * (Phase 2C-C.1 §5 — owner-based lifecycle).
     */
    public static InterruptObserver installInterruptObserver(InterruptObserver observer) {
        interruptObserver.set(observer);
        return observer;
    }

    /** Uninstall only if {@code observer} is still the current one. */
    public static void uninstallInterruptObserver(InterruptObserver observer) {
        interruptObserver.compareAndSet(observer, null);
    }

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

    /**
     * Immutable provider + channel identity for the currently executing Agent turn.
     * {@code null} when no turn is active. Set synchronously at turn start (after
     * {@link #launchClaude()} allocates the channelId) and cleared via CAS on terminal
     * completion. Turn Identity Freeze Closure: all turn lifecycle operations — launch,
     * send, interrupt, Desktop Stop, Remote Abort, Gateway dispose, clearAbort — target
     * this identity, never the mutable {@link SessionState}.
     */
    private final java.util.concurrent.atomic.AtomicReference<TurnIdentity> activeTurnIdentity =
            new java.util.concurrent.atomic.AtomicReference<>();

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

        /**
         * Called when a Claude Code task_* SDK system event is received
         * (task_started / task_progress / task_notification).
         *
         * <p>Async subagents (Agent/Task tool invoked with run_in_background:true) run
         * in a background sidechain whose detailed
         * messages never enter the main SDK stream. The main stream only carries these
         * lightweight system events, which carry the agent's lifecycle signals: launch,
         * per-tool progress, and terminal completion (with result + usage). Forwarding
         * them to the frontend lets the subagent list reflect real running/completed
         * state instead of being stuck on the launch summary.</p>
         */
        default void onTaskEvent(String eventJson) {
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

    /**
     * The session's {@link CallbackHandler}, so non-desktop subscribers (e.g. the
     * Remote event tap) can be added without going through the primary
     * {@link SessionCallback} that drives the WebView.
     */
    public CallbackHandler getCallbackHandler() {
        return callbackFacade.getCallbackHandler();
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

    /**
     * Returns the frozen turn identity for the currently executing Agent turn,
     * or {@code null} if no turn is active. Package-private for tests.
     */
    TurnIdentity getActiveTurnIdentity() {
        return activeTurnIdentity.get();
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
     * Synchronously allocate (or reuse) the channel identity for a turn.
     *
     * <p>Does NOT schedule any async work — only captures the immutable
     * {@code TurnIdentity}. Caller must publish it as {@link #activeTurnIdentity}
     * BEFORE any async provider launch/send work begins.
     *
     * <p>The original {@link #launchClaude()} is preserved for idle/restart
     * paths where no TurnIdentity is needed.
     */
    private TurnIdentity establishTurnIdentity() {
        String channelId = state.getChannelId();
        if (channelId == null) {
            state.setError(null);
            channelId = UUID.randomUUID().toString();
            state.setChannelId(channelId);
        }
        return new TurnIdentity(state.getProvider(), channelId);
    }

    /**
     * Async provider launch using the FROZEN turn identity — never reads
     * mutable {@link SessionState} for provider or channelId.
     *
     * @param turnId the turn identity established by {@link #establishTurnIdentity()}
     */
    private CompletableFuture<String> launchClaudeForTurn(TurnIdentity turnId) {
        String channelId = turnId.channelId();
        return CompletableFuture.supplyAsync(() -> {
                    try {
                        // Validate and clean invalid sessionId (e.g., path instead of UUID)
                        String currentSessionId = state.getSessionId();
                        if (currentSessionId != null && (currentSessionId.contains("/") || currentSessionId.contains("\\"))) {
                            LOG.warn("sessionId looks like a path, resetting: " + currentSessionId);
                            state.setSessionId(null);
                            currentSessionId = null;
                        }

                        // Use FROZEN turn identity — never mutable state for this turn.
                        String currentCwd = state.getCwd();
                        JsonObject result = providerRouter.launchChannel(
                                turnId.provider(),
                                turnId.channelId(),
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

                        return channelId;
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
     * Launch Claude agent (idle/restart path — no active turn identity needed).
     * Reuses existing channelId if available, otherwise creates a new one.
     *
     * <p>For active-turn sends, use {@link #establishTurnIdentity()} +
     * {@link #launchClaudeForTurn(TurnIdentity)} instead so the frozen identity
     * is published BEFORE any async work begins.
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

        // ── Turn Identity Freeze Closure ──────────────────────────────────
        //
        // 1. SYNCHRONOUSLY allocate/reuse channelId + capture provider.
        //    No async work has been scheduled yet. This is ONE synchronous
        //    step — identity allocation and TurnIdentity creation are the
        //    same lifecycle event.
        //
        // 2. PUBLISH the identity as the active turn BEFORE scheduling any
        //    async work, so interrupt()/clearAbort() can find it from the
        //    earliest possible moment.
        //
        // 3. ASYNC launch/send/cleanup all use this frozen identity.
        final TurnIdentity turnId = establishTurnIdentity();
        activeTurnIdentity.set(turnId);

        return launchClaudeForTurn(turnId).thenCompose(chId -> {            sendService.prepareContextCollector(contextCollector);

            return contextCollector.collectContext().thenCompose(openedFilesJson ->
                    sendService.sendMessageToProvider(
                            turnId.provider(),
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
        }).whenComplete((v, ex) -> {
            // Clear the provider bridge's abort state so the next turn is not
            // falsely aborted by a stale interrupt. Uses the frozen turn
            // identity. CAS ensures an old turn completion can never clear a
            // newer turn identity (Turn Identity Freeze Closure).
            try {
                providerRouter.clearAbort(turnId.provider(), turnId.channelId());
            } catch (Throwable ignored) {
            } finally {
                activeTurnIdentity.compareAndSet(turnId, null);
            }
        });
    }

    private CompletableFuture<Void> syncUserMessageUuidsAfterSend() {
        return messageOrchestrator.syncUserMessageUuidsAfterSend();
    }

    /**
     * Interrupt the current execution.
     *
     * <p>Uses the frozen {@link #activeTurnIdentity} (Turn Identity Freeze Closure)
     * so interrupt always targets the real active turn's provider + channel, even if
     * mutable {@link SessionState} has changed between turn start and interrupt.
     */
    public CompletableFuture<Void> interrupt() {
        // Use frozen turn identity — never mutable SessionState for an active turn.
        TurnIdentity turnId = activeTurnIdentity.get();
        String provider;
        String channelId;
        if (turnId != null) {
            provider = turnId.provider();
            channelId = turnId.channelId();
        } else {
            // No active turn — fall back to SessionState for non-turn interrupts
            // (e.g., idle restart, early lifecycle).
            provider = state.getProvider();
            channelId = state.getChannelId();
        }
        if (channelId == null) {
            return CompletableFuture.completedFuture(null);
        }

        // Notify the shared interrupt observer (Remote gateway) so an active
        // Remote task is marked abort-requested + pending interactions cancelled,
        // regardless of who initiated the interrupt (Phase 2C-C §21).
        InterruptObserver observer = interruptObserver.get();
        if (observer != null) {
            try {
                observer.onInterrupt(this);
            } catch (Throwable t) {
                LOG.warn("[Interrupt] observer threw: " + t.getMessage(), t);
            }
        }

        return CompletableFuture.runAsync(() -> {
            try {
                providerRouter.interruptChannel(provider, channelId);
                if (!isCurrentChannel(provider, channelId)) {
                    return;
                }
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
                if (isCurrentChannel(provider, channelId)) {
                    state.setError(e.getMessage());
                    state.setLoading(false);  // Also reset loading on error
                    callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
                }
                throw new CompletionException(e);
            }
        });
    }

    private boolean isCurrentChannel(String provider, String channelId) {
        return Objects.equals(provider, state.getProvider())
                && Objects.equals(channelId, state.getChannelId());
    }

    /**
     * Restart the Claude agent.
     */
    public CompletableFuture<Void> restart() {
        return interrupt().thenCompose(v -> {
            activeTurnIdentity.set(null);
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
