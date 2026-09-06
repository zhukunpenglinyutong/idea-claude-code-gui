package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import java.util.Locale;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** ZaiUsageVendor — migrated from the z.ai half of ClaudePlanUsageServiceTest. */
public class ZaiUsageVendorTest {

    private final ZaiUsageVendor vendor = new ZaiUsageVendor();

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
    }

    // ===== host matching =====

    @Test
    public void matches_hostsOnlyNotLookalikes() {
        assertTrue(vendor.matches("api.z.ai", "/api/anthropic"));
        assertTrue(vendor.matches("z.ai", "/api/anthropic"));
        assertTrue(vendor.matches("open.bigmodel.cn", "/api/anthropic"));
        assertTrue(vendor.matches("sub.open.bigmodel.cn", "/api/anthropic"));
        // Look-alike hosts must not trigger the z.ai probe
        assertFalse(vendor.matches("quiz.ai", "/api/anthropic"));
        assertFalse(vendor.matches("buzz.ai", "/api"));
        assertFalse(vendor.matches("api.anthropic.com", ""));
    }

    @Test
    public void matches_isNullSafeAndCaseInsensitive() {
        assertFalse(vendor.matches(null, "/api/anthropic"));
        assertTrue(vendor.matches("API.Z.AI", "/api/anthropic"));
    }

    @Test
    public void parseQuota_ignoresUnknownWindowShape() {
        JsonObject body = JsonParser.parseString("{\"data\":{\"limits\":["
                + "{\"type\":\"CREDIT_LIMIT\",\"unit\":4,\"number\":1,\"percentage\":41}]}}")
                .getAsJsonObject();
        assertNull(ZaiUsageVendor.parseQuota(body));
    }

    @Test
    public void parseQuota_maps5h7dWindowsAndLevel() {
        JsonObject body = JsonParser.parseString("""
                {"code":200,"success":true,"data":{
                  "level":"max",
                  "limits":[
                    {"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":13,"nextResetTime":1786624965401},
                    {"type":"CREDIT_LIMIT","unit":6,"number":1,"percentage":2,"nextResetTime":1787155353998}
                  ]
                }}
                """).getAsJsonObject();
        JsonObject payload = ZaiUsageVendor.parseQuota(body);

        assertEquals("claude", payload.get("provider").getAsString());
        assertEquals("zai-quota-limit", payload.get("source").getAsString());
        assertTrue(payload.get("present").getAsBoolean());
        assertEquals(13.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("5h", payload.get("period_type").getAsString());
        assertEquals("max", payload.get("level").getAsString());

        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(2, windows.size());
        JsonObject w0 = windows.get(0).getAsJsonObject();
        assertEquals("5h", w0.get("id").getAsString());
        assertEquals(13.0, w0.get("used_pct").getAsDouble(), 0.01);
        assertEquals("7d", windows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(2.0, windows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseQuota_timeLimitMapsToMonthly() {
        JsonObject body = JsonParser.parseString("""
                {"data":{"level":"pro","limits":[
                  {"type":"TIME_LIMIT","unit":4,"number":1,"percentage":55}
                ]}}
                """).getAsJsonObject();
        JsonObject payload = ZaiUsageVendor.parseQuota(body);
        assertEquals("monthly", payload.getAsJsonArray("windows").get(0).getAsJsonObject().get("id").getAsString());
        assertEquals("pro", payload.get("level").getAsString());
    }

    @Test
    public void parseQuota_timeLimitIsLocaleIndependent() {
        Locale previous = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"));
            JsonObject body = JsonParser.parseString("""
                    {"data":{"limits":[
                      {"type":"time_limit","unit":4,"number":1,"percentage":55}
                    ]}}
                    """).getAsJsonObject();
            assertEquals("monthly", ZaiUsageVendor.parseQuota(body)
                    .getAsJsonArray("windows").get(0).getAsJsonObject().get("id").getAsString());
        } finally {
            Locale.setDefault(previous);
        }
    }

    @Test
    public void parseQuota_emptyLimitsReturnsNull() {
        JsonObject body = JsonParser.parseString("{\"data\":{\"limits\":[]}}").getAsJsonObject();
        assertNull(ZaiUsageVendor.parseQuota(body));
    }

    @Test
    public void parseQuota_creditLimitUnitDays_mapsTo7d() {
        JsonObject body = JsonParser.parseString("""
                {"data":{"limits":[
                  {"type":"CREDIT_LIMIT","unit":4,"number":7,"percentage":41}
                ]}}
                """).getAsJsonObject();
        JsonObject payload = ZaiUsageVendor.parseQuota(body);
        assertEquals("7d", payload.getAsJsonArray("windows").get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(41.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseQuota_duplicatePeriodsMergeKeepingWorst() {
        JsonObject body = JsonParser.parseString("""
                {"data":{"limits":[
                  {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":10,"nextResetTime":1786624965401},
                  {"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":20,"nextResetTime":1786624965401}
                ]}}
                """).getAsJsonObject();
        JsonObject payload = ZaiUsageVendor.parseQuota(body);

        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(1, windows.size());
        JsonObject w = windows.get(0).getAsJsonObject();
        assertEquals("5h", w.get("id").getAsString());
        assertEquals(20.0, w.get("used_pct").getAsDouble(), 0.01);
        assertEquals(20.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    // ===== probe pipeline (transport injected) =====

    @Test
    public void probe_sendsBearerTokenToMonitorUrl() throws Exception {
        String[] seen = new String[2];
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seen[0] = url;
            seen[1] = headers.get("Authorization");
            return zaiBody(42);
        });

        JsonObject payload = vendor.probe(env("https://api.z.ai/api/anthropic", "glm-secret"));

        assertEquals("https://api.z.ai/api/monitor/usage/quota/limit", seen[0]);
        assertEquals("Bearer glm-secret", seen[1]);
        assertEquals(42.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void probe_customLoopbackPortKept_plainHttpAllowed() throws Exception {
        String[] seen = new String[1];
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seen[0] = url;
            return zaiBody(1);
        });

        vendor.probe(env("http://127.0.0.1:9000/api/anthropic", "t"));
        assertEquals("http://127.0.0.1:9000/api/monitor/usage/quota/limit", seen[0]);
    }

    @Test
    public void probe_plainHttpToRemoteHostRefused() throws Exception {
        // Bearer tokens must not travel over plaintext to a remote host
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            throw new IllegalStateException("transport must not be reached");
        });
        assertNull(vendor.probe(env("http://api.z.ai/api/anthropic", "t")));
    }

    private static JsonObject zaiBody(double pct) {
        return JsonParser.parseString(
                "{\"data\":{\"level\":\"max\",\"limits\":["
                        + "{\"type\":\"CREDIT_LIMIT\",\"unit\":3,\"number\":5,\"percentage\":" + pct
                        + ",\"nextResetTime\":1786624965401}]}}").getAsJsonObject();
    }

    static RelayUsageEnv env(String base, String token) {
        return RelayUsageEnv.from(settings(base, token));
    }

    static JsonObject settings(String base, String token) {
        JsonObject settings = new JsonObject();
        JsonObject envObj = new JsonObject();
        if (base != null) {
            envObj.addProperty("ANTHROPIC_BASE_URL", base);
        }
        if (token != null) {
            envObj.addProperty("ANTHROPIC_AUTH_TOKEN", token);
        }
        settings.add("env", envObj);
        return settings;
    }
}
