package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Kimi For Coding (Moonshot's Claude-compatible coding plan) via the
 * {@code api.kimi.com/coding} backend.
 *
 * <p>Probes {@code {origin}/coding/v1/usages}, which reports quota as
 * limit/remaining (or limit/used) pairs: each {@code limits[]} entry is a
 * rolling window (identified by {@code window.duration}) and the top-level
 * {@code usage} object is the weekly quota. Percentages are derived as
 * {@code (limit − remaining) / limit} (or {@code used / limit} when the API
 * reports {@code used} directly).
 */
public final class KimiCodingUsageVendor implements RelayUsageVendor {

    private static final String USAGE_PATH = "/coding/v1/usages";

    @Override
    public String id() {
        return "kimi-coding";
    }

    @Override
    public boolean matches(String host, String path) {
        // api.kimi.com also serves the plain Moonshot-style API; only the
        // /coding path is the Coding Plan whose /v1/usages endpoint exists.
        // Must be matched before any future plain-kimi vendor. The segment
        // boundary matters: a hypothetical "/codingfoo" path is not the plan.
        return "api.kimi.com".equalsIgnoreCase(host) && path != null
                && (path.equalsIgnoreCase("/coding") || path.toLowerCase(java.util.Locale.ROOT).startsWith("/coding/"));
    }

    @Override
    public JsonObject probe(RelayUsageEnv env) throws Exception {
        String origin = RelayUsageHttp.secureOrigin(env.baseUrl());
        if (origin == null) {
            return null;
        }
        JsonObject body = RelayUsageHttp.getJson(origin + USAGE_PATH, env.token());
        return parseUsages(body);
    }

    /** Parse the usages body into the capacity shape (5h from limits[], 7d from usage). */
    static JsonObject parseUsages(JsonObject body) {
        if (body == null) {
            return null;
        }
        Map<String, JsonObject> byPeriod = new LinkedHashMap<>();
        JsonArray limits = RelayUsageJson.asArray(body, "limits");
        if (limits != null) {
            for (JsonElement el : limits) {
                if (!RelayUsageJson.isObject(el)) {
                    continue;
                }
                JsonObject item = el.getAsJsonObject();
                String period = windowPeriod(item);
                if (period != null) {
                    mergeWindow(byPeriod, period, RelayUsageJson.asObject(item, "detail"));
                }
            }
        }
        mergeWindow(byPeriod, "7d", RelayUsageJson.asObject(body, "usage"));
        if (byPeriod.isEmpty()) {
            return null;
        }
        return RelayUsageJson.capacityPayload("kimi-coding-usages", byPeriod.values(), null);
    }

    /**
     * Classify a limits[] entry by its window duration. Observed shapes:
     * 300 minutes (or 18000 seconds) → 5h; 604800 seconds or 7 days → 7d.
     * When {@code timeUnit} is present it is authoritative — a 300-<em>second</em>
     * window is five minutes, not 5h, and must be ignored rather than
     * misclassified. Unit absent falls back to the numeric heuristic over the
     * observed values; anything unrecognized is ignored rather than guessed.
     */
    static String windowPeriod(JsonObject item) {
        JsonObject window = RelayUsageJson.asObject(item, "window");
        if (window == null) {
            return null;
        }
        Double duration = RelayUsageJson.asDouble(window, "duration");
        if (duration == null || !Double.isFinite(duration)) {
            return null;
        }
        long d = duration.longValue();
        String unit = RelayUsageJson.asString(window, "timeUnit");
        if (unit != null) {
            String u = unit.toUpperCase(Locale.ROOT);
            if (u.contains("MINUTE")) {
                return d == 300 ? "5h" : null;
            }
            if (u.contains("SECOND")) {
                if (d == 18000) {
                    return "5h";
                }
                return d == 604800 ? "7d" : null;
            }
            if (u.contains("HOUR")) {
                if (d == 5) {
                    return "5h";
                }
                return d == 168 ? "7d" : null;
            }
            if (u.contains("DAY")) {
                return d == 7 ? "7d" : null;
            }
            return null;
        }
        if (d == 300 || d == 18000) {
            return "5h";
        }
        return d == 604800 ? "7d" : null;
    }

    /**
     * Merge one limit/remaining (or limit/used) pair into {@code byPeriod},
     * keeping the worse usage when both sources report the same window
     * (e.g. a weekly limits[] entry plus the top-level usage object).
     */
    private static void mergeWindow(Map<String, JsonObject> byPeriod, String period, JsonObject detail) {
        if (detail == null) {
            return;
        }
        Double limit = RelayUsageJson.asDouble(detail, "limit");
        if (limit == null || !Double.isFinite(limit) || limit <= 0) {
            return;
        }
        Double used = RelayUsageJson.asDouble(detail, "used");
        Double pct;
        if (used != null && Double.isFinite(used)) {
            pct = used / limit * 100.0;
        } else {
            Double remaining = RelayUsageJson.asDouble(detail, "remaining");
            if (remaining == null || !Double.isFinite(remaining)) {
                return;
            }
            pct = Math.max(0, limit - remaining) / limit * 100.0;
        }
        pct = RelayUsageJson.clampPct(pct);
        Long resetAtMs = RelayUsageJson.asEpochMs(detail, "resetTime", "reset_time");

        JsonObject existing = byPeriod.get(period);
        if (existing != null) {
            if (pct > existing.get("used_pct").getAsDouble()) {
                existing.addProperty("used_pct", pct);
            }
            if (!existing.has("reset_at") && resetAtMs != null) {
                existing.addProperty("reset_at", RelayUsageJson.epochMsToIso(resetAtMs));
            }
            return;
        }
        byPeriod.put(period, RelayUsageJson.window(period, pct, resetAtMs));
    }
}
