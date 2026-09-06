package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.claude.usage.RelayUsageJson;
import com.github.claudecodegui.provider.claude.usage.RelayUsageRegistry;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Claude plan-usage snapshot builder + resolver.
 *
 * <p>Feeds the ContextBar plan-usage indicator using the same payload shape as
 * Gemini/Codex ({@code capacity_pct} + {@code windows[]}), so the shared
 * {@code GeminiPlanUsageIndicator} renders it unchanged.
 *
 * <p>Two data sources, picked by backend:
 * <ul>
 *   <li><b>Relay vendors</b> (z.ai/bigmodel.cn, MiniMax Coding Plan, Kimi For
 *       Coding): {@link RelayUsageRegistry} matches the {@code ANTHROPIC_BASE_URL}
 *       host against the registered vendors and probes their usage API — see
 *       the {@code provider.claude.usage} package.</li>
 *   <li><b>Real Anthropic (OAuth subscription):</b> the SDK emits
 *       {@code rate_limit_event} ({@code rate_limit_info: {status, resetsAt, utilization}})
 *       during turns; {@link com.github.claudecodegui.session.ClaudeMessageHandler}
 *       caches it via {@link #cacheRateLimitInfo(JsonObject)}.</li>
 * </ul>
 *
 * <p>The webview polls {@code get_claude_plan_usage} (~every 120s, like Gemini).
 */
public final class ClaudePlanUsageService {

    private static final Logger LOG = Logger.getInstance(ClaudePlanUsageService.class);

    /** Last rate_limit_event snapshot (real Anthropic). Null until the first event arrives. */
    private static volatile JsonObject cachedRateLimit;

    private ClaudePlanUsageService() {
    }

    /**
     * Cache a {@code rate_limit_event} snapshot from the SDK stream (real Anthropic).
     * Called by {@code ClaudeMessageHandler.handleRateLimit}.
     */
    public static void cacheRateLimitInfo(JsonObject rateLimitInfo) {
        if (rateLimitInfo == null) {
            return;
        }
        try {
            JsonObject payload = buildCapacityPayload(rateLimitInfo);
            if (payload != null) {
                cachedRateLimit = payload;
            }
        } catch (Exception e) {
            LOG.warn("Failed to cache Claude rate_limit_event: " + e.getMessage());
        }
    }

    /**
     * Resolve the plan-usage payload for the webview poll. Delegates to the
     * relay vendor registry (cache + probe + stale policy inside); when no
     * vendor matches or every probe path fails, falls back to the cached
     * rate_limit snapshot (real Anthropic). Final fallback is an unavailable
     * marker.
     *
     * <p>The settings service is passed in by the caller (which holds a long-lived
     * instance) — constructing a fresh {@code CodemossSettingsService} per poll would
     * rebuild its whole manager graph every 120s. Settings are still re-read from
     * disk on each call, so edits to {@code settings.json} are picked up.
     */
    public static JsonObject resolvePlanUsagePayload(CodemossSettingsService settingsService) {
        try {
            if (settingsService != null) {
                JsonObject relay = RelayUsageRegistry.resolve(
                        settingsService.readClaudeSettings(), System.currentTimeMillis());
                if (relay != null) {
                    return relay;
                }
            }
        } catch (Exception e) {
            LOG.warn("Claude plan-usage resolve failed, falling back to rate_limit cache: " + e.getMessage());
        }
        JsonObject cached = cachedRateLimit;
        if (cached != null) {
            return cached.deepCopy();
        }
        return unavailable("Claude usage unavailable");
    }

    // ===== real Anthropic rate_limit_event =====

    static JsonObject buildCapacityPayload(JsonObject rateLimitInfo) {
        Double utilization = RelayUsageJson.asDouble(rateLimitInfo, "utilization");
        if (utilization == null || !Double.isFinite(utilization)) {
            return null;
        }
        // The CLI documents utilization as a fraction of the window (0-1, and
        // exceeding 1 when over capacity), so scale it to a percent. The <= 10
        // guard only protects against a hypothetical already-percent payload
        // (0-100) from being scaled twice.
        double pct = RelayUsageJson.clampPct(utilization <= 10.0 ? utilization * 100.0 : utilization);

        // resetsAt is unix epoch SECONDS in the CLI schema (the CLI computes
        // `resetsAt - Date.now()/1000`), not millis — convert before use.
        Long resetsAtMs = RelayUsageJson.asEpochMs(rateLimitInfo, "resetsAt", "resets_at", "resetAt");
        String resetAt = resetsAtMs != null ? RelayUsageJson.epochMsToIso(resetsAtMs) : null;
        String periodType = periodTypeFromRateLimit(rateLimitInfo, resetsAtMs);

        JsonObject window = new JsonObject();
        window.addProperty("id", periodType);
        window.addProperty("used_pct", pct);
        if (resetAt != null) {
            window.addProperty("reset_at", resetAt);
        }
        window.addProperty("period_type", periodType);
        JsonArray windows = new JsonArray();
        windows.add(window);

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", "claude");
        out.addProperty("source", "sdk-rate-limit");
        out.addProperty("capacity_pct", pct);
        if (resetAt != null) {
            out.addProperty("reset_at", resetAt);
        }
        out.addProperty("period_type", periodType);
        out.add("windows", windows);
        String status = RelayUsageJson.asString(rateLimitInfo, "status");
        if (status != null) {
            out.addProperty("rate_limit_status", status);
        }
        return out;
    }

    /**
     * Window classification prefers the CLI-provided {@code rateLimitType}
     * ({@code five_hour} / {@code seven_day} / {@code seven_day_sonnet} / …) over
     * the reset-delta heuristic, which only survives as a fallback.
     */
    static String periodTypeFromRateLimit(JsonObject rateLimitInfo, Long resetsAtMs) {
        String type = RelayUsageJson.asString(rateLimitInfo, "rateLimitType");
        if (type == null) {
            type = RelayUsageJson.asString(rateLimitInfo, "rate_limit_type");
        }
        if (type != null) {
            if (type.startsWith("five_hour")) {
                return "5h";
            }
            if (type.startsWith("seven_day")) {
                return "7d";
            }
        }
        return resetsAtMs != null ? periodTypeFromResetMs(resetsAtMs) : "5h";
    }

    static String periodTypeFromResetMs(long resetsAtMs) {
        long deltaMs = resetsAtMs - System.currentTimeMillis();
        if (deltaMs <= 6L * 60 * 60 * 1000) {
            return "5h";
        }
        return "7d";
    }

    static JsonObject unavailable(String message) {
        JsonObject out = new JsonObject();
        out.addProperty("present", false);
        out.addProperty("unavailable", true);
        out.addProperty("provider", "claude");
        out.addProperty("message", message);
        return out;
    }

    /** Test-only: drop the cached rate_limit snapshot. */
    static void resetRateLimitCacheForTests() {
        cachedRateLimit = null;
    }

}
