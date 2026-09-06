package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClaudePlanUsageServiceTest {

    /** resetsAt is epoch SECONDS in the CLI rate_limit_info schema. */
    private static JsonObject info(double utilization, long resetsAtSec, String status) {
        JsonObject o = new JsonObject();
        o.addProperty("utilization", utilization);
        o.addProperty("resetsAt", resetsAtSec);
        if (status != null) {
            o.addProperty("status", status);
        }
        return o;
    }

    private static long nowSec() {
        return System.currentTimeMillis() / 1000L;
    }

    @After
    public void tearDown() {
        ClaudePlanUsageService.resetRateLimitCacheForTests();
    }

    @Test
    public void buildCapacityPayload_fractionUtilization_mapsToPercentWith5hWindow() {
        long resetsAt = nowSec() + 3L * 60 * 60; // ~3h out → 5h bucket
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(0.42, resetsAt, "allowed_warning"));

        assertEquals(42.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("claude", payload.get("provider").getAsString());
        assertEquals("sdk-rate-limit", payload.get("source").getAsString());
        assertTrue(payload.get("present").getAsBoolean());
        assertEquals("5h", payload.get("period_type").getAsString());
        assertEquals("allowed_warning", payload.get("rate_limit_status").getAsString());
        assertTrue(payload.has("reset_at"));

        JsonObject window = payload.getAsJsonArray("windows").get(0).getAsJsonObject();
        assertEquals("5h", window.get("id").getAsString());
        assertEquals(42.0, window.get("used_pct").getAsDouble(), 0.01);
        assertEquals("5h", window.get("period_type").getAsString());
    }

    @Test
    public void buildCapacityPayload_epochSecondsResetAt_convertsToMillis() {
        long resetsAtSec = nowSec() + 2L * 60 * 60; // 2h out
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(0.1, resetsAtSec, null));

        String resetAt = payload.get("reset_at").getAsString();
        long parsedMs = java.time.Instant.parse(resetAt).toEpochMilli();
        assertEquals(resetsAtSec * 1000L, parsedMs);
        // 2h out must classify as the 5h window — with the old millis misread
        // this landed in 1970 and misclassified everything.
        assertEquals("5h", payload.get("period_type").getAsString());
    }

    @Test
    public void buildCapacityPayload_overLimitFraction_clampsToHundred() {
        // utilization 1.3 = 130% used (over capacity) — must surface as ~100%,
        // not as a tiny "1.3%" reading.
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(1.3, nowSec() + 3600, null));
        assertEquals(100.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void buildCapacityPayload_percentUtilizationAboveTen_treatedAsPercent() {
        long resetsAt = nowSec() + 5L * 24 * 60 * 60; // ~5d → 7d bucket
        JsonObject payload = ClaudePlanUsageService.buildCapacityPayload(info(87.0, resetsAt, "rejected"));

        assertEquals(87.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("7d", payload.get("period_type").getAsString());
        assertEquals("rejected", payload.get("rate_limit_status").getAsString());
    }

    @Test
    public void buildCapacityPayload_rateLimitTypeWinsOverDeltaHeuristic() {
        // A seven_day window whose reset happens to be <6h out must still be 7d.
        JsonObject o = info(0.5, nowSec() + 2L * 60 * 60, null);
        o.addProperty("rateLimitType", "seven_day");
        assertEquals("7d", ClaudePlanUsageService.buildCapacityPayload(o).get("period_type").getAsString());

        JsonObject sonnet = info(0.5, nowSec() + 2L * 60 * 60, null);
        sonnet.addProperty("rateLimitType", "seven_day_sonnet");
        assertEquals("7d", ClaudePlanUsageService.buildCapacityPayload(sonnet).get("period_type").getAsString());

        JsonObject fiveHour = info(0.5, nowSec() + 5L * 24 * 60 * 60, null);
        fiveHour.addProperty("rateLimitType", "five_hour");
        assertEquals("5h", ClaudePlanUsageService.buildCapacityPayload(fiveHour).get("period_type").getAsString());
    }

    @Test
    public void buildCapacityPayload_missingUtilization_returnsNull() {
        JsonObject noUtil = new JsonObject();
        noUtil.addProperty("resetsAt", nowSec() + 1L);
        assertNull(ClaudePlanUsageService.buildCapacityPayload(noUtil));
    }

    @Test
    public void periodTypeFromResetMs_classifies5hAnd7d() {
        long now = System.currentTimeMillis();
        assertEquals("5h", ClaudePlanUsageService.periodTypeFromResetMs(now + 2L * 60 * 60 * 1000));
        assertEquals("5h", ClaudePlanUsageService.periodTypeFromResetMs(now + 6L * 60 * 60 * 1000));
        assertEquals("7d", ClaudePlanUsageService.periodTypeFromResetMs(now + 2L * 24 * 60 * 60 * 1000));
    }

    // ===== facade: registry miss falls back to the cached rate_limit snapshot =====

    @Test
    public void resolvePlanUsagePayload_noSettings_fallsBackToRateLimitCache() {
        // With no settings service there is no registry match and no cached
        // snapshot yet → the unavailable marker.
        assertFalse(ClaudePlanUsageService.resolvePlanUsagePayload(null).get("present").getAsBoolean());

        JsonObject rateLimit = info(0.42, nowSec() + 3L * 60 * 60, "allowed_warning");
        ClaudePlanUsageService.cacheRateLimitInfo(rateLimit);

        JsonObject payload = ClaudePlanUsageService.resolvePlanUsagePayload(null);
        assertTrue(payload.get("present").getAsBoolean());
        assertEquals("sdk-rate-limit", payload.get("source").getAsString());
        assertEquals(42.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void resolvePlanUsagePayload_noSnapshotAtAll_returnsUnavailableMarker() {
        JsonObject payload = ClaudePlanUsageService.resolvePlanUsagePayload(null);
        assertFalse(payload.get("present").getAsBoolean());
        assertTrue(payload.get("unavailable").getAsBoolean());
        assertEquals("claude", payload.get("provider").getAsString());
    }
}
