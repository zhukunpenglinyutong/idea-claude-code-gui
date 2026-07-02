package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.SDKResult;

import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Claude Agent SDK bridge.
 * Handles Java to Node.js SDK communication, supports async and streaming responses.
 */
public class ClaudeSDKBridge extends BaseSDKBridge {

    private final ClaudeStreamAdapter streamAdapter;
    private final ClaudeRequestParamsBuilder requestParamsBuilder;
    private final ClaudeJsonOutputExtractor jsonOutputExtractor;
    private final ClaudeDaemonCoordinator daemonCoordinator;
    private final ClaudeProcessInvoker processInvoker;
    private final ClaudeQueryExecutor queryExecutor;
    private final ClaudeSessionQueryService sessionQueryService;
    private final ClaudeMcpQueryService mcpQueryService;
    private final ClaudeRewindService rewindService;
    private final ClaudeDaemonRequestExecutor daemonRequestExecutor;

    public ClaudeSDKBridge() {
        super(ClaudeSDKBridge.class);

        // Shared dependencies extracted once to avoid repeated lambda allocation
        java.util.function.Supplier<File> sdkDirSupplier = () -> getDirectoryResolver().findSdkDir();

        this.streamAdapter = new ClaudeStreamAdapter(gson);
        this.requestParamsBuilder = new ClaudeRequestParamsBuilder(gson);
        this.jsonOutputExtractor = new ClaudeJsonOutputExtractor();
        ClaudeLogSanitizer logSanitizer = new ClaudeLogSanitizer();

        this.daemonCoordinator = new ClaudeDaemonCoordinator(
                LOG, nodeDetector, this::getDirectoryResolver, envConfigurator
        );
        this.processInvoker = new ClaudeProcessInvoker(
                LOG, gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, requestParamsBuilder, logSanitizer, streamAdapter
        );
        this.queryExecutor = new ClaudeQueryExecutor(
                gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, jsonOutputExtractor
        );
        this.sessionQueryService = new ClaudeSessionQueryService(
                LOG, gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, jsonOutputExtractor
        );
        this.mcpQueryService = new ClaudeMcpQueryService(
                LOG, gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, jsonOutputExtractor
        );
        this.rewindService = new ClaudeRewindService(
                LOG, gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, jsonOutputExtractor
        );
        this.daemonRequestExecutor = new ClaudeDaemonRequestExecutor(
                LOG, requestParamsBuilder, streamAdapter, jsonOutputExtractor
        );
    }

    /**
     * Register a listener for custom daemon events (e.g., AI title generation).
     * Multiple listeners may coexist; callers MUST pair this with
     * {@link #removeDaemonEventListener} on disposal to avoid leaks.
     */
    public void addDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.addDaemonEventListener(listener);
    }

    /**
     * Unregister a previously added daemon event listener.
     */
    public void removeDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.removeDaemonEventListener(listener);
    }

    /**
     * Shut down the daemon process.
     */
    public void shutdownDaemon() {
        daemonCoordinator.shutdownDaemon();
    }

    /**
     * Returns the currently active daemon bridge (or null if no daemon is running).
     * Read-only access for the Node process management panel — do not start/stop
     * via this reference; use shutdownDaemon() or sendCommand() through the bridge instead.
     */
    public DaemonBridge getCurrentDaemonBridgeForInspection() {
        return daemonCoordinator.getCurrentDaemonBridge();
    }

    public void prewarmDaemonAsync(String cwd) {
        prewarmDaemonAsync(cwd, null);
    }

    /**
     * Prewarm daemon asynchronously to reduce first-message latency.
     */
    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch) {
        daemonCoordinator.prewarmDaemonAsync(normalizeCwdForNode(cwd), runtimeSessionEpoch, null);
    }

    /**
     * Prewarm daemon asynchronously for a specific session.
     * Creates a runtime that loads the session's context via --resume.
     *
     * @param cwd Working directory
     * @param runtimeSessionEpoch Session epoch for cache invalidation
     * @param sessionId The historical session ID to resume
     */
    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch, String sessionId) {
        daemonCoordinator.prewarmDaemonAsync(normalizeCwdForNode(cwd), runtimeSessionEpoch, sessionId);
    }

    public void resetPersistentRuntime(String runtimeSessionEpoch) {
        daemonCoordinator.resetPersistentRuntime(runtimeSessionEpoch);
    }

    @Override
    public void cleanupAllProcesses() {
        shutdownDaemon();
        super.cleanupAllProcesses();
    }

    /**
     * Interrupt a channel. In daemon mode, sends an abort command to cancel the
     * active request. Also delegates to ProcessManager for per-process fallback.
     */
    @Override
    public void interruptChannel(String channelId) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db != null && db.isAlive()) {
            LOG.info("[ClaudeSDKBridge] Sending daemon abort for channel: " + channelId);
            try {
                db.sendAbort();
            } catch (Exception e) {
                LOG.error("[ClaudeSDKBridge] Daemon abort failed: " + e.getMessage());
            }
        }
        // Also try per-process interrupt (covers per-process fallback mode)
        super.interruptChannel(channelId);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "claude";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("CLAUDE_USE_STDIN", "true");
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[GET_SESSION_ERROR]")
                || line.startsWith("[PERSIST_ERROR]")) {
            LOG.warn("[Node.js ERROR] " + line);
        }
        streamAdapter.processOutputLine(line, callback, result, assistantContent, hadSendError, lastNodeError);
    }

    // ============================================================================
    // Node.js detection methods (Claude-specific extensions)
    // ============================================================================

    /**
     * Detect Node.js and return detailed results.
     */
    public NodeDetectionResult detectNodeWithDetails() {
        return nodeDetector.detectNodeWithDetails();
    }

    /**
     * Clear Node.js detection cache.
     */
    public void clearNodeCache() {
        nodeDetector.clearCache();
    }

    /**
     * Verify Node.js path and return version.
     */
    public String verifyNodePath(String path) {
        return nodeDetector.verifyNodePath(path);
    }

    /**
     * Get cached Node.js version.
     */
    public String getCachedNodeVersion() {
        return nodeDetector.getCachedNodeVersion();
    }

    /**
     * Get cached Node.js path.
     */
    public String getCachedNodePath() {
        return nodeDetector.getCachedNodePath();
    }

    /**
     * Verify and cache Node.js path.
     */
    public NodeDetectionResult verifyAndCacheNodePath(String path) {
        return nodeDetector.verifyAndCacheNodePath(path);
    }

    // ============================================================================
    // Bridge directory methods
    // ============================================================================

    /**
     * Set claude-bridge directory path manually.
     */
    public void setSdkTestDir(String path) {
        getDirectoryResolver().setSdkDir(path);
    }

    /**
     * Get current claude-bridge directory.
     */
    public File getSdkTestDir() {
        return getDirectoryResolver().getSdkDir();
    }

    // ============================================================================
    // Sync query methods (Claude-specific)
    // ============================================================================

    /**
     * Execute query synchronously (blocking).
     */
    public SDKResult executeQuerySync(String prompt) {
        return executeQuerySync(prompt, 60);
    }

    /**
     * Execute query synchronously with timeout.
     */
    public SDKResult executeQuerySync(String prompt, int timeoutSeconds) {
        return queryExecutor.executeQuerySync(prompt, timeoutSeconds);
    }

    /**
     * Execute query asynchronously.
     */
    public CompletableFuture<SDKResult> executeQueryAsync(String prompt) {
        return queryExecutor.executeQueryAsync(prompt);
    }

    /**
     * Execute query with streaming.
     */
    public CompletableFuture<SDKResult> executeQueryStream(String prompt, MessageCallback callback) {
        return queryExecutor.executeQueryStream(prompt, callback);
    }

    // ============================================================================
    // Multi-turn interaction support
    // ============================================================================

    /**
     * Send message in existing channel (streaming response).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, null, null, null, null, null, false, callback);
    }

    /**
     * Send message in existing channel (streaming response, with permission mode and model selection).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, permissionMode, model, openedFiles, agentPrompt, null, false, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, permissionMode, model, openedFiles, agentPrompt, streaming, false, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag and disableThinking).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, permissionMode,
                model, openedFiles, agentPrompt, streaming, disableThinking, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag and disableThinking).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, runtimeSessionEpoch, cwd, attachments, permissionMode,
                model, openedFiles, agentPrompt, streaming, disableThinking, null, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag, disableThinking, and reasoningEffort).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        String normalizedCwd = normalizeCwdForNode(cwd);

        // Try daemon mode first (avoids per-request Node.js process spawning)
        DaemonBridge db = daemonCoordinator.getDaemonBridge();
        if (db != null) {
            return sendMessageViaDaemon(db, channelId, message, sessionId, runtimeSessionEpoch, normalizedCwd,
                    attachments, permissionMode, model, openedFiles, agentPrompt,
                    streaming, disableThinking, reasoningEffort, callback);
        }

        // Fallback: per-process mode (spawns a new Node.js process per request)
        LOG.info("[ClaudeSDKBridge] Using per-process mode (daemon not available)");
        return processInvoker.sendMessage(
                channelId,
                message,
                sessionId,
                runtimeSessionEpoch,
                normalizedCwd,
                attachments,
                permissionMode,
                model,
                openedFiles,
                agentPrompt,
                streaming,
                disableThinking,
                reasoningEffort,
                callback
        );
    }

    /**
     * Get session history messages.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return sessionQueryService.getSessionMessages(sessionId, cwd);
    }

    public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
        return sessionQueryService.getLatestUserMessage(sessionId, cwd);
    }

    /**
     * Get MCP server connection status.
     */
    public CompletableFuture<List<JsonObject>> getMcpServerStatus(String cwd) {
        return mcpQueryService.getMcpServerStatus(normalizeCwdForNode(cwd));
    }

    /**
     * Get MCP server tools list.
     */
    public CompletableFuture<JsonObject> getMcpServerTools(String serverId) {
        return mcpQueryService.getMcpServerTools(serverId, null);
    }

    /**
     * Get MCP server tools list with working directory for project-specific config resolution.
     */
    public CompletableFuture<JsonObject> getMcpServerTools(String serverId, String cwd) {
        return mcpQueryService.getMcpServerTools(serverId, normalizeCwdForNode(cwd));
    }

    // ============================================================================
    // Rewind files support
    // ============================================================================

    /**
     * Rewind files to a specific user message state.
     * Uses the SDK's rewindFiles() API to restore files to their state at a given message.
     *
     * @param sessionId The session ID
     * @param userMessageId The user message UUID to rewind to
     * @param cwd Working directory for the session
     * @return CompletableFuture with the result
     */
    public CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId, String cwd) {
        return rewindService.rewindFiles(sessionId, userMessageId, cwd);
    }

    public CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId) {
        return rewindFiles(sessionId, userMessageId, null);
    }

    // ============================================================================
    // Context usage query
    // ============================================================================

    /**
     * Get context window usage breakdown from the active Claude runtime.
     * Calls the SDK's getContextUsage() API via the daemon process.
     *
     * @param sessionId The session ID to query context for
     * @param cwd Working directory
     * @param model The model ID to use for the runtime (e.g., "claude-opus-4-7")
     * @return CompletableFuture with context usage data as JsonObject
     */
    public CompletableFuture<JsonObject> getContextUsage(String sessionId, String cwd, String model) {
        DaemonBridge db = this.daemonCoordinator.getDaemonBridge();
        if (db == null) {
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", "Daemon not available. Context usage requires daemon mode.");
            return CompletableFuture.completedFuture(error);
        }

        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (cwd != null && !cwd.isEmpty()) {
            params.addProperty("cwd", cwd);
        }
        if (model != null && !model.isEmpty()) {
            params.addProperty("model", model);
        }

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                try {
                    JsonObject parsed = ClaudeSDKBridge.this.gson.fromJson(line, JsonObject.class);
                    resultRef.set(parsed);
                } catch (Exception ignored) {
                }
            }
            @Override
            public void onStderr(String text) { }
            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", error);
                    resultFuture.complete(err);
                }
            }
            @Override
            public void onComplete(boolean success) {
                if (!resultFuture.isDone()) {
                    if (success) {
                        JsonObject result = resultRef.get();
                        if (result != null) {
                            resultFuture.complete(result);
                        } else {
                            JsonObject err = new JsonObject();
                            err.addProperty("success", false);
                            err.addProperty("error", "No response received");
                            resultFuture.complete(err);
                        }
                    } else {
                        JsonObject err = new JsonObject();
                        err.addProperty("success", false);
                        err.addProperty("error", "getContextUsage command failed");
                        resultFuture.complete(err);
                    }
                }
            }
        };

        try {
            CompletableFuture<Boolean> commandFuture = db.sendCommand("claude.getContextUsage", params, callback);
            commandFuture.exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", ex.getMessage());
                    resultFuture.complete(err);
                }
                return false;
            });
        } catch (Exception e) {
            LOG.error("[ClaudeSDKBridge] getContextUsage failed: " + e.getMessage(), e);
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", e.getMessage());
            return CompletableFuture.completedFuture(err);
        }

        return resultFuture.orTimeout(180, TimeUnit.SECONDS).exceptionally(ex -> {
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", "getContextUsage timed out after 180 seconds (SDK may be loading)");
            return err;
        });
    }

    /**
     * Hot-swap the permission mode of the live daemon runtime mid-conversation.
     *
     * Pushes the new mode to the SDK query and the reactive state the PreToolUse
     * hook reads, so subsequent tool calls in the current turn honor it
     * immediately instead of waiting for the next user message.
     *
     * Fire-and-forget with a short guard timeout: when no daemon or no live
     * runtime is present this is a graceful no-op, and the next send_message
     * already carries the mode via the request payload.
     *
     * @param sessionId           The session whose runtime should be updated.
     * @param runtimeSessionEpoch The runtime epoch for logging/diagnostics (optional).
     * @param permissionMode      The normalized permission mode to apply.
     */
    public CompletableFuture<JsonObject> setPermissionModeLive(
            String sessionId, String runtimeSessionEpoch, String permissionMode) {
        // Use the non-spawning accessor: this is a best-effort push to whatever
        // daemon is already running. Spawning a fresh daemon here would block the
        // JCEF message thread and serve no purpose — a freshly started daemon has
        // no live runtime, so setPermissionModePersistent would be a no-op anyway.
        DaemonBridge db = this.daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            JsonObject skipped = new JsonObject();
            skipped.addProperty("success", true);
            skipped.addProperty("applied", false);
            skipped.addProperty("reason", "no-daemon");
            return CompletableFuture.completedFuture(skipped);
        }

        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (runtimeSessionEpoch != null && !runtimeSessionEpoch.isEmpty()) {
            params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch);
        }
        if (permissionMode != null && !permissionMode.isEmpty()) {
            params.addProperty("permissionMode", permissionMode);
        }

        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        // The setPermissionMode path only emits a {id, done, success} signal —
        // no streaming line output — so onLine is never invoked; we complete
        // purely from onComplete/onError.
        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) { }
            @Override
            public void onStderr(String text) { }
            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", error);
                    resultFuture.complete(err);
                }
            }
            @Override
            public void onComplete(boolean success) {
                if (!resultFuture.isDone()) {
                    JsonObject ok = new JsonObject();
                    ok.addProperty("success", success);
                    resultFuture.complete(ok);
                }
            }
        };

        try {
            CompletableFuture<Boolean> commandFuture = db.sendCommand("claude.setPermissionMode", params, callback);
            commandFuture.exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", ex.getMessage());
                    resultFuture.complete(err);
                }
                return false;
            });
        } catch (Exception e) {
            LOG.error("[ClaudeSDKBridge] setPermissionModeLive failed: " + e.getMessage(), e);
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", e.getMessage());
            return CompletableFuture.completedFuture(err);
        }

        return resultFuture.orTimeout(10, TimeUnit.SECONDS).exceptionally(ex -> {
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", "setPermissionMode timed out after 10 seconds");
            return err;
        });
    }

    // ============================================================================
    // Daemon mode message sending
    // ============================================================================

    /**
     * Send message via the long-running daemon process.
     * This avoids the ~5-10s overhead of spawning a new Node.js process per request.
     */
    private CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return daemonRequestExecutor.sendMessageViaDaemon(
                daemon,
                channelId,
                message,
                sessionId,
                runtimeSessionEpoch,
                cwd,
                attachments,
                permissionMode,
                model,
                openedFiles,
                agentPrompt,
                streaming,
                disableThinking,
                reasoningEffort,
                callback
        );
    }

    /**
     * Converts a Windows-style cwd to a WSL path when the active node executable is a WSL binary.
     * On non-WSL setups this is a no-op.
     */
    private String normalizeCwdForNode(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            LOG.info("[ClaudeSDKBridge.normalizeCwdForNode] cwd is null/empty, no-op");
            return cwd;
        }
        String nodePath = nodeDetector.getCachedNodePath();
        boolean isWsl = nodePath != null && NodeDetector.isWslPath(nodePath);
        String result = isWsl ? NodeDetector.convertToWslPath(cwd) : cwd;
        LOG.info("[ClaudeSDKBridge.normalizeCwdForNode] cwd=" + cwd
                + " nodePath=" + nodePath
                + " isWsl=" + isWsl
                + " result=" + result);
        return result;
    }
}
