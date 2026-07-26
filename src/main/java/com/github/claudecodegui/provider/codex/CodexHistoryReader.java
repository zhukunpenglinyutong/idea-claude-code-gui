package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/**
 * Codex local history reader.
 * Reads Codex CLI session history from ~/.codex/sessions directory.
 */
public class CodexHistoryReader {

    private static final Logger LOG = Logger.getInstance(CodexHistoryReader.class);

    private final Gson gson;
    private final CodexHistoryParser parser;
    private final CodexHistoryIndexService indexService;
    private final CodexUsageAggregator usageAggregator;
    private final CodexHistorySessionService sessionService;

    private static Path defaultSessionsDir() {
        return Paths.get(NodeDetector.resolveHomeForFileOps(), ".codex", "sessions");
    }

    public CodexHistoryReader() {
        this(defaultSessionsDir(), new Gson());
    }

    CodexHistoryReader(Path sessionsDir, Gson gson) {
        this.gson = gson;
        this.parser = new CodexHistoryParser(gson);
        this.indexService = new CodexHistoryIndexService(sessionsDir, parser);
        this.usageAggregator = new CodexUsageAggregator(sessionsDir, parser, gson);
        this.sessionService = new CodexHistorySessionService(sessionsDir, gson);
    }

    /**
     * Session info.
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
    }

    /**
     * Usage data structure (compatible with Claude format).
     */
    public static class UsageData {
        public long inputTokens;
        public long outputTokens;
        public long cacheWriteTokens;
        public long cacheReadTokens;
        public long totalTokens;
    }

    /**
     * Session summary for statistics.
     */
    public static class SessionSummary {
        public String sessionId;
        public long timestamp;
        public String model;
        public UsageData usage;
        public double cost;
        public String summary;
    }

    /**
     * Daily usage statistics.
     */
    public static class DailyUsage {
        public String date;
        public int sessions;
        public UsageData usage;
        public double cost;
        public List<String> modelsUsed;
    }

    /**
     * Model usage statistics.
     */
    public static class ModelUsage {
        public String model;
        public double totalCost;
        public long totalTokens;
        public long inputTokens;
        public long outputTokens;
        public long cacheCreationTokens;
        public long cacheReadTokens;
        public int sessionCount;
    }

    /**
     * Weekly comparison data.
     */
    public static class WeeklyComparison {
        public WeekData currentWeek;
        public WeekData lastWeek;
        public Trends trends;

        public static class WeekData {
            public int sessions;
            public double cost;
            public long tokens;
        }

        public static class Trends {
            public double sessions;
            public double cost;
            public double tokens;
        }
    }

    /**
     * Project statistics.
     */
    public static class ProjectStatistics {
        public String projectPath;
        public String projectName;
        public int totalSessions;
        public UsageData totalUsage;
        public double estimatedCost;
        public List<SessionSummary> sessions;
        public List<DailyUsage> dailyUsage;
        public WeeklyComparison weeklyComparison;
        public List<ModelUsage> byModel;
        public long lastUpdated;
    }

    /**
     * Codex message format.
     */
    public static class CodexMessage {
        public String timestamp;
        public String type;
        public JsonObject payload;
    }

    /**
     * Read all Codex sessions.
     * Returns all sessions regardless of project.
     * Uses memory cache and file index for performance optimization.
     */
    public List<SessionInfo> readAllSessions() throws IOException {
        logSessionAccessWithoutLocalConfigAuthorization();
        return indexService.readAllSessions();
    }

    /**
     * Get all sessions as JSON string.
     */
    public String getAllSessionsAsJson() {
        try {
            List<SessionInfo> sessions = readAllSessions();

            int totalMessages = sessions.stream()
                                        .mapToInt(s -> s.messageCount)
                                        .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Codex sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * Get sessions filtered by project path as JSON string.
     * Only returns sessions whose cwd matches or is under the specified project path.
     *
     * @param projectPath The project path to filter by
     */
    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> allSessions = readAllSessions();

            // Normalize the project path for comparison
            String normalizedProjectPath = normalizePath(projectPath);

            LOG.info("[CodexHistoryReader] Filtering sessions for project: " + normalizedProjectPath);
            LOG.info("[CodexHistoryReader] Total sessions before filtering: " + allSessions.size());

            // Filter sessions by cwd
            List<SessionInfo> filteredSessions = allSessions.stream()
                                                         .filter(session -> {
                                                             if (session.cwd == null || session.cwd.isEmpty()) {
                                                                 return false;
                                                             }
                                                             String normalizedCwd = normalizePath(session.cwd);
                                                             // Match if cwd equals project path or is a subdirectory of it
                                                             boolean matches = normalizedCwd.equals(normalizedProjectPath) ||
                                                                                       normalizedCwd.startsWith(normalizedProjectPath + "/");
                                                             if (matches) {
                                                                 LOG.debug("[CodexHistoryReader] Session " + session.sessionId + " matches (cwd: " + session.cwd + ")");
                                                             }
                                                             return matches;
                                                         })
                                                         .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Sessions after filtering: " + filteredSessions.size());

            int totalMessages = filteredSessions.stream()
                                        .mapToInt(s -> s.messageCount)
                                        .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", filteredSessions);
            result.put("total", totalMessages);
            result.put("sessionCount", filteredSessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions for project: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Codex sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * Normalize path for comparison.
     * Converts backslashes to forward slashes and removes trailing slashes.
     */
    private String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        // Convert backslashes to forward slashes
        String normalized = path.replace("\\", "/");
        // Remove trailing slash
        while (normalized.endsWith("/") && normalized.length() > 1) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    public String getSessionMessagesAsJson(String sessionId) {
        logSessionAccessWithoutLocalConfigAuthorization();
        return sessionService.getSessionMessagesAsJson(sessionId);
    }

    /**
     * Stream one session without materializing the complete JSONL file in memory.
     *
     * @return number of parsed top-level Codex records
     */
    public int forEachSessionMessage(String sessionId, Consumer<JsonObject> consumer) throws IOException {
        logSessionAccessWithoutLocalConfigAuthorization();
        return sessionService.forEachSessionMessage(sessionId, message -> {
            JsonObject raw = gson.toJsonTree(message).getAsJsonObject();
            consumer.accept(raw);
        });
    }

    /**
     * Get project statistics for usage tracking.
     * Note: Codex sessions don't store project path, so we return all sessions.
     *
     * @param projectPath project path (Codex ignores this and returns all sessions)
     * @param cutoffTime  earliest timestamp (ms) to include; 0 means no cutoff (all time)
     */
    public ProjectStatistics getProjectStatistics(String projectPath, long cutoffTime) {
        logSessionAccessWithoutLocalConfigAuthorization();
        return usageAggregator.getProjectStatistics(projectPath, cutoffTime);
    }

    /**
     * Codex session history lives under ~/.codex/sessions and does not require
     * permission to read ~/.codex/config.toml or auth.json.
     */
    private void logSessionAccessWithoutLocalConfigAuthorization() {
        if (!isCodexLocalConfigAuthorized()) {
            LOG.debug("[CodexHistoryReader] Reading ~/.codex/sessions without local config authorization");
        }
    }

    boolean isCodexLocalConfigAuthorized() {
        try {
            return new CodemossSettingsService().isCodexLocalConfigAuthorized();
        } catch (Exception e) {
            LOG.warn("[CodexHistoryReader] Failed to read Codex local authorization state: " + e.getMessage());
            return false;
        }
    }
}
