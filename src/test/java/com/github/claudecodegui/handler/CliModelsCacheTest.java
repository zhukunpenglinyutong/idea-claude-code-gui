package com.github.claudecodegui.handler;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Unit tests for the TTL catalog cache backing {@link CliModelsHandler}.
 * The injected clock is unit-agnostic (values only ever measure elapsed
 * time), so tests use small numbers against a millisecond-shaped TTL.
 */
public class CliModelsCacheTest {

    private static final String PAYLOAD = "{\"provider\":\"codebuddy\",\"models\":[{\"id\":\"model-a\"}]}";

    /** Puts through the current generation, mirroring how the handler calls the cache. */
    private static void putCurrent(CliModelsCache cache, String provider, String payload) {
        cache.putInternal(provider, payload, cache.generationInternal(provider));
    }

    @Test
    public void shouldReturnNullWhenNothingIsCached() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);

        assertNull(cache.getInternal("codebuddy"));
        assertNull(cache.getStaleInternal("codebuddy"));
    }

    @Test
    public void shouldServeFreshPayloadWithinTtl() {
        long[] now = {1_000L};
        CliModelsCache cache = new CliModelsCache(180_000L, () -> now[0]);
        putCurrent(cache, "codebuddy", PAYLOAD);

        now[0] = 1_000L + 179_999L;

        assertEquals(PAYLOAD, cache.getInternal("codebuddy"));
    }

    @Test
    public void shouldExpirePayloadAfterTtl() {
        long[] now = {1_000L};
        CliModelsCache cache = new CliModelsCache(180_000L, () -> now[0]);
        putCurrent(cache, "codebuddy", PAYLOAD);

        now[0] = 1_000L + 180_001L;

        assertNull(cache.getInternal("codebuddy"));
    }

    @Test
    public void shouldServeExpiredPayloadAsStale() {
        long[] now = {1_000L};
        CliModelsCache cache = new CliModelsCache(180_000L, () -> now[0]);
        putCurrent(cache, "codebuddy", PAYLOAD);

        now[0] = 1_000L + 180_001L;

        assertNull(cache.getInternal("codebuddy"));
        assertEquals(PAYLOAD, cache.getStaleInternal("codebuddy"));
    }

    @Test
    public void shouldNotServeStaleEntryAfterReput() {
        long[] now = {1_000L};
        CliModelsCache cache = new CliModelsCache(180_000L, () -> now[0]);
        putCurrent(cache, "codebuddy", PAYLOAD);
        now[0] = 200_000L;
        String fresh = "{\"provider\":\"codebuddy\",\"models\":[]}";
        putCurrent(cache, "codebuddy", fresh);
        now[0] = 200_000L + 100L;

        assertEquals(fresh, cache.getInternal("codebuddy"));
    }

    @Test
    public void shouldNotCacheProvidersWithoutInvalidationHook() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);

        putCurrent(cache, "dsh", PAYLOAD);

        assertNull(cache.getInternal("dsh"));
        assertNull(cache.getStaleInternal("dsh"));
    }

    @Test
    public void shouldDropEntryOnInvalidate() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);
        putCurrent(cache, "codebuddy", PAYLOAD);

        cache.invalidateInternal("codebuddy");

        assertNull(cache.getInternal("codebuddy"));
        assertNull(cache.getStaleInternal("codebuddy"));
    }

    @Test
    public void shouldIgnoreNullPayload() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);

        putCurrent(cache, "codebuddy", null);

        assertNull(cache.getInternal("codebuddy"));
    }

    @Test
    public void invalidateShouldBumpGeneration() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);
        assertEquals(0L, cache.generationInternal("codebuddy"));

        cache.invalidateInternal("codebuddy");
        cache.invalidateInternal("codebuddy");

        assertEquals(2L, cache.generationInternal("codebuddy"));
    }

    @Test
    public void shouldAcceptPutFromCurrentGeneration() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);

        cache.putInternal("codebuddy", PAYLOAD, cache.generationInternal("codebuddy"));

        assertEquals(PAYLOAD, cache.getInternal("codebuddy"));
    }

    @Test
    public void shouldIgnorePutFromSupersededGeneration() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);
        // A cold start that began before the invalidate tries to cache its
        // pre-invalidation payload afterwards — it must be dropped, otherwise
        // a save-triggered refresh would resurrect stale data.
        cache.invalidateInternal("codebuddy");

        cache.putInternal("codebuddy", PAYLOAD, 0L);

        assertNull(cache.getInternal("codebuddy"));
        assertNull(cache.getStaleInternal("codebuddy"));
    }

    @Test
    public void shouldTrackGenerationsPerProvider() {
        CliModelsCache cache = new CliModelsCache(180_000L, () -> 1_000L);
        cache.invalidateInternal("codebuddy");

        // Other providers have their own generation counter.
        assertEquals(0L, cache.generationInternal("dsh"));
        assertEquals(1L, cache.generationInternal("codebuddy"));
    }
}
