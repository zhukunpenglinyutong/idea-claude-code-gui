package com.github.claudecodegui.provider.common;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Base SDK bridge class.
 * Contains common logic shared by ClaudeSDKBridge and CodexSDKBridge.
 */
public abstract class BaseSDKBridge {

    protected static final String CHANNEL_SCRIPT = "channel-manager.js";

    protected final Logger LOG;
    protected final Gson gson = new Gson();
    /**
     * Shared NodeDetector instance (singleton pattern).
     * This ensures that ClaudeSDKBridge and CodexSDKBridge share the same cache,
     * avoiding redundant Node.js path detections across modes.
     */
    protected final NodeDetector nodeDetector = NodeDetector.getInstance();
    protected final ProcessManager processManager = new ProcessManager();
    protected final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    /**
     * Get the shared BridgeDirectoryResolver from BridgePreloader.
     * This ensures consistent extraction state across all components.
     */
    protected BridgeDirectoryResolver getDirectoryResolver() {
        return BridgePreloader.getSharedResolver();
    }

    protected BaseSDKBridge(Class<?> loggerClass) {
        this.LOG = Logger.getInstance(loggerClass);
        // Inject IntelliJ's managed executor into NodeDetector for in-flight detection tasks.
        this.nodeDetector.setDetectionExecutor(AppExecutorUtil.getAppExecutorService());
    }

    // ============================================================================
    // Abstract methods - to be implemented by subclasses
    // ============================================================================

    /**
     * Get the provider name (e.g., "claude" or "codex").
     */
    protected abstract String getProviderName();

    /**
     * Configure provider-specific environment variables.
     *
     * @param env       Environment map
     * @param stdinJson The JSON input that will be sent via stdin
     */
    protected abstract void configureProviderEnv(Map<String, String> env, String stdinJson);

    /**
     * Process a single line of output from the Node.js process.
     *
     * @param line             The output line
     * @param callback         Message callback
     * @param result           SDK result being built
     * @param assistantContent StringBuilder for accumulating assistant content
     * @param hadSendError     Flag indicating if send error occurred
     * @param lastNodeError    Holder for the last Node.js error
     */
    protected abstract void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    );

    // ============================================================================
    // Process management methods (common)
    // ============================================================================

    /**
     * Clean up all active child processes.
     */
    public void cleanupAllProcesses() {
        processManager.cleanupAllProcesses();
    }

    /**
     * Get the count of active processes.
     */
    public int getActiveProcessCount() {
        return processManager.getActiveProcessCount();
    }

    /**
     * Expose this bridge's ProcessManager for inspection by NodeProcessRegistry.
     * Callers must treat the returned manager as read-only — do not register/unregister
     * processes through this reference; use the bridge's normal API instead.
     */
    public ProcessManager getProcessManager() {
        return processManager;
    }

    /**
     * Get the session ID for this bridge instance.
     * @return Session ID
     */
    public String getSessionId() {
        return envConfigurator.getSessionId();
    }

    /**
     * Sets the current bridge session ID for permission service routing alignment.
     */
    public void setSessionId(String sessionId) {
        envConfigurator.setSessionId(sessionId);
    }

    /**
     * Interrupt a channel.
     */
    public void interruptChannel(String channelId) {
        processManager.interruptChannel(channelId);
    }

    // ============================================================================
    // Node.js detection methods (common)
    // ============================================================================

    /**
     * Set Node.js executable path manually.
     */
    public void setNodeExecutable(String path) {
        nodeDetector.setNodeExecutable(path);
    }

    /**
     * Get the current Node.js executable path.
     */
    public String getNodeExecutable() {
        return nodeDetector.getNodeExecutable();
    }

    // ============================================================================
    // Channel management (common)
    // ============================================================================

    /**
     * Launch a new channel (auto-launch on first send).
     */
    public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        result.addProperty("channelId", channelId);
        result.addProperty("message", getProviderName() + " channel ready (auto-launch on first send)");
        return result;
    }

    // ============================================================================
    // Environment check (common)
    // ============================================================================

    /**
     * Check if the environment is ready.
     */
    public boolean checkEnvironment() {
        try {
            String node = nodeDetector.findNodeExecutable();
            List<String> versionCmd = NodeDetector.buildNodeScriptCommand(node, "--version");
            ProcessBuilder pb = new ProcessBuilder(versionCmd);
            envConfigurator.updateProcessEnvironment(pb, node);
            Process process = pb.start();

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String version = reader.readLine();
                LOG.debug("Node.js version: " + version);
            }

            int exitCode = process.waitFor();
            if (exitCode != 0) {
                return false;
            }

            // Check bridge directory
            File bridgeDir = getDirectoryResolver().findSdkDir();
            if (bridgeDir == null) {
                // Bridge extraction is in progress (EDT thread scenario)
                LOG.info("Bridge directory not ready yet (extraction in progress)");
                return false;
            }

            File scriptFile = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!scriptFile.exists()) {
                LOG.error("channel-manager.js not found at: " + scriptFile.getAbsolutePath());
                return false;
            }

            LOG.info("Environment check passed for " + getProviderName());
            return true;
        } catch (Exception e) {
            LOG.warn("Environment check failed: " + e.getMessage());
            return false;
        }
    }

    // ============================================================================
    // Common message sending infrastructure
    // ============================================================================

    /**
     * Execute a command and process streaming output.
     * This is the core method that handles process lifecycle.
     *
     * @param channelId Channel identifier
     * @param command   Command arguments (node script provider action)
     * @param stdinJson JSON to write to stdin
     * @param cwd       Working directory
     * @param callback  Message callback
     * @return CompletableFuture with the result
     */
    protected CompletableFuture<SDKResult> executeStreamingCommand(
            String channelId,
            List<String> command,
            String stdinJson,
            String cwd,
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);

            try {
                File bridgeDir = getDirectoryResolver().findSdkDir();
                if (bridgeDir == null) {
                    // Bridge extraction is in progress
                    result.success = false;
                    result.error = "Bridge directory not ready yet (extraction in progress)";
                    callback.onError(result.error);
                    return result;
                }

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

                // Configure environment
                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processTempDir);
                configureProviderEnv(env, stdinJson);

                pb.redirectErrorStream(true);
                String node = nodeDetector.findNodeExecutable();
                envConfigurator.updateProcessEnvironment(pb, node);

                LOG.info("[" + getProviderName() + "] Command: " + String.join(" ", command));

                Process process = null;
                try {
                    process = processManager.startManagedProcess(channelId, pb);

                    // Write to stdin
                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                    } catch (Exception e) {
                        LOG.warn("Failed to write stdin: " + e.getMessage());
                    }

                    // Read output
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {

                            // Capture Node.js error logs
                            if (line.startsWith("[UNCAUGHT_ERROR]")
                                    || line.startsWith("[UNHANDLED_REJECTION]")
                                    || line.startsWith("[COMMAND_ERROR]")
                                    || line.startsWith("[STARTUP_ERROR]")
                                    || line.startsWith("[ERROR]")) {
                                LOG.warn("[Node.js ERROR] " + line);
                                lastNodeError.set(line);
                            }

                            // Delegate to subclass for provider-specific processing
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
                            String errorMsg = getProviderName() + " process exited with code: " + exitCode;
                            String nodeErr = lastNodeError.get();
                            if (nodeErr != null && !nodeErr.isEmpty()) {
                                errorMsg = errorMsg + "\n\nDetails: " + nodeErr;
                            }
                            result.error = errorMsg;
                            callback.onError(errorMsg);
                        }
                    } else {
                        // Send phase already handled the error, no need to append recent output
                        if (exitCode != 0 && result.error != null) {
                            callback.onError(result.error);
                        }
                    }

                    return result;
                } finally {
                    processManager.unregisterProcess(channelId, process);
                    processManager.waitForProcessTermination(process);
                    // L9 fix: waitForProcessTermination only waits 5s and then gives
                    // up. If the SDK is stuck on a network read it can outlive that
                    // window — force-kill so the child does not become a long-lived
                    // orphan. Matches the cleanup guarantee in interruptChannel.
                    if (process.isAlive()) {
                        LOG.warn("[" + getProviderName() + "] process " + process.pid()
                                + " did not terminate within waitForProcessTermination window, force-killing");
                        PlatformUtils.terminateProcess(process);
                    }
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                callback.onError(e.getMessage());
                return result;
            }
        }).exceptionally(ex -> {
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage();
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

    /**
     * Build the base command for invoking channel-manager.js.
     * When the node executable is a WSL path, prepends 'wsl' and converts
     * the script path to a WSL-accessible format.
     *
     * @param action The action to perform (e.g., "send", "sendWithAttachments")
     * @return Command list
     */
    protected List<String> buildBaseCommand(String action) {
        List<String> command = new ArrayList<>();
        try {
            String node = nodeDetector.findNodeExecutable();
            File bridgeDir = getDirectoryResolver().findSdkDir();
            if (bridgeDir == null) {
                LOG.warn("Bridge directory not ready yet (extraction in progress), cannot build command");
                return command;
            }

            String scriptPath = new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath();
            command.addAll(NodeDetector.buildNodeScriptCommand(node, scriptPath));
            command.add(getProviderName());
            command.add(action);
        } catch (Exception e) {
            LOG.error("Failed to build command: " + e.getMessage());
        }
        return command;
    }
}
