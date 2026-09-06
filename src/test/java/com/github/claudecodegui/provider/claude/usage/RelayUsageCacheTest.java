package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Verify isolation, expiry and bounded retention of relay quota snapshots. */
public class RelayUsageCacheTest {

    /** Release shared entries so every test starts with an empty cache. */
    @After
    public void tearDown() {
        RelayUsageCache.clearForTests();
    }

    /** Retain newly fetched quotas when older accounts fill the cache. */
    @Test
    public void store_retiresOldQuotasBeforeTheNewestSnapshot() {
        for (int i = 0; i < 32; i++) {
            RelayUsageCache.store("account-" + i, payload(i), 1000L + i);
            assertNotNull("The latest probe must remain available", RelayUsageCache.fresh("account-" + i, 1032L));
        }
        for (int i = 0; i < 32; i++) {
            if (i < 16) {
                assertNull(RelayUsageCache.fresh("account-" + i, 1032L));
            } else {
                assertNotNull(RelayUsageCache.fresh("account-" + i, 1032L));
            }
        }
    }

    /** Protect refreshed accounts even when all timestamps are identical. */
    @Test
    public void store_keepsRefreshedAccountsWhenRetiringOlderEntries() {
        for (int i = 0; i < 16; i++) {
            RelayUsageCache.store("account-" + i, payload(i), 1000L);
        }
        RelayUsageCache.store("account-0", payload(42), 1000L);
        RelayUsageCache.store("account-16", payload(16), 1000L);
        assertEquals(42, RelayUsageCache.fresh("account-0", 1000L).getAsJsonObject("window").get("used_pct").getAsInt());
        assertNull(RelayUsageCache.fresh("account-1", 1000L));
        assertNotNull(RelayUsageCache.fresh("account-16", 1000L));
    }

    /** Keep frequently read accounts from being retired by newer probes. */
    @Test
    public void read_keepsActiveAccountsFromBeingRetired() {
        RelayUsageCache.store("busy", payload(1), 1000L);
        for (int i = 0; i < 15; i++) {
            RelayUsageCache.store("other-" + i, payload(i), 1000L);
        }
        // "busy" is the eldest of 16 entries but still being polled.
        assertNotNull(RelayUsageCache.fresh("busy", 1000L));
        RelayUsageCache.store("other-15", payload(15), 1000L);
        assertNotNull(RelayUsageCache.fresh("busy", 1000L));
        assertNull(RelayUsageCache.fresh("other-0", 1000L));
        assertNotNull(RelayUsageCache.fresh("other-15", 1000L));
    }

    /** Prevent callers and stale flags from changing stored payloads. */
    @Test
    public void cache_keepsAccountSnapshotsAndReturnedCopiesIndependent() {
        JsonObject original = payload(10);
        RelayUsageCache.store("a", original, 1000L);
        RelayUsageCache.store("b", payload(20), 1000L);
        original.getAsJsonObject("window").addProperty("used_pct", 99);
        JsonObject fresh = RelayUsageCache.fresh("a", 1000L);
        fresh.getAsJsonObject("window").addProperty("used_pct", 88);
        JsonObject stale = RelayUsageCache.stale("a", 1000L + RelayUsageCache.TTL_MS);
        assertTrue(stale.get("stale").getAsBoolean());
        assertEquals(10, stale.getAsJsonObject("window").get("used_pct").getAsInt());
        stale.getAsJsonObject("window").addProperty("used_pct", 77);
        assertFalse(RelayUsageCache.fresh("a", 1001L).has("stale"));
        assertEquals(10, RelayUsageCache.fresh("a", 1001L).getAsJsonObject("window").get("used_pct").getAsInt());
        assertEquals(20, RelayUsageCache.fresh("b", 1001L).getAsJsonObject("window").get("used_pct").getAsInt());
    }

    /** Expire on the exact boundary and reject clock rollback or overflow. */
    @Test
    public void cache_honorsExpiryAndClockBoundaries() {
        RelayUsageCache.store("a", payload(10), 1000L);
        assertNotNull(RelayUsageCache.fresh("a", 1000L + RelayUsageCache.TTL_MS - 1));
        assertNull(RelayUsageCache.fresh("a", 1000L + RelayUsageCache.TTL_MS));
        assertNotNull(RelayUsageCache.stale("a", 1000L + RelayUsageCache.STALE_MAX_MS - 1));
        assertNull(RelayUsageCache.stale("a", 1000L + RelayUsageCache.STALE_MAX_MS));
        assertNull(RelayUsageCache.fresh("a", 999L));
        assertNull(RelayUsageCache.stale("a", 999L));
        RelayUsageCache.store("overflow", payload(10), Long.MIN_VALUE);
        assertNull(RelayUsageCache.fresh("overflow", Long.MAX_VALUE));
        assertNull(RelayUsageCache.stale("overflow", Long.MAX_VALUE));
        RelayUsageCache.store("null", null, 1000L);
        assertNull(RelayUsageCache.fresh("null", 1000L));
    }

    private static JsonObject payload(int usedPct) {
        JsonObject window = new JsonObject();
        window.addProperty("used_pct", usedPct);
        JsonObject payload = new JsonObject();
        payload.add("window", window);
        return payload;
    }
}
