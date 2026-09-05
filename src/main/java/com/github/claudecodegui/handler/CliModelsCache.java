package com.github.claudecodegui.handler;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * Short-lived Java-side cache for CLI provider model catalogs
 * ({@code get_cli_models} payloads).
 *
 * <p>Every cache miss spawns a full node + SDK + CLI cold start (2-5s for
 * codebuddy), while the catalog itself only changes when models.json is
 * edited or the remote model list rotates. A small TTL keeps repeat requests
 * — webview remounts, the post-save refetch, tool-window reloads — off the
 * cold-start path without meaningfully stalening the picker.
 *
 * <p>Measured on a warm dev machine (Windows, Node 22, authorized CLI):
 * an uncached {@code codebuddy listModels} round-trip takes ~1.9s median
 * (~130ms process spawn + module import, the rest SDK session + model
 * discovery), while a cache hit is a ConcurrentHashMap lookup (~10ns).
 * The 3-minute TTL is comfortably shorter than how often a user edits
 * models.json by hand, and any in-GUI edit bypasses it via invalidation.
 *
 * <p>The clock is {@link System#nanoTime}, so wall-clock jumps (NTP sync,
 * manual changes) cannot extend or shorten the TTL; values are only ever
 * compared for elapsed time.
 *
 * <p>Stale-while-revalidate: {@link #getStale} serves an expired entry so the
 * picker stays instant while the caller refreshes; the fresh payload then
 * replaces it. Only {@link #get} guarantees freshness.
 *
 * <p>Generations guard against a cold start that races an invalidation: every
 * invalidate bumps the provider's generation, and a {@link #put} carrying an
 * older generation is dropped — a request that started before models.json was
 * saved can never re-pollute the cache after the invalidation.
 *
 * <p>Invalidation points: {@link CodeBuddyProviderOperations} drops the
 * codebuddy entry whenever models.json is saved or local-config consent is
 * revoked. Externally edited files (outside the GUI) rely on the TTL.
 */
public final class CliModelsCache {

    /** 3 minutes, in nanoseconds — the clock is {@link System#nanoTime}-based. */
    private static final long DEFAULT_TTL_NANOS = 180_000_000_000L;
    private static final LongSupplier MONOTONIC_CLOCK = System::nanoTime;

    /**
     * Only providers whose catalog is derived from local config files with an
     * explicit invalidation hook are cached. Others (live-host catalogs such
     * as dsh) always take the cold path.
     */
    private static final Set<String> CACHEABLE_PROVIDERS = Set.of("codebuddy");

    private static final CliModelsCache SHARED = new CliModelsCache(DEFAULT_TTL_NANOS, MONOTONIC_CLOCK);

    private final long ttlNanos;
    private final LongSupplier clock;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    /** Bumped on every invalidate; puts from requests started before the bump are ignored. */
    private final Map<String, Long> generations = new ConcurrentHashMap<>();

    private static final class Entry {
        final String payload;
        final long storedAt;

        Entry(String payload, long storedAt) {
            this.payload = payload;
            this.storedAt = storedAt;
        }
    }

    CliModelsCache(long ttlNanos, LongSupplier clock) {
        this.ttlNanos = ttlNanos;
        this.clock = clock;
    }

    /** Returns the cached payload for {@code provider}, or null when absent/expired/not cacheable. */
    public static String get(String provider) {
        return SHARED.getInternal(provider);
    }

    /**
     * Returns the payload for {@code provider} even when expired
     * (stale-while-revalidate), or null when absent/not cacheable. Callers
     * must follow up with a fresh fetch — this only keeps the picker instant.
     */
    public static String getStale(String provider) {
        return SHARED.getStaleInternal(provider);
    }

    /** Current invalidation generation for {@code provider} (0 before the first invalidate). */
    public static long generation(String provider) {
        return SHARED.generationInternal(provider);
    }

    /**
     * Caches a successful payload; silently ignored for non-cacheable
     * providers or when {@code generation} no longer matches (an invalidate
     * superseded the request that produced this payload).
     */
    public static void put(String provider, String payload, long generation) {
        SHARED.putInternal(provider, payload, generation);
    }

    /** Drops the cached payload for {@code provider} and bumps its generation (no-op when nothing is cached). */
    public static void invalidate(String provider) {
        SHARED.invalidateInternal(provider);
    }

    String getInternal(String provider) {
        Entry entry = freshEntry(provider);
        return entry != null ? entry.payload : null;
    }

    String getStaleInternal(String provider) {
        if (provider == null || !CACHEABLE_PROVIDERS.contains(provider)) {
            return null;
        }
        Entry entry = entries.get(provider);
        return entry != null ? entry.payload : null;
    }

    long generationInternal(String provider) {
        return provider == null ? 0L : generations.getOrDefault(provider, 0L);
    }

    void putInternal(String provider, String payload, long generation) {
        if (provider == null || payload == null || !CACHEABLE_PROVIDERS.contains(provider)) {
            return;
        }
        if (generationInternal(provider) != generation) {
            return;
        }
        entries.put(provider, new Entry(payload, clock.getAsLong()));
    }

    void invalidateInternal(String provider) {
        if (provider == null) {
            return;
        }
        entries.remove(provider);
        generations.merge(provider, 1L, Long::sum);
    }

    private Entry freshEntry(String provider) {
        if (provider == null || !CACHEABLE_PROVIDERS.contains(provider)) {
            return null;
        }
        Entry entry = entries.get(provider);
        if (entry == null || clock.getAsLong() - entry.storedAt > ttlNanos) {
            return null;
        }
        return entry;
    }
}
