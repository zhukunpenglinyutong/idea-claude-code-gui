package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class MoonshotUsageVendorTest {

    private final MoonshotUsageVendor vendor = new MoonshotUsageVendor();

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
    }

    // ===== host matching =====

    @Test
    public void matches_moonshotApiHostsOnly() {
        assertTrue(vendor.matches("api.moonshot.cn", "/anthropic"));
        assertTrue(vendor.matches("api.moonshot.ai", "/anthropic"));
        // api.kimi.com is the Coding Plan host only — not a PayGo balance
        // endpoint; bare registrable domains must not trigger a probe either
        assertFalse(vendor.matches("api.kimi.com", "/v1"));
        assertFalse(vendor.matches("moonshot.cn", ""));
        assertFalse(vendor.matches("moonshot.cn.evil.net", ""));
        assertFalse(vendor.matches(null, "/v1"));
    }

    // ===== response parsing =====

    @Test
    public void parseBalance_readsAvailableBalance() {
        JsonObject body = JsonParser.parseString(
                "{\"code\":0,\"data\":{\"available_balance\":42.50,\"granted_balance\":10.00}}")
                .getAsJsonObject();

        RelayUsageJson.Balance balance = vendor.parseBalance(body, "api.moonshot.cn");

        assertEquals(42.50, balance.remaining(), 0.001);
        assertEquals("CNY", balance.unit());
    }

    @Test
    public void parseBalance_acceptsFieldVariants() {
        assertEquals(7.5, vendor.parseBalance(
                JsonParser.parseString("{\"data\":{\"balance\":7.5}}").getAsJsonObject(),
                "api.moonshot.ai").remaining(), 0.001);
        assertEquals(9.0, vendor.parseBalance(
                JsonParser.parseString("{\"total_balance\":9.0}").getAsJsonObject(),
                "api.moonshot.cn").remaining(), 0.001);
    }

    @Test
    public void parseBalance_missingAmountsYieldNull() {
        assertNull(vendor.parseBalance(JsonParser.parseString("{\"data\":{}}").getAsJsonObject(),
                "api.moonshot.cn"));
        assertNull(vendor.parseBalance(null, "api.moonshot.cn"));
    }

    // ===== probe =====

    @Test
    public void probe_hitsUsersMeBalancePath() throws Exception {
        String[] seenUrl = {null};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            seenUrl[0] = url;
            return JsonParser.parseString("{\"data\":{\"available_balance\":42.50}}").getAsJsonObject();
        });

        JsonObject payload = vendor.probe(RelayUsageEnv.from(
                ZaiUsageVendorTest.settings("https://api.moonshot.cn/anthropic", "sk-x")));

        assertEquals("https://api.moonshot.cn/v1/users/me/balance", seenUrl[0]);
        assertEquals("moonshot", payload.get("source").getAsString());
        assertEquals(42.50, payload.getAsJsonObject("balance").get("remaining").getAsDouble(), 0.001);
    }
}
