package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 智谱 GLM Coding Plan via the z.ai / bigmodel.cn anthropic-compat backend.
 *
 * <p>Probes {@code {origin}/api/monitor/usage/quota/limit} (both hosts expose
 * the same usage API) and parses the {@code TOKENS_LIMIT}/{@code CREDIT_LIMIT}
 * windows (5h + 7d) plus the {@code TIME_LIMIT} monthly MCP budget, returning
 * the per-window {@code percentage}. Migrated verbatim from the original
 * z.ai-only logic in {@code ClaudePlanUsageService}.
 */
public final class ZaiUsageVendor implements RelayUsageVendor {

    private static final String USAGE_PATH = "/api/monitor/usage/quota/limit";

    @Override
    public String id() {
        return "zai";
    }

    @Override
    public boolean matches(String host, String path) {
        if (host == null) {
            return false;
        }
        String normalizedHost = host.toLowerCase(java.util.Locale.ROOT);
        return normalizedHost.equals("z.ai") || normalizedHost.endsWith(".z.ai")
                || normalizedHost.equals("open.bigmodel.cn") || normalizedHost.endsWith(".bigmodel.cn");
    }

    @Override
    public JsonObject probe(RelayUsageEnv env) throws Exception {
        String origin = RelayUsageHttp.secureOrigin(env.baseUrl());
        if (origin == null) {
            return null;
        }
        JsonObject body = RelayUsageHttp.getJson(origin + USAGE_PATH, env.token());
        return parseQuota(body);
    }

    /**
     * Parse the quota-limit body into the capacity shape. Coding-token windows
     * ({@code CREDIT_LIMIT}/{@code TOKENS_LIMIT}) map to 5h/7d; the
     * {@code TIME_LIMIT} monthly MCP budget maps to a {@code monthly} window.
     * Only limits carrying a {@code percentage} are emitted.
     */
    static JsonObject parseQuota(JsonObject body) {
        if (body == null) {
            return null;
        }
        JsonObject data = RelayUsageJson.asObject(body, "data");
        if (data == null || RelayUsageJson.asArray(data, "limits") == null) {
            return null;
        }
        String level = RelayUsageJson.asString(data, "level");

        // Two limit types can map to the same window (e.g. TOKENS_LIMIT and
        // CREDIT_LIMIT both with unit=3 → "5h"); merge them, surfacing the worse
        // usage, so the frontend never sees duplicate window ids.
        Map<String, JsonObject> byPeriod = new LinkedHashMap<>();
        for (JsonElement el : data.getAsJsonArray("limits")) {
            if (!RelayUsageJson.isObject(el)) {
                continue;
            }
            JsonObject lim = el.getAsJsonObject();
            Double pct = RelayUsageJson.asDouble(lim, "percentage");
            if (pct == null || !Double.isFinite(pct)) {
                continue;
            }
            pct = RelayUsageJson.clampPct(pct);
            String type = RelayUsageJson.asString(lim, "type");
            String period = period(lim, type);
            if (period == null) {
                continue;
            }
            Long resetsAtMs = RelayUsageJson.asEpochMs(lim, "nextResetTime", "next_reset_time");

            JsonObject existing = byPeriod.get(period);
            if (existing != null) {
                if (pct > existing.get("used_pct").getAsDouble()) {
                    existing.addProperty("used_pct", pct);
                }
                if (!existing.has("reset_at") && resetsAtMs != null) {
                    existing.addProperty("reset_at", RelayUsageJson.epochMsToIso(resetsAtMs));
                }
                continue;
            }
            byPeriod.put(period, RelayUsageJson.window(period, pct, resetsAtMs));
        }
        if (byPeriod.isEmpty()) {
            return null;
        }
        return RelayUsageJson.capacityPayload("zai-quota-limit", byPeriod.values(), level);
    }

    /**
     * Map a limit to a window id/period. Observed payloads use unit 3=hours
     * (number=5 → 5h), unit 6=weeks (number=1 → 7d) and unit 4=weeks expressed
     * as seven days (number=7 → 7d). Unknown or inconsistent shapes are ignored
     * rather than guessed.
     */
    static String period(JsonObject lim, String type) {
        if (type != null && type.toUpperCase(Locale.ROOT).contains("TIME")) {
            return "monthly";
        }
        Integer unit = RelayUsageJson.asInt(lim, "unit");
        Integer number = RelayUsageJson.asInt(lim, "number");
        if (unit == null || number == null) {
            return null;
        }
        switch (unit) {
            case 3:
                return number == 5 ? "5h" : null;
            case 6:
                return number == 1 ? "7d" : null;
            case 4:
                return number == 7 ? "7d" : null;
            default:
                return null;
        }
    }
}
