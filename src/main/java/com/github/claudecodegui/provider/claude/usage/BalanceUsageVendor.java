package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

import java.net.URI;
import java.util.Locale;

/**
 * Template for prepaid-balance vendors: unlike the quota vendors there is no
 * percentage denominator — the API reports a money amount, so the payload is
 * the {@code balance{remaining, total?, used?, unit}} form built by
 * {@link RelayUsageJson#balancePayload(String, RelayUsageJson.Balance)}.
 *
 * <p>The shared {@link #probe} derives the API origin from the anthropic base
 * URL (same host, TLS-only rule as every vendor), issues one Bearer GET and
 * leaves host matching and body parsing to the subclass. Vendors whose
 * credential is not the Bearer token implement {@link RelayUsageVendor}
 * directly instead.
 */
public abstract class BalanceUsageVendor implements RelayUsageVendor {

    @Override
    public final JsonObject probe(RelayUsageEnv env) throws Exception {
        String origin = RelayUsageHttp.secureOrigin(env.baseUrl());
        if (origin == null) {
            return null;
        }
        String host = hostOf(env.baseUrl());
        JsonObject body = RelayUsageHttp.getJson(origin + usagePath(host), env.token());
        return RelayUsageJson.balancePayload(id(), parseBalance(body, host));
    }

    /** Absolute path of the balance API on the anthropic base URL origin. */
    protected abstract String usagePath(String host);

    /** Translate the vendor balance body; null when it carries no usable data. */
    protected abstract RelayUsageJson.Balance parseBalance(JsonObject body, String host);

    /**
     * {@code true} when {@code host} equals one of {@code domains} or is a
     * subdomain of one — the suffix must land on a dot boundary so look-alike
     * hosts ("notdeepseek.com") never match.
     */
    protected static boolean hostMatches(String host, String... domains) {
        if (host == null) {
            return false;
        }
        String h = host.toLowerCase(Locale.ROOT);
        for (String domain : domains) {
            String d = domain.toLowerCase(Locale.ROOT);
            if (h.equals(d) || h.endsWith("." + d)) {
                return true;
            }
        }
        return false;
    }

    private static String hostOf(String baseUrl) {
        try {
            URI u = URI.create(baseUrl);
            return u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
        } catch (RuntimeException e) {
            return "";
        }
    }
}
