package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Payload cache shared by all relay usage vendors.
 *
 * <p>The cache is bounded because settings can contain multiple relay
 * credentials over the lifetime of one IDE process. Payloads are copied at the
 * boundary so callers cannot mutate cached data.
 */
final class RelayUsageCache {

    /** Fresh TTL, set just under the webview's 120s poll cadence. */
    static final long TTL_MS = 115_000L;
    /** Max age for serving a stale payload after repeated probe failures. */
    static final long STALE_MAX_MS = 30 * 60_000L;
    private static final int MAX_ENTRIES = 16;

    private static final Map<String, Entry> entries = new LinkedHashMap<>();

    private RelayUsageCache() {
    }

    /** Fresh cached payload for {@code key}, or null when absent/expired. */
    static synchronized JsonObject fresh(String key, long nowMs) {
        if (key == null) {
            return null;
        }
        Entry c = entries.get(key);
        long age = age(nowMs, c);
        if (age >= 0 && age < TTL_MS) {
            touch(key, c);
            return c.payload.deepCopy();
        }
        return null;
    }

    /** Stale cached payload (flagged) for {@code key} within {@link #STALE_MAX_MS}, or null. */
    static synchronized JsonObject stale(String key, long nowMs) {
        if (key == null) {
            return null;
        }
        Entry c = entries.get(key);
        long age = age(nowMs, c);
        if (age >= 0 && age < STALE_MAX_MS) {
            touch(key, c);
            JsonObject copy = c.payload.deepCopy();
            copy.addProperty("stale", true);
            return copy;
        }
        return null;
    }

    /** Persist a successful probe result for {@code key}. */
    static synchronized void store(String key, JsonObject payload, long nowMs) {
        if (key == null || payload == null) {
            return;
        }
        // Refresh insertion order so eviction keeps the most recently fetched quotas.
        entries.remove(key);
        entries.put(key, new Entry(nowMs, payload.deepCopy()));
        while (entries.size() > MAX_ENTRIES) {
            Iterator<String> iterator = entries.keySet().iterator();
            entries.remove(iterator.next());
        }
    }

    /** Test-only: drop the cached payload. */
    static synchronized void clearForTests() {
        entries.clear();
    }

    /** Refresh insertion order on a read hit so active accounts survive eviction. */
    private static void touch(String key, Entry entry) {
        entries.remove(key);
        entries.put(key, entry);
    }

    private static long age(long nowMs, Entry entry) {
        if (entry == null || nowMs < entry.atMs) {
            return -1L;
        }
        long age = nowMs - entry.atMs;
        return age < 0 ? Long.MAX_VALUE : age;
    }

    private static final class Entry {
        final long atMs;
        final JsonObject payload;

        Entry(long atMs, JsonObject payload) {
            this.atMs = atMs;
            this.payload = payload;
        }
    }
}
