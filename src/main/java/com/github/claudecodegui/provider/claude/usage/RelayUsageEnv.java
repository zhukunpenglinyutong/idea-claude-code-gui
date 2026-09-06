package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;

/**
 * Credentials and routing inputs a relay usage vendor needs, extracted from the
 * Claude {@code settings.json} env block once per resolve so every vendor sees a
 * consistent snapshot.
 *
 * <ul>
 *   <li>{@code baseUrl} — {@code ANTHROPIC_BASE_URL}, the anthropic-compat
 *       endpoint whose host identifies the vendor.</li>
 *   <li>{@code token} — {@code ANTHROPIC_AUTH_TOKEN}, falling back to
 *       {@code ANTHROPIC_API_KEY} (the same chain the SDK itself uses).</li>
 *   <li>{@code model} — the active model id (from {@code ANTHROPIC_MODEL} or the
 *       per-tier defaults), used by vendors whose quota is reported per model
 *       (MiniMax Coding Plan).</li>
 * </ul>
 */
public final class RelayUsageEnv {

    private static final RelayUsageEnv EMPTY = new RelayUsageEnv(null, null, null);

    private final String baseUrl;
    private final String token;
    private final String model;

    private RelayUsageEnv(String baseUrl, String token, String model) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.model = model;
    }

    /** Extract the env snapshot from a settings object; null-safe. */
    public static RelayUsageEnv from(JsonObject settings) {
        if (settings == null) {
            return EMPTY;
        }
        String base = envString(settings, "ANTHROPIC_BASE_URL");
        String token = envString(settings, "ANTHROPIC_AUTH_TOKEN");
        if (token == null) {
            token = envString(settings, "ANTHROPIC_API_KEY");
        }
        String model = null;
        for (String key : new String[]{
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL"}) {
            model = envString(settings, key);
            if (model != null) {
                break;
            }
        }
        return new RelayUsageEnv(base, token, model);
    }

    /** Anthropic-compat base URL; null when unset. */
    public String baseUrl() {
        return baseUrl;
    }

    /** Bearer token for the vendor API; null when unset. */
    public String token() {
        return token;
    }

    /** Active model id for per-model quota APIs; null when unset. */
    public String model() {
        return model;
    }

    private static String envString(JsonObject settings, String key) {
        JsonObject env = RelayUsageJson.asObject(settings, "env");
        if (env == null || !env.has(key) || env.get(key).isJsonNull()) {
            return null;
        }
        return env.get(key).getAsString();
    }
}
