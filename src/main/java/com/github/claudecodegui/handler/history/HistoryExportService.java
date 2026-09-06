package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.provider.grok.GrokHistoryReader;
import com.github.claudecodegui.provider.kimi.KimiHistoryReader;
import com.github.claudecodegui.provider.minimax.MiniMaxHistoryReader;
import com.github.claudecodegui.provider.opencode.OpenCodeHistoryReader;
import com.github.claudecodegui.provider.pi.PiHistoryReader;
import com.github.claudecodegui.provider.omp.OmpHistoryReader;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Service for exporting session data.
 */
class HistoryExportService {

    private static final Logger LOG = Logger.getInstance(HistoryExportService.class);

    private final HandlerContext context;
    private final Gson gson = new Gson();

    HistoryExportService(HandlerContext context) {
        this.context = context;
    }

    /**
     * Export session data.
     * Reads all messages of the session and returns them to the frontend.
     */
    void handleExportSession(String content, String currentProvider) {
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始导出会话 ==========");

            try {
                // Parse JSON from frontend to extract sessionId and title
                JsonObject exportRequest = gson.fromJson(content, JsonObject.class);
                String sessionId = exportRequest.get("sessionId").getAsString();
                String title = exportRequest.get("title").getAsString();
                // Prefer provider embedded in the export request (history row) when present.
                String provider = currentProvider;
                if (exportRequest.has("provider") && !exportRequest.get("provider").isJsonNull()) {
                    String fromRequest = exportRequest.get("provider").getAsString();
                    if (fromRequest != null && !fromRequest.trim().isEmpty()) {
                        provider = fromRequest.trim();
                    }
                }

                String rawPath = context.resolveEffectiveWorkingDirectory();
                String nodePath = NodeDetector.getInstance().getCachedNodePath();
                String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
                if (projectPath == null) {
                    LOG.warn("[HistoryHandler] Project base path is null");
                    return;
                }
                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] Title: " + title);
                LOG.info("[HistoryHandler] ProjectPath: " + projectPath);
                LOG.info("[HistoryHandler] CurrentProvider: " + provider);

                JsonElement messagesElement = loadMessagesForExport(provider, sessionId, projectPath);

                // Wrap messages into an object containing sessionId and title
                JsonObject exportData = new JsonObject();
                exportData.addProperty("sessionId", sessionId);
                exportData.addProperty("title", title);
                exportData.addProperty("provider", provider != null ? provider : "claude");
                exportData.add("messages", messagesElement);

                String wrappedJson = gson.toJson(exportData);

                LOG.info("[HistoryHandler] 读取到会话消息，准备注入到前端");

                // Use Base64 encoding to avoid JavaScript string escaping issues
                String base64Json = Base64.getEncoder().encodeToString(
                        wrappedJson.getBytes(StandardCharsets.UTF_8));

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject export data');" +
                                            "if (window.onExportSessionData) { " +
                                            "  try { " +
                                            "    var base64Str = '" + base64Json + "'; " +
                                            "    var binaryStr = atob(base64Str); " +
                                            "    var bytes = new Uint8Array(binaryStr.length); " +
                                            "    for (var i = 0; i < binaryStr.length; i++) { bytes[i] = binaryStr.charCodeAt(i); } " +
                                            "    var jsonStr = new TextDecoder('utf-8').decode(bytes); " +
                                            "    window.onExportSessionData(jsonStr); " +
                                            "    console.log('[Backend->Frontend] Export data injected successfully'); " +
                                            "  } catch(e) { " +
                                            "    console.error('[Backend->Frontend] Failed to inject export data:', e); " +
                                            "  } " +
                                            "} else { " +
                                            "  console.error('[Backend->Frontend] onExportSessionData not available!'); " +
                                            "}";

                    context.executeJavaScriptQueued(jsCode);
                });

                LOG.info("[HistoryHandler] ========== 导出会话完成 ==========");

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 导出会话失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                                            "  window.addToast('导出失败: " + context.escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                                            "}";
                    context.executeJavaScriptQueued(jsCode);
                });
            }
        });
    }

    private JsonElement loadMessagesForExport(String provider, String sessionId, String projectPath)
            throws Exception {
        if ("codex".equals(provider)) {
            LOG.info("[HistoryHandler] 使用 CodexHistoryReader 读取 Codex 会话消息");
            CodexHistoryReader codexReader = new CodexHistoryReader();
            String messagesJson = codexReader.getSessionMessagesAsJson(sessionId);
            return JsonParser.parseString(messagesJson != null ? messagesJson : "[]");
        }
        if ("grok".equals(provider)) {
            LOG.info("[HistoryHandler] 使用 GrokHistoryReader 导出 Grok 会话");
            return toJsonArray(new GrokHistoryReader().getSessionMessages(sessionId, projectPath));
        }
        if ("opencode".equals(provider)) {
            LOG.info("[HistoryHandler] 使用 OpenCodeHistoryReader 导出 OpenCode 会话");
            return toJsonArray(new OpenCodeHistoryReader().getSessionMessages(sessionId, projectPath));
        }
        if ("kimi".equals(provider)) {
            LOG.info("[HistoryHandler] 使用 KimiHistoryReader 导出 Kimi 会话");
            return toJsonArray(new KimiHistoryReader().getSessionMessages(sessionId, projectPath));
        }
        if ("minimax".equals(provider)) {
            LOG.info("[HistoryHandler] 使用 MiniMaxHistoryReader 导出 MiniMax 会话");
            return toJsonArray(new MiniMaxHistoryReader().getSessionMessages(sessionId, projectPath));
        }
        if ("pi".equals(provider)) {
            LOG.info("[HistoryHandler] 使用 PiHistoryReader 导出 PI 会话");
            return toJsonArray(new PiHistoryReader().getSessionMessages(sessionId, projectPath));
        }
        if ("omp".equals(provider)) {
            LOG.info("[HistoryHandler] 使用 OmpHistoryReader 导出 OMP 会话");
            return toJsonArray(new OmpHistoryReader().getSessionMessages(sessionId, projectPath));
        }
        LOG.info("[HistoryHandler] 使用 ClaudeHistoryReader 读取 Claude 会话消息");
        ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
        String messagesJson = historyReader.getSessionMessagesAsJson(projectPath, sessionId);
        return JsonParser.parseString(messagesJson != null ? messagesJson : "[]");
    }

    private JsonElement toJsonArray(List<JsonObject> messages) {
        if (messages == null || messages.isEmpty()) {
            return new JsonArray();
        }
        JsonArray array = new JsonArray();
        for (JsonObject message : messages) {
            if (message != null) {
                array.add(message);
            }
        }
        return array;
    }
}
