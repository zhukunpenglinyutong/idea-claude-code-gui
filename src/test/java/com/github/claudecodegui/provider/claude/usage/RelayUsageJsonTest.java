package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class RelayUsageJsonTest {

    @Test
    public void clampPct_boundsZeroToHundred() {
        assertEquals(0.0, RelayUsageJson.clampPct(-5), 0.001);
        assertEquals(100.0, RelayUsageJson.clampPct(144), 0.001);
        assertEquals(50.0, RelayUsageJson.clampPct(50), 0.001);
        assertEquals(0.0, RelayUsageJson.clampPct(Double.NaN), 0.001);
    }

    @Test
    public void accessors_acceptFirstPresentKeyAndParseStrings() {
        JsonObject o = com.google.gson.JsonParser.parseString(
                "{\"n\":\"12.5\",\"m\":7,\"s\":\"x\",\"absent\":null}").getAsJsonObject();
        assertEquals(12.5, RelayUsageJson.asDouble(o, "n"), 0.001);
        // "12.5" is not a long → skipped, the next parsable key wins
        assertEquals(Long.valueOf(7), RelayUsageJson.asLong(o, "n", "m"));
        assertEquals(Integer.valueOf(7), RelayUsageJson.asInt(o, "m"));
        assertEquals("x", RelayUsageJson.asString(o, "s"));
        // absent/null keys yield null instead of throwing
        assertNull(RelayUsageJson.asDouble(o, "absent", "missing"));
        assertNull(RelayUsageJson.asString(o, "missing"));
        assertNull(RelayUsageJson.asObject(o, "missing"));
        assertNull(RelayUsageJson.asArray(o, "missing"));
        assertNull(RelayUsageJson.asDouble(null, "n"));
    }

    @Test
    public void asEpochMs_normalizesSecondsAndKeepsMillis() {
        JsonObject o = com.google.gson.JsonParser.parseString(
                "{\"sec\":1759180800,\"ms\":1759180800000,\"strSec\":\"1759180800\"}").getAsJsonObject();
        // Seconds are scaled up; millis pass through untouched
        assertEquals(Long.valueOf(1759180800000L), RelayUsageJson.asEpochMs(o, "sec"));
        assertEquals(Long.valueOf(1759180800000L), RelayUsageJson.asEpochMs(o, "ms"));
        assertEquals(Long.valueOf(1759180800000L), RelayUsageJson.asEpochMs(o, "strSec"));
        assertNull(RelayUsageJson.asEpochMs(o, "missing"));
        assertNull(RelayUsageJson.asEpochMs(null, "sec"));
        assertNull(RelayUsageJson.asEpochMs(com.google.gson.JsonParser.parseString("{\"v\":-1}").getAsJsonObject(), "v"));
    }

    @Test
    public void capacityPayload_emptyWindowsReturnsNull() {
        assertNull(RelayUsageJson.capacityPayload("test", List.of(), null));
    }

    @Test
    public void capacityPayload_prefers5hWindowOverWorst() {
        JsonObject payload = RelayUsageJson.capacityPayload("test",
                List.of(RelayUsageJson.window("5h", 13, null),
                        RelayUsageJson.window("7d", 99, null)), null);
        assertEquals(13.0, payload.get("capacity_pct").getAsDouble(), 0.001);
        assertEquals("5h", payload.get("period_type").getAsString());
        assertEquals("test", payload.get("source").getAsString());
        assertTrue(payload.get("present").getAsBoolean());
        assertFalse(payload.has("level"));
        assertEquals(2, payload.getAsJsonArray("windows").size());
    }

    @Test
    public void capacityPayload_without5hFallsBackToWorstWindow() {
        JsonObject payload = RelayUsageJson.capacityPayload("test",
                List.of(RelayUsageJson.window("monthly", 55, 1786624965401L)), "pro");
        assertEquals(55.0, payload.get("capacity_pct").getAsDouble(), 0.001);
        assertEquals("monthly", payload.get("period_type").getAsString());
        assertEquals("pro", payload.get("level").getAsString());
        JsonObject w = payload.getAsJsonArray("windows").get(0).getAsJsonObject();
        assertTrue(w.has("reset_at"));
        assertEquals("monthly", w.get("period_type").getAsString());
    }
}
