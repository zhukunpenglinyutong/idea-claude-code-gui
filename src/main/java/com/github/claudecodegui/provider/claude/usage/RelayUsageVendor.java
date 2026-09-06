package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

/**
 * One relay vendor that can report Claude plan usage for its own backend.
 *
 * <p>Implementations are stateless; caching, HTTP and error policy live in
 * {@link RelayUsageRegistry} / {@link RelayUsageHttp} / {@link RelayUsageCache}.
 * Vendors only decide <em>whether</em> they own a base URL and <em>how</em> to
 * translate their usage API into the shared capacity payload
 * ({@code capacity_pct} + {@code windows[]}).
 */
public interface RelayUsageVendor {

    /**
     * Stable vendor id ("zai", "minimax", "kimi-coding", …). Namespaces the
     * probe cache; also used in log messages.
     */
    String id();

    /**
     * Whether this vendor serves the given anthropic base URL. {@code host} is
     * the lowercased {@code ANTHROPIC_BASE_URL} host; {@code path} is its
     * (possibly empty) lowercased path — needed because some vendors share a
     * host and are distinguished by path only (api.kimi.com/coding).
     */
    boolean matches(String host, String path);

    /**
     * Probe the vendor usage API and translate the response into a capacity
     * payload (or null when the response carries no usable data — e.g. an
     * expired plan). Throwing signals a transport/API failure and triggers the
     * caller's stale-cache fallback.
     */
    JsonObject probe(RelayUsageEnv env) throws Exception;
}
