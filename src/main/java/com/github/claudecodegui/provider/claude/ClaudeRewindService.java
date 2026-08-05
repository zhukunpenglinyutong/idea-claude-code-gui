package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/**
 * Executes Claude file rewind commands.
 */
class ClaudeRewindService {

    private static final String CHANNEL_SCRIPT = "channel-manager.js";

    /** Hard wall-clock timeout for the rewind Node.js process. */
    private static final long REWIND_TIMEOUT_SECONDS = 60;
    /** Grace window for the async reader thread to drain stdout after the child exits. */
    private static final long READER_DRAIN_SECONDS = 5;

    private final Logger log;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final ProcessManager processManager;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeRewindService(
            Logger log,
            Gson gson,
            NodeDetector nodeDetector,
            Supplier<File> sdkDirSupplier,
            ProcessManager processManager,
            EnvironmentConfigurator envConfigurator,
            ClaudeJsonOutputExtractor outputExtractor
    ) {
        this.log = log;
        this.gson = gson;
        this.nodeDetector = nodeDetector;
        this.sdkDirSupplier = sdkDirSupplier;
        this.processManager = processManager;
        this.envConfigurator = envConfigurator;
        this.outputExtractor = outputExtractor;
    }

    CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId, String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            JsonObject response = new JsonObject();

            try {
                String node = nodeDetector.findNodeExecutable();
                File workDir = sdkDirSupplier.get();
                if (workDir == null || !workDir.exists()) {
                    response.addProperty("success", false);
                    response.addProperty("error", "Bridge directory not ready or invalid");
                    return response;
                }

                log.info("[Rewind] Starting rewind operation");
                log.info("[Rewind] Session ID: " + sessionId);
                log.info("[Rewind] Target message ID: " + userMessageId);

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("sessionId", sessionId);
                stdinInput.addProperty("userMessageId", userMessageId);
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                String stdinJson = gson.toJson(stdinInput);

                String scriptPath = new File(workDir, CHANNEL_SCRIPT).getAbsolutePath();
                List<String> command = NodeDetector.buildNodeScriptCommand(node, scriptPath);
                command.add("claude");
                command.add("rewindFiles");

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(ClaudeBridgeUtils.resolveWorkingDirectory(workDir, cwd));
                pb.redirectErrorStream(true);

                Map<String, String> env = pb.environment();
                envConfigurator.configureProjectPath(env, cwd);
                File processTempDir = processManager.prepareClaudeTempDir();
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CLAUDE_USE_STDIN", "true");
                envConfigurator.updateProcessEnvironment(pb, node);

                // L6 fix: register with ProcessManager so cleanupAllProcesses sees this child.
                // M3 fix: explicit reader drain mirroring PromptEnhancerProcessRunner so
                // reader exceptions are categorised (IOException = expected on kill;
                // RuntimeException = real bug) instead of being swallowed wholesale.
                String channelId = ProcessManager.newChannelId("claude-rewind");
                Process process = null;
                CompletableFuture<String> outputFuture = null;
                boolean finished = false;
                int exitCode = -1;
                try {
                    process = processManager.startManagedProcess(channelId, pb);
                    log.info("[Rewind] Process started, PID: " + process.pid());

                    ClaudeBridgeUtils.writeStdin(stdinJson, process);

                    final Process finalProcess = process;
                    outputFuture = CompletableFuture.supplyAsync(() -> {
                        StringBuilder output = new StringBuilder();
                        try (BufferedReader reader = new BufferedReader(
                                new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                            String line;
                            while ((line = reader.readLine()) != null) {
                                log.info("[Rewind] Output: " + line);
                                output.append(line).append("\n");
                            }
                        } catch (IOException e) {
                            // Expected when the stream is force-closed on timeout kill.
                            log.debug("[Rewind] reader stream closed: " + e.getMessage());
                        } catch (RuntimeException e) {
                            log.warn("[Rewind] reader thread failed unexpectedly", e);
                        }
                        return output.toString();
                    });

                    finished = process.waitFor(REWIND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                    if (!finished) {
                        PlatformUtils.terminateProcess(process);
                        exitCode = -1;
                    } else {
                        exitCode = process.exitValue();
                    }
                    log.info("[Rewind] Process exited with code: " + exitCode);

                    String outputStr = drainReader(outputFuture);

                    String jsonStr = outputExtractor.extractLastJsonLine(outputStr);
                    if (jsonStr != null) {
                        try {
                            return gson.fromJson(jsonStr, JsonObject.class);
                        } catch (Exception e) {
                            log.warn("[Rewind] Failed to parse JSON: " + e.getMessage());
                        }
                    }

                    response.addProperty("success", exitCode == 0);
                    if (exitCode != 0) {
                        response.addProperty("error", !finished
                                ? "Rewind process timeout"
                                : "Process exited with code: " + exitCode);
                    }
                    return response;
                } finally {
                    if (process != null) {
                        if (process.isAlive()) {
                            PlatformUtils.terminateProcess(process);
                        }
                        processManager.unregisterProcess(channelId, process);
                    }
                    if (outputFuture != null && !outputFuture.isDone()) {
                        outputFuture.cancel(true);
                    }
                }
            } catch (Exception e) {
                log.error("[Rewind] Exception: " + e.getMessage(), e);
                response.addProperty("success", false);
                response.addProperty("error", e.getMessage());
                return response;
            }
        });
    }

    /**
     * Drains the async reader future with categorised failure handling.
     *
     * <p>{@link TimeoutException} means stdout is still flowing past the drain
     * window — accept partial output rather than block indefinitely.
     * {@link ExecutionException} means the reader thread itself threw; the
     * root cause has already been logged inside the async block, so we
     * surface only a short message here.
     * {@link CancellationException} would only occur if the finally block ran
     * before this method, which the control flow prevents — log defensively.
     */
    private String drainReader(CompletableFuture<String> outputFuture) {
        try {
            return outputFuture.get(READER_DRAIN_SECONDS, TimeUnit.SECONDS).trim();
        } catch (TimeoutException te) {
            log.warn("[Rewind] Reader didn't drain within " + READER_DRAIN_SECONDS
                    + "s, continuing with partial output");
            return "";
        } catch (ExecutionException ee) {
            log.debug("[Rewind] Reader execution failed: "
                    + (ee.getCause() != null ? ee.getCause().getMessage() : ee.getMessage()));
            return "";
        } catch (CancellationException ce) {
            log.debug("[Rewind] Reader was cancelled unexpectedly");
            return "";
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            log.debug("[Rewind] Reader drain interrupted");
            return "";
        }
    }

}
