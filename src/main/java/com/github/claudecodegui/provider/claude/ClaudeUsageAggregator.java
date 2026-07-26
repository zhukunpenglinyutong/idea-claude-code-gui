package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.pricing.ClaudePricing;
import com.github.claudecodegui.provider.pricing.ClaudePricingTable;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Aggregates Claude session summaries into usage statistics for the settings UI.
 */
class ClaudeUsageAggregator {

    private static final String ALL_PROJECTS = "all";
    private static final String JSONL_SUFFIX = ".jsonl";
    private static final String UNKNOWN_MODEL = "unknown";
    private static final String DEFAULT_MODEL = "claude-sonnet-4-6";

    private static final DateTimeFormatter DATE_FORMATTER =
            DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.systemDefault());

    private final Path projectsDir;
    private final ClaudeHistoryParser parser;

    ClaudeUsageAggregator(Path projectsDir, ClaudeHistoryParser parser) {
        this.projectsDir = projectsDir;
        this.parser = parser;
    }

    ClaudeHistoryReader.ProjectStatistics getProjectStatistics(String projectPath, long cutoffTime) {
        ClaudeHistoryReader.ProjectStatistics stats = initEmptyStatistics(projectPath);

        try {
            List<ClaudeHistoryReader.SessionSummary> allSessions = readSessions(projectPath);
            List<ClaudeHistoryReader.SessionSummary> filteredSessions = cutoffTime > 0
                    ? allSessions.stream().filter(session -> session.timestamp >= cutoffTime).collect(Collectors.toList())
                    : allSessions;

            stats.totalSessions = filteredSessions.size();
            processSessions(filteredSessions, stats);
        } catch (Exception ignored) {
        }

        return stats;
    }

    private ClaudeHistoryReader.ProjectStatistics initEmptyStatistics(String projectPath) {
        ClaudeHistoryReader.ProjectStatistics stats = new ClaudeHistoryReader.ProjectStatistics();
        boolean allProjects = ALL_PROJECTS.equals(projectPath);
        stats.projectPath = projectPath;
        stats.projectName = allProjects ? "All Projects" : Paths.get(projectPath).getFileName().toString();
        stats.totalUsage = new ClaudeHistoryReader.UsageData();
        stats.sessions = new ArrayList<>();
        stats.dailyUsage = new ArrayList<>();
        stats.byModel = new ArrayList<>();
        stats.weeklyComparison = new ClaudeHistoryReader.WeeklyComparison();
        stats.weeklyComparison.currentWeek = new ClaudeHistoryReader.WeeklyComparison.WeekData();
        stats.weeklyComparison.lastWeek = new ClaudeHistoryReader.WeeklyComparison.WeekData();
        stats.weeklyComparison.trends = new ClaudeHistoryReader.WeeklyComparison.Trends();
        stats.lastUpdated = System.currentTimeMillis();
        return stats;
    }

    private List<ClaudeHistoryReader.SessionSummary> readSessions(String projectPath) throws IOException {
        if (ALL_PROJECTS.equals(projectPath)) {
            return readAllSessions();
        }

        Path projectDir = resolveProjectDir(projectPath);
        return projectDir == null ? List.of() : readSessionsFromDir(projectDir);
    }

    private List<ClaudeHistoryReader.SessionSummary> readAllSessions() throws IOException {
        if (!Files.exists(projectsDir)) {
            return List.of();
        }

        List<ClaudeHistoryReader.SessionSummary> sessions = new ArrayList<>();
        try (Stream<Path> paths = Files.list(projectsDir)) {
            for (Path dir : paths.filter(Files::isDirectory).collect(Collectors.toList())) {
                sessions.addAll(readSessionsFromDir(dir));
            }
        }
        return sessions;
    }

    private Path resolveProjectDir(String projectPath) {
        if (projectPath == null || projectPath.isBlank()) {
            return null;
        }

        List<Path> candidates = List.of(
                projectsDir.resolve(projectPath.replaceAll("[^a-zA-Z0-9]", "-")),
                projectsDir.resolve(PathUtils.sanitizePath(projectPath))
        );

        return candidates.stream().filter(Files::exists).findFirst().orElse(null);
    }

    private List<ClaudeHistoryReader.SessionSummary> readSessionsFromDir(Path projectDir) {
        List<ClaudeHistoryReader.SessionSummary> sessions = new ArrayList<>();

        try (Stream<Path> paths = Files.list(projectDir)) {
            for (Path file : paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(JSONL_SUFFIX))
                    .collect(Collectors.toList())) {
                ClaudeHistoryReader.SessionSummary session = parseSessionFile(file);
                if (session != null) {
                    sessions.add(session);
                }
            }
        } catch (IOException ignored) {
        }

        return sessions;
    }

    private ClaudeHistoryReader.SessionSummary parseSessionFile(Path filePath) {
        ClaudeHistoryReader.UsageData usage = new ClaudeHistoryReader.UsageData();
        double totalCost = 0;
        String model = UNKNOWN_MODEL;
        long firstTimestamp = 0;
        String summary = null;

        try (BufferedReader reader = Files.newBufferedReader(filePath, StandardCharsets.UTF_8)) {
            // Claude Code persists each content block (thinking, tool_use, text) of one
            // assistant API response as its own JSONL line, all sharing the same message.id
            // and a duplicated usage payload. Summing per line inflates tokens/cost by the
            // average blocks-per-response (~2x), so count each message.id only once per file.
            Set<String> seenMessageIds = new HashSet<>();
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }

                try {
                    JsonObject json = JsonParser.parseString(line).getAsJsonObject();

                    if (firstTimestamp == 0) {
                        firstTimestamp = parser.parseTimestamp(readString(json, "timestamp"));
                    }

                    if (summary == null && "summary".equals(readString(json, "type"))) {
                        summary = readString(json, "summary");
                    }

                    if (!"assistant".equals(readString(json, "type"))) {
                        continue;
                    }

                    JsonObject message = readObject(json, "message");
                    JsonObject usageJson = readObject(message, "usage");
                    ClaudeHistoryReader.UsageData delta = readUsage(usageJson);
                    if (delta.totalTokens == 0) {
                        continue;
                    }

                    String messageId = readString(message, "id");
                    if (messageId != null && !seenMessageIds.add(messageId)) {
                        continue;
                    }

                    if (UNKNOWN_MODEL.equals(model)) {
                        model = readString(message, "model", UNKNOWN_MODEL);
                    }

                    mergeUsage(usage, delta);
                    totalCost += calculateCost(delta, model);
                } catch (Exception ignored) {
                }
            }
        } catch (IOException e) {
            return null;
        }

        if (usage.totalTokens == 0) {
            return null;
        }

        ClaudeHistoryReader.SessionSummary session = new ClaudeHistoryReader.SessionSummary();
        session.sessionId = filePath.getFileName().toString().replace(JSONL_SUFFIX, "");
        session.timestamp = firstTimestamp > 0 ? firstTimestamp : System.currentTimeMillis();
        session.model = UNKNOWN_MODEL.equals(model) ? DEFAULT_MODEL : model;
        session.usage = usage;
        session.cost = totalCost;
        session.summary = summary;
        return session;
    }

    private ClaudeHistoryReader.UsageData readUsage(JsonObject usageJson) {
        ClaudeHistoryReader.UsageData usage = new ClaudeHistoryReader.UsageData();
        if (usageJson == null) {
            return usage;
        }

        usage.inputTokens = readLong(usageJson, "input_tokens");
        usage.outputTokens = readLong(usageJson, "output_tokens");
        usage.cacheWriteTokens = readLong(usageJson, "cache_creation_input_tokens");
        usage.cacheReadTokens = readLong(usageJson, "cache_read_input_tokens");
        usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
        return usage;
    }

    private double calculateCost(ClaudeHistoryReader.UsageData usage, String model) {
        ClaudePricing pricing = ClaudePricingTable.resolveOrDefault(model);
        return pricing.costUsd(usage.inputTokens, usage.outputTokens, usage.cacheWriteTokens, usage.cacheReadTokens);
    }

    private void processSessions(
            List<ClaudeHistoryReader.SessionSummary> sessions,
            ClaudeHistoryReader.ProjectStatistics stats
    ) {
        Map<String, ClaudeHistoryReader.DailyUsage> dailyMap = new HashMap<>();
        Map<String, ClaudeHistoryReader.ModelUsage> modelMap = new HashMap<>();

        long now = System.currentTimeMillis();
        long oneWeekAgo = now - 7L * 24 * 3600 * 1000;
        long twoWeeksAgo = now - 14L * 24 * 3600 * 1000;

        for (ClaudeHistoryReader.SessionSummary session : sessions) {
            mergeUsage(stats.totalUsage, session.usage);
            stats.estimatedCost += session.cost;

            ClaudeHistoryReader.DailyUsage daily = dailyMap.computeIfAbsent(
                    DATE_FORMATTER.format(Instant.ofEpochMilli(session.timestamp)),
                    this::createDailyUsage
            );
            daily.sessions++;
            daily.cost += session.cost;
            mergeUsage(daily.usage, session.usage);
            if (!daily.modelsUsed.contains(session.model)) {
                daily.modelsUsed.add(session.model);
            }

            ClaudeHistoryReader.ModelUsage modelUsage = modelMap.computeIfAbsent(session.model, this::createModelUsage);
            modelUsage.sessionCount++;
            modelUsage.totalCost += session.cost;
            modelUsage.totalTokens += session.usage.totalTokens;
            modelUsage.inputTokens += session.usage.inputTokens;
            modelUsage.outputTokens += session.usage.outputTokens;
            modelUsage.cacheCreationTokens += session.usage.cacheWriteTokens;
            modelUsage.cacheReadTokens += session.usage.cacheReadTokens;

            ClaudeHistoryReader.WeeklyComparison.WeekData week = session.timestamp > oneWeekAgo
                    ? stats.weeklyComparison.currentWeek
                    : session.timestamp > twoWeeksAgo ? stats.weeklyComparison.lastWeek : null;
            if (week != null) {
                week.sessions++;
                week.cost += session.cost;
                week.tokens += session.usage.totalTokens;
            }
        }

        stats.dailyUsage = dailyMap.values().stream()
                .sorted((a, b) -> a.date.compareTo(b.date))
                .collect(Collectors.toList());
        stats.byModel = modelMap.values().stream()
                .sorted((a, b) -> Double.compare(b.totalCost, a.totalCost))
                .collect(Collectors.toList());
        stats.sessions = sessions.stream()
                .sorted((a, b) -> Long.compare(b.timestamp, a.timestamp))
                .limit(200)
                .collect(Collectors.toList());

        stats.weeklyComparison.trends.sessions = calculateTrend(
                stats.weeklyComparison.currentWeek.sessions,
                stats.weeklyComparison.lastWeek.sessions
        );
        stats.weeklyComparison.trends.cost = calculateTrend(
                stats.weeklyComparison.currentWeek.cost,
                stats.weeklyComparison.lastWeek.cost
        );
        stats.weeklyComparison.trends.tokens = calculateTrend(
                stats.weeklyComparison.currentWeek.tokens,
                stats.weeklyComparison.lastWeek.tokens
        );
    }

    private ClaudeHistoryReader.DailyUsage createDailyUsage(String date) {
        ClaudeHistoryReader.DailyUsage usage = new ClaudeHistoryReader.DailyUsage();
        usage.date = date;
        usage.usage = new ClaudeHistoryReader.UsageData();
        usage.modelsUsed = new ArrayList<>();
        return usage;
    }

    private ClaudeHistoryReader.ModelUsage createModelUsage(String model) {
        ClaudeHistoryReader.ModelUsage usage = new ClaudeHistoryReader.ModelUsage();
        usage.model = model;
        return usage;
    }

    private void mergeUsage(ClaudeHistoryReader.UsageData target, ClaudeHistoryReader.UsageData source) {
        target.inputTokens += source.inputTokens;
        target.outputTokens += source.outputTokens;
        target.cacheWriteTokens += source.cacheWriteTokens;
        target.cacheReadTokens += source.cacheReadTokens;
        target.totalTokens += source.totalTokens;
    }

    private double calculateTrend(double current, double last) {
        return last == 0 ? 0 : ((current - last) / last) * 100;
    }

    private JsonObject readObject(JsonObject json, String key) {
        return json != null && json.has(key) && json.get(key).isJsonObject() ? json.getAsJsonObject(key) : null;
    }

    private String readString(JsonObject json, String key) {
        return readString(json, key, null);
    }

    private String readString(JsonObject json, String key, String fallback) {
        return json != null && json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : fallback;
    }

    private long readLong(JsonObject json, String key) {
        return json != null && json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsLong() : 0;
    }
}
