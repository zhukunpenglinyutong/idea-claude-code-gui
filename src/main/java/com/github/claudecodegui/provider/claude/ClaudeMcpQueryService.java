package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * Queries MCP server status and tool metadata through the Node bridge.
 */
class ClaudeMcpQueryService {

    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final String MCP_STATUS_CHANNEL_ID = "__mcp_status__";
    private static final String MCP_TOOLS_CHANNEL_ID = "__mcp_tools__";

    private final Logger log;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final ProcessManager processManager;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeMcpQueryService(
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

    CompletableFuture<List<JsonObject>> getMcpServerStatus(String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            log.info("[McpStatus] Starting getMcpServerStatus, cwd=" + cwd);

            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("cwd", cwd != null ? cwd : "");

            MarkerResult result = executeMarkerQuery(
                    MCP_STATUS_CHANNEL_ID,
                    "getMcpServerStatus",
                    stdinInput,
                    "[MCP_SERVER_STATUS]",
                    "[McpStatus]"
            );

            if (result.markerJson != null && !result.markerJson.isEmpty()) {
                try {
                    JsonArray serversArray = gson.fromJson(result.markerJson, JsonArray.class);
                    List<JsonObject> servers = new ArrayList<>();
                    for (var server : serversArray) {
                        servers.add(server.getAsJsonObject());
                    }
                    log.info("[McpStatus] Successfully parsed " + servers.size() + " MCP servers in " + result.elapsedMs + "ms");
                    return servers;
                } catch (Exception e) {
                    log.warn("[McpStatus] Failed to parse MCP status JSON: " + e.getMessage());
                }
            }

            log.info("[McpStatus] Marker not found, trying fallback (elapsed=" + result.elapsedMs + "ms)");
            List<JsonObject> servers = new ArrayList<>();

            for (String line : result.fullOutput.split("\n")) {
                if (line.startsWith("[MCP_SERVER_STATUS]")) {
                    String fallbackJson = line.substring("[MCP_SERVER_STATUS]".length()).trim();
                    try {
                        JsonArray serversArray = gson.fromJson(fallbackJson, JsonArray.class);
                        for (var server : serversArray) {
                            servers.add(server.getAsJsonObject());
                        }
                        log.info("[McpStatus] Fallback marker parse: " + servers.size() + " servers");
                        return servers;
                    } catch (Exception e) {
                        log.debug("[McpStatus] Fallback marker parse failed: " + e.getMessage());
                    }
                }
            }

            String jsonStr = outputExtractor.extractLastJsonLine(result.fullOutput);
            if (jsonStr != null) {
                try {
                    JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                    if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean() && jsonResult.has("servers")) {
                        JsonArray serversArray = jsonResult.getAsJsonArray("servers");
                        for (var server : serversArray) {
                            servers.add(server.getAsJsonObject());
                        }
                    }
                } catch (Exception e) {
                    log.debug("[McpStatus] Fallback JSON parse failed: " + e.getMessage());
                }
            }

            return servers;
        });
    }

    CompletableFuture<JsonObject> getMcpServerTools(String serverId, String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            log.info("[McpTools] Starting getMcpServerTools, serverId=" + serverId + ", cwd=" + cwd);

            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("serverId", serverId != null ? serverId : "");
            if (cwd != null && !cwd.isEmpty()) {
                stdinInput.addProperty("cwd", cwd);
            }

            MarkerResult result = executeMarkerQuery(
                    MCP_TOOLS_CHANNEL_ID,
                    "getMcpServerTools",
                    stdinInput,
                    "[MCP_SERVER_TOOLS]",
                    "[McpTools]"
            );

            if (result.markerJson != null && !result.markerJson.isEmpty()) {
                try {
                    JsonObject parsed = gson.fromJson(result.markerJson, JsonObject.class);
                    log.info("[McpTools] Successfully got tools for server " + serverId + " in " + result.elapsedMs + "ms");
                    return parsed;
                } catch (Exception e) {
                    log.warn("[McpTools] Failed to parse MCP tools JSON: " + e.getMessage());
                }
            }

            String jsonStr = outputExtractor.extractLastJsonLine(result.fullOutput);
            if (jsonStr != null) {
                try {
                    JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                    if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                        return jsonResult;
                    }
                } catch (Exception e) {
                    log.debug("[McpTools] Fallback JSON parse failed: " + e.getMessage());
                }
            }

            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("serverId", serverId);
            errorResult.addProperty("error", "Failed to get tools list");
            return errorResult;
        });
    }

    // ============================================================================
    // Shared process execution template
    // ============================================================================

    /**
     * Execute a Node bridge command and wait for a tagged marker line in stdout.
     * Handles process lifecycle, stdin writing, marker detection via CountDownLatch, and cleanup.
     */
    private MarkerResult executeMarkerQuery(
            String channelId,
            String commandName,
            JsonObject stdinInput,
            String markerPrefix,
            String logPrefix
    ) {
        Process process = null;
        long startTime = System.currentTimeMillis();

        try {
            String node = nodeDetector.findNodeExecutable();
            File bridgeDir = sdkDirSupplier.get();
            if (bridgeDir == null || !bridgeDir.exists()) {
                log.warn(logPrefix + " Bridge directory not ready or invalid");
                log.warn(logPrefix + " This is usually caused by missing node_modules in development environment.");
                log.warn(logPrefix + " Please run: cd ai-bridge && npm install");
                return new MarkerResult(null, "", System.currentTimeMillis() - startTime);
            }

            String scriptPath = new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath();
            List<String> command = NodeDetector.buildNodeScriptCommand(node, scriptPath);
            command.add("claude");
            command.add(commandName);

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);
            envConfigurator.updateProcessEnvironment(pb, node);
            pb.environment().put("CLAUDE_USE_STDIN", "true");

            process = processManager.startManagedProcess(channelId, pb);
            final Process finalProcess = process;

            ClaudeBridgeUtils.writeStdin(gson.toJson(stdinInput), process, log, logPrefix);

            CountDownLatch markerLatch = new CountDownLatch(1);
            AtomicReference<String> markerJson = new AtomicReference<>(null);
            final StringBuilder output = new StringBuilder();

            Thread readerThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        output.append(line).append("\n");
                        if (line.startsWith(markerPrefix)) {
                            markerJson.set(line.substring(markerPrefix.length()).trim());
                            markerLatch.countDown();
                            break;
                        }
                    }
                } catch (Exception e) {
                    log.debug(logPrefix + " Reader thread exception: " + e.getMessage());
                } finally {
                    markerLatch.countDown();
                }
            });
            readerThread.start();

            markerLatch.await(65, TimeUnit.SECONDS);

            long elapsed = System.currentTimeMillis() - startTime;
            if (process.isAlive()) {
                PlatformUtils.terminateProcess(process);
            }

            return new MarkerResult(markerJson.get(), output.toString().trim(), elapsed);
        } catch (Exception e) {
            log.error(logPrefix + " Exception: " + e.getMessage());
            return new MarkerResult(null, "", System.currentTimeMillis() - startTime);
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
    }

    private static class MarkerResult {
        final String markerJson;
        final String fullOutput;
        final long elapsedMs;

        MarkerResult(String markerJson, String fullOutput, long elapsedMs) {
            this.markerJson = markerJson;
            this.fullOutput = fullOutput;
            this.elapsedMs = elapsedMs;
        }
    }
}
