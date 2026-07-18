package com.github.claudecodegui.provider.ppcc;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.AiProviderBridge;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.File;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;


/** PPCC provider adapter over the existing Node ai-bridge daemon. */
public class PpccSDKBridge implements AiProviderBridge {
    private final DaemonBridge daemon;
    private final String configPath;

    public PpccSDKBridge() {
        this(
                new BridgeDirectoryResolver(),
                new EnvironmentConfigurator(),
                resolveConfigPath()
        );
    }

    public PpccSDKBridge(BridgeDirectoryResolver resolver, EnvironmentConfigurator environment, String configPath) {
        this(new DaemonBridge(NodeDetector.getInstance(), resolver, environment), configPath);
    }

    PpccSDKBridge(DaemonBridge daemon, String configPath) {
        this.daemon = daemon;
        this.configPath = configPath;
    }

    @Override
    public String providerId() {
        return "ppcc";
    }

    @Override
    public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("channelId", channelId);
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        return result;
    }

    @Override
    public void interruptChannel(String channelId) {
        // Outer daemon owns the active PPCC run id and acknowledges cancellation
        // only after the inner PPCC daemon has accepted ppcc.cancel(runId).
        daemon.sendPpccCancel().exceptionally(error -> false);
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return Collections.emptyList();
    }

    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            String model,
            MessageCallback callback
    ) {
        SDKResult result = new SDKResult();
        if (configPath == null || configPath.isBlank()) {
            result.success = false;
            result.error = "PPCC_CONFIG_PATH must point to a PPCC routing config";
            callback.onError(result.error);
            return CompletableFuture.completedFuture(result);
        }
        if (!daemon.ensureRunning()) {
            result.success = false;
            result.error = "PPCC bridge daemon failed to start";
            callback.onError(result.error);
            return CompletableFuture.completedFuture(result);
        }

        JsonObject params = new JsonObject();
        params.addProperty("runId", channelId);
        if (sessionId != null && !sessionId.isBlank()) {
            params.addProperty("sessionId", sessionId);
        }
        params.addProperty("workspace", normalizeForPpcc(cwd));
        params.addProperty("prompt", message);
        params.addProperty("configPath", normalizeForPpcc(configPath));
        String hermesConfig = System.getenv("HERMES_CONFIG_PATH");
        if (hermesConfig != null && !hermesConfig.isBlank()) {
            params.addProperty("hermesConfig", normalizeForPpcc(hermesConfig));
        }
        params.addProperty("maxTurns", 12);
        JsonArray checks = new JsonArray();
        checks.add("test");
        params.add("allowedChecks", checks);

        CompletableFuture<SDKResult> future = new CompletableFuture<>();
        daemon.sendCommand("ppcc.send", params, new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                if (line.startsWith("[CONTENT]")) {
                    callback.onMessage("content", decodePayload(line, "[CONTENT]"));
                } else if (line.startsWith("[PPCC_APPROVAL_REQUIRED]")) {
                    callback.onMessage("ppcc_approval_required", line.substring("[PPCC_APPROVAL_REQUIRED]".length()).trim());
                } else if (line.startsWith("[PPCC_EVENT]")) {
                    callback.onMessage("ppcc_event", line.substring("[PPCC_EVENT]".length()).trim());
                } else if (line.startsWith("[PPCC_RUN_COMPLETED]")) {
                    callback.onMessage("ppcc_event", line.substring("[PPCC_RUN_COMPLETED]".length()).trim());
                } else if (line.startsWith("[STREAM_START]")) {
                    callback.onMessage("stream_start", "");
                } else if (line.startsWith("[STREAM_END]")) {
                    callback.onMessage("stream_end", "");
                }
            }

            @Override
            public void onStderr(String text) {
                // Diagnostics are intentionally not forwarded as chat content.
            }

            @Override
            public void onError(String error) {
                result.success = false;
                result.error = error;
                callback.onError(error);
                future.complete(result);
            }

            @Override
            public void onComplete(boolean success) {
                result.success = success;
                if (success) {
                    callback.onComplete(result);
                } else if (!future.isDone()) {
                    callback.onError("PPCC request failed");
                }
                future.complete(result);
            }
        });
        return future;
    }

    public CompletableFuture<Boolean> respondApproval(
            String runId,
            String approvalId,
            String diffSha256,
            boolean approved
    ) {
        JsonObject params = new JsonObject();
        params.addProperty("runId", runId);
        params.addProperty("approvalId", approvalId);
        params.addProperty("diffSha256", diffSha256);
        String method = approved ? "ppcc.approve" : "ppcc.reject";
        return daemon.sendCommand(method, params, silentCallback());
    }

    private static String resolveConfigPath() {
        String configured = System.getenv("PPCC_CONFIG_PATH");
        if (configured != null && !configured.isBlank()) {
            return configured;
        }
        String home = PlatformUtils.getHomeDirectory();
        if (home == null || home.isBlank()) {
            return null;
        }
        File candidate = new File(home, ".ppcc/config.yaml");
        return candidate.isFile() ? candidate.getAbsolutePath() : null;
    }

    private String normalizeForPpcc(String path) {
        if (path == null || path.isBlank()) {
            return path;
        }
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        return NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(path) : path;
    }

    private DaemonBridge.DaemonOutputCallback silentCallback() {
        return new DaemonBridge.DaemonOutputCallback() {
            @Override public void onLine(String line) { }
            @Override public void onStderr(String text) { }
            @Override public void onError(String error) { }
            @Override public void onComplete(boolean success) { }
        };
    }

    private String decodePayload(String line, String prefix) {
        String value = line.substring(prefix.length()).trim();
        try {
            return new com.google.gson.Gson().fromJson(value, String.class);
        } catch (Exception ignored) {
            return value;
        }
    }
}
