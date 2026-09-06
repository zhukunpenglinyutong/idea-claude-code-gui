package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * DeepSeek prepaid balance via the api.deepseek.com anthropic-compat backend.
 *
 * <p>Probes {@code {origin}/user/balance}: {@code balance_infos[]} entries
 * carry {@code total_balance} (string amount) plus the ISO-4217
 * {@code currency} ("CNY"); the first entry is the account's own currency.
 */
public final class DeepSeekUsageVendor extends BalanceUsageVendor {

    private static final String USAGE_PATH = "/user/balance";

    @Override
    public String id() {
        return "deepseek";
    }

    @Override
    public boolean matches(String host, String path) {
        // Only the official API host; the bare registrable domain could serve
        // unrelated pages (docs, console) that must not trigger a probe.
        return hostMatches(host, "api.deepseek.com");
    }

    @Override
    protected String usagePath(String host) {
        return USAGE_PATH;
    }

    /** Parse the balance body; the currency comes from the response itself. */
    @Override
    protected RelayUsageJson.Balance parseBalance(JsonObject body, String host) {
        if (body == null) {
            return null;
        }
        JsonArray infos = RelayUsageJson.asArray(body, "balance_infos");
        if (infos == null || infos.isEmpty()) {
            return null;
        }
        for (JsonElement el : infos) {
            if (!RelayUsageJson.isObject(el)) {
                continue;
            }
            JsonObject info = el.getAsJsonObject();
            Double remaining = RelayUsageJson.asDouble(info, "total_balance");
            if (remaining == null || !Double.isFinite(remaining)) {
                continue;
            }
            return new RelayUsageJson.Balance(
                    remaining, null, null,
                    RelayUsageJson.Balance.unitOrCny(RelayUsageJson.asString(info, "currency")));
        }
        return null;
    }
}
