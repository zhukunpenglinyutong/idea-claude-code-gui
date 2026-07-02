package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import com.github.claudecodegui.handler.history.HistoryMessageInjector;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Codex SDK bridge.
 * Handles Java to Node.js Codex SDK communication, supports streaming responses.
 * Uses unified ai-bridge directory (shared with Claude).
 */
public class CodexSDKBridge extends BaseSDKBridge {

    // Codex API configuration
    private String baseUrl = null;
    private String apiKey = null;
    private static final String SANDBOX_MODE_WORKSPACE_WRITE = "workspace-write";
    private static final String SANDBOX_MODE_DANGER_FULL_ACCESS = "danger-full-access";
    private static final String SANDBOX_MODE_READ_ONLY = "read-only";
    private static final String APPROVAL_POLICY_NEVER = "never";
    private static final String APPROVAL_POLICY_ON_REQUEST = "on-request";
    private static final String APPROVAL_POLICY_UNTRUSTED = "untrusted";
    private static final String ENV_CODEX_APPROVAL_POLICY = "CODEX_APPROVAL_POLICY";
    private static final String ENV_CODEX_SANDBOX_MODE = "CODEX_SANDBOX_MODE";
    private static final String ENV_CODEX_SANDBOX = "CODEX_SANDBOX";
    private static final String ENV_CODEX_CI = "CODEX_CI";
    private static final String ENV_CODEX_SANDBOX_NETWORK_DISABLED = "CODEX_SANDBOX_NETWORK_DISABLED";
    private static final long MCP_TOOLS_TIMEOUT_MS = 65_000;
    private static final int MAX_ENV_VAR_VALUE_LENGTH = 16 * 1024;
    private final CodexHistoryReader historyReader;
    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    private static final Set<String> PROTECTED_ENV_KEYS = new HashSet<>();
    static {
        PROTECTED_ENV_KEYS.add("CODEX_USE_STDIN");
        PROTECTED_ENV_KEYS.add("CODEX_MODEL");
        PROTECTED_ENV_KEYS.add("CODEX_SANDBOX_MODE");
        PROTECTED_ENV_KEYS.add("CODEX_SANDBOX");
        PROTECTED_ENV_KEYS.add("CODEX_APPROVAL_POLICY");
        PROTECTED_ENV_KEYS.add("CODEX_CI");
        PROTECTED_ENV_KEYS.add("CODEX_SANDBOX_NETWORK_DISABLED");
        PROTECTED_ENV_KEYS.add("CODEX_HOME");
        PROTECTED_ENV_KEYS.add("CLAUDE_SESSION_ID");
        PROTECTED_ENV_KEYS.add("CLAUDE_PERMISSION_DIR");
        PROTECTED_ENV_KEYS.add("HOME");
        PROTECTED_ENV_KEYS.add("PATH");
        PROTECTED_ENV_KEYS.add("TMPDIR");
        PROTECTED_ENV_KEYS.add("TEMP");
        PROTECTED_ENV_KEYS.add("TMP");
        PROTECTED_ENV_KEYS.add("IDEA_PROJECT_PATH");
        PROTECTED_ENV_KEYS.add("PROJECT_PATH");
        PROTECTED_ENV_KEYS.add("CLAUDE_USE_STDIN");
        // Security (C): code-execution / library-injection variables must never be
        // overridable by a (possibly imported/malicious) provider's custom env vars.
        PROTECTED_ENV_KEYS.add("NODE_OPTIONS");
        PROTECTED_ENV_KEYS.add("NODE_EXTRA_CA_CERTS");
        PROTECTED_ENV_KEYS.add("ELECTRON_RUN_AS_NODE");
        PROTECTED_ENV_KEYS.add("LD_PRELOAD");
        PROTECTED_ENV_KEYS.add("LD_LIBRARY_PATH");
        PROTECTED_ENV_KEYS.add("LD_AUDIT");
        PROTECTED_ENV_KEYS.add("DYLD_INSERT_LIBRARIES");
        PROTECTED_ENV_KEYS.add("DYLD_LIBRARY_PATH");
        PROTECTED_ENV_KEYS.add("DYLD_FRAMEWORK_PATH");
        PROTECTED_ENV_KEYS.add("BASH_ENV");
        PROTECTED_ENV_KEYS.add("PERL5LIB");
        PROTECTED_ENV_KEYS.add("PYTHONPATH");
        PROTECTED_ENV_KEYS.add("GIT_SSH_COMMAND");
        PROTECTED_ENV_KEYS.add("GIT_EXTERNAL_DIFF");
    }

    public CodexSDKBridge() {
        super(CodexSDKBridge.class);
        this.historyReader = new CodexHistoryReader();
    }

    CodexSDKBridge(Path sessionsDir) {
        super(CodexSDKBridge.class);
        this.historyReader = new CodexHistoryReader(sessionsDir, gson);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "codex";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("CODEX_USE_STDIN", "true");
    }

    /**
     * Inject custom environment variables from the active Codex provider.
     * Skips any keys that match protected built-in variable names.
     *
     * @param env      ProcessBuilder environment map
     * @param category "message" or "mcp" to select the correct env var list
     */
    private void injectCustomEnvVars(Map<String, String> env, String category) {
        JsonObject activeProvider;
        try {
            activeProvider = settingsService.getActiveCodexProvider();
        } catch (Exception e) {
            LOG.error("[Codex] Failed to load active provider for env var injection (category=" + category + ")", e);
            return;
        }

        if (activeProvider == null) {
            return;
        }

        String field = "message".equals(category) ? "messageEnvVars" : "mcpEnvVars";
        if (!activeProvider.has(field) || !activeProvider.get(field).isJsonArray()) {
            return;
        }

        JsonArray envVars = activeProvider.getAsJsonArray(field);
        for (JsonElement el : envVars) {
            if (!el.isJsonObject()) { continue; }
            JsonObject entry = el.getAsJsonObject();
            if (!entry.has("key") || !entry.has("value")) { continue; }

            try {
                String key = entry.get("key").getAsString().trim();
                String value = entry.get("value").getAsString();

                if (key.isEmpty()) { continue; }
                if (PROTECTED_ENV_KEYS.contains(key.toUpperCase())) {
                    LOG.warn("[Codex] Skipping protected env var: " + key);
                    continue;
                }
                if (value.length() > MAX_ENV_VAR_VALUE_LENGTH) {
                    LOG.warn("[Codex] Skipping env var '" + key + "': value exceeds " +
                            MAX_ENV_VAR_VALUE_LENGTH + " bytes");
                    continue;
                }
                env.put(key, value);
                LOG.debug("[Codex] Injected custom env var: " + key);
            } catch (Exception e) {
                LOG.warn("[Codex] Failed to inject single env var entry: " + e.getMessage());
            }
        }
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
        if (line.contains("[DEBUG]")) {
            LOG.debug("[Codex] " + line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
        } else if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        } else if (line.startsWith("[THREAD_ID]")) {
            String receivedThreadId = line.substring("[THREAD_ID]".length()).trim();
            callback.onMessage("session_id", receivedThreadId);
        } else if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "unknown";

                    if ("status".equals(msgType)) {
                        String status = "";
                        if (msg.has("message") && !msg.get("message").isJsonNull()) {
                            JsonElement statusEl = msg.get("message");
                            status = statusEl.isJsonPrimitive() ? statusEl.getAsString() : statusEl.toString();
                        }
                        if (status != null && !status.isEmpty()) {
                            callback.onMessage("status", status);
                        }
                        return;
                    }

                    result.messages.add(msg);

                    if ("assistant".equals(msgType)) {
                        try {
                            String extracted = extractAssistantText(msg);
                            if (extracted != null && !extracted.isEmpty()) {
                                assistantContent.append(extracted);
                            }
                        } catch (Exception ignored) {
                        }
                    }

                    callback.onMessage(msgType, jsonStr);
                }
            } catch (Exception ignored) {
            }
        } else if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        } else if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
        } else if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            // Avoid duplicate
            if (!assistantContent.toString().contains(content)) {
                assistantContent.append(content);
            }
            callback.onMessage("content", content);
        } else if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
        }
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            LOG.warn("[CodexSDKBridge] Failed to decode JSON string payload, falling back to raw: " + e.getMessage());
            return jsonStr;
        }
    }

    // ============================================================================
    // Codex-specific configuration
    // ============================================================================

    /**
     * Set Codex API base URL.
     */
    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    /**
     * Get Codex API base URL.
     */
    public String getBaseUrl() {
        return this.baseUrl;
    }

    /**
     * Set Codex API key.
     */
    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    /**
     * Get Codex API key.
     */
    public String getApiKey() {
        return this.apiKey;
    }

    /**
     * Set executable permission for Codex binary.
     * Codex SDK is installed in ~/.codemoss/dependencies/codex-sdk/, not in ai-bridge.
     */
    private void setCodexExecutablePermission(File bridgeDir) {
        try {
            // Codex SDK is installed in ~/.codemoss/dependencies/codex-sdk/
            // not in ai-bridge directory
            DependencyManager depManager = new DependencyManager();
            File sdkNodeModules = depManager.getSdkNodeModulesDir("codex-sdk").toFile();
            File vendorDir = new File(sdkNodeModules, "@openai/codex-sdk/vendor");

            if (!vendorDir.exists()) {
                LOG.info("Codex vendor directory not found at: " + vendorDir.getAbsolutePath() + ", skipping permission setup");
                return;
            }

            File[] platformDirs = vendorDir.listFiles();
            if (platformDirs == null) { return; }

            for (File platformDir : platformDirs) {
                if (!platformDir.isDirectory()) { continue; }

                File codexDir = new File(platformDir, "codex");
                File codexBinary = new File(codexDir, "codex");
                File codexExe = new File(codexDir, "codex.exe");

                if (codexBinary.exists()) {
                    boolean success = codexBinary.setExecutable(true, false);
                    LOG.info("Set executable permission: " + codexBinary.getAbsolutePath() + " -> " + success);
                }
                if (codexExe.exists()) {
                    boolean success = codexExe.setExecutable(true, false);
                    LOG.info("Set executable permission: " + codexExe.getAbsolutePath() + " -> " + success);
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to set executable permission: " + e.getMessage());
        }
    }

    // ============================================================================
    // Message sending
    // ============================================================================

    /**
     * Send message to Codex (streaming response).
     *
     * Note: Codex uses threadId instead of sessionId
     * Note: Codex supports images via local_image type (requires file path, not base64)
     * Note: Codex does not support system prompts, so agentPrompt is appended to user message
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String threadId,  // Codex uses threadId, not sessionId
            String cwd,
            List<ClaudeSession.Attachment> attachments,  // Image attachments (saved to temp files for Codex)
            String permissionMode,
            String model,
            String agentPrompt,  // Agent prompt (appended to message for Codex)
            String reasoningEffort,  // Codex reasoning effort (thinking depth)
            String serviceTier,  // Codex service tier: null uses Codex defaults; "fast" matches CLI /fast
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            final List<File> tempImageFiles = new ArrayList<>();  // Track temp images for cleanup

            try {
                String accessMode = CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE;
                try {
                    accessMode = new CodemossSettingsService().getCodexRuntimeAccessMode();
                } catch (Exception e) {
                    LOG.warn("[Codex] Failed to resolve runtime access mode before send: " + e.getMessage());
                }
                if (CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE.equals(accessMode)) {
                    String error = ClaudeCodeGuiBundle.message("error.codexLocalAccessNotAuthorized");
                    result.success = false;
                    result.error = error;
                    callback.onError(error);
                    return result;
                }

                String node = nodeDetector.findNodeExecutable();
                File bridgeDir = getDirectoryResolver().findSdkDir();

                // Null check for bridgeDir
                if (bridgeDir == null || !bridgeDir.exists()) {
                    result.success = false;
                    result.error = "Bridge directory not ready or invalid";
                    return result;
                }

                // Ensure Codex SDK binary has executable permission
                setCodexExecutablePermission(bridgeDir);

                // Append agentPrompt to message if provided (Codex doesn't support system prompts)
                String finalMessage = message;
                if (agentPrompt != null && !agentPrompt.isEmpty()) {
                    finalMessage = message + "\n\n## Agent Role and Instructions\n\n" + agentPrompt;
                    LOG.info("[Agent] ✓ Appending agentPrompt to user message for Codex (length: " + agentPrompt.length() + " chars)");
                }

                // Build stdin input JSON
                // Note: Codex uses 'threadId' (not 'sessionId')
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("message", finalMessage);
                stdinInput.addProperty("threadId", threadId != null ? threadId : "");
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
                stdinInput.addProperty("model", model != null ? model : "");
                // Reasoning effort (thinking depth)
                stdinInput.addProperty("reasoningEffort", reasoningEffort != null ? reasoningEffort : "medium");
                stdinInput.addProperty("serviceTier", serviceTier != null ? serviceTier : "");

                // API configuration — skip for CLI Login mode (uses native OAuth from ~/.codex/auth.json)
                boolean isCodexCliLogin = isCodexCliLoginActive();
                if (!isCodexCliLogin) {
                    stdinInput.addProperty("baseUrl", baseUrl != null ? baseUrl : "");
                    stdinInput.addProperty("apiKey", apiKey != null ? apiKey : "");
                } else {
                    stdinInput.addProperty("baseUrl", "");
                    stdinInput.addProperty("apiKey", "");
                    LOG.info("[Codex] CLI Login mode: skipping apiKey/baseUrl, using native OAuth tokens");
                }

                // Process attachments for Codex (images need to be saved as temp files)
                // Codex SDK requires local file paths, not base64 data
                JsonArray attachmentsArray = buildCodexAttachments(attachments, tempImageFiles);
                if (attachmentsArray.size() > 0) {
                    stdinInput.add("attachments", attachmentsArray);
                    LOG.info("[Codex] ✓ Prepared " + attachmentsArray.size() + " image attachment(s)");
                }

                String stdinJson = gson.toJson(stdinInput);

                String scriptPath = new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath();
                List<String> command = NodeDetector.buildNodeScriptCommand(node, scriptPath);
                command.add("codex");
                command.add("send");

                File processTempDir = processManager.prepareClaudeTempDir();

                ProcessBuilder pb = new ProcessBuilder(command);

                // Set working directory
                if (cwd != null && !cwd.isEmpty() && !"undefined".equals(cwd) && !"null".equals(cwd)) {
                    File userWorkDir = new File(cwd);
                    if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                        pb.directory(userWorkDir);
                    } else {
                        pb.directory(bridgeDir);
                    }
                } else {
                    pb.directory(bridgeDir);
                }

                // Configure environment variables
                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CODEX_USE_STDIN", "true");

                // Set model via environment variable if specified
                if (model != null && !model.isEmpty()) {
                    env.put("CODEX_MODEL", model);
                }

                // Override user's ~/.codex/config.toml sandbox and approval settings via environment variables
                if (permissionMode != null && !permissionMode.isEmpty()) {
                    String sandboxMode = resolveCodexSandboxMode(cwd);

                    switch (permissionMode) {
                        case "bypassPermissions":
                            env.put(ENV_CODEX_SANDBOX_MODE, sandboxMode);
                            env.put(ENV_CODEX_SANDBOX, sandboxMode);
                            env.put(ENV_CODEX_APPROVAL_POLICY, APPROVAL_POLICY_NEVER);
                            break;
                        case "acceptEdits":
                        case "autoEdit":
                            env.put(ENV_CODEX_SANDBOX_MODE, sandboxMode);
                            env.put(ENV_CODEX_SANDBOX, sandboxMode);
                            env.put(ENV_CODEX_APPROVAL_POLICY, APPROVAL_POLICY_ON_REQUEST);
                            break;
                        case "plan":
                            env.put(ENV_CODEX_SANDBOX_MODE, sandboxMode);
                            env.put(ENV_CODEX_SANDBOX, sandboxMode);
                            env.put(ENV_CODEX_APPROVAL_POLICY, APPROVAL_POLICY_UNTRUSTED);
                            break;
                        default:
                            // Default mode: use configured sandbox mode with confirmation
                            env.put(ENV_CODEX_SANDBOX_MODE, sandboxMode);
                            env.put(ENV_CODEX_SANDBOX, sandboxMode);
                            env.put(ENV_CODEX_APPROVAL_POLICY, APPROVAL_POLICY_UNTRUSTED);
                            break;
                    }
                    LOG.info("[Codex] Permission env override: SANDBOX_MODE=" +
                            env.get(ENV_CODEX_SANDBOX_MODE) + ", SANDBOX=" +
                            env.get(ENV_CODEX_SANDBOX) + ", APPROVAL_POLICY=" +
                            env.get(ENV_CODEX_APPROVAL_POLICY) + " (from permissionMode=" + permissionMode +
                            ")");
                }

                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);

                // Configure Codex-specific env vars from ~/.codex/config.toml
                envConfigurator.configureCodexEnv(env);

                // Inject custom "message" env vars from active provider
                injectCustomEnvVars(env, "message");

                LOG.info("[Codex] Final Node permission env snapshot: CODEX_SANDBOX_MODE=" +
                        env.get(ENV_CODEX_SANDBOX_MODE) + ", CODEX_SANDBOX=" +
                        env.get(ENV_CODEX_SANDBOX) + ", CODEX_CI=" + env.get(ENV_CODEX_CI) +
                        ", CODEX_SANDBOX_NETWORK_DISABLED=" + env.get(ENV_CODEX_SANDBOX_NETWORK_DISABLED) +
                        ", CLAUDE_SESSION_ID=" + env.get("CLAUDE_SESSION_ID") +
                        ", CLAUDE_PERMISSION_DIR=" + env.get("CLAUDE_PERMISSION_DIR"));

                LOG.info("Command: " + String.join(" ", command));

                Process process = null;
                try {
                    process = pb.start();
                    processManager.registerProcess(channelId, process);

                    // Write to stdin
                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                    } catch (Exception e) {
                        LOG.warn("Failed to write stdin: " + e.getMessage());
                    }

                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {
                            // Capture Node.js error logs
                            if (line.startsWith("[UNCAUGHT_ERROR]")
                                    || line.startsWith("[UNHANDLED_REJECTION]")
                                    || line.startsWith("[COMMAND_ERROR]")) {
                                LOG.warn("[Node.js ERROR] " + line);
                                lastNodeError.set(line);
                            }
                            processOutputLine(line, callback, result, assistantContent, hadSendError, lastNodeError);
                        }
                    }

                    process.waitFor();

                    int exitCode = process.exitValue();
                    boolean wasInterrupted = processManager.wasInterrupted(channelId);

                    result.finalResult = assistantContent.toString();
                    result.messageCount = result.messages.size();

                    if (wasInterrupted) {
                        result.success = false;
                        result.error = "User interrupted";
                        callback.onComplete(result);
                    } else if (!hadSendError.get()) {
                        result.success = exitCode == 0;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            String errorMsg = "Codex process exited with code: " + exitCode;
                            String nodeErr = lastNodeError.get();
                            if (nodeErr != null && !nodeErr.isEmpty()) {
                                errorMsg = errorMsg + " | Last error: " + nodeErr;
                            }
                            result.error = errorMsg;
                            callback.onError(errorMsg);
                        }
                    }

                    return result;
                } finally {
                    processManager.unregisterProcess(channelId, process);
                    processManager.waitForProcessTermination(process);
                    cleanupTempImages(tempImageFiles);  // Cleanup temp image files
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                callback.onError(e.getMessage());
                cleanupTempImages(tempImageFiles);  // Cleanup temp image files on error
                return result;
            }
        });
    }

    /**
     * Get persisted Codex session history messages.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            String rawMessages = historyReader.getSessionMessagesAsJson(sessionId);
            JsonArray historyItems = gson.fromJson(rawMessages, JsonArray.class);
            if (historyItems == null) {
                return List.of();
            }
            return HistoryMessageInjector.convertCodexMessagesToFrontendBatch(historyItems);
        } catch (Exception e) {
            LOG.warn("Failed to load Codex session history: " + e.getMessage(), e);
            return List.of();
        }
    }

    /**
     * Gets the tool list for the specified Codex MCP server.
     */
    public CompletableFuture<JsonObject> getMcpServerTools(String serverId, JsonObject serverConfig) {
        return CompletableFuture.supplyAsync(() -> {
            // L10 fix: unique channelId per call. The original code used the
            // constant "__codex_mcp_tools__" as the registration key. Concurrent
            // calls would overwrite each other's Process reference in the
            // ConcurrentHashMap, leaving the displaced entry leaked (no path could
            // unregister it because the lookup key now points to the newer
            // Process). UUID suffix makes each call independent.
            String channelId = ProcessManager.newChannelId("__codex_mcp_tools__");
            Process process = null;
            long startTime = System.currentTimeMillis();
            LOG.info("[CodexMcpTools] Starting getMcpServerTools, serverId=" + serverId);

            try {
                String node = nodeDetector.findNodeExecutable();
                File bridgeDir = getDirectoryResolver().findSdkDir();
                if (bridgeDir == null || !bridgeDir.exists()) {
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("serverId", serverId);
                    errorResult.addProperty("error", "Bridge directory not ready");
                    errorResult.add("tools", new JsonArray());
                    return errorResult;
                }

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("serverId", serverId != null ? serverId : "");
                if (serverConfig != null) {
                    stdinInput.add("serverConfig", serverConfig);
                } else {
                    stdinInput.add("serverConfig", new JsonObject());
                }
                String stdinJson = gson.toJson(stdinInput);

                String scriptPath = new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath();
                List<String> command = NodeDetector.buildNodeScriptCommand(node, scriptPath);
                command.add("codex");
                command.add("getMcpServerTools");

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(bridgeDir);
                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);
                pb.environment().put("CODEX_USE_STDIN", "true");

                // Inject custom "mcp" env vars from active provider
                injectCustomEnvVars(pb.environment(), "mcp");

                process = pb.start();
                processManager.registerProcess(channelId, process);
                final Process finalProcess = process;

                try (java.io.OutputStream stdin = process.getOutputStream()) {
                    stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                }

                AtomicBoolean found = new AtomicBoolean(false);
                AtomicBoolean readerDone = new AtomicBoolean(false);
                AtomicReference<String> toolsJson = new AtomicReference<>(null);
                final StringBuilder output = new StringBuilder();

                Thread readerThread = new Thread(() -> {
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while (!found.get() && (line = reader.readLine()) != null) {
                            output.append(line).append("\n");
                            if (line.startsWith("[MCP_SERVER_TOOLS]")) {
                                toolsJson.set(line.substring("[MCP_SERVER_TOOLS]".length()).trim());
                                found.set(true);
                                break;
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[CodexMcpTools] Reader thread exception: " + e.getMessage());
                    } finally {
                        readerDone.set(true);
                    }
                });
                readerThread.start();

                long deadline = System.currentTimeMillis() + MCP_TOOLS_TIMEOUT_MS;
                while (!found.get() && !readerDone.get() && System.currentTimeMillis() < deadline) {
                    Thread.sleep(100);
                }

                long elapsed = System.currentTimeMillis() - startTime;
                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }

                String capturedTools = toolsJson.get();
                if (found.get() && capturedTools != null && !capturedTools.isEmpty()) {
                    try {
                        JsonObject result = gson.fromJson(capturedTools, JsonObject.class);
                        LOG.info("[CodexMcpTools] Got tools for " + serverId + " in " + elapsed + "ms");
                        return result;
                    } catch (Exception e) {
                        LOG.warn("[CodexMcpTools] Failed to parse MCP tools JSON: " + e.getMessage());
                    }
                }

                String outputStr = output.toString().trim();
                String jsonStr = extractLastJsonLine(outputStr);
                if (jsonStr != null) {
                    try {
                        JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                        if (jsonResult != null && jsonResult.has("success")) {
                            return jsonResult;
                        }
                    } catch (Exception e) {
                        LOG.debug("[CodexMcpTools] Fallback JSON parse failed: " + e.getMessage());
                    }
                }

                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("serverId", serverId);
                errorResult.addProperty("error", "Failed to get tools list");
                errorResult.add("tools", new JsonArray());
                return errorResult;
            } catch (Exception e) {
                LOG.error("[CodexMcpTools] Exception: " + e.getMessage(), e);
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("serverId", serverId);
                errorResult.addProperty("error", e.getMessage());
                errorResult.add("tools", new JsonArray());
                return errorResult;
            } finally {
                if (process != null) {
                    try {
                        if (process.isAlive()) {
                            PlatformUtils.terminateProcess(process);
                        }
                    } finally {
                        processManager.unregisterProcess(channelId, process);
                    }
                }
            }
        });
    }

    /**
     * Extracts the last JSON object text from multi-line output.
     */
    private String extractLastJsonLine(String outputStr) {
        if (outputStr == null || outputStr.isEmpty()) {
            return null;
        }
        String[] lines = outputStr.split("\\r?\\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.startsWith("{") && line.endsWith("}")) {
                return line;
            }
        }
        if (outputStr.startsWith("{") && outputStr.endsWith("}")) {
            return outputStr;
        }
        int jsonStart = outputStr.indexOf("{");
        if (jsonStart != -1) {
            return outputStr.substring(jsonStart);
        }
        return null;
    }

    // ============================================================================
    // Utility methods
    // ============================================================================

    /**
     * Build Codex-compatible attachments array.
     * Codex SDK requires local file paths for images, not base64 data.
     * This method saves base64 image data to temporary files and returns file paths.
     * Files are marked for deletion on JVM exit and tracked for cleanup after message send.
     *
     * @param attachments List of attachments from the UI
     * @param tempFiles List to collect temp files for cleanup after send (optional, can be null)
     * @return JsonArray with local_image entries for Codex SDK
     */
    private JsonArray buildCodexAttachments(List<ClaudeSession.Attachment> attachments, List<File> tempFiles) {
        JsonArray result = new JsonArray();

        if (attachments == null || attachments.isEmpty()) {
            return result;
        }

        // Use system temp directory (clean, no project pollution)
        File tempDir = new File(System.getProperty("java.io.tmpdir"), "codex-images");

        // Create temp directory if not exists
        if (!tempDir.exists()) {
            tempDir.mkdirs();
        }

        for (ClaudeSession.Attachment attachment : attachments) {
            if (attachment == null) { continue; }

            String type = attachment.mediaType;
            String data = attachment.data;

            // Only process image types
            if (type == null || !type.startsWith("image/") || data == null) {
                LOG.debug("[Codex] Skipping non-image attachment: " + type);
                continue;
            }

            try {
                // Determine file extension from MIME type
                String extension = getImageExtension(type);

                // Generate unique filename
                String filename = "codex-img-" + System.currentTimeMillis() + "-" +
                                  java.util.UUID.randomUUID().toString().substring(0, 8) + extension;
                File imageFile = new File(tempDir, filename);

                // Decode base64 and write to file
                byte[] imageBytes = java.util.Base64.getDecoder().decode(data);
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(imageFile)) {
                    fos.write(imageBytes);
                }

                // Mark for deletion on JVM exit (fallback cleanup)
                imageFile.deleteOnExit();

                // Track for immediate cleanup after send
                if (tempFiles != null) {
                    tempFiles.add(imageFile);
                }

                LOG.info("[Codex] Saved temp image: " + imageFile.getAbsolutePath() +
                         " (" + imageBytes.length + " bytes, will auto-delete)");

                // Add to result array in Codex SDK format
                JsonObject imageEntry = new JsonObject();
                imageEntry.addProperty("type", "local_image");
                imageEntry.addProperty("path", imageFile.getAbsolutePath());
                result.add(imageEntry);

            } catch (Exception e) {
                LOG.warn("[Codex] Failed to process image attachment: " + e.getMessage());
            }
        }

        return result;
    }

    /**
     * Cleanup temporary image files after message send.
     */
    private void cleanupTempImages(List<File> tempFiles) {
        if (tempFiles == null || tempFiles.isEmpty()) {
            return;
        }
        for (File file : tempFiles) {
            try {
                if (file.exists() && file.delete()) {
                    LOG.debug("[Codex] Cleaned up temp image: " + file.getName());
                }
            } catch (Exception e) {
                LOG.debug("[Codex] Failed to cleanup temp image: " + e.getMessage());
            }
        }
    }

    /**
     * Get file extension from MIME type.
     */
    private String getImageExtension(String mimeType) {
        if (mimeType == null) { return ".png"; }

        switch (mimeType.toLowerCase()) {
            case "image/jpeg":
            case "image/jpg":
                return ".jpg";
            case "image/gif":
                return ".gif";
            case "image/webp":
                return ".webp";
            case "image/bmp":
                return ".bmp";
            case "image/svg+xml":
                return ".svg";
            case "image/png":
            default:
                return ".png";
        }
    }

    private String extractAssistantText(JsonObject msg) {
        if (msg == null) { return ""; }
        if (!msg.has("message") || !msg.get("message").isJsonObject()) { return ""; }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) { return ""; }

        JsonElement contentEl = message.get("content");
        if (contentEl.isJsonPrimitive()) {
            return contentEl.getAsString();
        }
        if (!contentEl.isJsonArray()) {
            return "";
        }

        JsonArray arr = contentEl.getAsJsonArray();
        StringBuilder sb = new StringBuilder();
        for (JsonElement el : arr) {
            if (!el.isJsonObject()) { continue; }
            JsonObject block = el.getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull()) { continue; }
            String type = block.get("type").getAsString();
            if ("text".equals(type) && block.has("text") && !block.get("text").isJsonNull()) {
                if (sb.length() > 0) { sb.append("\n"); }
                sb.append(block.get("text").getAsString());
            }
        }
        return sb.toString();
    }
    /**
     * Resolve effective Codex sandbox mode from user settings.
     * Falls back to platform defaults when settings are unavailable or invalid.
     */
    private String resolveCodexSandboxMode(String cwd) {
        // Default to workspace-write (safer) on non-Windows; Windows sandbox is
        // experimental so danger-full-access is used there as a platform fallback.
        String defaultMode = PlatformUtils.isWindows()
                ? SANDBOX_MODE_DANGER_FULL_ACCESS
                : SANDBOX_MODE_WORKSPACE_WRITE;

        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            String configured = settingsService.getCodexSandboxMode(cwd);
            if (SANDBOX_MODE_WORKSPACE_WRITE.equals(configured) || SANDBOX_MODE_DANGER_FULL_ACCESS.equals(configured)) {
                return configured;
            }
        } catch (Exception e) {
            LOG.warn("[Codex] Failed to read Codex sandbox mode config: " + e.getMessage());
        }
        return defaultMode;
    }

    /**
     * Check if Codex CLI Login provider is currently active by reading config.json directly.
     */
    private boolean isCodexCliLoginActive() {
        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            return CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN
                    .equals(settingsService.getCodexRuntimeAccessMode());
        } catch (Exception e) {
            LOG.debug("[Codex] Failed to check CLI login status: " + e.getMessage());
            return false;
        }
    }
}
