package com.github.claudecodegui.service;

import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.CodexSettingsManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.*;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * Caches and refreshes Codex subscription quota snapshots.
 * It extracts data from 2 sources:
 * 1) Latest session files under ~/.codex/sessions, which may contain "event_msg" messages with "token_count" events that have rate limit info in their payload.
 */
@Service(Service.Level.APP)
public final class CodexSubscriptionQuotaService {

    static final Pattern EVENT_MSG_TOKEN_COUNT_REGEX = Pattern.compile(
        "\"type\"\\s*:\\s*\"event_msg\"\\s*.+\"type\"\\s*:\\s*\"token_count\"",
        Pattern.CASE_INSENSITIVE
    );
    private static final Logger LOG = Logger.getInstance(CodexSubscriptionQuotaService.class);
    private static final Gson GSON = new Gson();
    private static final String WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(12);
    private static final int FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
    private static final int WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
    static final Duration SESSION_UPDATE_TIMEOUT = Duration.ofSeconds(5);
    static final Duration SESSION_FALLBACK_TIMEOUT = Duration.ofSeconds(60);
    static final Duration API_UPDATE_TIMEOUT = Duration.ofSeconds(60);

    private static final String HOME_DIR = PlatformUtils.getHomeDirectory();
    private static final Path CODEX_SESSIONS_DIR = Paths.get(HOME_DIR, ".codex", "sessions");
    private final RuntimeAccessResolver runtimeAccessResolver;
    private final AuthSupplier authSupplier;
    private final WhamUsageFetcher usageFetcher;
    private final SnapshotCache sessionSnapshotCache;
    private final SnapshotCache apiSnapshotCache;
    private final AtomicReference<CompletableFuture<JsonObject>> inFlightRefresh = new AtomicReference<>();
    private final Object refreshLock = new Object();
    private final Path codexSessionPath;
    private final LongSupplier nowSupplier;
    private final Gson gson = new Gson();

    public CodexSubscriptionQuotaService() {
        this(
            new CodemossSettingsService()::getCodexRuntimeAccessMode,
            () -> new CodexSettingsManager(GSON).readAuthJson(),
            new HttpWhamUsageFetcher(),
            CODEX_SESSIONS_DIR,
            System::currentTimeMillis
        );
    }

    CodexSubscriptionQuotaService(
        RuntimeAccessResolver runtimeAccessResolver,
        AuthSupplier authSupplier,
        WhamUsageFetcher usageFetcher,
        Path codexSessionPath,
        LongSupplier nowSupplier
    ) {
        this.runtimeAccessResolver = runtimeAccessResolver;
        this.authSupplier = authSupplier;
        this.usageFetcher = usageFetcher;
        this.codexSessionPath = codexSessionPath;
        this.nowSupplier = nowSupplier;
        this.sessionSnapshotCache = new SnapshotCache(SESSION_UPDATE_TIMEOUT, this::fromRecentSessions);
        this.apiSnapshotCache = new SnapshotCache(API_UPDATE_TIMEOUT, this::fetchApiSnapshot);
    }

    static JsonObject buildPayloadFromUsage(JsonObject usage, long now) {
        return buildPayloadFromRateLimit(pickFirstObject(usage, "rate_limit"), now, "wham_usage");
    }

    static JsonObject buildPayloadFromSessionRateLimits(JsonObject rateLimits, long now) {
        return buildPayloadFromRateLimit(rateLimits, now, "session_event");
    }

    public static JsonObject buildUnavailablePayload(String reason, long now) {
        JsonObject payload = new JsonObject();
        payload.addProperty("status", "unavailable");
        payload.addProperty("fetchedAt", now);
        payload.addProperty("source", "none");
        payload.addProperty("error", reason != null ? reason : "unavailable");

        JsonObject windows = new JsonObject();
        windows.add("fiveHour", toWindow("5h", 5, null, "none", now));
        windows.add("weekly", toWindow("weekly", 7 * 24, null, "none", now));
        payload.add("windows", windows);
        return payload;
    }

    /**
     * API-key (managed provider) mode has no subscription quota: requests are billed
     * per token, and any OAuth credentials left in ~/.codex/auth.json belong to an
     * account unrelated to the active provider. The reasonCode lets the WebView show
     * a dedicated message instead of a generic "unavailable".
     */
    static JsonObject buildApiKeyModePayload(long now) {
        JsonObject payload = buildUnavailablePayload("API key mode has no subscription quota", now);
        payload.addProperty("reasonCode", "api_key_mode");
        return payload;
    }

    private static JsonObject buildPayloadFromRateLimit(JsonObject rateLimit, long now, String source) {
        JsonObject payload = new JsonObject();
        payload.addProperty("status", "ok");
        payload.addProperty("fetchedAt", now);
        payload.addProperty("source", source);

        JsonObject primaryWindow = pickFirstObject(rateLimit, "primary_window", "primary");
        JsonObject secondaryWindow = pickFirstObject(rateLimit, "secondary_window", "secondary");
        JsonObject fiveHourWindow = findWindowByDuration(primaryWindow, secondaryWindow, FIVE_HOUR_WINDOW_MINUTES);
        JsonObject weeklyWindow = findWindowByDuration(primaryWindow, secondaryWindow, WEEKLY_WINDOW_MINUTES);

        // Older payloads may omit duration metadata. Preserve the original positional
        // mapping for those responses, without misclassifying a duration-identified
        // weekly primary window as the five-hour window.
        if (fiveHourWindow == null && primaryWindow != weeklyWindow) {
            fiveHourWindow = primaryWindow;
        }
        if (weeklyWindow == null && secondaryWindow != fiveHourWindow) {
            weeklyWindow = secondaryWindow;
        }

        JsonObject windows = new JsonObject();
        windows.add("fiveHour", toWindow("5h", 5, fiveHourWindow, source, now));
        windows.add("weekly", toWindow("weekly", 7 * 24, weeklyWindow, source, now));
        payload.add("windows", windows);
        return payload;
    }

    private static JsonObject findWindowByDuration(
            JsonObject first,
            JsonObject second,
            int expectedMinutes
    ) {
        if (readWindowDurationMinutes(first) == expectedMinutes) {
            return first;
        }
        if (readWindowDurationMinutes(second) == expectedMinutes) {
            return second;
        }
        return null;
    }

    private static int readWindowDurationMinutes(JsonObject source) {
        int durationMinutes = readInt(source, "window_duration_mins", "window_minutes");
        if (durationMinutes > 0) {
            return durationMinutes;
        }
        int durationSeconds = readInt(source, "limit_window_seconds");
        return durationSeconds > 0 ? Math.max(1, durationSeconds / 60) : 0;
    }

    private static JsonObject toWindow(String label, int defaultHours, JsonObject source, String payloadSource, long now) {
        JsonObject window = new JsonObject();
        window.addProperty("windowLabel", label);
        int durationMinutes = readWindowDurationMinutes(source);
        window.addProperty("windowHours", durationMinutes > 0 ? Math.max(1, durationMinutes / 60) : defaultHours);

        Double usedPercent = readDoubleNullable(source, "used_percent");
        Double remainingPercent = usedPercent == null
            ? null
            : Math.max(0.0, Math.min(100.0, 100.0 - usedPercent));

        if (usedPercent != null) {
            window.addProperty("usedPercent", usedPercent);
        } else {
            window.add("usedPercent", JsonNull.INSTANCE);
        }
        if (remainingPercent != null) {
            window.addProperty("remainingPercent", remainingPercent);
        } else {
            window.add("remainingPercent", JsonNull.INSTANCE);
        }

        Long resetsAtMs = readEpochMillisNullable(source, "reset_at", "resets_at");
        if (resetsAtMs != null) {
            window.addProperty("resetsAt", resetsAtMs);
        } else {
            window.add("resetsAt", JsonNull.INSTANCE);
        }

        window.addProperty("usedTokens", 0);
        window.add("limitTokens", JsonNull.INSTANCE);
        window.add("remainingTokens", JsonNull.INSTANCE);
        window.add("usedCost", JsonNull.INSTANCE);
        window.addProperty("sessionCount", 0);
        window.addProperty("lastUpdated", now);
        window.addProperty("source", payloadSource);
        return window;
    }

    private static long getModifiedTime(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0;
        }
    }

    private static JsonObject pickFirstObject(JsonObject root, String... keys) {
        if (root == null) {
            return null;
        }
        for (String key : keys) {
            if (root.has(key) && root.get(key).isJsonObject()) {
                return root.getAsJsonObject(key);
            }
        }
        return null;
    }

    private static String readAccessToken(JsonObject auth) {
        JsonObject tokens = pickFirstObject(auth, "tokens");
        if (tokens == null) {
            return null;
        }
        return readStringNullable(tokens, "access_token", "accessToken");
    }

    private static String readStringNullable(JsonObject obj, String... keys) {
        if (obj == null) {
            return null;
        }
        for (String key : keys) {
            if (obj.has(key) && !obj.get(key).isJsonNull()) {
                return obj.get(key).getAsString();
            }
        }
        return null;
    }

    private static int readInt(JsonObject obj, String... keys) {
        if (obj == null) {
            return 0;
        }
        for (String key : keys) {
            try {
                if (obj.has(key) && !obj.get(key).isJsonNull()) {
                    return obj.get(key).getAsInt();
                }
            } catch (Exception ignored) {
            }
        }
        return 0;
    }

    private static Double readDoubleNullable(JsonObject obj, String... keys) {
        if (obj == null) {
            return null;
        }
        for (String key : keys) {
            try {
                if (obj.has(key) && !obj.get(key).isJsonNull()) {
                    return obj.get(key).getAsDouble();
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private static Long readEpochMillisNullable(JsonObject obj, String... keys) {
        if (obj == null) {
            return null;
        }
        for (String key : keys) {
            try {
                if (obj.has(key) && !obj.get(key).isJsonNull()) {
                    JsonElement element = obj.get(key);
                    if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isNumber()) {
                        long value = element.getAsLong();
                        if (value > 1_000_000_000_000L) {
                            return value;
                        }
                        if (value > 1_000_000_000L) {
                            return value * 1000L;
                        }
                    } else if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()) {
                        String raw = element.getAsString().trim();
                        if (!raw.isEmpty()) {
                            return Instant.parse(raw).toEpochMilli();
                        }
                    }
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private static long parseTimestamp(String timestamp) {
        try {
            return Instant.parse(timestamp).toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    public Optional<CodexHistoryReader.CodexMessage> findLastEventMsgTokenCount(@NotNull Path sessionFile) {
        try (var reader = Files.newBufferedReader(sessionFile)) {
            return reader.lines()
                .filter(s -> EVENT_MSG_TOKEN_COUNT_REGEX.matcher(s).find())
                .reduce((first, second) -> second)
                .map(s -> this.gson.fromJson(s, CodexHistoryReader.CodexMessage.class));
        } catch (IOException e) {
            LOG.warn("Failed to read session file " + sessionFile + ": " + e.getMessage());
            return Optional.empty();
        }
    }

    private long now() {
        return nowSupplier.getAsLong();
    }

    private static boolean isWithin(Duration timeout, long now, long timestamp) {
        return timestamp > 0 && now - timestamp <= timeout.toMillis();
    }

    private boolean isSessionSnapshotUsable(Snapshot snapshot, long now) {
        return snapshot != null && isWithin(SESSION_FALLBACK_TIMEOUT, now, snapshot.dataTimestamp);
    }

    private JsonObject copyPayload(Snapshot snapshot) {
        return snapshot.payload.deepCopy();
    }

    private boolean isApiKeyMode() {
        try {
            return CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED.equals(runtimeAccessResolver.get());
        } catch (Exception e) {
            LOG.warn("Failed to resolve Codex runtime access mode: " + e.getMessage());
            return false;
        }
    }

    /**
     * Drop all cached quota snapshots so the next {@link #getQuotaSnapshot()} refetches.
     * Must be called when the active Codex account changes: a cli_login snapshot belongs
     * to the previous OAuth account and would otherwise be served (up to ~60s) for the
     * new one. Resetting the in-flight ref also stops the next request from awaiting the
     * previous account's mid-flight refresh.
     */
    public void invalidateCache() {
        sessionSnapshotCache.clear();
        apiSnapshotCache.clear();
        inFlightRefresh.set(null);
    }

    public CompletableFuture<JsonObject> getQuotaSnapshot() {
        long now = now();
        // Checked before the cache fast path so a snapshot cached under cli_login
        // mode is never served after the user switches to an API-key provider.
        if (isApiKeyMode()) {
            return CompletableFuture.completedFuture(buildApiKeyModePayload(now));
        }
        Optional<Snapshot> cachedSession = sessionSnapshotCache.current()
            .filter(snapshot -> isSessionSnapshotUsable(snapshot, now));
        if (sessionSnapshotCache.shouldSkipUpdate(now) && cachedSession.isPresent()) {
            return CompletableFuture.completedFuture(copyPayload(cachedSession.orElseThrow()));
        }

        Optional<Snapshot> cachedApi = apiSnapshotCache.currentFresh(now);
        if (sessionSnapshotCache.shouldSkipUpdate(now) && cachedSession.isEmpty() && cachedApi.isPresent()) {
            return CompletableFuture.completedFuture(copyPayload(cachedApi.orElseThrow()));
        }

        CompletableFuture<JsonObject> currentRefresh = inFlightRefresh.get();
        if (currentRefresh != null && !currentRefresh.isDone()) {
            return currentRefresh.thenApply(JsonObject::deepCopy);
        }

        synchronized (refreshLock) {
            Optional<Snapshot> lockedSession = sessionSnapshotCache.current()
                .filter(snapshot -> isSessionSnapshotUsable(snapshot, now));
            if (sessionSnapshotCache.shouldSkipUpdate(now) && lockedSession.isPresent()) {
                return CompletableFuture.completedFuture(copyPayload(lockedSession.orElseThrow()));
            }

            Optional<Snapshot> lockedApi = apiSnapshotCache.currentFresh(now);
            if (sessionSnapshotCache.shouldSkipUpdate(now) && lockedSession.isEmpty() && lockedApi.isPresent()) {
                return CompletableFuture.completedFuture(copyPayload(lockedApi.orElseThrow()));
            }

            CompletableFuture<JsonObject> lockedRefresh = inFlightRefresh.get();
            if (lockedRefresh != null && !lockedRefresh.isDone()) {
                return lockedRefresh.thenApply(JsonObject::deepCopy);
            }

            CompletableFuture<JsonObject> refresh = CompletableFuture.supplyAsync(this::refreshQuotaSnapshot)
                .thenApply(JsonObject::deepCopy);
            inFlightRefresh.set(refresh);
            refresh.whenComplete((ignored, error) -> inFlightRefresh.compareAndSet(refresh, null));
            return refresh;
        }
    }

    JsonObject forceRefreshForTest() {
        return refreshQuotaSnapshot();
    }

    Snapshot buildFromSessionMessage(@NotNull CodexHistoryReader.CodexMessage message) {
        var rateLimits = pickFirstObject(message.payload, "rate_limits");
        if (rateLimits == null) {
            LOG.warn("Session message with token_count event does not contain rate_limits object");
            return null;
        }
        long timestamp = parseTimestamp(message.timestamp);
        long now = now();
        return new Snapshot(buildPayloadFromSessionRateLimits(rateLimits, now), timestamp, now);
    }

    private JsonObject refreshQuotaSnapshot() {
        long now = now();
        String fallbackReason;
        try {
            Optional<Snapshot> session = sessionSnapshotCache.updateIfDue(now);
            if (session.filter(snapshot -> isSessionSnapshotUsable(snapshot, now)).isPresent()) {
                LOG.debug("Using quota snapshot from recent session");
                return copyPayload(session.orElseThrow());
            }

            Optional<Snapshot> api = apiSnapshotCache.updateIfDue(now);
            if (apiSnapshotCache.currentFresh(now).isPresent()) {
                LOG.debug("Using quota snapshot from wham/usage API");
                return copyPayload(api.orElseThrow());
            }

            Optional<String> apiError = apiSnapshotCache.lastUpdateError();
            if (apiError.isPresent()) {
                fallbackReason = apiError.orElseThrow();
            } else if (CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE.equals(runtimeAccessResolver.get())) {
                fallbackReason = "Codex runtime access is inactive";
            } else {
                String token = readAccessToken(authSupplier.get());
                fallbackReason = (token == null || token.isBlank())
                    ? "No access_token in ~/.codex/auth.json"
                    : "wham/usage returned no fresh snapshot";
            }
        } catch (Exception e) {
            LOG.warn("[CodexSubscriptionQuotaService] Failed to refresh quota: " + e.getMessage());
            fallbackReason = e.getMessage();
        }
        return fallbackOrUnavailable(fallbackReason, now);
    }

    private Optional<Snapshot> fetchApiSnapshot(long lastUpdate, long now) throws Exception {
        String accessMode = runtimeAccessResolver.get();
        // In managed (API-key) mode any access_token in auth.json belongs to an
        // unrelated OAuth login, so querying wham/usage would show quota for the
        // wrong account. Skipped here as well in case a future caller bypasses
        // the getQuotaSnapshot() entry check.
        if (CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE.equals(accessMode)
                || CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED.equals(accessMode)) {
            return Optional.empty();
        }

        String token = readAccessToken(authSupplier.get());
        if (token == null || token.isBlank()) {
            return Optional.empty();
        }

        JsonObject usage = usageFetcher.fetch(token);
        JsonObject payload = buildPayloadFromUsage(usage, now);
        return Optional.of(new Snapshot(payload, now, now));
    }

    private Optional<Snapshot> fromRecentSessions(long lastUpdate, long now) {
        try (var stream = Files.walk(codexSessionPath)) {
            // Stat each file once up front; sorting on getModifiedTime directly
            // would re-stat files on every comparison.
            return stream
                .filter(Files::isRegularFile)
                .filter(p -> p.toString().endsWith(".jsonl"))
                .map(p -> Map.entry(p, getModifiedTime(p)))
                .filter(e -> e.getValue() > lastUpdate)
                .sorted(Map.Entry.<Path, Long>comparingByValue().reversed())
                .map(Map.Entry::getKey)
                .map(this::findLastEventMsgTokenCount)
                .flatMap(Optional::stream)
                .map(this::buildFromSessionMessage)
                .filter(Objects::nonNull)
                .findFirst();
        } catch (IOException e) {
            LOG.warn("Failed to read Codex session files: " + e.getMessage());
            return Optional.empty();
        }
    }

    private JsonObject fallbackOrUnavailable(String reason, long now) {
        Snapshot cachedApi = apiSnapshotCache.current().orElse(null);
        if (cachedApi != null) {
            JsonObject payload = copyPayload(cachedApi);
            payload.addProperty("stale", true);
            return payload;
        }

        Snapshot cachedSession = sessionSnapshotCache.current().orElse(null);
        if (cachedSession != null) {
            JsonObject payload = copyPayload(cachedSession);
            payload.addProperty("stale", true);
            return payload;
        }
        return buildUnavailablePayload(reason, now);
    }

    @FunctionalInterface
    private interface SnapshotUpdater {
        Optional<Snapshot> update(long lastUpdate, long now) throws Exception;
    }

    interface WhamUsageFetcher {
        JsonObject fetch(String token) throws Exception;
    }

    interface RuntimeAccessResolver {
        String get() throws Exception;
    }

    interface AuthSupplier {
        JsonObject get() throws Exception;
    }

    private static class HttpWhamUsageFetcher implements WhamUsageFetcher {
        private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(HTTP_TIMEOUT)
            .build();

        @Override
        public JsonObject fetch(String token) throws Exception {
            HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(WHAM_USAGE_URL))
                .timeout(HTTP_TIMEOUT)
                .header("Authorization", "Bearer " + token)
                .header("Accept", "application/json")
                .header("User-Agent", "jetbrains-cc-gui-codex-quota")
                .GET()
                .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IllegalStateException("wham/usage HTTP " + response.statusCode());
            }
            JsonElement parsed = JsonParser.parseString(response.body());
            if (!parsed.isJsonObject()) {
                throw new IllegalStateException("wham/usage returned non-object JSON");
            }
            return parsed.getAsJsonObject();
        }
    }

    private static final class SnapshotCache {
        private final Duration timeout;
        private final SnapshotUpdater updater;
        private final AtomicReference<Snapshot> snapshot = new AtomicReference<>();
        private final AtomicReference<String> lastUpdateError = new AtomicReference<>();
        private final AtomicLong lastUpdateAttemptAtMillis = new AtomicLong(Long.MIN_VALUE);

        private SnapshotCache(Duration timeout, SnapshotUpdater updater) {
            this.timeout = timeout;
            this.updater = updater;
        }

        private Optional<Snapshot> current() {
            return Optional.ofNullable(snapshot.get());
        }

        private Optional<Snapshot> currentFresh(long now) {
            Snapshot current = snapshot.get();
            if (current == null || !isWithin(timeout, now, current.snapshotTimestamp)) {
                return Optional.empty();
            }
            return Optional.of(current);
        }

        private boolean shouldSkipUpdate(long now) {
            return isWithin(timeout, now, lastUpdateAttemptAtMillis.get());
        }

        private Optional<String> lastUpdateError() {
            return Optional.ofNullable(lastUpdateError.get());
        }

        private Optional<Snapshot> updateIfDue(long now) throws Exception {
            Snapshot current = snapshot.get();
            if (shouldSkipUpdate(now)) {
                return Optional.ofNullable(current);
            }

            long lastUpdate = lastUpdateAttemptAtMillis.getAndSet(now);
            try {
                Optional<Snapshot> updated = updater.update(lastUpdate, now);
                lastUpdateError.set(null);
                updated.ifPresent(snapshot::set);
                return updated.isPresent() ? updated : Optional.ofNullable(current);
            } catch (Exception e) {
                lastUpdateError.set(e.getMessage());
                throw e;
            }
        }

        private void clear() {
            snapshot.set(null);
            lastUpdateError.set(null);
            lastUpdateAttemptAtMillis.set(Long.MIN_VALUE);
        }
    }

    /**
     * @param payload the quota snapshot payload, compliant with the structure expected by the WebView
     * @param dataTimestamp the timestamp associated with the data in the payload (e.g. when the usage was fetched, or when the session message was recorded)
     * @param snapshotTimestamp when this snapshot was created (i.e. when the payload was generated from the data). Used to determine staleness in fallback scenarios.
     */
    private record Snapshot(JsonObject payload, long dataTimestamp, long snapshotTimestamp) {
    }
}
