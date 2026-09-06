package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

/**
 * Moonshot/Kimi prepaid balance via the api.moonshot.cn (国内) /
 * api.moonshot.ai (国际) anthropic-compat backends
 * ({@code api.moonshot.cn/anthropic}). api.kimi.com is deliberately NOT
 * matched: that host only serves the Coding Plan, which the
 * {@code kimi-coding} vendor owns.
 *
 * <p>Probes {@code {origin}/v1/users/me/balance}: {@code data.available_balance}
 * is the usable amount; {@code granted_balance} is gift credit the payload does
 * not carry. Field names have been observed in several shapes, so
 * {@code balance}/{@code total_balance} are accepted as fallbacks. Both sites
 * bill in CNY.
 */
public final class MoonshotUsageVendor extends BalanceUsageVendor {

    private static final String USAGE_PATH = "/v1/users/me/balance";

    @Override
    public String id() {
        return "moonshot";
    }

    @Override
    public boolean matches(String host, String path) {
        return hostMatches(host, "api.moonshot.cn", "api.moonshot.ai");
    }

    @Override
    protected String usagePath(String host) {
        return USAGE_PATH;
    }

    /** Parse the balance body, accepting the observed field-name variants. */
    @Override
    protected RelayUsageJson.Balance parseBalance(JsonObject body, String host) {
        if (body == null) {
            return null;
        }
        JsonObject data = RelayUsageJson.asObject(body, "data");
        if (data == null) {
            data = body;
        }
        Double remaining = RelayUsageJson.asDouble(data, "available_balance", "balance", "total_balance");
        if (remaining == null || !Double.isFinite(remaining)) {
            return null;
        }
        return new RelayUsageJson.Balance(remaining, null, null, "CNY");
    }
}
