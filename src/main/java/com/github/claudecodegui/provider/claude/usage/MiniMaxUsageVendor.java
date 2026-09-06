package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * MiniMax Coding Plan via the minimaxi.com (国内) / minimax.io (国际)
 * anthropic-compat backend.
 *
 * <p>Probes {@code {origin}/v1/api/openplatform/coding_plan/remains}, which
 * reports <em>remaining</em> percentages per model per window — translated here
 * into used percentages. The entry matching the active model is preferred
 * (falling back to "general", the Coding Plan default, then the first entry);
 * the weekly window is only reported when
 * {@code current_weekly_status == 1} (weekly quota enabled for the plan).
 */
public final class MiniMaxUsageVendor implements RelayUsageVendor {

    private static final String USAGE_PATH = "/v1/api/openplatform/coding_plan/remains";

    @Override
    public String id() {
        return "minimax";
    }

    @Override
    public boolean matches(String host, String path) {
        if (host == null) {
            return false;
        }
        String normalizedHost = host.toLowerCase(java.util.Locale.ROOT);
        return normalizedHost.equals("minimaxi.com") || normalizedHost.endsWith(".minimaxi.com")
                || normalizedHost.equals("minimax.io") || normalizedHost.endsWith(".minimax.io");
    }

    @Override
    public JsonObject probe(RelayUsageEnv env) throws Exception {
        String origin = RelayUsageHttp.secureOrigin(env.baseUrl());
        if (origin == null) {
            return null;
        }
        JsonObject body = RelayUsageHttp.getJson(origin + USAGE_PATH, env.token());
        return parseRemains(body, env.model());
    }

    /** Parse the coding-plan-remains body for {@code currentModel} into the capacity shape. */
    static JsonObject parseRemains(JsonObject body, String currentModel) {
        if (body == null) {
            return null;
        }
        // base_resp carries a non-zero status_code on API errors — treat as
        // "no data" so the caller can fall back rather than show garbage.
        JsonObject baseResp = RelayUsageJson.asObject(body, "base_resp");
        Integer statusCode = baseResp != null ? RelayUsageJson.asInt(baseResp, "status_code") : null;
        if (statusCode != null && statusCode != 0) {
            return null;
        }
        JsonArray remains = RelayUsageJson.asArray(body, "model_remains");
        if (remains == null || remains.isEmpty()) {
            return null;
        }
        JsonObject main = pickModel(remains, currentModel);
        if (main == null) {
            return null;
        }

        List<JsonObject> windows = new ArrayList<>();
        addWindow(windows, "5h",
                invertRemaining(RelayUsageJson.asDouble(main, "current_interval_remaining_percent")),
                RelayUsageJson.asEpochMs(main, "end_time"));
        Integer weeklyStatus = RelayUsageJson.asInt(main, "current_weekly_status");
        if (weeklyStatus != null && weeklyStatus == 1) {
            addWindow(windows, "7d",
                    invertRemaining(RelayUsageJson.asDouble(main, "current_weekly_remaining_percent")),
                    RelayUsageJson.asEpochMs(main, "weekly_end_time"));
        }
        addWindow(windows, "monthly",
                invertRemaining(RelayUsageJson.asDouble(main, "current_monthly_remaining_percent")),
                RelayUsageJson.asEpochMs(main, "monthly_end_time"));
        if (windows.isEmpty()) {
            return null;
        }
        return RelayUsageJson.capacityPayload("minimax-coding-plan", windows, null);
    }

    /** Remaining percent (0-100) → clamped used percent; null when the field is absent. */
    private static Double invertRemaining(Double remainingPct) {
        if (remainingPct == null || !Double.isFinite(remainingPct)) {
            return null;
        }
        return RelayUsageJson.clampPct(100.0 - remainingPct);
    }

    private static void addWindow(List<JsonObject> windows, String id, Double usedPct, Long resetAtMs) {
        if (usedPct == null) {
            return;
        }
        windows.add(RelayUsageJson.window(id, usedPct, resetAtMs));
    }

    /**
     * Pick the model_remains entry for the user's active model. Matching runs in
     * two passes — exact normalized-name equality first, then bidirectional
     * substring — so an earlier substring hit never shadows a later exact entry
     * ("MiniMax-M2" must not resolve to a "MiniMax-M2.5" entry that precedes the
     * exact one). Substring matching tolerates "MiniMax-M3" vs "M3",
     * "minimax_m3", Unicode-dash variants etc. Fallback chain: "general" (the
     * Coding Plan default) → first entry.
     */
    static JsonObject pickModel(JsonArray remains, String currentModel) {
        if (currentModel != null && !currentModel.isBlank()) {
            String cur = normalizeModelKey(currentModel);
            if (!cur.isEmpty()) {
                for (JsonElement el : remains) {
                    if (!RelayUsageJson.isObject(el)) {
                        continue;
                    }
                    String name = normalizeModelKey(RelayUsageJson.asString(el.getAsJsonObject(), "model_name"));
                    if (!name.isEmpty() && name.equals(cur)) {
                        return el.getAsJsonObject();
                    }
                }
                for (JsonElement el : remains) {
                    if (!RelayUsageJson.isObject(el)) {
                        continue;
                    }
                    String name = normalizeModelKey(RelayUsageJson.asString(el.getAsJsonObject(), "model_name"));
                    if (!name.isEmpty() && (name.contains(cur) || cur.contains(name))) {
                        return el.getAsJsonObject();
                    }
                }
            }
        }
        for (JsonElement el : remains) {
            if (RelayUsageJson.isObject(el)
                    && "general".equals(RelayUsageJson.asString(el.getAsJsonObject(), "model_name"))) {
                return el.getAsJsonObject();
            }
        }
        for (JsonElement el : remains) {
            if (RelayUsageJson.isObject(el)) {
                return el.getAsJsonObject();
            }
        }
        return null;
    }

    /** Lowercase + strip non-alphanumerics, for tolerant cross-format model matching. */
    static String normalizeModelKey(String s) {
        if (s == null) {
            return "";
        }
        return s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }
}
