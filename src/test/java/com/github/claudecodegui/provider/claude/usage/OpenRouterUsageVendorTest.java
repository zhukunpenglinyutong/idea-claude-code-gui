package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class OpenRouterUsageVendorTest {

    private final OpenRouterUsageVendor vendor = new OpenRouterUsageVendor();

    // ===== host matching =====

    @Test
    public void matches_openRouterHostsOnly() {
        assertTrue(vendor.matches("openrouter.ai", "/api/v1"));
        assertTrue(vendor.matches("api.openrouter.ai", "/api/v1"));
        assertFalse(vendor.matches("openrouter.ai.evil.net", ""));
        assertFalse(vendor.matches(null, "/api/v1"));
    }

    // ===== response parsing =====

    @Test
    public void parseBalance_derivesRemainingFromCreditsMinusUsage() {
        JsonObject body = JsonParser.parseString(
                "{\"data\":{\"total_credits\":100,\"total_usage\":57.5}}").getAsJsonObject();

        RelayUsageJson.Balance balance = vendor.parseBalance(body, "openrouter.ai");

        assertEquals(42.5, balance.remaining(), 0.001);
        assertEquals(100.0, balance.total(), 0.001);
        assertEquals(57.5, balance.used(), 0.001);
        assertEquals("USD", balance.unit());
    }

    @Test
    public void parseBalance_singleFieldStillReports() {
        RelayUsageJson.Balance balance = vendor.parseBalance(
                JsonParser.parseString("{\"data\":{\"total_usage\":12.5}}").getAsJsonObject(),
                "openrouter.ai");
        assertEquals(-12.5, balance.remaining(), 0.001);
        assertNull(balance.total());
    }

    @Test
    public void parseBalance_missingBothFieldsYieldsNull() {
        assertNull(vendor.parseBalance(JsonParser.parseString("{\"data\":{}}").getAsJsonObject(),
                "openrouter.ai"));
        assertNull(vendor.parseBalance(null, "openrouter.ai"));
    }
}
