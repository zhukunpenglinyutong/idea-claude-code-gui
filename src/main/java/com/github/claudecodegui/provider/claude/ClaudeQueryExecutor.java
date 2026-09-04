package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Handles one-shot simple query execution for the Claude bridge.
 */
class ClaudeQueryExecutor {

    private static final String NODE_SCRIPT = "simple-query.js";

    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final ProcessManager processManager;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeQueryExecutor(
            Gson gson,
            NodeDetector nodeDetector,
            Supplier<File> sdkDirSupplier,
            ProcessManager processManager,
            EnvironmentConfigurator envConfigurator,
            ClaudeJsonOutputExtractor outputExtractor
    ) {
        this.gson = gson;
        this.nodeDetector = nodeDetector;
        this.sdkDirSupplier = sdkDirSupplier;
        this.processManager = processManager;
        this.envConfigurator = envConfigurator;
        this.outputExtractor = outputExtractor;
    }

    SDKResult executeQuerySync(String prompt, int timeoutSeconds) {
        SDKResult result = new SDKResult();
        StringBuilder output = new StringBuilder();
        StringBuilder jsonBuffer = new StringBuilder();
        boolean inJson = false;

        try {
            String node = nodeDetector.findNodeExecutable();

            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("prompt", prompt);
            String stdinJson = gson.toJson(stdinInput);

            File workDir = sdkDirSupplier.get();
            if (workDir == null || !workDir.exists()) {
                result.success = false;
                result.error = "Bridge directory not ready or invalid";
                return result;
            }

            List<String> command = NodeDetector.buildNodeScriptCommand(
                    node, new File(workDir, NODE_SCRIPT).getAbsolutePath());

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            envConfigurator.updateProcessEnvironment(pb, node);
            pb.environment().put("CLAUDE_USE_STDIN", "true");

            // L4 fix: register with ProcessManager so cleanupAllProcesses sees this
            // child on IDE shutdown. Without it, a hung sync query leaked the node
            // process for the lifetime of the IDE.
            String channelId = ProcessManager.newChannelId("claude-query-sync");
            Process process = null;
            try {
                process = processManager.startManagedProcess(channelId, pb);
                ClaudeBridgeUtils.writeStdin(stdinJson, process);

                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                    String line;
                    while ((line = reader.readLine()) != null) {
                        output.append(line).append("\n");

                        if (line.contains("[JSON_START]")) {
                            inJson = true;
                            jsonBuffer.setLength(0);
                            continue;
                        }
                        if (line.contains("[JSON_END]")) {
                            inJson = false;
                            continue;
                        }
                        if (inJson) {
                            jsonBuffer.append(line).append("\n");
                        }

                        if (line.contains("[Assistant]:")) {
                            result.finalResult = line.substring(line.indexOf("[Assistant]:") + 12).trim();
                        }
                    }
                }

                boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
                if (!finished) {
                    PlatformUtils.terminateProcess(process);
                    result.success = false;
                    result.error = "Process timeout";
                    return result;
                }

                int exitCode = process.exitValue();
                result.rawOutput = output.toString();

                if (jsonBuffer.length() > 0) {
                    try {
                        String jsonStr = jsonBuffer.toString().trim();
                        JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                        result.success = jsonResult.get("success").getAsBoolean();

                        if (result.success) {
                            result.messageCount = jsonResult.get("messageCount").getAsInt();
                        } else {
                            result.error = jsonResult.has("error")
                                    ? jsonResult.get("error").getAsString()
                                    : "Unknown error";
                        }
                    } catch (Exception e) {
                        result.success = false;
                        result.error = "JSON parse failed: " + e.getMessage();
                    }
                } else {
                    result.success = exitCode == 0;
                    if (!result.success) {
                        result.error = "Process exit code: " + exitCode;
                    }
                }
            } finally {
                if (process != null) {
                    if (process.isAlive()) {
                        PlatformUtils.terminateProcess(process);
                    }
                    processManager.unregisterProcess(channelId, process);
                }
            }
        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
            result.rawOutput = output.toString();
        }

        return result;
    }

    CompletableFuture<SDKResult> executeQueryAsync(String prompt) {
        return CompletableFuture.supplyAsync(() -> executeQuerySync(prompt, 60));
    }

    CompletableFuture<SDKResult> executeQueryStream(String prompt, MessageCallback callback) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder output = new StringBuilder();
            StringBuilder jsonBuffer = new StringBuilder();
            boolean inJson = false;

            try {
                String node = nodeDetector.findNodeExecutable();

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("prompt", prompt);
                String stdinJson = gson.toJson(stdinInput);

                File workDir = sdkDirSupplier.get();
                if (workDir == null || !workDir.exists()) {
                    result.success = false;
                    result.error = "Bridge directory not ready or invalid";
                    return result;
                }

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(NODE_SCRIPT);

                File processTempDir = processManager.prepareClaudeTempDir();

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(workDir);
                pb.redirectErrorStream(true);

                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processTempDir);
                envConfigurator.updateProcessEnvironment(pb, node);
                env.put("CLAUDE_USE_STDIN", "true");

                // L3 fix: Without ProcessManager registration, this child was invisible
                // to cleanupAllProcesses on IDE shutdown — every stalled stream query
                // leaked a node process. We now register before any I/O and unregister
                // in the finally block, with force-kill as the last-resort cleanup.
                String channelId = ProcessManager.newChannelId("claude-query-stream");
                Process process = null;
                try {
                    process = processManager.startManagedProcess(channelId, pb);
                    ClaudeBridgeUtils.writeStdin(stdinJson, process);

                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {
                            output.append(line).append("\n");

                            if (line.contains("[Message Type:")) {
                                String type = outputExtractor.extractBetween(line, "[Message Type:", "]");
                                if (type != null) {
                                    callback.onMessage("type", type.trim());
                                }
                            }

                            if (line.contains("[Assistant]:")) {
                                String content = line.substring(line.indexOf("[Assistant]:") + 12).trim();
                                result.finalResult = content;
                                callback.onMessage("assistant", content);
                            }

                            if (line.contains("[Result]")) {
                                callback.onMessage("status", "Complete");
                            }

                            if (line.contains("[JSON_START]")) {
                                inJson = true;
                                jsonBuffer.setLength(0);
                                continue;
                            }
                            if (line.contains("[JSON_END]")) {
                                inJson = false;
                                continue;
                            }
                            if (inJson) {
                                jsonBuffer.append(line).append("\n");
                            }
                        }
                    }

                    int exitCode = process.waitFor();
                    result.rawOutput = output.toString();

                    if (jsonBuffer.length() > 0) {
                        try {
                            String jsonStr = jsonBuffer.toString().trim();
                            JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                            result.success = jsonResult.get("success").getAsBoolean();

                            if (result.success) {
                                result.messageCount = jsonResult.get("messageCount").getAsInt();
                                callback.onComplete(result);
                            } else {
                                result.error = jsonResult.has("error")
                                        ? jsonResult.get("error").getAsString()
                                        : "Unknown error";
                                callback.onError(result.error);
                            }
                        } catch (Exception e) {
                            result.success = false;
                            result.error = "JSON parse failed: " + e.getMessage();
                            callback.onError(result.error);
                        }
                    } else {
                        result.success = exitCode == 0;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            result.error = "Process exit code: " + exitCode;
                            callback.onError(result.error);
                        }
                    }
                } finally {
                    if (process != null) {
                        processManager.unregisterProcess(channelId, process);
                        processManager.waitForProcessTermination(process);
                        // Last-resort: if the child still hasn't exited (e.g. Node SDK
                        // stuck on a network read), force-kill so it does not outlive
                        // the request. Matches the cleanup guarantee enforced by
                        // ProcessManager.interruptChannel for the cancellation path.
                        if (process.isAlive()) {
                            PlatformUtils.terminateProcess(process);
                        }
                    }
                }
            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                result.rawOutput = output.toString();
                callback.onError(e.getMessage());
            }

            return result;
        });
    }

}
