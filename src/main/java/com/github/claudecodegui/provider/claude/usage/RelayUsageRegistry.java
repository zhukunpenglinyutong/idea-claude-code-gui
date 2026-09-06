package com.github.claudecodegui.provider.claude.usage;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Locale;

/**
 * Resolves the plan-usage payload for the active relay backend: matches
 * {@code ANTHROPIC_BASE_URL} against the registered {@link RelayUsageVendor}s,
 * then probes with the shared cache/stale policy.
 *
 * <p>Registration order matters where vendors share a host:
 * {@code api.kimi.com} serves both the plain Moonshot API and the Coding Plan,
 * so {@code kimi-coding} (path-gated on {@code /coding}) must sit before any
 * future plain-kimi/moonshot vendor.
 */
public final class RelayUsageRegistry {

    private static final Logger LOG = Logger.getInstance(RelayUsageRegistry.class);

    private static final List<RelayUsageVendor> VENDORS = List.of(
            new KimiCodingUsageVendor(),
            new MiniMaxUsageVendor(),
            new ZaiUsageVendor());

    private RelayUsageRegistry() {
    }

    /**
     * Resolve the capacity payload for the relay backend described by
     * {@code settings} (the Claude settings object; see
     * {@link CodemossSettingsService#readClaudeSettings()}). Null when no
     * vendor matches, the credential is missing, the probe yields no usable
     * data and no fresh/stale cache entry can be served — callers fall back to
     * the SDK rate_limit snapshot.
     */
    public static JsonObject resolve(JsonObject settings, long nowMs) {
        RelayUsageEnv env = RelayUsageEnv.from(settings);
        RelayUsageVendor vendor = match(env.baseUrl());
        if (vendor == null || env.token() == null) {
            return null;
        }
        // Keep credentials out of long-lived cache objects while retaining account isolation.
        String cacheKey = vendor.id() + '\n' + canonicalBaseUrl(env.baseUrl()) + '\n' + sha256(env.token());
        // MiniMax selects a model-specific quota before the payload reaches the cache.
        if ("minimax".equals(vendor.id())) {
            cacheKey += '\n' + (env.model() == null ? "" : env.model());
        }

        JsonObject fresh = RelayUsageCache.fresh(cacheKey, nowMs);
        if (fresh != null) {
            return fresh;
        }
        try {
            JsonObject payload = vendor.probe(env);
            if (payload != null) {
                RelayUsageCache.store(cacheKey, payload, nowMs);
                return payload.deepCopy();
            }
        } catch (Exception e) {
            LOG.warn("relay usage probe failed (" + vendor.id() + "): " + e.getMessage());
        }
        return RelayUsageCache.stale(cacheKey, nowMs);
    }

    /** Vendor owning {@code baseUrl}, or null when unassigned/malformed. */
    static RelayUsageVendor match(String baseUrl) {
        if (baseUrl == null) {
            return null;
        }
        String host;
        String path;
        try {
            URI u = URI.create(baseUrl);
            if (u.getHost() == null) {
                return null;
            }
            host = u.getHost().toLowerCase(Locale.ROOT);
            path = u.getPath() == null ? "" : u.getPath().toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return null;
        }
        for (RelayUsageVendor vendor : VENDORS) {
            if (vendor.matches(host, path)) {
                return vendor;
            }
        }
        return null;
    }

    private static String canonicalBaseUrl(String baseUrl) {
        try {
            URI u = URI.create(baseUrl.trim());
            String scheme = u.getScheme().toLowerCase(Locale.ROOT);
            String host = u.getHost();
            if (host == null) {
                return baseUrl.trim();
            }
            host = host.toLowerCase(Locale.ROOT);
            int port = u.getPort();
            boolean defaultPort = ("http".equals(scheme) && port == 80)
                    || ("https".equals(scheme) && port == 443);
            String authorityHost = host.contains(":") && !host.startsWith("[")
                    ? "[" + host + "]" : host;
            StringBuilder out = new StringBuilder(scheme).append("://").append(authorityHost);
            if (port != -1 && !defaultPort) {
                out.append(':').append(port);
            }
            return out.toString();
        } catch (RuntimeException ignored) {
            return baseUrl == null ? "" : baseUrl.trim();
        }
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    /** Registered vendors, in match order (tests). */
    static List<RelayUsageVendor> vendors() {
        return VENDORS;
    }
}
