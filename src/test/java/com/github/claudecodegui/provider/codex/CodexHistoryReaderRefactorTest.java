package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.CustomPricingProvider;
import com.github.claudecodegui.provider.codex.CodexHistoryReader.CodexMessage;
import com.github.claudecodegui.provider.codex.CodexHistoryReader.ProjectStatistics;
import com.github.claudecodegui.provider.codex.CodexHistoryReader.SessionInfo;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class CodexHistoryReaderRefactorTest {

    private final Gson gson = new Gson();

    private Path pricingIsolationDir;

    /**
     * The aggregator consults the CustomPricingProvider singleton, which reads the developer's
     * real ~/.codemoss/config.json. Point it at an empty config so the exact-cost assertions
     * below stay hermetic regardless of local custom pricing.
     */
    @Before
    public void isolateCustomPricingFromLocalConfig() throws IOException {
        pricingIsolationDir = Files.createTempDirectory("codex-history-pricing-isolation");
        CustomPricingProvider.setInstanceForTests(
                CustomPricingProvider.createForTests(pricingIsolationDir.resolve("config.json")));
    }

    @After
    public void restoreCustomPricingSingleton() throws IOException {
        CustomPricingProvider.setInstanceForTests(null);
        Files.deleteIfExists(pricingIsolationDir);
    }

    @Test
    public void parserBuildsSessionInfoFromSessionFile() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-parser");
        try {
            Path sessionFile = writeSessionFile(
                    sessionsDir,
                    "session-1",
                    line("2026-03-10T10:00:00Z", "session_meta", "{\"cwd\":\"/workspace/demo\",\"timestamp\":\"2026-03-10T10:00:00Z\"}"),
                    line("2026-03-10T10:01:00Z", "event_msg", "{\"type\":\"user_message\",\"message\":\"<command-name>review</command-name>\\n请帮我检查一下这个文件的改动是否安全\"}"),
                    line("2026-03-10T10:02:00Z", "response_item", "{\"type\":\"function_call\",\"name\":\"shell_command\",\"arguments\":\"{\\\"command\\\":\\\"pwd\\\"}\"}"),
                    line("2026-03-10T10:03:00Z", "response_item", "{\"type\":\"message\"}")
            );

            CodexHistoryParser parser = new CodexHistoryParser(new Gson());

            SessionInfo session = parser.parseSessionFile(sessionFile);

            assertNotNull(session);
            assertEquals("session-1", session.sessionId);
            assertEquals("/workspace/demo", session.cwd);
            assertEquals(2, session.messageCount);
            assertEquals(Instant.parse("2026-03-10T10:00:00Z").toEpochMilli(), session.firstTimestamp);
            assertEquals(Instant.parse("2026-03-10T10:03:00Z").toEpochMilli(), session.lastTimestamp);
            assertTrue(session.title.contains("review"));
            assertTrue(session.title.endsWith("..."));
            assertTrue(parser.isValidSession(session));
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void sessionServiceTransformsFileViewingShellCommandToRead() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-messages");
        try {
            writeSessionFile(
                    sessionsDir,
                    "session-2",
                    line("2026-03-10T10:00:00Z", "response_item", "{\"type\":\"function_call\",\"name\":\"shell_command\",\"arguments\":\"{\\\"command\\\":\\\"sed -n '1,20p' src/App.tsx\\\"}\"}"),
                    line("2026-03-10T10:01:00Z", "response_item", "{\"type\":\"function_call\",\"name\":\"shell_command\",\"arguments\":\"{\\\"command\\\":\\\"npm test\\\"}\"}")
            );

            CodexHistorySessionService service = new CodexHistorySessionService(sessionsDir, gson);
            Type listType = new TypeToken<List<CodexMessage>>() {}.getType();

            List<CodexMessage> messages = gson.fromJson(service.getSessionMessagesAsJson("session-2"), listType);

            assertEquals(2, messages.size());
            assertEquals("read", messages.get(0).payload.get("name").getAsString());
            assertEquals("shell_command", messages.get(1).payload.get("name").getAsString());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void sessionServiceReadsConcatenatedJsonObjectsFromOnePhysicalLine() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-concatenated");
        try {
            String first = line("2026-03-10T10:00:00Z", "event_msg",
                    "{\"type\":\"user_message\",\"message\":\"first\"}");
            String second = line("2026-03-10T10:01:00Z", "response_item",
                    "{\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}");
            writeSessionFile(sessionsDir, "session-concatenated", first + second);

            CodexHistorySessionService service = new CodexHistorySessionService(sessionsDir, gson);
            Type listType = new TypeToken<List<CodexMessage>>() {}.getType();

            List<CodexMessage> messages = gson.fromJson(
                    service.getSessionMessagesAsJson("session-concatenated"), listType);

            assertEquals(2, messages.size());
            assertEquals("event_msg", messages.get(0).type);
            assertEquals("response_item", messages.get(1).type);
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void indexServiceDeduplicatesSessionsByCanonicalSessionId() {
        SessionInfo first = new SessionInfo();
        first.sessionId = "thread-1";
        first.title = "older";
        first.messageCount = 10;
        first.firstTimestamp = Instant.parse("2026-03-10T10:00:00Z").toEpochMilli();
        first.lastTimestamp = Instant.parse("2026-03-10T10:10:00Z").toEpochMilli();
        first.cwd = "/workspace/demo";

        SessionInfo second = new SessionInfo();
        second.sessionId = "thread-1";
        second.title = "newer";
        second.messageCount = 15;
        second.firstTimestamp = Instant.parse("2026-03-10T09:55:00Z").toEpochMilli();
        second.lastTimestamp = Instant.parse("2026-03-10T10:20:00Z").toEpochMilli();
        second.cwd = "/workspace/demo";

        SessionInfo third = new SessionInfo();
        third.sessionId = "thread-2";
        third.title = "another";
        third.messageCount = 3;
        third.firstTimestamp = Instant.parse("2026-03-11T08:00:00Z").toEpochMilli();
        third.lastTimestamp = Instant.parse("2026-03-11T08:05:00Z").toEpochMilli();
        third.cwd = "/workspace/other";

        List<SessionInfo> deduplicated = CodexHistoryIndexService.deduplicateSessions(List.of(first, second, third));

        assertEquals(2, deduplicated.size());
        assertEquals("thread-2", deduplicated.get(0).sessionId);
        assertEquals("thread-1", deduplicated.get(1).sessionId);
        assertEquals("newer", deduplicated.get(1).title);
        assertEquals(15, deduplicated.get(1).messageCount);
        assertEquals(Instant.parse("2026-03-10T09:55:00Z").toEpochMilli(), deduplicated.get(1).firstTimestamp);
        assertEquals(Instant.parse("2026-03-10T10:20:00Z").toEpochMilli(), deduplicated.get(1).lastTimestamp);
    }

    @Test
    public void usageAggregatorBuildsStatisticsFromSessionSummaries() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-usage");
        try {
            writeSessionFile(
                    sessionsDir.resolve("2026/03/10"),
                    "session-3",
                    line("2026-03-10T10:00:00Z", "turn_context", "{\"model\":\"gpt-5.1\"}"),
                    line("2026-03-10T10:01:00Z", "event_msg", "{\"type\":\"user_message\",\"message\":\"Summarize test results\"}"),
                    line("2026-03-10T10:02:00Z", "event_msg", "{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1000,\"output_tokens\":250,\"cached_input_tokens\":50}}}")
            );
            writeSessionFile(
                    sessionsDir.resolve("2026/03/16"),
                    "session-4",
                    line("2026-03-16T09:00:00Z", "turn_context", "{\"model\":\"gpt-5.1\"}"),
                    line("2026-03-16T09:01:00Z", "event_msg", "{\"type\":\"user_message\",\"message\":\"Explain the latest refactor\"}"),
                    line("2026-03-16T09:02:00Z", "event_msg", "{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":2000,\"output_tokens\":500,\"cached_input_tokens\":100}}}")
            );

            CodexUsageAggregator aggregator = new CodexUsageAggregator(sessionsDir, new CodexHistoryParser(new Gson()), new Gson());

            ProjectStatistics stats = aggregator.getProjectStatistics("all", 0);

            assertEquals("All Projects", stats.projectName);
            assertEquals(2, stats.totalSessions);
            assertEquals(3000, stats.totalUsage.inputTokens);
            assertEquals(750, stats.totalUsage.outputTokens);
            assertEquals(150, stats.totalUsage.cacheReadTokens);
            assertEquals(3750, stats.totalUsage.totalTokens);
            assertEquals(2, stats.sessions.size());
            assertEquals(2, stats.byModel.get(0).sessionCount);
            assertFalse(stats.dailyUsage.isEmpty());
            assertEquals(0.01108125, stats.estimatedCost, 0.0000001);
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void usageAggregatorUsesModelSpecificPricingForNewerModels() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-pricing");
        try {
            writeSessionFile(
                    sessionsDir.resolve("2026/03/10"),
                    "session-8",
                    line("2026-03-10T10:00:00Z", "turn_context", "{\"model\":\"gpt-5.4\"}"),
                    line("2026-03-10T10:01:00Z", "event_msg", "{\"type\":\"user_message\",\"message\":\"Summarize test results\"}"),
                    line("2026-03-10T10:02:00Z", "event_msg",
                            "{\"type\":\"token_count\",\"info\":{\"total_token_usage\":"
                                    + "{\"input_tokens\":3500,\"output_tokens\":250,"
                                    + "\"cached_input_tokens\":1500,\"total_tokens\":3750}}}")
            );

            CodexUsageAggregator aggregator = new CodexUsageAggregator(sessionsDir, new CodexHistoryParser(new Gson()), new Gson());

            ProjectStatistics stats = aggregator.getProjectStatistics("all", 0);

            assertEquals(1, stats.totalSessions);
            assertEquals(3500, stats.totalUsage.inputTokens);
            assertEquals(250, stats.totalUsage.outputTokens);
            assertEquals(1500, stats.totalUsage.cacheReadTokens);
            assertEquals(3750, stats.totalUsage.totalTokens);
            assertEquals(0.009125, stats.estimatedCost, 0.0000001);
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void historyReaderReadsSessionsEvenWhenLocalConfigAuthorizationIsFalse() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-reader");
        try {
            writeSessionFile(
                    sessionsDir.resolve("2026/03/10"),
                    "session-5",
                    line("2026-03-10T10:00:00Z", "session_meta", "{\"cwd\":\"/workspace/demo\",\"timestamp\":\"2026-03-10T10:00:00Z\"}"),
                    line("2026-03-10T10:01:00Z", "event_msg", "{\"type\":\"user_message\",\"message\":\"Review this regression\"}"),
                    line("2026-03-10T10:02:00Z", "response_item", "{\"type\":\"message\"}")
            );

            CodexHistoryReader reader = createReaderWithLocalConfigAuthorization(sessionsDir, false);

            List<SessionInfo> sessions = reader.readAllSessions();

            assertEquals(1, sessions.size());
            assertEquals("session-5", sessions.get(0).sessionId);
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void historyReaderReadsSessionMessagesEvenWhenLocalConfigAuthorizationIsFalse() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-reader-messages");
        try {
            writeSessionFile(
                    sessionsDir.resolve("2026/03/10"),
                    "session-6",
                    line("2026-03-10T10:00:00Z", "response_item", "{\"type\":\"function_call\",\"name\":\"shell_command\",\"arguments\":\"{\\\"command\\\":\\\"pwd\\\"}\"}")
            );

            CodexHistoryReader reader = createReaderWithLocalConfigAuthorization(sessionsDir, false);
            Type listType = new TypeToken<List<CodexMessage>>() {}.getType();

            List<CodexMessage> messages = gson.fromJson(reader.getSessionMessagesAsJson("session-6"), listType);

            assertEquals(1, messages.size());
            assertEquals("read", messages.get(0).payload.get("name").getAsString());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void historyReaderBuildsUsageStatisticsEvenWhenLocalConfigAuthorizationIsFalse() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-reader-stats");
        try {
            writeSessionFile(
                    sessionsDir.resolve("2026/03/10"),
                    "session-7",
                    line("2026-03-10T10:00:00Z", "turn_context", "{\"model\":\"gpt-5.1\"}"),
                    line("2026-03-10T10:01:00Z", "event_msg", "{\"type\":\"user_message\",\"message\":\"Summarize test results\"}"),
                    line("2026-03-10T10:02:00Z", "event_msg", "{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1000,\"output_tokens\":250,\"cached_input_tokens\":50}}}")
            );

            CodexHistoryReader reader = createReaderWithLocalConfigAuthorization(sessionsDir, false);
            ProjectStatistics stats = reader.getProjectStatistics("all", 0);

            assertEquals(1, stats.totalSessions);
            assertEquals(1250, stats.totalUsage.inputTokens + stats.totalUsage.outputTokens);
            assertFalse(stats.sessions.isEmpty());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    private CodexHistoryReader createReaderWithLocalConfigAuthorization(Path sessionsDir, boolean authorized) {
        return new CodexHistoryReader(sessionsDir, gson) {
            @Override
            boolean isCodexLocalConfigAuthorized() {
                return authorized;
            }
        };
    }

    private Path writeSessionFile(Path parentDir, String sessionId, String... lines) throws IOException {
        Files.createDirectories(parentDir);
        Path file = parentDir.resolve(sessionId + ".jsonl");
        Files.write(file, List.of(lines));
        return file;
    }

    private String line(String timestamp, String type, String payloadJson) {
        return "{\"timestamp\":\"" + timestamp + "\",\"type\":\"" + type + "\",\"payload\":" + payloadJson + "}";
    }

    private void deleteDirectory(Path dir) throws IOException {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
    }
}
