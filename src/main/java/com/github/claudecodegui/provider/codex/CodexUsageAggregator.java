package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.pricing.CodexPricingTable;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Aggregates Codex session summaries into usage statistics for the settings UI.
 */
class CodexUsageAggregator {

    private static final Logger LOG = Logger.getInstance(CodexUsageAggregator.class);

    private static final String ALL_PROJECTS = "all";
    private static final String JSONL_SUFFIX = ".jsonl";
    private static final String DEFAULT_MODEL = "gpt-5.1";

    private static final DateTimeFormatter DATE_FORMATTER =
            DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.systemDefault());

    private final Path sessionsDir;
    private final CodexHistoryParser parser;
    private final Gson gson;

    CodexUsageAggregator(Path sessionsDir, CodexHistoryParser parser, Gson gson) {
        this.sessionsDir = sessionsDir;
        this.parser = parser;
        this.gson = gson;
    }

    CodexHistoryReader.ProjectStatistics getProjectStatistics(String projectPath, long cutoffTime) {
        CodexHistoryReader.ProjectStatistics stats = initEmptyStatistics(projectPath);

        try {
            List<CodexHistoryReader.SessionSummary> allSessions = readAllSessionSummaries();
            LOG.info("[CodexHistoryReader] Total sessions before filtering: " + allSessions.size());

            if (!ALL_PROJECTS.equals(projectPath)) {
                LOG.info("[CodexHistoryReader] Project-based filtering requested for: " + projectPath);
                LOG.info("[CodexHistoryReader] Codex sessions don't track project paths, showing all sessions instead");
            }

            List<CodexHistoryReader.SessionSummary> filteredSessions = cutoffTime > 0
                    ? allSessions.stream().filter(session -> session.timestamp >= cutoffTime).collect(Collectors.toList())
                    : allSessions;

            stats.totalSessions = filteredSessions.size();
            LOG.info("[CodexHistoryReader] Filtered sessions count (cutoffTime=" + cutoffTime + "): " + stats.totalSessions);
            processSessions(filteredSessions, stats);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to get project statistics: " + e.getMessage(), e);
        }

        return stats;
    }

    private CodexHistoryReader.ProjectStatistics initEmptyStatistics(String projectPath) {
        CodexHistoryReader.ProjectStatistics stats = new CodexHistoryReader.ProjectStatistics();
        boolean allProjects = ALL_PROJECTS.equals(projectPath);
        stats.projectPath = projectPath;
        stats.projectName = allProjects ? "All Projects" : Paths.get(projectPath).getFileName().toString();
        stats.totalUsage = new CodexHistoryReader.UsageData();
        stats.sessions = new ArrayList<>();
        stats.dailyUsage = new ArrayList<>();
        stats.byModel = new ArrayList<>();
        stats.weeklyComparison = new CodexHistoryReader.WeeklyComparison();
        stats.weeklyComparison.currentWeek = new CodexHistoryReader.WeeklyComparison.WeekData();
        stats.weeklyComparison.lastWeek = new CodexHistoryReader.WeeklyComparison.WeekData();
        stats.weeklyComparison.trends = new CodexHistoryReader.WeeklyComparison.Trends();
        stats.lastUpdated = System.currentTimeMillis();
        return stats;
    }

    private List<CodexHistoryReader.SessionSummary> readAllSessionSummaries() throws IOException {
        List<CodexHistoryReader.SessionSummary> sessions = new ArrayList<>();

        if (!Files.exists(sessionsDir) || !Files.isDirectory(sessionsDir)) {
            return sessions;
        }

        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            List<Path> jsonlFiles = paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(JSONL_SUFFIX))
                    .filter(CodexHistoryParser::isNonEmptyFile)
                    .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Found " + jsonlFiles.size() + " Codex session files");

            for (Path sessionFile : jsonlFiles) {
                try {
                    CodexHistoryReader.SessionSummary summary = parseSessionSummary(sessionFile);
                    if (summary != null) {
                        sessions.add(summary);
                    }
                } catch (Exception e) {
                    LOG.warn("[CodexHistoryReader] Failed to parse session summary: " + sessionFile + " - " + e.getMessage());
                }
            }
        }

        sessions.sort((a, b) -> Long.compare(b.timestamp, a.timestamp));
        LOG.info("[CodexHistoryReader] Successfully loaded " + sessions.size() + " valid Codex sessions");
        return sessions;
    }

    private CodexHistoryReader.SessionSummary parseSessionSummary(Path sessionFile) throws IOException {
        CodexHistoryReader.SessionSummary summary = new CodexHistoryReader.SessionSummary();

        String fileName = sessionFile.getFileName().toString();
        summary.sessionId = fileName.substring(0, fileName.length() - JSONL_SUFFIX.length());
        summary.usage = new CodexHistoryReader.UsageData();
        summary.model = DEFAULT_MODEL;

        long firstTimestamp = 0;
        String sessionTitle = null;
        String actualModel = null;
        JsonObject latestTokenUsage = null;

        try (BufferedReader reader = Files.newBufferedReader(sessionFile, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }

                try {
                    CodexHistoryReader.CodexMessage msg = gson.fromJson(line, CodexHistoryReader.CodexMessage.class);
                    if (msg == null || msg.payload == null) {
                        continue;
                    }

                    if (firstTimestamp == 0 && msg.timestamp != null) {
                        firstTimestamp = parser.parseTimestamp(msg.timestamp);
                    }

                    if (actualModel == null) {
                        actualModel = extractModel(msg);
                    }

                    if (sessionTitle == null) {
                        sessionTitle = extractTitle(msg);
                    }

                    JsonObject tokenUsage = extractTokenUsage(msg, summary.usage);
                    if (tokenUsage != null) {
                        latestTokenUsage = tokenUsage;
                    }
                } catch (Exception e) {
                    LOG.debug("[CodexHistoryReader] Failed to parse line: " + e.getMessage());
                }
            }
        }

        summary.timestamp = firstTimestamp > 0 ? firstTimestamp : System.currentTimeMillis();
        summary.summary = sessionTitle;
        summary.usage.totalTokens = extractTotalTokens(summary.usage, latestTokenUsage);

        if (actualModel != null && !actualModel.isEmpty()) {
            summary.model = actualModel;
        }

        summary.cost = calculateCost(summary.usage, summary.model);

        if (sessionTitle == null && summary.usage.totalTokens == 0) {
            LOG.debug("[CodexHistoryReader] Skipping session with no valid data: " + summary.sessionId);
            return null;
        }

        return summary;
    }

    private String extractModel(CodexHistoryReader.CodexMessage msg) {
        if (!"turn_context".equals(msg.type)) {
            return null;
        }
        JsonObject payload = msg.payload;
        if (!payload.has("model") || payload.get("model").isJsonNull()) {
            return null;
        }
        String model = payload.get("model").getAsString();
        LOG.debug("[CodexHistoryReader] Found model: " + model);
        return model;
    }

    private String extractTitle(CodexHistoryReader.CodexMessage msg) {
        if (!"event_msg".equals(msg.type)) {
            return null;
        }
        return parser.extractUserMessageTitle(msg.payload);
    }

    private JsonObject extractTokenUsage(CodexHistoryReader.CodexMessage msg, CodexHistoryReader.UsageData usage) {
        if (!"event_msg".equals(msg.type)) {
            return null;
        }
        JsonObject payload = msg.payload;
        if (!payload.has("type") || !"token_count".equals(payload.get("type").getAsString())) {
            return null;
        }
        if (!payload.has("info") || payload.get("info").isJsonNull() || !payload.get("info").isJsonObject()) {
            return null;
        }
        JsonObject info = payload.getAsJsonObject("info");
        if (!info.has("total_token_usage") || !info.get("total_token_usage").isJsonObject()) {
            return null;
        }
        JsonObject totalUsage = info.getAsJsonObject("total_token_usage");
        usage.inputTokens = totalUsage.has("input_tokens") ? totalUsage.get("input_tokens").getAsLong() : 0;
        usage.outputTokens = totalUsage.has("output_tokens") ? totalUsage.get("output_tokens").getAsLong() : 0;
        usage.cacheReadTokens = totalUsage.has("cached_input_tokens")
                ? totalUsage.get("cached_input_tokens").getAsLong()
                : totalUsage.has("cache_read_input_tokens") ? totalUsage.get("cache_read_input_tokens").getAsLong() : 0;
        usage.cacheWriteTokens = 0;
        return totalUsage;
    }

    private long extractTotalTokens(CodexHistoryReader.UsageData usage, JsonObject totalUsage) {
        if (totalUsage != null && totalUsage.has("total_tokens")) {
            return totalUsage.get("total_tokens").getAsLong();
        }
        // Codex includes cached input inside input_tokens, so total usage is input + output.
        return usage.inputTokens + usage.outputTokens;
    }

    private double calculateCost(CodexHistoryReader.UsageData usage, String model) {
        // Codex folds cached input into input_tokens, so split it out before billing.
        long cachedInputTokens = Math.min(usage.cacheReadTokens, usage.inputTokens);
        long nonCachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
        return CodexPricingTable.resolveOrDefault(model)
                .costUsd(nonCachedInputTokens, usage.outputTokens, cachedInputTokens);
    }

    private void processSessions(
            List<CodexHistoryReader.SessionSummary> sessions,
            CodexHistoryReader.ProjectStatistics stats
    ) {
        aggregateTotals(sessions, stats);
        stats.sessions = sessions;
        stats.dailyUsage = buildDailyUsage(sessions);
        stats.byModel = buildModelUsage(sessions);
        buildWeeklyComparison(sessions, stats.weeklyComparison);
    }

    private void aggregateTotals(
            List<CodexHistoryReader.SessionSummary> sessions,
            CodexHistoryReader.ProjectStatistics stats
    ) {
        for (CodexHistoryReader.SessionSummary session : sessions) {
            mergeUsage(stats.totalUsage, session.usage);
            stats.estimatedCost += session.cost;
        }
    }

    private List<CodexHistoryReader.DailyUsage> buildDailyUsage(List<CodexHistoryReader.SessionSummary> sessions) {
        Map<String, CodexHistoryReader.DailyUsage> dailyMap = new HashMap<>();

        for (CodexHistoryReader.SessionSummary session : sessions) {
            String date = DATE_FORMATTER.format(Instant.ofEpochMilli(session.timestamp));

            CodexHistoryReader.DailyUsage daily = dailyMap.computeIfAbsent(date, key -> {
                CodexHistoryReader.DailyUsage created = new CodexHistoryReader.DailyUsage();
                created.date = key;
                created.usage = new CodexHistoryReader.UsageData();
                created.modelsUsed = new ArrayList<>();
                return created;
            });

            daily.sessions++;
            daily.cost += session.cost;
            mergeUsage(daily.usage, session.usage);

            if (!daily.modelsUsed.contains(session.model)) {
                daily.modelsUsed.add(session.model);
            }
        }

        List<CodexHistoryReader.DailyUsage> result = new ArrayList<>(dailyMap.values());
        result.sort((a, b) -> a.date.compareTo(b.date));
        return result;
    }

    private List<CodexHistoryReader.ModelUsage> buildModelUsage(List<CodexHistoryReader.SessionSummary> sessions) {
        Map<String, CodexHistoryReader.ModelUsage> modelMap = new HashMap<>();

        for (CodexHistoryReader.SessionSummary session : sessions) {
            CodexHistoryReader.ModelUsage modelUsage = modelMap.computeIfAbsent(session.model, key -> {
                CodexHistoryReader.ModelUsage created = new CodexHistoryReader.ModelUsage();
                created.model = key;
                return created;
            });

            modelUsage.sessionCount++;
            modelUsage.totalCost += session.cost;
            modelUsage.totalTokens += session.usage.totalTokens;
            modelUsage.inputTokens += session.usage.inputTokens;
            modelUsage.outputTokens += session.usage.outputTokens;
            modelUsage.cacheCreationTokens += session.usage.cacheWriteTokens;
            modelUsage.cacheReadTokens += session.usage.cacheReadTokens;
        }

        List<CodexHistoryReader.ModelUsage> result = new ArrayList<>(modelMap.values());
        result.sort((a, b) -> Double.compare(b.totalCost, a.totalCost));
        return result;
    }

    private void buildWeeklyComparison(
            List<CodexHistoryReader.SessionSummary> sessions,
            CodexHistoryReader.WeeklyComparison weekly
    ) {
        long now = System.currentTimeMillis();
        long oneWeekAgo = now - 7L * 24 * 60 * 60 * 1000;
        long twoWeeksAgo = now - 14L * 24 * 60 * 60 * 1000;

        for (CodexHistoryReader.SessionSummary session : sessions) {
            if (session.timestamp >= oneWeekAgo) {
                weekly.currentWeek.sessions++;
                weekly.currentWeek.cost += session.cost;
                weekly.currentWeek.tokens += session.usage.totalTokens;
            } else if (session.timestamp >= twoWeeksAgo) {
                weekly.lastWeek.sessions++;
                weekly.lastWeek.cost += session.cost;
                weekly.lastWeek.tokens += session.usage.totalTokens;
            }
        }

        if (weekly.lastWeek.sessions > 0) {
            weekly.trends.sessions =
                    ((weekly.currentWeek.sessions - weekly.lastWeek.sessions)
                            / (double) weekly.lastWeek.sessions) * 100.0;
        }
        if (weekly.lastWeek.cost > 0) {
            weekly.trends.cost =
                    ((weekly.currentWeek.cost - weekly.lastWeek.cost)
                            / weekly.lastWeek.cost) * 100.0;
        }
        if (weekly.lastWeek.tokens > 0) {
            weekly.trends.tokens =
                    ((weekly.currentWeek.tokens - weekly.lastWeek.tokens)
                            / (double) weekly.lastWeek.tokens) * 100.0;
        }
    }

    private void mergeUsage(CodexHistoryReader.UsageData target, CodexHistoryReader.UsageData source) {
        target.inputTokens += source.inputTokens;
        target.outputTokens += source.outputTokens;
        target.cacheWriteTokens += source.cacheWriteTokens;
        target.cacheReadTokens += source.cacheReadTokens;
        target.totalTokens += source.totalTokens;
    }
}
