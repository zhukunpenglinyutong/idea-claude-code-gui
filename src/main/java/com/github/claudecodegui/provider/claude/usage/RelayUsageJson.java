package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.time.Instant;
import java.util.Collection;

/**
 * Shared JSON accessors and capacity-payload builders for relay usage vendors.
 *
 * <p>Every vendor must translate its native usage API response into the capacity
 * shape consumed by the webview ({@code capacity_pct} + {@code windows[]}); these
 * helpers keep that translation in one place so all vendors emit an identical,
 * contract-stable structure (see {@code planUsagePace.ts#parseCapacityPayload}).
 */
public final class RelayUsageJson {

    private RelayUsageJson() {
    }

    // ===== tolerant accessors (accept the first present, numeric-parsable key) =====

    /** First finite double among {@code keys}, or null. String primitives are parsed. */
    public static Double asDouble(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o != null && o.has(k) && o.get(k).isJsonPrimitive() && !o.get(k).isJsonNull()) {
                try {
                    return o.get(k).getAsDouble();
                } catch (RuntimeException ignored) {
                }
            }
        }
        return null;
    }

    /** First long among {@code keys}, or null. String primitives are parsed. */
    public static Long asLong(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o != null && o.has(k) && o.get(k).isJsonPrimitive() && !o.get(k).isJsonNull()) {
                try {
                    return o.get(k).getAsLong();
                } catch (RuntimeException ignored) {
                }
            }
        }
        return null;
    }

    /** Integer value of {@code key}, or null when absent/not numeric. */
    public static Integer asInt(JsonObject o, String key) {
        if (o != null && o.has(key) && o.get(key).isJsonPrimitive() && !o.get(key).isJsonNull()) {
            try {
                return o.get(key).getAsInt();
            } catch (RuntimeException ignored) {
            }
        }
        return null;
    }

    /** String value of {@code key}, or null. */
    public static String asString(JsonObject o, String key) {
        if (o != null && o.has(key) && o.get(key).isJsonPrimitive() && !o.get(key).isJsonNull()) {
            return o.get(key).getAsString();
        }
        return null;
    }

    /** Object value of {@code key}, or null when absent or not an object. */
    public static JsonObject asObject(JsonObject o, String key) {
        if (o != null && o.has(key) && o.get(key).isJsonObject()) {
            return o.getAsJsonObject(key);
        }
        return null;
    }

    /** Array value of {@code key}, or null when absent or not an array. */
    public static JsonArray asArray(JsonObject o, String key) {
        if (o != null && o.has(key) && o.get(key).isJsonArray()) {
            return o.getAsJsonArray(key);
        }
        return null;
    }

    /** Clamp a percentage into [0, 100]; non-finite values collapse to 0. */
    public static double clampPct(double v) {
        if (!Double.isFinite(v)) {
            return 0;
        }
        return Math.max(0, Math.min(100, v));
    }

    /**
     * Values below this threshold are treated as epoch SECONDS, not millis:
     * 1e11 ms is March 1973 while 1e11 s is the year 5138, so any realistic
     * reset time sits cleanly on one side of it. Vendor APIs differ on the
     * unit (and some are undocumented), so normalize here rather than guess
     * per vendor.
     */
    private static final long EPOCH_SECONDS_CEILING = 100_000_000_000L;

    /** Epoch timestamp among {@code keys}, normalized to milliseconds, or null. */
    public static Long asEpochMs(JsonObject o, String... keys) {
        Long v = asLong(o, keys);
        if (v == null || v < 0) {
            return null;
        }
        return v < EPOCH_SECONDS_CEILING ? v * 1000L : v;
    }

    /** Render epoch milliseconds as an ISO-8601 instant (the payload reset_at format). */
    public static String epochMsToIso(long epochMs) {
        if (epochMs < 0) {
            return null;
        }
        return Instant.ofEpochMilli(epochMs).toString();
    }

    // ===== capacity payload construction =====

    /**
     * One {@code windows[]} entry. {@code id} doubles as {@code period_type}
     * ("5h" / "7d" / "monthly" / …); {@code resetAtMs} is optional.
     */
    public static JsonObject window(String id, double usedPct, Long resetAtMs) {
        JsonObject w = new JsonObject();
        w.addProperty("id", id);
        w.addProperty("used_pct", usedPct);
        if (resetAtMs != null) {
            String resetAt = epochMsToIso(resetAtMs);
            if (resetAt != null) {
                w.addProperty("reset_at", resetAt);
            }
        }
        w.addProperty("period_type", id);
        return w;
    }

    /**
     * Assemble the shared capacity payload from ordered windows. The binding
     * {@code capacity_pct} prefers the 5h window (the shortest actionable budget)
     * and otherwise falls back to the worst window, mirroring the original z.ai
     * behaviour. {@code windows} must be non-empty; {@code level} (plan tier) is
     * optional and vendor-specific.
     */
    public static JsonObject capacityPayload(String source, Collection<JsonObject> windows, String level) {
        if (windows == null || windows.isEmpty()) {
            return null;
        }
        Double primary5h = null;
        double maxPct = 0;
        for (JsonObject w : windows) {
            double pct = w.get("used_pct").getAsDouble();
            if ("5h".equals(w.get("id").getAsString())) {
                primary5h = pct;
            }
            if (pct > maxPct) {
                maxPct = pct;
            }
        }
        double capacity = primary5h != null ? primary5h : maxPct;

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", "claude");
        out.addProperty("source", source);
        out.addProperty("capacity_pct", capacity);
        out.addProperty("period_type", windows.iterator().next().get("id").getAsString());
        JsonArray arr = new JsonArray();
        for (JsonObject w : windows) {
            arr.add(w);
        }
        out.add("windows", arr);
        if (level != null) {
            out.addProperty("level", level);
        }
        return out;
    }

    /** {@code true} when {@code el} is a JSON object (array element guard). */
    public static boolean isObject(JsonElement el) {
        return el != null && el.isJsonObject();
    }
}
