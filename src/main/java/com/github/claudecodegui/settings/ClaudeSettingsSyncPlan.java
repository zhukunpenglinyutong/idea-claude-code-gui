package com.github.claudecodegui.settings;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Set;

/**
 * Plan whether / how to mutate {@code ~/.claude/settings.json} when applying a Claude provider.
 * <p>
 * Mirrors vscode-cc-gui {@code planClaudeSettingsSync}:
 * <ul>
 *   <li>Skip local / disabled / null providers (would wipe user or cc-switch credentials)</li>
 *   <li>Skip managed providers with an empty {@code settingsConfig.env} payload</li>
 *   <li>On write: only clear plugin-managed env keys, then merge the payload — preserve
 *       unrelated user env keys (e.g. proxy / custom vars)</li>
 * </ul>
 */
public final class ClaudeSettingsSyncPlan {

    public static final String LOCAL_SETTINGS_PROVIDER_ID = ProviderManager.LOCAL_SETTINGS_PROVIDER_ID;
    public static final String CLI_LOGIN_PROVIDER_ID = ProviderManager.CLI_LOGIN_PROVIDER_ID;
    public static final String DISABLED_PROVIDER_ID = ProviderManager.DISABLED_PROVIDER_ID;

    /**
     * Env keys the plugin owns when syncing a managed provider.
     * Aligned with vscode-cc-gui {@code CLAUDE_MANAGED_ENV_KEYS}.
     *
     * <p>Deliberately excludes {@code API_TIMEOUT_MS}: it is a user-tunable
     * performance knob, not a plugin-managed credential. Removing it from the
     * managed set lets users extend the timeout for slow local-model backends
     * (e.g. Ollama with 80k+ token contexts) that exceed the CLI default
     * (#1307). When unset, the Claude CLI keeps its own default.
     */
    public static final Set<String> CLAUDE_MANAGED_ENV_KEYS = Set.of(
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL", "ANTHROPIC_API_URL",
            "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
            "CCGUI_CLI_LOGIN_AUTHORIZED"
    );

    public enum Action {
        SKIP,
        WRITE
    }

    public static final class Decision {
        public final Action action;
        public final String reason;
        public final JsonObject nextSettings;

        private Decision(Action action, String reason, JsonObject nextSettings) {
            this.action = action;
            this.reason = reason;
            this.nextSettings = nextSettings;
        }

        public static Decision skip(String reason) {
            return new Decision(Action.SKIP, reason, null);
        }

        public static Decision write(JsonObject nextSettings) {
            return new Decision(Action.WRITE, null, nextSettings);
        }
    }

    private ClaudeSettingsSyncPlan() {
    }

    /**
     * @param currentSettings existing ~/.claude/settings.json (may be empty object)
     * @param activeProvider  active Claude provider from codemoss config (may be null)
     */
    public static Decision plan(JsonObject currentSettings, JsonObject activeProvider) {
        if (activeProvider == null || !activeProvider.has("id") || activeProvider.get("id").isJsonNull()) {
            return Decision.skip("no-managed-provider");
        }
        String id = activeProvider.get("id").getAsString();
        if (LOCAL_SETTINGS_PROVIDER_ID.equals(id)
                || DISABLED_PROVIDER_ID.equals(id)
                || id == null
                || id.isBlank()) {
            return Decision.skip("no-managed-provider");
        }

        // Idea tracks CLI login only in codemoss config and does not mutate settings.json
        // for that mode (see ClaudeSettingsManager.applyCliLoginToClaudeSettings).
        if (CLI_LOGIN_PROVIDER_ID.equals(id)) {
            return Decision.skip("cli-login-no-settings-write");
        }

        JsonObject settingsConfig = null;
        if (activeProvider.has("settingsConfig") && activeProvider.get("settingsConfig").isJsonObject()) {
            settingsConfig = activeProvider.getAsJsonObject("settingsConfig");
        }
        JsonObject envPayload = null;
        if (settingsConfig != null
                && settingsConfig.has("env")
                && settingsConfig.get("env").isJsonObject()) {
            envPayload = settingsConfig.getAsJsonObject("env");
        }
        boolean hasEnvPayload = envPayload != null && envPayload.size() > 0;
        if (!hasEnvPayload) {
            return Decision.skip("empty-env-payload");
        }

        JsonObject next = currentSettings != null && !currentSettings.isJsonNull()
                ? currentSettings.deepCopy()
                : new JsonObject();

        JsonObject nextEnv = new JsonObject();
        if (next.has("env") && next.get("env").isJsonObject()) {
            for (String key : next.getAsJsonObject("env").keySet()) {
                nextEnv.add(key, next.getAsJsonObject("env").get(key));
            }
        }

        for (String key : CLAUDE_MANAGED_ENV_KEYS) {
            nextEnv.remove(key);
        }
        for (String key : envPayload.keySet()) {
            JsonElement value = envPayload.get(key);
            if (value == null || value.isJsonNull()) {
                continue;
            }
            nextEnv.add(key, value);
        }
        next.add("env", nextEnv);

        // Non-env provider fields (model, alwaysThinkingEnabled, …) — full replace when present
        for (String key : settingsConfig.keySet()) {
            if ("env".equals(key)) {
                continue;
            }
            if (ClaudeSettingsManager.PROTECTED_SYSTEM_FIELDS.contains(key)) {
                continue;
            }
            if (!ClaudeSettingsManager.PROVIDER_MANAGED_FIELDS.contains(key)) {
                continue;
            }
            JsonElement value = settingsConfig.get(key);
            if (value == null || value.isJsonNull()) {
                continue;
            }
            next.add(key, value);
        }

        if (activeProvider.has("id") && !activeProvider.get("id").isJsonNull()) {
            next.addProperty("codemossProviderId", activeProvider.get("id").getAsString());
        }

        return Decision.write(next);
    }
}
