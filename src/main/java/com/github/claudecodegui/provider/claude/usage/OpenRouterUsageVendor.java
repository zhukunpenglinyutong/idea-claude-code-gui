package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

/**
 * OpenRouter prepaid credits via the openrouter.ai anthropic-compat backend.
 *
 * <p>Probes {@code {origin}/api/v1/credits}: the only balance vendor that
 * reports a denominator — remaining is derived as
 * {@code total_credits − total_usage} so the payload also carries
 * {@code total}/{@code used} for the tooltip. Amounts are USD.
 */
public final class OpenRouterUsageVendor extends BalanceUsageVendor {

    private static final String USAGE_PATH = "/api/v1/credits";

    @Override
    public String id() {
        return "openrouter";
    }

    @Override
    public boolean matches(String host, String path) {
        return hostMatches(host, "openrouter.ai");
    }

    @Override
    protected String usagePath(String host) {
        return USAGE_PATH;
    }

    /** Parse the credits body into remaining/total/used (USD). */
    @Override
    protected RelayUsageJson.Balance parseBalance(JsonObject body, String host) {
        if (body == null) {
            return null;
        }
        JsonObject data = RelayUsageJson.asObject(body, "data");
        if (data == null) {
            data = body;
        }
        Double total = RelayUsageJson.asDouble(data, "total_credits");
        Double used = RelayUsageJson.asDouble(data, "total_usage");
        if (total == null && used == null) {
            return null;
        }
        // Missing fields stay null in the payload; the arithmetic treats them as 0.
        double t = total != null && Double.isFinite(total) ? total : 0.0;
        double u = used != null && Double.isFinite(used) ? used : 0.0;
        return new RelayUsageJson.Balance(t - u, total, used, "USD");
    }
}
