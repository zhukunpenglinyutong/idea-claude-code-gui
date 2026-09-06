package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.provider.dsh.DshHistoryReader;
import com.github.claudecodegui.provider.grok.GrokHistoryReader;
import com.github.claudecodegui.provider.kimi.KimiHistoryReader;
import com.github.claudecodegui.provider.minimax.MiniMaxHistoryReader;
import com.github.claudecodegui.provider.opencode.OpenCodeHistoryReader;
import com.github.claudecodegui.provider.pi.PiHistoryReader;
import com.github.claudecodegui.provider.omp.OmpHistoryReader;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;

/**
 * Service for loading and enhancing history data.
 * Handles loading history records, deep search (cache clear + reload),
 * and enriching data with favorites and custom titles.
 */
class HistoryLoadService {

    private static final Logger LOG = Logger.getInstance(HistoryLoadService.class);

    private final HandlerContext context;
    private final NodeJsServiceCaller nodeJsServiceCaller;

    HistoryLoadService(HandlerContext context, NodeJsServiceCaller nodeJsServiceCaller) {
        this.context = context;
        this.nodeJsServiceCaller = nodeJsServiceCaller;
    }

    /**
     * Load and inject history data into the frontend (including favorite info).
     *
     * @param provider the provider identifier ("claude" or "codex")
     */
    void handleLoadHistoryData(String provider) {
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始加载历史数据 ========== provider=" + provider);

            try {
                String historyJson;

                // Get current project path
                String rawPath = context.resolveEffectiveWorkingDirectory();
                String nodePath = NodeDetector.getInstance().getCachedNodePath();
                String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
                if (projectPath == null) {
                    LOG.warn("[HistoryHandler] Project base path is null");
                    return;
                }

                // Choose a different reader based on the provider
                if ("codex".equals(provider)) {
                    // Use CodexHistoryReader to read Codex sessions (filtered by project)
                    LOG.info("[HistoryHandler] 使用 CodexHistoryReader 读取 Codex 会话 (项目: " + projectPath + ")");
                    CodexHistoryReader codexReader = new CodexHistoryReader();
                    historyJson = codexReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] CodexHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else if ("grok".equals(provider)) {
                    LOG.info("[HistoryHandler] 使用 GrokHistoryReader 读取 Grok 会话 (项目: " + projectPath + ")");
                    GrokHistoryReader grokReader = new GrokHistoryReader();
                    historyJson = grokReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] GrokHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else if ("pi".equals(provider)) {
                    LOG.info("[HistoryHandler] 使用 PiHistoryReader 读取 PI 会话 (项目: " + projectPath + ")");
                    PiHistoryReader piReader = new PiHistoryReader();
                    historyJson = piReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] PiHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else if ("omp".equals(provider)) {
                    LOG.info("[HistoryHandler] 使用 OmpHistoryReader 读取 OMP 会话 (项目: " + projectPath + ")");
                    OmpHistoryReader ompReader = new OmpHistoryReader();
                    historyJson = ompReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] OmpHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else if ("opencode".equals(provider)) {
                    LOG.info("[HistoryHandler] 使用 OpenCodeHistoryReader 读取 OpenCode 会话 (项目: " + projectPath + ")");
                    OpenCodeHistoryReader openCodeReader = new OpenCodeHistoryReader();
                    historyJson = openCodeReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] OpenCodeHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else if ("dsh".equals(provider)) {
                    LOG.info("[HistoryHandler] 使用 DshHistoryReader 读取 DSH 会话 (项目: " + projectPath + ")");
                    DshHistoryReader dshReader = new DshHistoryReader();
                    historyJson = dshReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] DshHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else if ("kimi".equals(provider)) {
                    LOG.info("[HistoryHandler] 使用 KimiHistoryReader 读取 Kimi 会话 (项目: " + projectPath + ")");
                    KimiHistoryReader kimiReader = new KimiHistoryReader();
                    historyJson = kimiReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] KimiHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else if ("minimax".equals(provider)) {
                    LOG.info("[HistoryHandler] 使用 MiniMaxHistoryReader 读取 MiniMax 会话 (项目: " + projectPath + ")");
                    MiniMaxHistoryReader miniMaxReader = new MiniMaxHistoryReader();
                    historyJson = miniMaxReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] MiniMaxHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else {
                    // Default: use ClaudeHistoryReader to read Claude sessions
                    LOG.info("[HistoryHandler] 使用 ClaudeHistoryReader 读取 Claude 会话");
                    ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                    historyJson = historyReader.getProjectDataAsJson(projectPath);
                }

                // Load favorite data and merge into history data
                String enhancedJson = enhanceHistoryWithFavorites(historyJson, provider);
                LOG.info("[HistoryHandler] enhanceHistoryWithFavorites 完成，JSON 长度: " + enhancedJson.length());

                // Load custom titles and merge into history data
                String finalJson = enhanceHistoryWithTitles(enhancedJson);
                LOG.info("[HistoryHandler] enhanceHistoryWithTitles 完成，JSON 长度: " + finalJson.length());

                // Use Base64 encoding to avoid JavaScript string escaping issues
                String base64Json = Base64.getEncoder().encodeToString(finalJson.getBytes(StandardCharsets.UTF_8));
                LOG.info("[HistoryHandler] Base64 编码完成，长度: " + base64Json.length());

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject history data');" +
                                            "if (window.setHistoryData) { " +
                                            "  try { " +
                                            "    var base64Str = '" + base64Json + "'; " +
                                            "    console.log('[Backend->Frontend] Base64 length:', base64Str.length); " +
                                            // Use TextDecoder to properly decode UTF-8 Base64 strings (avoid garbled non-ASCII characters)
                                            "    var binaryStr = atob(base64Str); " +
                                            "    var bytes = new Uint8Array(binaryStr.length); " +
                                            "    for (var i = 0; i < binaryStr.length; i++) { bytes[i] = binaryStr.charCodeAt(i); } " +
                                            "    var jsonStr = new TextDecoder('utf-8').decode(bytes); " +
                                            "    console.log('[Backend->Frontend] Decoded JSON length:', jsonStr.length); " +
                                            "    var data = JSON.parse(jsonStr); " +
                                            "    console.log('[Backend->Frontend] Parsed data, sessions:', data.sessions ? data.sessions.length : 0); " +
                                            "    window.setHistoryData(data); " +
                                            "    console.log('[Backend->Frontend] setHistoryData called successfully'); " +
                                            "  } catch(e) { " +
                                            "    console.error('[Backend->Frontend] Failed to parse/set history data:', e); " +
                                            "    window.setHistoryData({ success: false, error: '解析历史数据失败: ' + e.message }); " +
                                            "  } " +
                                            "} else { " +
                                            "  console.error('[Backend->Frontend] setHistoryData not available!'); " +
                                            "}";

                    context.executeJavaScriptQueued(jsCode);
                    LOG.info("[HistoryHandler] JavaScript 代码已注入");
                });

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 加载历史数据失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String errorMsg = context.escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.setHistoryData) { " +
                                            "  window.setHistoryData({ success: false, error: '" + errorMsg + "' }); " +
                                            "}";
                    context.executeJavaScriptQueued(jsCode);
                });
            }
        });
    }

    /**
     * Deep search history records.
     * Clears cache and reloads complete history from the file system.
     *
     * @param provider the provider identifier ("claude" or "codex")
     */
    void handleDeepSearchHistory(String provider) {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        LOG.info("[HistoryHandler] ========== 开始深度搜索 ========== provider=" + provider);

        try {
            if ("codex".equals(provider)) {
                SessionIndexCache.getInstance().clearAllCodexCache();
                SessionIndexManager.getInstance().clearAllCodexIndex();
            } else if ("grok".equals(provider)) {
                // Grok history is read live from disk; no dedicated index cache yet.
                LOG.info("[HistoryHandler] Grok deep search: reloading from ~/.grok/sessions");
            } else if ("pi".equals(provider) || "omp".equals(provider) || "opencode".equals(provider) || "kimi".equals(provider) || "minimax".equals(provider)) {
                // Disk readers scan live filesystem; no dedicated index cache.
                LOG.info("[HistoryHandler] " + provider + " deep search: reloading from disk");
            } else if (projectPath != null) {
                SessionIndexCache.getInstance().clearProject(projectPath);
                SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
            }

            LOG.info("[HistoryHandler] 缓存清理完成，开始重新加载历史数据...");

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 清理缓存时出错（继续加载）: " + e.getMessage());
        }

        // 3. Reload history data (using existing method)
        handleLoadHistoryData(provider);
    }

    /**
     * Enhance history data: add favorite info to each session.
     */
    private String enhanceHistoryWithFavorites(String historyJson, String currentProvider) {
        try {
            // Load favorite data
            String favoritesJson = nodeJsServiceCaller.callNodeJsFavoritesService("loadFavorites", "");

            // Parse history data and favorite data
            JsonObject history = new Gson().fromJson(historyJson, JsonObject.class);
            JsonObject favorites = new Gson().fromJson(favoritesJson, JsonObject.class);

            // Add favorite info and provider info to each session
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    // Add provider info
                    session.addProperty("provider", currentProvider);

                    if (favorites.has(sessionId)) {
                        JsonObject favoriteInfo = favorites.getAsJsonObject(sessionId);
                        session.addProperty("isFavorited", true);
                        session.addProperty("favoritedAt", favoriteInfo.get("favoritedAt").getAsLong());
                    } else {
                        session.addProperty("isFavorited", false);
                    }
                }
            }

            // Also add favorite data to the history data
            history.add("favorites", favorites);

            return new Gson().toJson(history);

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 增强历史数据失败，返回原始数据: " + e.getMessage());
            return historyJson;
        }
    }

    /**
     * Enhance history data: add custom titles to each session.
     */
    private String enhanceHistoryWithTitles(String historyJson) {
        try {
            // Load title data
            String titlesJson = nodeJsServiceCaller.callNodeJsTitlesService("loadTitles");

            // Parse history data and title data
            JsonObject history = new Gson().fromJson(historyJson, JsonObject.class);
            JsonObject titles = new Gson().fromJson(titlesJson, JsonObject.class);

            // Add custom title to each session
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    if (titles.has(sessionId)) {
                        JsonObject titleInfo = titles.getAsJsonObject(sessionId);
                        // If a custom title exists, override the original title
                        if (titleInfo.has("customTitle")) {
                            String customTitle = titleInfo.get("customTitle").getAsString();
                            session.addProperty("title", customTitle);
                            session.addProperty("hasCustomTitle", true);
                        }
                    }
                }
            }

            return new Gson().toJson(history);

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 增强标题数据失败，返回原始数据: " + e.getMessage());
            return historyJson;
        }
    }
}
