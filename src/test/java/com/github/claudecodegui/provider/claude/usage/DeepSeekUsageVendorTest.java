package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class DeepSeekUsageVendorTest {

    private final DeepSeekUsageVendor vendor = new DeepSeekUsageVendor();

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
    }

    // ===== host matching =====

    @Test
    public void matches_apiHostsOnly() {
        assertTrue(vendor.matches("api.deepseek.com", "/anthropic"));
        // The bare registrable domain must not trigger a probe
        assertFalse(vendor.matches("deepseek.com", ""));
        assertFalse(vendor.matches("www.deepseek.com", ""));
        // Look-alikes: suffix must be a domain boundary, not a substring
        assertFalse(vendor.matches("notdeepseek.com", ""));
        assertFalse(vendor.matches("api.deepseek.com.evil.net", ""));
        assertFalse(vendor.matches(null, "/anthropic"));
    }

    // ===== response parsing =====

    @Test
    public void parseBalance_readsFirstEntryWithResponseCurrency() {
        JsonObject body = JsonParser.parseString("""
                {"is_available":true,"balance_infos":[
                  {"currency":"CNY","total_balance":"110.06",
                   "granted_balance":"10.03","topped_up_balance":"100.03"}
                ]}
                """).getAsJsonObject();

        RelayUsageJson.Balance balance = vendor.parseBalance(body, "api.deepseek.com");

        assertEquals(110.06, balance.remaining(), 0.001);
        assertNull(balance.total());
        assertNull(balance.used());
        assertEquals("CNY", balance.unit());
    }

    @Test
    public void parseBalance_nonNumericFirstEntryFallsThroughToNext() {
        JsonObject body = JsonParser.parseString("""
                {"balance_infos":[
                  {"currency":"CNY","total_balance":"not-a-number"},
                  {"currency":"CNY","total_balance":"42.50"}
                ]}
                """).getAsJsonObject();

        assertEquals(42.50, vendor.parseBalance(body, "api.deepseek.com").remaining(), 0.001);
    }

    @Test
    public void parseBalance_emptyOrMissingInfosYieldsNull() {
        assertNull(vendor.parseBalance(JsonParser.parseString("{\"balance_infos\":[]}").getAsJsonObject(),
                "api.deepseek.com"));
        assertNull(vendor.parseBalance(new JsonObject(), "api.deepseek.com"));
        assertNull(vendor.parseBalance(null, "api.deepseek.com"));
    }

    // ===== probe =====

    @Test
    public void probe_hitsBalancePathOnBaseOriginAndEmitsBalancePayload() throws Exception {
        String[] seenUrl = {null};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seenUrl[0] = url;
            return JsonParser.parseString(
                    "{\"balance_infos\":[{\"currency\":\"CNY\",\"total_balance\":\"88.20\"}]}").getAsJsonObject();
        });

        JsonObject payload = vendor.probe(RelayUsageEnv.from(
                ZaiUsageVendorTest.settings("https://api.deepseek.com/anthropic", "sk-x")));

        assertEquals("https://api.deepseek.com/user/balance", seenUrl[0]);
        assertEquals("deepseek", payload.get("source").getAsString());
        assertEquals(88.20, payload.getAsJsonObject("balance").get("remaining").getAsDouble(), 0.001);
        assertEquals("CNY", payload.getAsJsonObject("balance").get("unit").getAsString());
        assertFalse(payload.has("capacity_pct"));
        assertFalse(payload.has("windows"));
    }
}
