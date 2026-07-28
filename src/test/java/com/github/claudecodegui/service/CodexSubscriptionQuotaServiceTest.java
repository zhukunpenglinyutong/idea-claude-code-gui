package com.github.claudecodegui.service;

import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodexSubscriptionQuotaServiceTest {
    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    private static final long BASE_NOW = Instant.parse("2026-06-05T09:10:00Z").toEpochMilli();

    @Test
    public void eventMsgTokenCountRegex() {
        var bad1 = """
            {"timestamp":"2026-06-05T09:00:45.366Z","type":"event_msg","payload":{"type":"agent_message","message":"test","phase":"final_answer","memory_citation":null}}""";
        var bad2 = """
            {"timestamp":"2026-06-05T09:00:45.366Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"test"}],"phase":"final_answer"}}""";
        var bad3 = """
            {"timestamp":"2026-06-05T09:00:45.431Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"xxxx","last_agent_message":"test","completed_at":1780650045,"duration_ms":15178,"time_to_first_token_ms":15061}}""";
        var good = """
            {"timestamp":"2026-06-05T09:00:45.409Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":30115,"cached_input_tokens":4480,"output_tokens":161,"reasoning_output_tokens":154,"total_tokens":30276},"last_token_usage":{"input_tokens":30115,"cached_input_tokens":4480,"output_tokens":161,"reasoning_output_tokens":154,"total_tokens":30276},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":53.0,"window_minutes":300,"resets_at":1780658406},"secondary":{"used_percent":24.0,"window_minutes":10080,"resets_at":1781144788},"credits":null,"plan_type":"plus","rate_limit_reached_type":null}}}""";

        assertFalse(CodexSubscriptionQuotaService.EVENT_MSG_TOKEN_COUNT_REGEX.matcher(bad1).find());
        assertFalse(CodexSubscriptionQuotaService.EVENT_MSG_TOKEN_COUNT_REGEX.matcher(bad2).find());
        assertFalse(CodexSubscriptionQuotaService.EVENT_MSG_TOKEN_COUNT_REGEX.matcher(bad3).find());
        assertTrue(CodexSubscriptionQuotaService.EVENT_MSG_TOKEN_COUNT_REGEX.matcher(good).find());
    }

    @Test
    public void mapsWhamUsageResetAtToResetsAtMillis() {
        JsonObject usage = JsonParser.parseString("""
                {
                  "plan_type": "plus",
                  "rate_limit": {
                    "primary_window": {
                      "used_percent": 31,
                      "reset_at": 1735401600,
                      "limit_window_seconds": 18000
                    },
                    "secondary_window": {
                      "used_percent": 58,
                      "reset_at": 1735920000,
                      "limit_window_seconds": 604800
                    }
                  }
                }
                """).getAsJsonObject();

        JsonObject payload = CodexSubscriptionQuotaService.buildPayloadFromUsage(usage, 1710000000000L);
        JsonObject windows = payload.getAsJsonObject("windows");
        JsonObject fiveHour = windows.getAsJsonObject("fiveHour");
        JsonObject weekly = windows.getAsJsonObject("weekly");

        assertEquals(31.0, fiveHour.get("usedPercent").getAsDouble(), 0.001);
        assertEquals(69.0, fiveHour.get("remainingPercent").getAsDouble(), 0.001);
        assertEquals(1735401600000L, fiveHour.get("resetsAt").getAsLong());
        assertEquals(5, fiveHour.get("windowHours").getAsInt());

        assertEquals(42.0, weekly.get("remainingPercent").getAsDouble(), 0.001);
        assertEquals(1735920000000L, weekly.get("resetsAt").getAsLong());
        assertEquals(168, weekly.get("windowHours").getAsInt());
    }

    @Test
    public void mapsSessionRateLimitsSnapshotToQuotaPayload() {
        JsonObject rateLimits = sessionRateLimits(53.0, 24.0);

        JsonObject payload = CodexSubscriptionQuotaService.buildPayloadFromSessionRateLimits(rateLimits, 1710000000000L);
        JsonObject windows = payload.getAsJsonObject("windows");

        assertEquals("session_event", payload.get("source").getAsString());
        assertEquals(53.0, windows.getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
        assertEquals(47.0, windows.getAsJsonObject("fiveHour").get("remainingPercent").getAsDouble(), 0.001);
        assertEquals(5, windows.getAsJsonObject("fiveHour").get("windowHours").getAsInt());
        assertEquals(1780658406000L, windows.getAsJsonObject("fiveHour").get("resetsAt").getAsLong());

        assertEquals(24.0, windows.getAsJsonObject("weekly").get("usedPercent").getAsDouble(), 0.001);
        assertEquals(76.0, windows.getAsJsonObject("weekly").get("remainingPercent").getAsDouble(), 0.001);
        assertEquals(168, windows.getAsJsonObject("weekly").get("windowHours").getAsInt());
        assertEquals(1781144788000L, windows.getAsJsonObject("weekly").get("resetsAt").getAsLong());
    }

    @Test
    public void mapsWeeklyOnlyPrimaryWindowToWeeklySlot() {
        JsonObject usage = JsonParser.parseString("""
                {
                  "rate_limit": {
                    "primary_window": {
                      "used_percent": 2,
                      "limit_window_seconds": 604800,
                      "reset_at": 1784511152
                    }
                  }
                }
                """).getAsJsonObject();

        JsonObject payload = CodexSubscriptionQuotaService.buildPayloadFromUsage(usage, 1710000000000L);
        JsonObject windows = payload.getAsJsonObject("windows");
        JsonObject fiveHour = windows.getAsJsonObject("fiveHour");
        JsonObject weekly = windows.getAsJsonObject("weekly");

        assertTrue(fiveHour.get("usedPercent").isJsonNull());
        assertEquals(2.0, weekly.get("usedPercent").getAsDouble(), 0.001);
        assertEquals(98.0, weekly.get("remainingPercent").getAsDouble(), 0.001);
        assertEquals(168, weekly.get("windowHours").getAsInt());
        assertEquals(1784511152000L, weekly.get("resetsAt").getAsLong());
    }

    @Test
    public void mapsWeeklyOnlySessionPrimaryToWeeklySlot() {
        JsonObject rateLimits = JsonParser.parseString("""
                {
                  "primary": {
                    "used_percent": 2,
                    "window_minutes": 10080,
                    "resets_at": 1784511152
                  }
                }
                """).getAsJsonObject();

        JsonObject payload = CodexSubscriptionQuotaService.buildPayloadFromSessionRateLimits(
                rateLimits,
                1710000000000L
        );
        JsonObject windows = payload.getAsJsonObject("windows");

        assertTrue(windows.getAsJsonObject("fiveHour").get("usedPercent").isJsonNull());
        assertEquals(2.0, windows.getAsJsonObject("weekly").get("usedPercent").getAsDouble(), 0.001);
        assertEquals(168, windows.getAsJsonObject("weekly").get("windowHours").getAsInt());
    }

    @Test
    public void keepsLegacyPositionalMappingWhenDurationsAreMissing() {
        JsonObject usage = JsonParser.parseString("""
                {
                  "rate_limit": {
                    "primary_window": { "used_percent": 30 },
                    "secondary_window": { "used_percent": 40 }
                  }
                }
                """).getAsJsonObject();

        JsonObject payload = CodexSubscriptionQuotaService.buildPayloadFromUsage(usage, 1710000000000L);
        JsonObject windows = payload.getAsJsonObject("windows");

        assertEquals(30.0, windows.getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
        assertEquals(40.0, windows.getAsJsonObject("weekly").get("usedPercent").getAsDouble(), 0.001);
    }

    @Test
    public void returnsFreshSessionSnapshotWithoutFetching() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        Path sessionsDir = newSessionsDir();
        writeSessionFile(
                sessionsDir.resolve("2026/06/05/session.jsonl"),
                sessionLine(Instant.ofEpochMilli(now.get() - 1_000).toString(), 40.0, 10.0)
        );
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(40);
                },
                sessionsDir,
                now
        );

        JsonObject payload = service.getQuotaSnapshot().join();

        assertEquals(0, fetchCount.get());
        assertEquals("session_event", payload.get("source").getAsString());
        assertEquals(40.0, payload.getAsJsonObject("windows").getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
    }

    @Test
    public void fetchesWhamUsageAndUpdatesSnapshotWhenCacheIsMissing() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(44);
                },
                newSessionsDir(),
                now
        );

        JsonObject payload = service.getQuotaSnapshot().join();
        JsonObject secondPayload = service.getQuotaSnapshot().join();

        assertEquals(1, fetchCount.get());
        assertEquals("wham_usage", payload.get("source").getAsString());
        assertEquals(44.0, payload.getAsJsonObject("windows").getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
        assertEquals(44.0, secondPayload.getAsJsonObject("windows").getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
    }

    @Test
    public void returnsStaleSnapshotWhenRefreshFails() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    if (fetchCount.incrementAndGet() == 1) {
                        return usageWithPrimaryUsedPercent(50);
                    }
                    throw new IllegalStateException("network");
                },
                newSessionsDir(),
                now
        );

        JsonObject cached = service.getQuotaSnapshot().join();
        now.addAndGet(CodexSubscriptionQuotaService.API_UPDATE_TIMEOUT.toMillis() + 1);
        JsonObject failedRefresh = service.forceRefreshForTest();

        assertFalse(cached.has("stale"));
        assertTrue(failedRefresh.get("stale").getAsBoolean());
        assertEquals(50.0, failedRefresh.getAsJsonObject("windows").getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
    }

    @Test
    public void returnsUnavailableWhenRefreshFailsWithoutCache() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    throw new IllegalStateException("network");
                },
                newSessionsDir(),
                now
        );

        JsonObject payload = service.getQuotaSnapshot().join();

        assertEquals("unavailable", payload.get("status").getAsString());
        assertEquals("network", payload.get("error").getAsString());
    }

    @Test
    public void doesNotRefetchApiWithinFiveSecondsAfterFailedAttempt() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    throw new IllegalStateException("network");
                },
                newSessionsDir(),
                now
        );

        JsonObject first = service.getQuotaSnapshot().join();
        now.addAndGet(CodexSubscriptionQuotaService.SESSION_UPDATE_TIMEOUT.toMillis() + 1);
        JsonObject second = service.getQuotaSnapshot().join();
        assertEquals(1, fetchCount.get());
        now.addAndGet(CodexSubscriptionQuotaService.API_UPDATE_TIMEOUT.toMillis() + 1);
        JsonObject third = service.getQuotaSnapshot().join();

        assertEquals("unavailable", first.get("status").getAsString());
        assertEquals("unavailable", second.get("status").getAsString());
        assertEquals("unavailable", third.get("status").getAsString());
        assertEquals("network", first.get("error").getAsString());
        assertEquals("network", second.get("error").getAsString());
        assertEquals("network", third.get("error").getAsString());
        assertEquals(2, fetchCount.get());
    }

    @Test
    public void findLastEventMsgTokenCountReturnsLatestMatchingSessionEntry() throws Exception {
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> usageWithPrimaryUsedPercent(44)
        );
        Path sessionFile = temporaryFolder.newFile("session.jsonl").toPath();
        Files.writeString(sessionFile, String.join("\n",
                "{\"timestamp\":\"2026-06-05T09:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\"}}",
                sessionLine("2026-06-05T09:01:00Z", 20.0, 10.0),
                sessionLine("2026-06-05T09:02:00Z", 60.0, 30.0)
        ), StandardCharsets.UTF_8);

        CodexHistoryReader.CodexMessage message = service.findLastEventMsgTokenCount(sessionFile).orElseThrow();

        assertEquals("2026-06-05T09:02:00Z", message.timestamp);
        assertEquals("token_count", message.payload.get("type").getAsString());
        assertEquals(60.0, message.payload.getAsJsonObject("rate_limits").getAsJsonObject("primary").get("used_percent").getAsDouble(), 0.001);
    }

    @Test
    public void findLastEventMsgTokenCountReturnsEmptyWhenNoMatchingEntryExists() throws Exception {
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> usageWithPrimaryUsedPercent(44)
        );
        Path sessionFile = temporaryFolder.newFile("no-token-count.jsonl").toPath();
        Files.writeString(sessionFile, """
                {"timestamp":"2026-06-05T09:00:00Z","type":"event_msg","payload":{"type":"agent_message"}}
                {"timestamp":"2026-06-05T09:01:00Z","type":"response_item","payload":{"type":"message"}}
                """, StandardCharsets.UTF_8);

        assertTrue(service.findLastEventMsgTokenCount(sessionFile).isEmpty());
    }

    @Test
    public void ignoresTokenCountWithoutRateLimitsAndFallsBackToWhamUsage() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        Path sessionsDir = newSessionsDir();
        writeSessionFile(sessionsDir.resolve("session.jsonl"),
                "{\"timestamp\":\"%s\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}"
                        .formatted(Instant.ofEpochMilli(now.get() - 1_000).toString()));
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(44);
                },
                sessionsDir,
                now
        );

        JsonObject payload = service.getQuotaSnapshot().join();

        assertEquals(1, fetchCount.get());
        assertEquals("wham_usage", payload.get("source").getAsString());
        assertEquals(44.0, payload.getAsJsonObject("windows").getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
    }

    @Test
    public void fallsBackToApiWhenSessionDataIsOlderThanSixtySeconds() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        Path sessionsDir = newSessionsDir();
        writeSessionFile(
                sessionsDir.resolve("2026/06/05/stale-session.jsonl"),
                sessionLine(Instant.ofEpochMilli(now.get() - 61_000).toString(), 80.0, 20.0)
        );
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(44);
                },
                sessionsDir,
                now
        );

        JsonObject payload = service.getQuotaSnapshot().join();

        assertEquals(1, fetchCount.get());
        assertEquals("wham_usage", payload.get("source").getAsString());
        assertEquals(44.0, payload.getAsJsonObject("windows").getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
    }

    @Test
    public void reusesApiSnapshotWithinSixtySecondsWithoutRefetch() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(44);
                },
                newSessionsDir(),
                now
        );

        JsonObject first = service.getQuotaSnapshot().join();
        now.addAndGet(CodexSubscriptionQuotaService.SESSION_UPDATE_TIMEOUT.toMillis() + 1);
        JsonObject second = service.getQuotaSnapshot().join();

        assertEquals(1, fetchCount.get());
        assertEquals("wham_usage", first.get("source").getAsString());
        assertEquals("wham_usage", second.get("source").getAsString());
    }

    @Test
    public void invalidateCacheForcesRefetchAfterAccountSwitch() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(44);
                },
                newSessionsDir(),
                now
        );

        service.getQuotaSnapshot().join();
        // Within the API window a second read is served from cache: no refetch.
        service.getQuotaSnapshot().join();
        assertEquals(1, fetchCount.get());

        // Switching Codex accounts must drop the previous account's snapshot so the next
        // read refetches even though the cache window has not elapsed.
        service.invalidateCache();
        JsonObject afterSwitch = service.getQuotaSnapshot().join();

        assertEquals(2, fetchCount.get());
        assertEquals("wham_usage", afterSwitch.get("source").getAsString());
    }

    @Test
    public void rescansSessionAfterFiveSecondsAndStopsUsingApi() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        Path sessionsDir = newSessionsDir();
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(44);
                },
                sessionsDir,
                now
        );

        JsonObject first = service.getQuotaSnapshot().join();
        writeSessionFile(
                sessionsDir.resolve("2026/06/05/new-session.jsonl"),
                sessionLine(Instant.ofEpochMilli(now.get()).toString(), 30.0, 10.0),
                now.get() + 1
        );
        now.addAndGet(CodexSubscriptionQuotaService.SESSION_UPDATE_TIMEOUT.toMillis() + 1);
        JsonObject second = service.getQuotaSnapshot().join();

        assertEquals(1, fetchCount.get());
        assertEquals("wham_usage", first.get("source").getAsString());
        assertEquals("session_event", second.get("source").getAsString());
        assertEquals(30.0, second.getAsJsonObject("windows").getAsJsonObject("fiveHour").get("usedPercent").getAsDouble(), 0.001);
    }

    @Test
    public void usesSessionSnapshotEvenWhenRuntimeAccessIsInactive() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        Path sessionsDir = newSessionsDir();
        writeSessionFile(
                sessionsDir.resolve("2026/06/05/session.jsonl"),
                sessionLine(Instant.ofEpochMilli(now.get() - 1_000).toString(), 40.0, 10.0)
        );
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(99);
                },
                sessionsDir,
                now
        );

        JsonObject payload = service.getQuotaSnapshot().join();

        assertEquals(0, fetchCount.get());
        assertEquals("session_event", payload.get("source").getAsString());
    }

    @Test
    public void managedModeReturnsApiKeyModePayloadWithoutTouchingAnySource() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        Path sessionsDir = newSessionsDir();
        writeSessionFile(
                sessionsDir.resolve("2026/06/05/session.jsonl"),
                sessionLine(Instant.ofEpochMilli(now.get() - 1_000).toString(), 40.0, 10.0)
        );
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(99);
                },
                sessionsDir,
                now
        );

        JsonObject payload = service.getQuotaSnapshot().join();

        assertEquals(0, fetchCount.get());
        assertEquals("unavailable", payload.get("status").getAsString());
        assertEquals("api_key_mode", payload.get("reasonCode").getAsString());
        assertEquals("none", payload.get("source").getAsString());
    }

    @Test
    public void managedModeSkipsApiFetchEvenWhenAuthJsonHasLeftoverOauthToken() {
        AtomicLong now = new AtomicLong(BASE_NOW);
        AtomicInteger fetchCount = new AtomicInteger();
        CodexSubscriptionQuotaService service = newService(
                CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED,
                authWithToken(),
                token -> {
                    fetchCount.incrementAndGet();
                    return usageWithPrimaryUsedPercent(99);
                },
                newSessionsDir(),
                now
        );

        // Exercise the refresh path directly to verify the defense-in-depth
        // check inside fetchApiSnapshot, not just the entry shortcut.
        JsonObject payload = service.forceRefreshForTest();

        assertEquals(0, fetchCount.get());
        assertEquals("unavailable", payload.get("status").getAsString());
    }

    private CodexSubscriptionQuotaService newService(
            String runtimeAccessMode,
            JsonObject auth,
            CodexSubscriptionQuotaService.WhamUsageFetcher fetcher
    ) {
        return newService(runtimeAccessMode, auth, fetcher, newSessionsDir(), new AtomicLong(BASE_NOW));
    }

    private CodexSubscriptionQuotaService newService(
            String runtimeAccessMode,
            JsonObject auth,
            CodexSubscriptionQuotaService.WhamUsageFetcher fetcher,
            Path sessionsDir,
            AtomicLong now
    ) {
        try {
            return new CodexSubscriptionQuotaService(
                    () -> runtimeAccessMode,
                    () -> auth,
                    fetcher,
                    sessionsDir,
                    now::get
            );
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private Path newSessionsDir() {
        try {
            return temporaryFolder.newFolder().toPath();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static void writeSessionFile(Path sessionFile, String content) {
        writeSessionFile(sessionFile, content, System.currentTimeMillis());
    }

    private static void writeSessionFile(Path sessionFile, String content, long modifiedAtMillis) {
        try {
            Files.createDirectories(sessionFile.getParent());
            Files.writeString(sessionFile, content, StandardCharsets.UTF_8);
            Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(modifiedAtMillis));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static JsonObject authWithToken() {
        return JsonParser.parseString("""
                {
                  "tokens": {
                    "access_token": "token"
                  }
                }
                """).getAsJsonObject();
    }

    private static JsonObject usageWithPrimaryUsedPercent(int usedPercent) {
        return JsonParser.parseString("""
                {
                  "rate_limit": {
                    "primary_window": {
                      "used_percent": %d,
                      "limit_window_seconds": 18000,
                      "reset_at": 1730947200
                    },
                    "secondary_window": {
                      "used_percent": 20,
                      "limit_window_seconds": 604800,
                      "reset_at": 1731552000
                    }
                  }
                }
                """.formatted(usedPercent)).getAsJsonObject();
    }

    private static JsonObject sessionRateLimits(double primaryUsedPercent, double secondaryUsedPercent) {
        return JsonParser.parseString("""
                {
                  "primary": {
                    "used_percent": %s,
                    "window_minutes": 300,
                    "resets_at": 1780658406
                  },
                  "secondary": {
                    "used_percent": %s,
                    "window_minutes": 10080,
                    "resets_at": 1781144788
                  }
                }
                """.formatted(primaryUsedPercent, secondaryUsedPercent)).getAsJsonObject();
    }

    private static String sessionLine(String timestamp, double primaryUsedPercent, double secondaryUsedPercent) {
        return """
                {"timestamp":"%s","type":"event_msg","payload":{"type":"token_count","rate_limits":%s}}""".formatted(
                timestamp,
                sessionRateLimits(primaryUsedPercent, secondaryUsedPercent)
        );
    }
}
