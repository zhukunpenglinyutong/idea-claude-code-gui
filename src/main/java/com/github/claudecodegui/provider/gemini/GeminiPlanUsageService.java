package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * Token-free Gemini / Antigravity account quota for ContextBar.
 *
 * <p>One-shot {@code agy -p "/usage" --output-format json} print-mode probe
 * (agy ≥ 1.1.11): read-only slash commands answer structurally without an
 * agent turn — zero tokens, zero quota, no conversation left behind.
 * agy authenticates itself; the plugin never reads keychain or OAuth tokens.
 * {@code command.data.groups[].buckets[]} is normalized into the same capacity
 * shape used by Grok/Claude plan-usage UI ({@code capacity_pct} + {@code windows[]}).
 */
public final class GeminiPlanUsageService {

    private static final Logger LOG = Logger.getInstance(GeminiPlanUsageService.class);
    private static final Gson GSON = new Gson();

    private static final long DEFAULT_TIMEOUT_MS = 15_000L;
    private static final long CACHE_TTL_MS = 90_000L;

    private static final AtomicReference<CacheEntry> CACHE = new AtomicReference<>();

    private GeminiPlanUsageService() {
    }

    /**
     * Resolve plan-usage payload. Uses a short in-memory cache to avoid spawning agy
     * on every 2-minute poll when the previous snapshot is still fresh.
     */
    public static JsonObject resolvePlanUsagePayload() {
        CacheEntry cached = CACHE.get();
        long now = System.currentTimeMillis();
        if (cached != null && now - cached.atMs < CACHE_TTL_MS && cached.payload != null) {
            JsonObject copy = cached.payload.deepCopy();
            copy.addProperty("cached", true);
            return copy;
        }
        JsonObject fresh = fetchViaUsageProbe(DEFAULT_TIMEOUT_MS);
        if (isPresent(fresh)) {
            CACHE.set(new CacheEntry(now, fresh));
            return fresh.deepCopy();
        }
        if (cached != null && isPresent(cached.payload)) {
            JsonObject copy = cached.payload.deepCopy();
            copy.addProperty("cached", true);
            copy.addProperty("stale", true);
            return copy;
        }
        return fresh;
    }

    /**
     * Normalize {@code /usage} command groups into capacity shape.
     *
     * <p>Antigravity exposes two billing families (same as TUI /usage):
     * <ul>
     *   <li>{@code gemini} — "Gemini Models" group</li>
     *   <li>{@code third_party} — "Claude and GPT models" group (buckets {@code 3p-*})</li>
     * </ul>
     * Each family carries only {@code 5h}/{@code 7d} windows so the ContextBar switcher
     * matches Claude (period only). The webview picks a family from the selected model.
     */
    static JsonObject normalizeUsageGroups(JsonArray groups) {
        if (groups == null || groups.size() == 0) {
            return unavailable("No /usage groups in payload");
        }

        Map<String, List<Window>> byFamily = new LinkedHashMap<>();
        byFamily.put("gemini", new ArrayList<>());
        byFamily.put("third_party", new ArrayList<>());

        for (JsonElement g : groups) {
            if (g == null || !g.isJsonObject()) {
                continue;
            }
            JsonObject group = g.getAsJsonObject();
            String family = familyFromGroupName(asString(group, "name"));
            JsonArray buckets = group.has("buckets") && group.get("buckets").isJsonArray()
                    ? group.getAsJsonArray("buckets")
                    : null;
            if (buckets == null) {
                continue;
            }
            for (JsonElement b : buckets) {
                if (b == null || !b.isJsonObject()) {
                    continue;
                }
                JsonObject bucket = b.getAsJsonObject();
                Double remaining = asDouble(bucket, "remaining_fraction", "remainingFraction");
                if (remaining == null || !Double.isFinite(remaining)) {
                    continue;
                }
                double usedPct = clampPct((1.0 - remaining) * 100.0);
                String resetAt = asString(bucket, "reset_time", "resetTime");
                String periodType = periodFromWindow(asString(bucket, "window"));
                String windowId = windowIdFromPeriod(periodType);
                if (windowId == null) {
                    continue;
                }
                byFamily.computeIfAbsent(family, k -> new ArrayList<>())
                        .add(new Window(windowId, usedPct, resetAt, periodType));
            }
        }

        // Collapse duplicate period keys within a family (keep first = sorted later)
        JsonObject families = new JsonObject();
        JsonObject defaultFamily = null;
        for (Map.Entry<String, List<Window>> fe : byFamily.entrySet()) {
            List<Window> list = fe.getValue();
            if (list.isEmpty()) {
                continue;
            }
            list.sort(Comparator.comparingInt(w -> windowRank(w.periodType)));
            Map<String, Window> unique = new LinkedHashMap<>();
            for (Window w : list) {
                unique.putIfAbsent(w.id, w);
            }
            List<Window> ordered = new ArrayList<>(unique.values());
            JsonObject fam = familyPayload(ordered);
            families.add(fe.getKey(), fam);
            if (defaultFamily == null && "gemini".equals(fe.getKey())) {
                defaultFamily = fam;
            }
            if (defaultFamily == null) {
                defaultFamily = fam;
            }
        }
        if (families.size() == 0 || defaultFamily == null) {
            return unavailable("Quota buckets empty");
        }

        // Top-level mirrors default (gemini) family so parseCapacityPayload works
        // without model context; webview re-binds via families + selected model.
        JsonObject out = defaultFamily.deepCopy();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", "gemini");
        out.addProperty("source", "agy-usage-probe");
        out.addProperty("default_family", families.has("gemini") ? "gemini" : families.entrySet().iterator().next().getKey());
        out.add("families", families);
        return out;
    }

    /**
     * One-shot {@code agy -p "/usage" --output-format json}.
     *
     * <p>agy ≥ 1.1.11 answers read-only slash commands structurally without an
     * agent turn. Older versions send the command to the model as literal text
     * (burning quota, no {@code command} field) — detected and reported below.
     */
    private static JsonObject fetchViaUsageProbe(long timeoutMs) {
        return fetchViaUsageProbe(timeoutMs, resolveAgyBinary());
    }

    /**
     * Probe with an explicit agy binary (test seam; {@code null} → not found).
     *
     * <p>Same process discipline as {@code CliStatusDetector}/{@code ShellExecutor}:
     * streams are merged and the wait is bounded FIRST, so a hung agy cannot
     * block the probe — draining {@code readAllBytes()} before {@code waitFor}
     * would block until process exit and make the timeout dead code. The
     * /usage JSON is tiny and will not fill the OS pipe buffer before exit,
     * so draining after {@code waitFor} is safe.
     */
    static JsonObject fetchViaUsageProbe(long timeoutMs, String agy) {
        if (agy == null) {
            return unavailable("agy CLI not found");
        }

        Path workDir = null;
        Process process = null;
        try {
            // Guard: never inherit plugin/Application Support cwd as workspaceDirs.
            workDir = Files.createTempDirectory("agy-plan-usage-");

            ProcessBuilder pb = new ProcessBuilder(agy, "-p", "/usage", "--output-format", "json");
            pb.directory(workDir.toFile());
            pb.redirectErrorStream(true);
            process = pb.start();

            boolean finished = false;
            try {
                finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
            if (!finished) {
                return unavailable("agy /usage probe timed out");
            }

            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            JsonObject payload = parseJsonObject(output);
            if (payload == null) {
                String hint = output.trim();
                return unavailable("agy /usage probe returned no JSON"
                        + (hint.isEmpty() ? "" : ": " + hint.substring(0, Math.min(hint.length(), 200))));
            }

            String status = asString(payload, "status");
            if (status == null || !"SUCCESS".equalsIgnoreCase(status)) {
                String error = asString(payload, "error");
                return unavailable(error != null ? error : "agy /usage probe status=" + status);
            }

            // Old agy (< 1.1.11) runs the text as a model prompt — no command object.
            JsonObject command = payload.has("command") && payload.get("command").isJsonObject()
                    ? payload.getAsJsonObject("command")
                    : null;
            JsonArray groups = command != null && command.has("data")
                    && command.get("data").isJsonObject()
                    && command.getAsJsonObject("data").has("groups")
                    && command.getAsJsonObject("data").get("groups").isJsonArray()
                    ? command.getAsJsonObject("data").getAsJsonArray("groups")
                    : null;
            if (groups == null) {
                return unavailable("agy has no print-mode slash commands (needs agy ≥ 1.1.11)");
            }
            return normalizeUsageGroups(groups);
        } catch (Exception e) {
            LOG.warn("[GeminiPlanUsageService] /usage probe failed: " + e.getMessage());
            return unavailable("Usage unavailable: " + e.getMessage());
        } finally {
            if (process != null && process.isAlive()) {
                try {
                    process.descendants().forEach(ProcessHandle::destroyForcibly);
                } catch (Exception ignored) {
                }
                process.destroyForcibly();
            }
            if (workDir != null) {
                deleteRecursiveQuietly(workDir);
            }
        }
    }

    private static JsonObject parseJsonObject(String raw) {
        try {
            String trimmed = raw == null ? "" : raw.trim();
            if (trimmed.isEmpty()) {
                return null;
            }
            JsonElement el = JsonParser.parseString(trimmed);
            return el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static JsonObject familyPayload(List<Window> ordered) {
        Window primary = pickPrimary(ordered);
        JsonObject fam = new JsonObject();
        fam.addProperty("capacity_pct", primary.usedPct);
        if (primary.resetAt != null) {
            fam.addProperty("reset_at", primary.resetAt);
        }
        fam.addProperty("period_type", primary.periodType);
        JsonArray arr = new JsonArray();
        for (Window w : ordered) {
            JsonObject o = new JsonObject();
            o.addProperty("id", w.id);
            o.addProperty("used_pct", w.usedPct);
            if (w.resetAt != null) {
                o.addProperty("reset_at", w.resetAt);
            }
            o.addProperty("period_type", w.periodType);
            arr.add(o);
        }
        fam.add("windows", arr);
        return fam;
    }

    private static Window pickPrimary(List<Window> windows) {
        for (Window w : windows) {
            if ("5h".equals(w.periodType) || "5h".equals(w.id)) {
                return w;
            }
        }
        return windows.get(0);
    }

    /** "Gemini Models" → gemini; "Claude and GPT models" → third_party. */
    static String familyFromGroupName(String name) {
        String s = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (s.contains("claude") || s.contains("gpt")) {
            return "third_party";
        }
        return "gemini";
    }

    /** Only 5h / 7d are shown in the bar switcher (Claude-style). */
    private static String windowIdFromPeriod(String periodType) {
        if ("5h".equals(periodType)) {
            return "5h";
        }
        if ("7d".equals(periodType) || "weekly".equals(periodType)) {
            return "7d";
        }
        return null;
    }

    private static int windowRank(String periodType) {
        if ("5h".equals(periodType)) {
            return 0;
        }
        if ("7d".equals(periodType) || "weekly".equals(periodType)) {
            return 1;
        }
        return 2;
    }

    /** /usage bucket window field: "5h" | "weekly" (| "monthly" reserved). */
    private static String periodFromWindow(String window) {
        String s = window == null ? "" : window.toLowerCase(Locale.ROOT);
        if (s.contains("5h") || s.contains("five")) {
            return "5h";
        }
        if (s.contains("week") || s.contains("7d")) {
            return "7d";
        }
        if (s.contains("month")) {
            return "monthly";
        }
        return s.isEmpty() ? "limit" : s;
    }

    private static void deleteRecursiveQuietly(Path root) {
        try {
            if (!Files.exists(root)) {
                return;
            }
            Files.walk(root)
                    .sorted(Comparator.reverseOrder())
                    .forEach(p -> {
                        try {
                            Files.deleteIfExists(p);
                        } catch (Exception ignored) {
                        }
                    });
        } catch (Exception ignored) {
        }
    }

    /**
     * Same discovery rules as {@link com.github.claudecodegui.dependency.DependencyManager}:
     * only {@code agy}, never {@code agy.real}.
     */
    static String resolveAgyBinary() {
        String[] envKeys = {"AGY_PATH", "GEMINI_CLI_PATH", "AGY_CLI_PATH"};
        for (String key : envKeys) {
            String v = System.getenv(key);
            if (v != null && !v.trim().isEmpty()) {
                String path = v.trim();
                if (isForbiddenAgyBinaryName(path)) {
                    break;
                }
                Path p = Paths.get(path);
                if (Files.isExecutable(p)) {
                    return p.toAbsolutePath().toString();
                }
                return null;
            }
        }
        String home = PlatformUtils.getHomeDirectory();
        String[] candidates = {
                home + "/.local/bin/agy",
                home + "/.gemini/antigravity-cli/bin/agy",
                home + "/bin/agy",
                "/usr/local/bin/agy",
                "/opt/homebrew/bin/agy",
        };
        for (String c : candidates) {
            try {
                if (isForbiddenAgyBinaryName(c)) {
                    continue;
                }
                Path p = Paths.get(c);
                if (Files.isExecutable(p)) {
                    return p.toAbsolutePath().toString();
                }
            } catch (Exception ignored) {
            }
        }
        String pathEnv = System.getenv("PATH");
        if (pathEnv != null) {
            for (String dir : pathEnv.split(Pattern.quote(java.io.File.pathSeparator))) {
                if (dir == null || dir.isEmpty()) {
                    continue;
                }
                try {
                    Path p = Paths.get(dir, "agy");
                    if (isForbiddenAgyBinaryName(p.toString())) {
                        continue;
                    }
                    if (Files.isExecutable(p)) {
                        return p.toAbsolutePath().toString();
                    }
                } catch (Exception ignored) {
                }
            }
        }
        return null;
    }

    private static boolean isForbiddenAgyBinaryName(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        String norm = path.replace('\\', '/');
        int slash = norm.lastIndexOf('/');
        String base = slash >= 0 ? norm.substring(slash + 1) : norm;
        return "agy.real".equalsIgnoreCase(base);
    }

    private static JsonObject unavailable(String message) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.addProperty("present", false);
        o.addProperty("message", message != null ? message : "Usage unavailable");
        o.addProperty("provider", "gemini");
        o.addProperty("source", "plugin");
        return o;
    }

    private static boolean isPresent(JsonObject o) {
        return o != null
                && o.has("present")
                && o.get("present").isJsonPrimitive()
                && o.get("present").getAsBoolean();
    }

    private static Double asDouble(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o.has(k) && o.get(k).isJsonPrimitive()) {
                try {
                    return o.get(k).getAsDouble();
                } catch (Exception ignored) {
                }
            }
        }
        return null;
    }

    private static String asString(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o.has(k) && o.get(k).isJsonPrimitive()) {
                try {
                    return o.get(k).getAsString();
                } catch (Exception ignored) {
                }
            }
        }
        return null;
    }

    private static double clampPct(double v) {
        if (!Double.isFinite(v)) {
            return 0;
        }
        return Math.max(0, Math.min(100, v));
    }

    private static final class CacheEntry {
        final long atMs;
        final JsonObject payload;

        CacheEntry(long atMs, JsonObject payload) {
            this.atMs = atMs;
            this.payload = payload;
        }
    }

    private static final class Window {
        final String id;
        final double usedPct;
        final String resetAt;
        final String periodType;

        Window(String id, double usedPct, String resetAt, String periodType) {
            this.id = id;
            this.usedPct = usedPct;
            this.resetAt = resetAt;
            this.periodType = periodType;
        }
    }
}
