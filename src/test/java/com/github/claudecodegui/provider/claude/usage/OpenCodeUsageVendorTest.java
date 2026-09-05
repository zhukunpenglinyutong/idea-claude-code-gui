package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class OpenCodeUsageVendorTest {

    private final OpenCodeUsageVendor vendor = new OpenCodeUsageVendor();

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
    }

    // ===== host matching =====

    @Test
    public void matches_openCodeHostOnly() {
        assertTrue(vendor.matches("opencode.ai", "/zen/v1"));
        assertTrue(vendor.matches("opencode.ai", "/zen/go/v1"));
        assertFalse(vendor.matches("www.opencode.ai", ""));
        assertFalse(vendor.matches("opencode.ai.evil.net", ""));
        assertFalse(vendor.matches(null, "/zen/v1"));
    }

    // ===== response parsing =====

    @Test
    public void parseUsage_mapsWindowsWithUsedPercentAndIsoReset() {
        JsonObject body = JsonParser.parseString("""
                {"usage":{
                  "rolling":{"percent":30.5,"resetsAt":"2026-09-05T12:00:00Z","status":"ok"},
                  "weekly":{"percent":64,"resetsAt":"2026-09-08T00:00:00Z","status":"ok"},
                  "monthly":{"percent":80,"status":"ok"}
                }}
                """).getAsJsonObject();

        JsonObject payload = OpenCodeUsageVendor.parseUsage(body);

        assertEquals("opencode-zen-usage", payload.get("source").getAsString());
        assertEquals(30.5, payload.get("capacity_pct").getAsDouble(), 0.01);

        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(3, windows.size());
        JsonObject w5h = windows.get(0).getAsJsonObject();
        assertEquals("5h", w5h.get("id").getAsString());
        assertEquals(30.5, w5h.get("used_pct").getAsDouble(), 0.01);
        assertEquals("2026-09-05T12:00:00Z", w5h.get("reset_at").getAsString());
        JsonObject w7d = windows.get(1).getAsJsonObject();
        assertEquals("7d", w7d.get("id").getAsString());
        assertEquals(64.0, w7d.get("used_pct").getAsDouble(), 0.01);
        // monthly has no resetsAt → no reset_at field
        JsonObject wMo = windows.get(2).getAsJsonObject();
        assertEquals("monthly", wMo.get("id").getAsString());
        assertFalse(wMo.has("reset_at"));
    }

    @Test
    public void parseUsage_partialWindowsStillParse() {
        JsonObject payload = OpenCodeUsageVendor.parseUsage(JsonParser.parseString(
                "{\"usage\":{\"weekly\":{\"percent\":42}}}").getAsJsonObject());
        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(1, windows.size());
        assertEquals("7d", windows.get(0).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void parseUsage_garbageYieldsNull() {
        assertNull(OpenCodeUsageVendor.parseUsage(JsonParser.parseString("{}").getAsJsonObject()));
        assertNull(OpenCodeUsageVendor.parseUsage(
                JsonParser.parseString("{\"usage\":{}}").getAsJsonObject()));
        assertNull(OpenCodeUsageVendor.parseUsage(
                JsonParser.parseString("{\"usage\":{\"rolling\":{\"percent\":\"NaN\"}}}")
                        .getAsJsonObject()));
        assertNull(OpenCodeUsageVendor.parseUsage(null));
    }

    // ===== probe =====

    @Test
    public void probe_hitsGoUsagePathFromOrigin() throws Exception {
        String[] seenUrl = {null};
        String[] seenAuth = {null};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seenUrl[0] = url;
            seenAuth[0] = headers.get("Authorization");
            return JsonParser.parseString(
                    "{\"usage\":{\"rolling\":{\"percent\":10,\"status\":\"ok\"}}}")
                    .getAsJsonObject();
        });

        // Both zen and zen/go base URLs share the opencode.ai origin
        JsonObject payload = vendor.probe(RelayUsageEnv.from(
                ZaiUsageVendorTest.settings("https://opencode.ai/zen/v1", "zen-secret")));

        assertEquals("https://opencode.ai/zen/go/v1/usage", seenUrl[0]);
        assertEquals("Bearer zen-secret", seenAuth[0]);
        assertEquals(10.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }
}
