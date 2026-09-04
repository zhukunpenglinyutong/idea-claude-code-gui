package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Mirrors vscode-cc-gui claudeSettingsSync.test.mts.
 */
public class ClaudeSettingsSyncPlanTest {

    @Test
    public void skipsLocalSettingsMode() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "keep-me");
        current.add("env", env);

        JsonObject active = new JsonObject();
        active.addProperty("id", ProviderManager.LOCAL_SETTINGS_PROVIDER_ID);
        active.addProperty("isActive", true);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertEquals("no-managed-provider", d.reason);
    }

    @Test
    public void skipsWhenNoProviderActive() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "keep-me");
        env.addProperty("ANTHROPIC_BASE_URL", "https://example.test");
        current.add("env", env);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, null);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertEquals("no-managed-provider", d.reason);
    }

    @Test
    public void skipsManagedProviderWithEmptyEnvPayload() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "keep-me");
        current.add("env", env);
        current.addProperty("model", "claude-opus-4-8");

        JsonObject active = new JsonObject();
        active.addProperty("id", "proxy-a");
        active.addProperty("isActive", true);
        JsonObject settingsConfig = new JsonObject();
        settingsConfig.addProperty("model", "claude-opus-4-8");
        // no env
        active.add("settingsConfig", settingsConfig);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertEquals("empty-env-payload", d.reason);
    }

    @Test
    public void writesEnvWhilePreservingCustomKeys() {
        JsonObject current = new JsonObject();
        current.addProperty("model", "claude-opus-4-8");
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "old");
        env.addProperty("ANTHROPIC_BASE_URL", "https://old.test");
        env.addProperty("CUSTOM_KEEP", "1");
        current.add("env", env);

        JsonObject active = new JsonObject();
        active.addProperty("id", "proxy-b");
        active.addProperty("isActive", true);
        JsonObject settingsConfig = new JsonObject();
        JsonObject newEnv = new JsonObject();
        newEnv.addProperty("ANTHROPIC_AUTH_TOKEN", "new");
        newEnv.addProperty("ANTHROPIC_BASE_URL", "https://new.test");
        settingsConfig.add("env", newEnv);
        active.add("settingsConfig", settingsConfig);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.WRITE, d.action);
        assertNotNull(d.nextSettings);
        JsonObject outEnv = d.nextSettings.getAsJsonObject("env");
        assertEquals("new", outEnv.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://new.test", outEnv.get("ANTHROPIC_BASE_URL").getAsString());
        assertEquals("1", outEnv.get("CUSTOM_KEEP").getAsString());
        assertEquals("claude-opus-4-8", d.nextSettings.get("model").getAsString());
        assertEquals("proxy-b", d.nextSettings.get("codemossProviderId").getAsString());
    }

    @Test
    public void skipsCliLoginSettingsWrite() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "old");
        current.add("env", env);

        JsonObject active = new JsonObject();
        active.addProperty("id", ProviderManager.CLI_LOGIN_PROVIDER_ID);
        active.addProperty("isActive", true);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertTrue(d.reason.contains("cli-login"));
        assertNull(d.nextSettings);
    }

    /**
     * Regression for #1307: API_TIMEOUT_MS is a user-tunable performance knob,
     * not a plugin-managed credential. It must survive provider sync so users
     * can extend the timeout for slow local backends (e.g. Ollama with 80k+
     * token contexts that exceed the CLI's built-in default).
     */
    @Test
    public void preservesUserConfiguredApiTimeoutMs() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "old");
        env.addProperty("ANTHROPIC_BASE_URL", "http://localhost:11434");
        // User explicitly raised the timeout for a slow local Ollama backend.
        env.addProperty("API_TIMEOUT_MS", "900000");
        current.add("env", env);

        JsonObject active = new JsonObject();
        active.addProperty("id", "proxy-ollama");
        active.addProperty("isActive", true);
        JsonObject settingsConfig = new JsonObject();
        JsonObject newEnv = new JsonObject();
        newEnv.addProperty("ANTHROPIC_AUTH_TOKEN", "new");
        newEnv.addProperty("ANTHROPIC_BASE_URL", "http://localhost:11434");
        settingsConfig.add("env", newEnv);
        active.add("settingsConfig", settingsConfig);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.WRITE, d.action);
        assertNotNull(d.nextSettings);
        JsonObject outEnv = d.nextSettings.getAsJsonObject("env");
        // Managed credentials are replaced by the provider payload...
        assertEquals("new", outEnv.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        // ...but the user's API_TIMEOUT_MS is NOT stripped (#1307).
        assertTrue("API_TIMEOUT_MS must survive provider sync",
                outEnv.has("API_TIMEOUT_MS"));
        assertEquals("900000", outEnv.get("API_TIMEOUT_MS").getAsString());
    }
}
