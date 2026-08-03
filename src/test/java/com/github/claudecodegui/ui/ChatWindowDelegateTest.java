package com.github.claudecodegui.ui;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Assert;
import org.junit.Test;

/**
 * Unit tests for serializing the authoritative Java tab state restored after WebView reload.
 */
public class ChatWindowDelegateTest {

    /**
     * Verifies that a Claude recovery snapshot preserves its provider, model, and mode fields.
     */
    @Test
    public void backendTabStatePreservesCurrentClaudeSessionConfiguration() {
        String payload = ChatWindowDelegate.buildBackendTabStateJson(
                "claude",
                "claude-opus-4-8[1m]",
                "default",
                null,
                null
        );

        JsonObject state = JsonParser.parseString(payload).getAsJsonObject();
        Assert.assertEquals("claude", state.get("provider").getAsString());
        Assert.assertEquals("claude-opus-4-8[1m]", state.get("model").getAsString());
        Assert.assertEquals("default", state.get("permissionMode").getAsString());
        Assert.assertTrue(state.get("reasoningEffort").isJsonNull());
        Assert.assertEquals("normal", state.get("codexFastMode").getAsString());
    }

    /**
     * Verifies that the Codex fast service tier is represented by the frontend fast-mode value.
     */
    @Test
    public void backendTabStateMapsCodexFastServiceTier() {
        String payload = ChatWindowDelegate.buildBackendTabStateJson(
                "codex",
                "gpt-5.6-sol",
                "default",
                "high",
                "fast"
        );

        JsonObject state = JsonParser.parseString(payload).getAsJsonObject();
        Assert.assertEquals("codex", state.get("provider").getAsString());
        Assert.assertEquals("gpt-5.6-sol", state.get("model").getAsString());
        Assert.assertEquals("high", state.get("reasoningEffort").getAsString());
        Assert.assertEquals("fast", state.get("codexFastMode").getAsString());
    }

    /**
     * Verifies that recovery resolves a Claude family alias through provider settings
     * before calculating the context limit shown by the frontend.
     */
    @Test
    public void recoveryContextLimitUsesConfiguredClaudeModelMapping() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-4.7[1M]");
        JsonObject settings = new JsonObject();
        settings.add("env", env);
        CodemossSettingsService settingsService = new CodemossSettingsService() {
            @Override
            public JsonObject readClaudeSettings() {
                return settings;
            }
        };

        int limit = ChatWindowDelegate.resolveModelContextLimitForRecovery(
                "claude-sonnet-4-7",
                settingsService
        );

        Assert.assertEquals(1_000_000, limit);
    }
}
