package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class MiniMaxUsageVendorTest {

    private final MiniMaxUsageVendor vendor = new MiniMaxUsageVendor();

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
    }

    // ===== host matching =====

    @Test
    public void matches_cnAndIntlHostsOnly() {
        assertTrue(vendor.matches("api.minimaxi.com", "/v1"));
        assertTrue(vendor.matches("minimaxi.com", ""));
        assertTrue(vendor.matches("api.minimax.io", "/v1"));
        // Look-alikes: suffix must be a domain boundary, not a substring
        assertFalse(vendor.matches("notminimaxi.com", ""));
        assertFalse(vendor.matches("api.minimaxi.com.evil.net", ""));
        assertFalse(vendor.matches("minimaxis.com", ""));
    }

    // ===== response parsing =====

    @Test
    public void parseRemains_generalEntryMapsRemainingToUsed() {
        JsonObject body = JsonParser.parseString("""
                {"base_resp":{"status_code":0},"model_remains":[{
                  "model_name":"general",
                  "current_interval_remaining_percent":65.5,
                  "end_time":1786624965401,
                  "current_weekly_status":1,
                  "current_weekly_remaining_percent":80,
                  "weekly_end_time":1787155353998,
                  "current_monthly_remaining_percent":90,
                  "monthly_end_time":1789747353998
                }]}
                """).getAsJsonObject();

        JsonObject payload = MiniMaxUsageVendor.parseRemains(body, null);

        assertEquals("minimax-coding-plan", payload.get("source").getAsString());
        // 5h window binds capacity: 100 − 65.5 remaining = 34.5 used
        assertEquals(34.5, payload.get("capacity_pct").getAsDouble(), 0.01);

        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(3, windows.size());
        JsonObject w5h = windows.get(0).getAsJsonObject();
        assertEquals("5h", w5h.get("id").getAsString());
        assertEquals(34.5, w5h.get("used_pct").getAsDouble(), 0.01);
        assertEquals(java.time.Instant.ofEpochMilli(1786624965401L).toString(), w5h.get("reset_at").getAsString());
        JsonObject w7d = windows.get(1).getAsJsonObject();
        assertEquals("7d", w7d.get("id").getAsString());
        assertEquals(20.0, w7d.get("used_pct").getAsDouble(), 0.01);
        JsonObject wMo = windows.get(2).getAsJsonObject();
        assertEquals("monthly", wMo.get("id").getAsString());
        assertEquals(10.0, wMo.get("used_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseRemains_weeklyWindowOnlyWhenStatusEnabled() {
        JsonObject body = JsonParser.parseString("""
                {"model_remains":[{
                  "model_name":"general",
                  "current_interval_remaining_percent":50,
                  "current_weekly_status":0,
                  "current_weekly_remaining_percent":80
                }]}
                """).getAsJsonObject();

        com.google.gson.JsonArray windows = MiniMaxUsageVendor.parseRemains(body, null).getAsJsonArray("windows");
        assertEquals(1, windows.size());
        assertEquals("5h", windows.get(0).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void parseRemains_prefersCurrentModelOverGeneral() {
        JsonObject body = JsonParser.parseString("""
                {"model_remains":[
                  {"model_name":"MiniMax-M3","current_interval_remaining_percent":10},
                  {"model_name":"general","current_interval_remaining_percent":90}
                ]}
                """).getAsJsonObject();

        // Exact id, cased/underscore variants and unicode dashes all normalize alike
        assertEquals(90.0, usedPct(MiniMaxUsageVendor.parseRemains(body, "minimax_m3")), 0.01);
        assertEquals(90.0, usedPct(MiniMaxUsageVendor.parseRemains(body, "MiniMax–M3")), 0.01);
        // No model context → the "general" Coding Plan default
        assertEquals(10.0, usedPct(MiniMaxUsageVendor.parseRemains(body, null)), 0.01);
        // Unknown model still falls back to general
        assertEquals(10.0, usedPct(MiniMaxUsageVendor.parseRemains(body, "gpt-9")), 0.01);
    }

    @Test
    public void parseRemains_exactModelBeatsEarlierSubstringEntry() {
        // "minimaxm25".contains("minimaxm2") — the exact M2 entry must win even
        // though a substring-matching M2.5 entry precedes it in the array.
        JsonObject body = JsonParser.parseString("""
                {"model_remains":[
                  {"model_name":"MiniMax-M2.5","current_interval_remaining_percent":40},
                  {"model_name":"MiniMax-M2","current_interval_remaining_percent":75}
                ]}
                """).getAsJsonObject();

        assertEquals(25.0, usedPct(MiniMaxUsageVendor.parseRemains(body, "MiniMax-M2")), 0.01);
        // Substring still applies when no exact entry exists
        assertEquals(60.0, usedPct(MiniMaxUsageVendor.parseRemains(body, "MiniMax-M2.5-long-ctx")), 0.01);
    }

    @Test
    public void parseRemains_secondsEndTimeNormalizedToMillis() {
        JsonObject body = JsonParser.parseString("""
                {"model_remains":[{
                  "model_name":"general",
                  "current_interval_remaining_percent":50,
                  "end_time":1786624965
                }]}
                """).getAsJsonObject();

        JsonObject w5h = MiniMaxUsageVendor.parseRemains(body, null)
                .getAsJsonArray("windows").get(0).getAsJsonObject();
        assertEquals(java.time.Instant.ofEpochMilli(1786624965000L).toString(),
                w5h.get("reset_at").getAsString());
    }

    @Test
    public void parseRemains_apiErrorReturnsNull() {
        JsonObject body = JsonParser.parseString(
                "{\"base_resp\":{\"status_code\":1004,\"status_msg\":\"invalid api key\"}}").getAsJsonObject();
        assertNull(MiniMaxUsageVendor.parseRemains(body, null));
    }

    @Test
    public void parseRemains_emptyRemainsReturnsNull() {
        assertNull(MiniMaxUsageVendor.parseRemains(JsonParser.parseString(
                "{\"model_remains\":[]}").getAsJsonObject(), null));
        assertNull(MiniMaxUsageVendor.parseRemains(new JsonObject(), null));
        assertNull(MiniMaxUsageVendor.parseRemains(null, null));
    }

    // ===== probe pipeline (transport injected) =====

    @Test
    public void probe_cnAndIntlEndpointsDerivedFromBase() throws Exception {
        String[] seen = new String[2];
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seen[0] = url;
            return minimaxBody();
        });

        vendor.probe(ZaiUsageVendorTest.env("https://api.minimaxi.com/v1", "mm-cn"));
        assertEquals("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains", seen[0]);

        vendor.probe(ZaiUsageVendorTest.env("https://api.minimax.io/v1", "mm-intl"));
        assertEquals("https://api.minimax.io/v1/api/openplatform/coding_plan/remains", seen[0]);
    }

    private static double usedPct(JsonObject payload) {
        return payload.get("capacity_pct").getAsDouble();
    }

    private static JsonObject minimaxBody() {
        return JsonParser.parseString("""
                {"model_remains":[{"model_name":"general","current_interval_remaining_percent":50}]}
                """).getAsJsonObject();
    }
}
