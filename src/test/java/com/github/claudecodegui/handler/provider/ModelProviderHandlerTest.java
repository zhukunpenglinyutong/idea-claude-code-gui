package com.github.claudecodegui.handler.provider;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for Claude model resolution in {@link ModelProviderHandler}.
 */
public class ModelProviderHandlerTest {

    @Test
    public void shouldUseMainModelAsFallbackWhenFamilyMappingIsMissing() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL", "glm-4.7");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-opus-4-6", env);

        assertEquals("glm-4.7", resolved);
    }

    @Test
    public void shouldPreferFamilySpecificMappingOverMainModel() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL", "deepseek-v4-pro");
        env.addProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4-flash");

        String haiku = ModelProviderHandler.resolveConfiguredClaudeModel("claude-haiku-4-5", env);
        String sonnet = ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-4-6", env);

        assertEquals("deepseek-v4-flash", haiku);
        assertEquals("deepseek-v4-flash", sonnet);
    }

    @Test
    public void shouldUseFamilySpecificMappingForSelectedClaudeModel() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL", "haiku-proxy");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-haiku-4-5", env);

        assertEquals("haiku-proxy", resolved);
    }

    @Test
    public void shouldIgnoreSmallFastModelForHaikuResolution() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_SMALL_FAST_MODEL", "legacy-haiku-proxy");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-haiku-4-5", env);

        assertEquals("claude-haiku-4-5", resolved);
    }

    @Test
    public void shouldNotApplySonnetMappingToAlreadyCustomModelIds() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-4.7");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("deepseek-v3", env);

        assertEquals("deepseek-v3", resolved);
    }

    @Test
    public void shouldUseResolvedModelForContextLimitWhenCapacitySuffixExists() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-4.7[1M]");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-4-6", env);

        assertEquals("glm-4.7[1M]", resolved);
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit(resolved));
    }

    @Test
    public void shouldKeepExpectedContextLimitsForVisibleCodexModels() {
        assertEquals(258_000, ModelProviderHandler.getModelContextLimit("gpt-5.3-codex"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gpt-5.4"));
        assertEquals(258_000, ModelProviderHandler.getModelContextLimit("gpt-5.2-codex"));
    }

    @Test
    public void shouldReturnCorrectContextLimitsForClaudeModels() {
        // Base IDs without [1m] suffix - 200k context by default
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5[1m]"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-6"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-8"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-6"));
        // IDs with [1m] suffix - 1M context
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-5[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-6[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-8[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-6[1m]"));
        // Haiku - no 1M context available
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-haiku-4-5"));
    }

    @Test
    public void shouldParseCapacitySuffixForCustomContextLimits() {
        assertEquals(500_000, ModelProviderHandler.getModelContextLimit("custom-model[500k]"));
        assertEquals(2_000_000, ModelProviderHandler.getModelContextLimit("custom-model[2m]"));
        assertEquals(100_000, ModelProviderHandler.getModelContextLimit("custom-model[100K]"));
    }

    // ============================================================================
    // Provider transition matrix — see L2 in NODE_PROCESS_LEAK_FIX_TASKS.md.
    // The Claude daemon must be torn down when (and ONLY when) the tab leaves
    // the Claude family. These tests pin the full matrix.
    // ============================================================================

    @Test
    public void shouldShutdownDaemonWhenSwitchingFromClaudeToCodex() {
        // The bug: switching to Codex previously left the Claude daemon alive,
        // causing it to accumulate as a phantom process across the tab lifetime.
        assertTrue(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "codex"));
    }

    @Test
    public void shouldNotShutdownDaemonWhenSwitchingFromCodexToClaude() {
        // Returning to Claude must NOT shut down the daemon — the next message
        // will lazily start a fresh one if needed.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("codex", "claude"));
    }

    @Test
    public void shouldNotShutdownDaemonOnClaudeToClaudeReaffirmation() {
        // useMessageSender re-fires set_provider("claude") on every message send.
        // We must never tear down the warm daemon on these no-op transitions.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "claude"));
    }

    @Test
    public void shouldNotShutdownDaemonOnCodexToCodexReaffirmation() {
        // Same protection on the Codex side — there's no Claude daemon to kill
        // here, but the predicate must still return false so we don't log noise.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("codex", "codex"));
    }

    @Test
    public void shouldNotShutdownDaemonOnNullPreviousProvider() {
        // Initial startup may surface a null previous provider; nothing to clean up yet.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch(null, "codex"));
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch(null, "claude"));
    }

    @Test
    public void shouldNotShutdownDaemonOnNullNewProvider() {
        // Defensive: a null new provider should not be treated as a leave-claude transition.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", null));
    }

    @Test
    public void shouldShutdownDaemonWhenSwitchingFromClaudeToUnknownProvider() {
        // Future-proof: any non-claude target after Claude qualifies as leave-claude.
        assertTrue(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "gemini"));
    }

    @Test
    public void shouldNotShutdownDaemonOnEmptyNewProvider() {
        // Empty string is not a valid "leave claude" transition — it usually
        // signals an init race. The predicate must treat it the same as null
        // to avoid spurious 5–10s daemon restarts.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", ""));
    }
}
