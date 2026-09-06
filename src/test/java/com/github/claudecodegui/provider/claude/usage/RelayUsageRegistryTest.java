package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class RelayUsageRegistryTest {

    @After
    public void tearDown() {
        RelayUsageHttp.setTransportForTests(null);
        RelayUsageCache.clearForTests();
    }

    // ===== vendor dispatch by base URL =====

    @Test
    public void match_dispatchesByHostAndPath() {
        assertEquals("kimi-coding", RelayUsageRegistry.match("https://api.kimi.com/coding").id());
        assertEquals("minimax", RelayUsageRegistry.match("https://api.minimaxi.com/v1").id());
        assertEquals("minimax", RelayUsageRegistry.match("https://api.minimax.io/v1").id());
        assertEquals("zai", RelayUsageRegistry.match("https://api.z.ai/api/anthropic").id());
        assertEquals("zai", RelayUsageRegistry.match("https://open.bigmodel.cn/api/anthropic").id());
        assertNull(RelayUsageRegistry.match("https://api.anthropic.com"));
        assertNull(RelayUsageRegistry.match("https://gateway.example.com"));
        assertNull(RelayUsageRegistry.match("https://gateway.example.com/z.ai/proxy"));
        assertNull(RelayUsageRegistry.match(null));
        assertNull(RelayUsageRegistry.match("not a url"));
    }

    @Test
    public void resolve_unknownHostOrNullToken_neverProbes() {
        int[] calls = {0};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            calls[0]++;
            return new JsonObject();
        });

        assertNull(RelayUsageRegistry.resolve(ZaiUsageVendorTest.settings("https://api.deepseek.com", "sk-x"), 1000L));
        // Vendor host but no credential → nothing to authenticate with
        assertNull(RelayUsageRegistry.resolve(ZaiUsageVendorTest.settings("https://api.z.ai/api/anthropic", null), 1000L));
        assertNull(RelayUsageRegistry.resolve(null, 1000L));
        assertEquals(0, calls[0]);
    }

    @Test
    public void resolve_probesMatchingVendorAndCachesWithinTtl() {
        int[] calls = {0};
        String[] seenUrl = {null};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            calls[0]++;
            seenUrl[0] = url;
            return zaiBody(42);
        });
        JsonObject settings = ZaiUsageVendorTest.settings("https://api.z.ai/api/anthropic", "t");
        long t0 = 1_000_000L;

        JsonObject payload = RelayUsageRegistry.resolve(settings, t0);
        assertEquals("https://api.z.ai/api/monitor/usage/quota/limit", seenUrl[0]);
        assertEquals(42.0, payload.get("capacity_pct").getAsDouble(), 0.01);

        // Within TTL → served from cache, no second probe
        RelayUsageRegistry.resolve(settings, t0 + RelayUsageCache.TTL_MS - 1);
        assertEquals(1, calls[0]);
        // TTL expired → probes again
        RelayUsageRegistry.resolve(settings, t0 + RelayUsageCache.TTL_MS + 1);
        assertEquals(2, calls[0]);
    }

    @Test
    public void resolve_cacheKeyedByVendorEndpointAndToken() {
        int[] calls = {0};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            calls[0]++;
            return zaiBody(10);
        });
        long t0 = 1_000_000L;

        RelayUsageRegistry.resolve(ZaiUsageVendorTest.settings("https://api.z.ai/api/anthropic", "account-a"), t0);
        assertEquals(1, calls[0]);
        // Same endpoint but a different token (account switch) must not reuse the cache
        RelayUsageRegistry.resolve(ZaiUsageVendorTest.settings("https://api.z.ai/api/anthropic", "account-b"), t0 + 1);
        assertEquals(2, calls[0]);
        // Same token on a different vendor never collides (different endpoint anyway)
        RelayUsageRegistry.resolve(ZaiUsageVendorTest.settings("https://api.minimaxi.com/v1", "account-a"), t0 + 2);
        assertEquals(3, calls[0]);
    }

    @Test
    public void resolve_cacheKeyUsesProbeOriginNotIgnoredPathOrQuery() {
        int[] calls = {0};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            calls[0]++;
            return zaiBody(10);
        });
        long t0 = 1_000_000L;

        RelayUsageRegistry.resolve(ZaiUsageVendorTest.settings(
                "https://api.z.ai/api/anthropic?token=secret", "account-a"), t0);
        RelayUsageRegistry.resolve(ZaiUsageVendorTest.settings(
                "https://api.z.ai/another-path?token=secret", "account-a"), t0 + 1);

        assertEquals(1, calls[0]);
    }

    @Test
    public void resolve_staleFallbackOnProbeFailure() {
        boolean[] fail = {false};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            if (fail[0]) {
                throw new IllegalStateException("boom");
            }
            return zaiBody(33);
        });
        JsonObject settings = ZaiUsageVendorTest.settings("https://api.z.ai/api/anthropic", "t");
        long t0 = 1_000_000L;

        RelayUsageRegistry.resolve(settings, t0);

        fail[0] = true;
        // Probe fails with an expired-but-recent cache → stale payload
        JsonObject stale = RelayUsageRegistry.resolve(settings, t0 + RelayUsageCache.TTL_MS + 1);
        assertEquals(33.0, stale.get("capacity_pct").getAsDouble(), 0.01);
        assertTrue(stale.get("stale").getAsBoolean());

        // Cache older than the stale cap → give up (null → caller falls back)
        assertNull(RelayUsageRegistry.resolve(settings, t0 + RelayUsageCache.STALE_MAX_MS + 1));
    }

    @Test
    public void resolve_parseFailureWithoutCacheReturnsNull() {
        RelayUsageHttp.setTransportForTests((url, headers) -> new JsonObject());
        assertNull(RelayUsageRegistry.resolve(
                ZaiUsageVendorTest.settings("https://api.z.ai/api/anthropic", "t"), 1000L));
    }

    @Test
    public void cache_nullKeyIsHandledAsMiss() {
        assertNull(RelayUsageCache.fresh(null, 1000L));
        assertNull(RelayUsageCache.stale(null, 1000L));
        RelayUsageCache.store(null, new JsonObject(), 1000L);
    }

    /** Keep per-model quotas separate even when the account and endpoint match. */
    @Test
    public void resolve_remembersEachMiniMaxModelQuota() {
        int[] calls = {0};
        RelayUsageHttp.setTransportForTests((url, headers) -> {
            calls[0]++;
            return JsonParser.parseString("""
                    {"model_remains":[
                      {"model_name":"MiniMax-M3","current_interval_remaining_percent":10},
                      {"model_name":"general","current_interval_remaining_percent":90}
                    ]}
                    """).getAsJsonObject();
        });
        JsonObject settings = ZaiUsageVendorTest.settings("https://api.minimax.io/v1", "account-a");
        assertEquals(10, RelayUsageRegistry.resolve(settings, 1000L).get("capacity_pct").getAsDouble(), 0.01);
        settings.getAsJsonObject("env").addProperty("ANTHROPIC_MODEL", "MiniMax-M3");
        assertEquals(90, RelayUsageRegistry.resolve(settings, 1001L).get("capacity_pct").getAsDouble(), 0.01);
        settings.getAsJsonObject("env").remove("ANTHROPIC_MODEL");
        assertEquals(10, RelayUsageRegistry.resolve(settings, 1002L).get("capacity_pct").getAsDouble(), 0.01);
        assertEquals(2, calls[0]);
    }

    private static JsonObject zaiBody(double pct) {
        return JsonParser.parseString(
                "{\"data\":{\"level\":\"max\",\"limits\":["
                        + "{\"type\":\"CREDIT_LIMIT\",\"unit\":3,\"number\":5,\"percentage\":" + pct
                        + ",\"nextResetTime\":1786624965401}]}}").getAsJsonObject();
    }
}
