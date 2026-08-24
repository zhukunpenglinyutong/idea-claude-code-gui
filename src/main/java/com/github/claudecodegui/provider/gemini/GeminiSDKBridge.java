package com.github.claudecodegui.provider.gemini;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Gemini / Antigravity CLI bridge.
 *
 * Transport is one-shot channel-manager → agy headless stream-json (not ACP).
 * Java contract mirrors Claude send shape so
 * {@link com.github.claudecodegui.session.SessionSendService} can route uniformly.
 */
public class GeminiSDKBridge extends BaseSDKBridge {

    /** Last observed token total from [USAGE] for /context synthesis. */
    private final AtomicInteger lastUsedTokens = new AtomicInteger(0);
    private volatile String lastUsageModel = "";

    public GeminiSDKBridge() {
        super(GeminiSDKBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "gemini";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("GEMINI_USE_STDIN", "true");
        env.put("CI", "1");
        // Optional path overrides from host environment are already on process env.
        // Prefer not to invent auth keys — agy uses Google Sign-In on first TUI run.
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
        if (line.contains("[DEBUG]") || line.startsWith("[AGY]") || line.startsWith("[DIAG-")) {
            LOG.debug("[Gemini] " + line);
            return;
        }

        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[COMMAND_ERROR]")
                || line.startsWith("[UNCAUGHT_ERROR]")
                || line.startsWith("[UNHANDLED_REJECTION]")) {
            lastNodeError.set(line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
            return;
        }
        if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
            return;
        }
        if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
            return;
        }
        if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
            return;
        }
        if (line.startsWith("[BLOCK_RESET]")) {
            callback.onMessage("block_reset", "");
            return;
        }
        if (line.startsWith("[SESSION_ID]")) {
            String id = line.substring("[SESSION_ID]".length()).trim();
            if (!id.isEmpty()) {
                callback.onMessage("session_id", id);
            }
            return;
        }
        if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    result.messages.add(msg);
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "assistant";
                    callback.onMessage(msgType, jsonStr);

                    if ("assistant".equals(msgType)) {
                        String text = extractAssistantText(msg);
                        if (text != null && !text.isEmpty() && assistantContent.indexOf(text) < 0) {
                            if (text.length() >= assistantContent.length()) {
                                assistantContent.setLength(0);
                                assistantContent.append(text);
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            return;
        }
        if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
            return;
        }
        if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            assistantContent.append(content);
            callback.onMessage("content", content);
            return;
        }
        if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
            return;
        }
        if (line.startsWith("[THINKING]")) {
            callback.onMessage("thinking", line.substring("[THINKING]".length()).trim());
            return;
        }
        if (line.startsWith("[TOOL_RESULT]")) {
            callback.onMessage("tool_result", line.substring("[TOOL_RESULT]".length()).trim());
            return;
        }
        if (line.startsWith("[USAGE]")) {
            String usageJson = line.substring("[USAGE]".length()).trim();
            try {
                JsonObject usage = gson.fromJson(usageJson, JsonObject.class);
                int used = extractUsedTokens(usage);
                // Keep peak context this process lifetime for /context synthesis;
                // small checkpoint rows must not wipe a larger peak.
                if (used > lastUsedTokens.get()) {
                    lastUsedTokens.set(used);
                }
            } catch (Exception ignored) {
            }
            callback.onMessage("usage", usageJson);
            return;
        }
        if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj != null && obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
            return;
        }

        if (line.startsWith("{") && line.contains("\"success\"")) {
            try {
                JsonObject obj = gson.fromJson(line, JsonObject.class);
                if (obj != null && obj.has("success") && !obj.get("success").getAsBoolean()) {
                    String err = obj.has("error") ? obj.get("error").getAsString() : line;
                    hadSendError.set(true);
                    result.success = false;
                    result.error = err;
                    callback.onError(err);
                } else if (obj != null && obj.has("sessionId") && !obj.get("sessionId").isJsonNull()) {
                    String sid = obj.get("sessionId").getAsString();
                    if (sid != null && !sid.isEmpty()) {
                        callback.onMessage("session_id", sid);
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Context occupancy for the status ring: input (+ cache), never total/output.
     * Matches {@link com.github.claudecodegui.util.TokenUsageUtils#extractContextTokens}.
     */
    private static int extractUsedTokens(JsonObject usage) {
        return com.github.claudecodegui.util.TokenUsageUtils.extractContextTokens(usage, "gemini");
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            return jsonStr;
        }
    }

    private String extractAssistantText(JsonObject msg) {
        if (msg == null || !msg.has("message")) {
            return null;
        }
        try {
            JsonObject message = msg.getAsJsonObject("message");
            if (message == null || !message.has("content")) {
                return null;
            }
            com.google.gson.JsonElement contentEl = message.get("content");
            if (contentEl.isJsonArray()) {
                StringBuilder sb = new StringBuilder();
                for (com.google.gson.JsonElement el : contentEl.getAsJsonArray()) {
                    if (el.isJsonObject()) {
                        JsonObject block = el.getAsJsonObject();
                        if (block.has("text")) {
                            sb.append(block.get("text").getAsString());
                        }
                    }
                }
                return sb.toString();
            } else if (contentEl.isJsonPrimitive()) {
                return contentEl.getAsString();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /**
     * Full Claude-shaped send entry (preferred). One-shot channel-manager only —
     * agy does not keep a persistent ACP session in the plugin process.
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
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        String normalizedCwd = normalizeCwdForNode(cwd);

        if (model != null && !model.isEmpty()) {
            lastUsageModel = model;
        }

        JsonObject stdinInput = buildStdinPayload(
                message, sessionId, runtimeSessionEpoch, normalizedCwd, attachments,
                permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort
        );
        String stdinJson = gson.toJson(stdinInput);
        List<String> command = buildBaseCommand("send");
        LOG.info("[Gemini] sendMessage sessionId=" + (sessionId != null ? sessionId : "(new)")
                + ", epoch=" + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)")
                + ", model=" + (model != null ? model : "(default)"));

        return executeStreamingCommand(channelId, command, stdinJson, normalizedCwd, callback);
    }

    /**
     * Compatibility overload used by older call sites.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            MessageCallback callback
    ) {
        return sendMessage(
                channelId,
                message,
                sessionId,
                null,
                cwd,
                attachments,
                permissionMode,
                model,
                null,
                agentPrompt,
                true,
                false,
                null,
                callback
        );
    }

    private String normalizeCwdForNode(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return cwd;
        }
        String nodePath = nodeDetector.getCachedNodePath();
        boolean isWsl = nodePath != null && NodeDetector.isWslPath(nodePath);
        return isWsl ? NodeDetector.convertToWslPath(cwd) : cwd;
    }

    private JsonObject buildStdinPayload(
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
            boolean disableThinking,
            String reasoningEffort
    ) {
        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("message", message != null ? message : "");
        stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
        if (runtimeSessionEpoch != null && !runtimeSessionEpoch.isEmpty()) {
            stdinInput.addProperty("runtimeSessionEpoch", runtimeSessionEpoch);
        }
        stdinInput.addProperty("cwd", cwd != null ? cwd : "");
        stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        stdinInput.addProperty("model", model != null ? model : "");
        stdinInput.addProperty("agentPrompt", agentPrompt != null ? agentPrompt : "");
        stdinInput.addProperty("streaming", streaming == null || streaming);
        stdinInput.addProperty("disableThinking", disableThinking);
        if (reasoningEffort != null && !reasoningEffort.isEmpty()) {
            stdinInput.addProperty("reasoningEffort", reasoningEffort);
        }
        if (openedFiles != null) {
            stdinInput.add("openedFiles", openedFiles);
        }
        if (attachments != null && !attachments.isEmpty()) {
            JsonArray attArr = new JsonArray();
            for (ClaudeSession.Attachment a : attachments) {
                JsonObject o = new JsonObject();
                o.addProperty("fileName", a.fileName);
                o.addProperty("mediaType", a.mediaType);
                o.addProperty("data", a.data);
                attArr.add(o);
            }
            stdinInput.add("attachments", attArr);
        }
        return stdinInput;
    }

    /**
     * Fetch live model catalog from {@code agy models} via channel-manager listModels.
     * Returns JSON: {@code { success, models:[{id,label}], families:[...], binary }}.
     */
    public CompletableFuture<JsonObject> listModels() {
        return CompletableFuture.supplyAsync(() -> {
            JsonObject fallback = new JsonObject();
            fallback.addProperty("success", false);
            fallback.add("models", new JsonArray());
            fallback.add("families", new JsonArray());
            fallback.addProperty("binary", "");
            fallback.addProperty("error", "listModels failed");

            try {
                List<String> command = buildBaseCommand("listModels");
                if (command.isEmpty()) {
                    fallback.addProperty("error", "channel-manager command unavailable");
                    return fallback;
                }

                File bridgeDir = getDirectoryResolver().findSdkDir();
                if (bridgeDir == null) {
                    fallback.addProperty("error", "Bridge directory not ready");
                    return fallback;
                }

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(bridgeDir);
                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processManager.prepareClaudeTempDir());
                configureProviderEnv(env, "{}");
                String node = nodeDetector.findNodeExecutable();
                envConfigurator.updateProcessEnvironment(pb, node);
                pb.redirectErrorStream(true);

                Process process = pb.start();
                // listModels needs no stdin payload
                try {
                    process.getOutputStream().close();
                } catch (Exception ignored) {
                }

                StringBuilder out = new StringBuilder();
                try (java.io.BufferedReader reader = new java.io.BufferedReader(
                        new java.io.InputStreamReader(process.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        out.append(line).append('\n');
                    }
                }
                boolean finished = process.waitFor(20, java.util.concurrent.TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                    fallback.addProperty("error", "listModels timed out");
                    return fallback;
                }

                JsonObject parsed = extractLastJsonObject(out.toString());
                if (parsed != null && parsed.has("success")) {
                    return parsed;
                }
                fallback.addProperty("error", "No listModels JSON in output");
                fallback.addProperty("raw", out.length() > 500 ? out.substring(0, 500) : out.toString());
                return fallback;
            } catch (Exception e) {
                LOG.warn("[Gemini] listModels failed: " + e.getMessage());
                fallback.addProperty("error", e.getMessage() != null ? e.getMessage() : "listModels exception");
                return fallback;
            }
        });
    }

    private JsonObject extractLastJsonObject(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String[] lines = text.split("\\R");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.isEmpty() || !line.startsWith("{")) {
                continue;
            }
            try {
                return gson.fromJson(line, JsonObject.class);
            } catch (Exception ignored) {
                // try previous line
            }
        }
        return null;
    }

    /**
     * Best-effort context usage from last [USAGE] tags (agy has no live /context RPC).
     * Signature matches Claude bridge for ContextHandler routing.
     */
    public CompletableFuture<JsonObject> getContextUsage(String sessionId, String cwd, String model) {
        int used = lastUsedTokens.get();
        String m = model != null && !model.isEmpty() ? model : lastUsageModel;
        int max = com.github.claudecodegui.handler.provider.ModelProviderHandler
                .getModelContextLimit("gemini", m != null ? m : "");
        if (max <= 0) {
            max = 200_000;
        }
        JsonObject data = new JsonObject();
        data.addProperty("usedTokens", used);
        data.addProperty("maxTokens", max);
        data.addProperty("percentage", used <= 0 ? 0 : Math.min(100.0, Math.round(used * 1000.0 / max) / 10.0));
        data.addProperty("model", m != null ? m : "");
        data.addProperty("source", "gemini-bridge");
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.add("data", data);
        return CompletableFuture.completedFuture(result);
    }

    /**
     * Reads persisted session messages from Gemini/Antigravity CLI transcript.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new GeminiHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[GeminiSDKBridge] Failed to get session messages for " + sessionId + ": " + e.getMessage());
            return new ArrayList<>();
        }
    }
}
