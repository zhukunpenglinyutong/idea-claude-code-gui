package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class KimiCodingUsageVendorTest {

    private final KimiCodingUsageVendor vendor = new KimiCodingUsageVendor();

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
    }

    // ===== host/path matching: the /coding path is what makes it a Coding Plan =====

    @Test
    public void matches_apiKimiHostWithCodingPathOnly() {
        assertTrue(vendor.matches("api.kimi.com", "/coding"));
        assertTrue(vendor.matches("api.kimi.com", "/coding/"));
        assertTrue(vendor.matches("api.kimi.com", "/coding/anthropic"));
        assertFalse(vendor.matches("api.kimi.com", ""));
        assertFalse(vendor.matches("api.kimi.com", "/v1"));
        // Segment boundary: a longer path merely prefixed by "coding" is not the plan
        assertFalse(vendor.matches("api.kimi.com", "/codingfoo"));
        assertFalse(vendor.matches("moonshot.cn", "/coding"));
        assertFalse(vendor.matches("api.moonshot.cn", "/coding"));
    }

    // ===== response parsing =====

    @Test
    public void parseUsages_limitAndRemainingProduce5hAndWeeklyWindows() {
        JsonObject body = JsonParser.parseString("""
                {"limits":[
                  {"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
                   "detail":{"limit":"120","remaining":"30","resetTime":"1759180800000"}}
                ],
                "usage":{"limit":"500","used":"150","resetTime":"1759699200000"}}
                """).getAsJsonObject();

        JsonObject payload = KimiCodingUsageVendor.parseUsages(body);

        assertEquals("kimi-coding-usages", payload.get("source").getAsString());
        // (120−30)/120 = 75% binds capacity
        assertEquals(75.0, payload.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("5h", payload.get("period_type").getAsString());

        com.google.gson.JsonArray windows = payload.getAsJsonArray("windows");
        assertEquals(2, windows.size());
        JsonObject w5h = windows.get(0).getAsJsonObject();
        assertEquals("5h", w5h.get("id").getAsString());
        assertEquals(75.0, w5h.get("used_pct").getAsDouble(), 0.01);
        assertEquals(java.time.Instant.ofEpochMilli(1759180800000L).toString(), w5h.get("reset_at").getAsString());
        JsonObject w7d = windows.get(1).getAsJsonObject();
        assertEquals("7d", w7d.get("id").getAsString());
        assertEquals(30.0, w7d.get("used_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseUsages_durationVariantsRecognized() {
        // 18000 seconds == 300 minutes == 5h; 604800 seconds == 7d; 7 days == 7d
        JsonObject body = JsonParser.parseString("""
                {"limits":[
                  {"window":{"duration":18000,"timeUnit":"TIME_UNIT_SECOND"},
                   "detail":{"limit":"100","used":"20"}},
                  {"window":{"duration":604800},
                   "detail":{"limit":"400","used":"100"}},
                  {"window":{"duration":7,"timeUnit":"TIME_UNIT_DAY"},
                   "detail":{"limit":"400","used":"300"}},
                  {"window":{"duration":999},
                   "detail":{"limit":"1","used":"1"}}
                ]}
                """).getAsJsonObject();

        com.google.gson.JsonArray windows = KimiCodingUsageVendor.parseUsages(body).getAsJsonArray("windows");
        // 5h once, then the two weekly variants merged keeping the worst (300/400)
        assertEquals(2, windows.size());
        assertEquals("5h", windows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(20.0, windows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
        assertEquals("7d", windows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(75.0, windows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseUsages_timeUnitIsAuthoritativeWhenPresent() {
        // 300 SECONDS is five minutes, not the 5h window — ignored, not misclassified.
        // 168 HOURS is a valid 7d spelling. Unknown units are ignored.
        JsonObject body = JsonParser.parseString("""
                {"limits":[
                  {"window":{"duration":300,"timeUnit":"TIME_UNIT_SECOND"},
                   "detail":{"limit":"100","used":"90"}},
                  {"window":{"duration":168,"timeUnit":"TIME_UNIT_HOUR"},
                   "detail":{"limit":"100","used":"40"}},
                  {"window":{"duration":300,"timeUnit":"FORTNIGHTS"},
                   "detail":{"limit":"100","used":"80"}}
                ]}
                """).getAsJsonObject();

        com.google.gson.JsonArray windows = KimiCodingUsageVendor.parseUsages(body).getAsJsonArray("windows");
        assertEquals(1, windows.size());
        assertEquals("7d", windows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(40.0, windows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseUsages_secondsResetTimeNormalizedToMillis() {
        JsonObject body = JsonParser.parseString("""
                {"usage":{"limit":"400","used":"100","resetTime":1759699200}}
                """).getAsJsonObject();

        JsonObject w7d = KimiCodingUsageVendor.parseUsages(body)
                .getAsJsonArray("windows").get(0).getAsJsonObject();
        assertEquals(java.time.Instant.ofEpochMilli(1759699200000L).toString(),
                w7d.get("reset_at").getAsString());
    }

    @Test
    public void parseUsages_weeklyUsageOnly() {
        JsonObject body = JsonParser.parseString("""
                {"usage":{"limit":"400","remaining":"100","resetTime":1759699200000}}
                """).getAsJsonObject();

        JsonObject payload = KimiCodingUsageVendor.parseUsages(body);
        assertEquals("7d", payload.get("period_type").getAsString());
        assertEquals(75.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseUsages_overRemainingClampsToHundred() {
        JsonObject body = JsonParser.parseString("""
                {"usage":{"limit":"100","remaining":"-50"}}
                """).getAsJsonObject();
        assertEquals(100.0, KimiCodingUsageVendor.parseUsages(body).get("capacity_pct").getAsDouble(), 0.01);
    }

    @Test
    public void parseUsages_zeroLimitOrNoQuotaFieldsReturnsNull() {
        assertNull(KimiCodingUsageVendor.parseUsages(JsonParser.parseString(
                "{\"limits\":[{\"window\":{\"duration\":300},\"detail\":{\"limit\":\"0\"}}]}").getAsJsonObject()));
        assertNull(KimiCodingUsageVendor.parseUsages(JsonParser.parseString(
                "{\"limits\":[{\"window\":{\"duration\":300},\"detail\":{}},\"no-window\"]}").getAsJsonObject()));
        assertNull(KimiCodingUsageVendor.parseUsages(new JsonObject()));
        assertNull(KimiCodingUsageVendor.parseUsages(null));
    }

    // ===== probe pipeline (transport injected) =====

    @Test
    public void probe_appendsUsagesPathToOrigin() throws Exception {
        String[] seen = new String[2];
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seen[0] = url;
            seen[1] = headers.get("Authorization");
            return JsonParser.parseString(
                    "{\"usage\":{\"limit\":\"100\",\"used\":\"10\"}}").getAsJsonObject();
        });

        JsonObject payload = vendor.probe(ZaiUsageVendorTest.env("https://api.kimi.com/coding", "kimi-t"));

        assertEquals("https://api.kimi.com/coding/v1/usages", seen[0]);
        assertEquals("Bearer kimi-t", seen[1]);
        assertEquals(10.0, payload.get("capacity_pct").getAsDouble(), 0.01);
    }
}
