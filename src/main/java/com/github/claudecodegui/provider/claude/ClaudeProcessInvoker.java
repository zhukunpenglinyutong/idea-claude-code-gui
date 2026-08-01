package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * Runs the per-process Claude fallback path while preserving legacy output handling.
 */
class ClaudeProcessInvoker {

    private static final String PROVIDER_NAME = "claude";
    private static final String CHANNEL_SCRIPT = "channel-manager.js";

    private final Logger log;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final ProcessManager processManager;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeRequestParamsBuilder requestParamsBuilder;
    private final ClaudeLogSanitizer logSanitizer;
    private final ClaudeStreamAdapter streamAdapter;

    ClaudeProcessInvoker(
            Logger log,
            Gson gson,
            NodeDetector nodeDetector,
            Supplier<File> sdkDirSupplier,
            ProcessManager processManager,
            EnvironmentConfigurator envConfigurator,
            ClaudeRequestParamsBuilder requestParamsBuilder,
            ClaudeLogSanitizer logSanitizer,
            ClaudeStreamAdapter streamAdapter
    ) {
        this.log = log;
        this.gson = gson;
        this.nodeDetector = nodeDetector;
        this.sdkDirSupplier = sdkDirSupplier;
        this.processManager = processManager;
        this.envConfigurator = envConfigurator;
        this.requestParamsBuilder = requestParamsBuilder;
        this.logSanitizer = logSanitizer;
        this.streamAdapter = streamAdapter;
    }

    CompletableFuture<SDKResult> sendMessage(
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
        AtomicBoolean errorAlreadyReported = new AtomicBoolean(false);
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);
            long startTime = System.currentTimeMillis();

            try {
                String node = nodeDetector.findNodeExecutable();
                File workDir = sdkDirSupplier.get();
                if (workDir == null || !workDir.exists()) {
                    result.success = false;
                    result.error = "Bridge directory not ready or invalid. Please wait for extraction to complete or reinstall the plugin.";
                    callback.onError(result.error);
                    return result;
                }

                log.info("[ProcessInvoker] Environment diagnostics:");
                log.info("[ProcessInvoker]   Node.js path: " + node);
                String nodeVersion = nodeDetector.verifyNodePath(node);
                log.info("[ProcessInvoker]   Node.js version: " + (nodeVersion != null ? nodeVersion : "unknown"));
                log.info("[ProcessInvoker]   SDK directory: " + workDir.getAbsolutePath());

                JsonObject stdinInput = requestParamsBuilder.buildSendParams(
                        message,
                        sessionId,
                        runtimeSessionEpoch,
                        cwd,
                        permissionMode,
                        model,
                        attachments,
                        openedFiles,
                        agentPrompt,
                        streaming,
                        disableThinking,
                        reasoningEffort
                );
                String stdinJson = gson.toJson(stdinInput);
                String preview = logSanitizer.buildPreview(stdinJson, 500);
                log.debug("[PROMPT] Sending to Node.js (" + stdinJson.length() + " chars):\n" + preview);

                boolean hasAttachments = stdinInput.has("attachments");
                String scriptPath = new File(workDir, CHANNEL_SCRIPT).getAbsolutePath();
                List<String> command = NodeDetector.buildNodeScriptCommand(node, scriptPath);
                command.add(PROVIDER_NAME);
                command.add(hasAttachments ? "sendWithAttachments" : "send");

                File processTempDir = processManager.prepareClaudeTempDir();
                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(ClaudeBridgeUtils.resolveWorkingDirectory(workDir, cwd));

                Map<String, String> env = pb.environment();
                envConfigurator.configureProjectPath(env, cwd);
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CLAUDE_USE_STDIN", "true");
                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);

                Process process = null;
                try {
                    // Pre-spawn boundary (provider-abort final closure, PART C):
                    // if an interrupt already won, do NOT start Agent work.
                    // Same atomic spawn-vs-interrupt protocol as Codex (PART B).
                    if (!processManager.beginSpawn(channelId)) {
                        long elapsed = System.currentTimeMillis() - startTime;
                        log.info("[ProcessInvoker] Interrupt won before spawn (elapsed: " + elapsed + "ms)");
                        result.success = false;
                        result.error = "User interrupted";
                        callback.onComplete(result);
                        return result;
                    }
                    process = pb.start();
                    log.info("[ProcessInvoker] Node.js process started, PID: " + process.pid());
                    if (!processManager.registerProcessChecked(channelId, process)) {
                        // Interrupt won during spawn — destroy the process BEFORE it
                        // begins Agent work (stdin not yet written). No Agent turn runs.
                        long elapsed = System.currentTimeMillis() - startTime;
                        log.info("[ProcessInvoker] Interrupt won during spawn, rejecting (elapsed: " + elapsed + "ms)");
                        try {
                            process.destroyForcibly();
                        } catch (Exception ignored) {
                        }
                        processManager.waitForProcessTermination(process);
                        result.success = false;
                        result.error = "User interrupted";
                        callback.onComplete(result);
                        return result;
                    }

                    captureEarlyExitIfNeeded(process, lastNodeError);
                    ClaudeBridgeUtils.writeStdin(stdinJson, process);
                    readOutput(
                            process,
                            callback,
                            result,
                            assistantContent,
                            hadSendError,
                            lastNodeError,
                            node,
                            nodeVersion,
                            workDir
                    );

                    log.debug("[ProcessInvoker] Output loop ended, waiting for process to exit...");
                    process.waitFor();

                    int exitCode = process.exitValue();
                    boolean wasInterrupted = processManager.wasInterrupted(channelId);
                    log.debug("[ProcessInvoker] Process exited, exitCode=" + exitCode
                            + ", wasInterrupted=" + wasInterrupted + ", hadSendError=" + hadSendError.get());

                    result.finalResult = assistantContent.toString();
                    result.messageCount = result.messages.size();

                    if (wasInterrupted) {
                        long elapsed = System.currentTimeMillis() - startTime;
                        log.info("[ProcessInvoker] Request was interrupted by user (elapsed: " + elapsed + "ms)");
                        result.error = "User interrupted";
                        callback.onComplete(result);
                    } else if (!hadSendError.get()) {
                        result.success = exitCode == 0;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            String errorMsg = "Process exited with code: " + exitCode;
                            String nodeErr = lastNodeError.get();
                            if (nodeErr != null && !nodeErr.isEmpty()) {
                                errorMsg = errorMsg + "\n\nDetails: " + nodeErr;
                            }
                            result.success = false;
                            result.error = errorMsg;
                            callback.onError(errorMsg);
                        }
                    } else {
                        result.success = exitCode == 0;
                        callback.onComplete(result);
                    }

                    return result;
                } finally {
                    processManager.unregisterProcess(channelId, process);
                    processManager.waitForProcessTermination(process);
                }
            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                errorAlreadyReported.set(true);
                callback.onError(e.getMessage());
                return result;
            }
        }).exceptionally(ex -> {
            if (errorAlreadyReported.get()) {
                log.debug("[ProcessInvoker] Skipping duplicate onError in exceptionally (already reported by catch)");
                return new SDKResult();
            }
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage();
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

    private void readOutput(
            Process process,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError,
            String node,
            String nodeVersion,
            File workDir
    ) throws Exception {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("[UNCAUGHT_ERROR]")
                        || line.startsWith("[UNHANDLED_REJECTION]")
                        || line.startsWith("[COMMAND_ERROR]")
                        || line.startsWith("[STARTUP_ERROR]")
                        || line.startsWith("[ERROR]")
                        || line.startsWith("[STDIN_ERROR]")
                        || line.startsWith("[STDIN_PARSE_ERROR]")
                        || line.startsWith("[GET_SESSION_ERROR]")
                        || line.startsWith("[PERSIST_ERROR]")) {
                    log.warn("[Node.js ERROR] " + line);
                    lastNodeError.set(line);
                }

                if (line.startsWith("[SEND_ERROR]")) {
                    String errorMessage = formatSendError(line, node, nodeVersion, workDir);
                    hadSendError.set(true);
                    result.success = false;
                    result.error = errorMessage;
                    callback.onError(errorMessage);
                } else if (isRecognizedBridgeLine(line)) {
                    streamAdapter.processOutputLine(line, callback, result, assistantContent, hadSendError, lastNodeError);
                } else {
                    callback.onMessage("node_log", line);
                }
            }
        }
    }

    private boolean isRecognizedBridgeLine(String line) {
        return line.startsWith("[MESSAGE]")
                || line.startsWith("[CONTENT]")
                || line.startsWith("[CONTENT_DELTA]")
                || line.startsWith("[THINKING]")
                || line.startsWith("[THINKING_DELTA]")
                || line.startsWith("[STREAM_START]")
                || line.startsWith("[STREAM_END]")
                || line.startsWith("[SESSION_ID]")
                || line.startsWith("[TOOL_RESULT]")
                || line.startsWith("[USAGE]")
                || line.startsWith("[MESSAGE_START]")
                || line.startsWith("[MESSAGE_END]");
    }

    private String formatSendError(String line, String node, String nodeVersion, File workDir) {
        String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
        String errorMessage = jsonStr;
        try {
            JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
            if (obj.has("error")) {
                errorMessage = obj.get("error").getAsString();
            }
        } catch (Exception ignored) {
        }

        StringBuilder diagMsg = new StringBuilder();
        diagMsg.append(errorMessage);
        diagMsg.append("\n\n**【Environment Diagnostics】**  \n");
        diagMsg.append("  Node.js path: `").append(node).append("`  \n");
        diagMsg.append("  Node.js version: ").append(nodeVersion != null ? nodeVersion : "❌ unknown").append("  \n");
        diagMsg.append("  SDK directory: `").append(workDir.getAbsolutePath()).append("`  \n");
        return diagMsg.toString();
    }

    private void captureEarlyExitIfNeeded(Process process, AtomicReference<String> lastNodeError) {
        try {
            if (!process.isAlive()) {
                int earlyExitCode = process.exitValue();
                log.error("[ProcessInvoker] Process exited immediately, exitCode: " + earlyExitCode);
                try (BufferedReader earlyReader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    StringBuilder earlyOutput = new StringBuilder();
                    String line;
                    while ((line = earlyReader.readLine()) != null) {
                        earlyOutput.append(line).append("\n");
                        log.error("[ProcessInvoker] Process output: " + line);
                    }
                    log.debug("[ProcessInvoker] Early exit - captured " + earlyOutput.length() + " chars");
                    if (earlyOutput.length() > 0) {
                        lastNodeError.set(earlyOutput.toString().trim());
                    }
                }
            }
        } catch (Exception earlyCheckError) {
            log.debug("[ProcessInvoker] Early exit check failed: " + earlyCheckError.getMessage());
        }
    }

}
