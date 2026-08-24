package com.github.claudecodegui.util;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for provider-aware token extraction and context-snapshot lifecycle.
 */
public class TokenUsageUtilsTest {

    /**
     * Verifies Claude context usage includes all input-side cache categories but excludes output.
     */
    @Test
    public void contextTokensExcludeOutputTokens() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("cache_creation_input_tokens", 12000);
        usage.addProperty("cache_read_input_tokens", 160000);
        usage.addProperty("output_tokens", 2400);

        assertEquals(352000, TokenUsageUtils.extractContextTokens(usage, "claude"));
    }

    /**
     * Verifies Codex context usage uses the provider's cache-inclusive input count only.
     */
    @Test
    public void geminiContextTokensPreferInputAndAgyCacheFieldsNotTotal() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 27793);
        usage.addProperty("output_tokens", 18);
        usage.addProperty("thinking_tokens", 0);
        usage.addProperty("cache_read_tokens", 100);
        usage.addProperty("total_tokens", 27911);

        // Must NOT use total_tokens; must NOT sum input+cache (double-count)
        assertEquals(27793, TokenUsageUtils.extractContextTokens(usage, "gemini"));
    }

    @Test
    public void geminiDoesNotInflateWhenCacheEqualsInput() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 900000);
        usage.addProperty("cache_read_tokens", 900000);
        usage.addProperty("cache_creation_input_tokens", 150000);
        usage.addProperty("output_tokens", 10);
        usage.addProperty("total_tokens", 1950010);

        // Would be ~1.95M if we summed input+cache+creation; occupancy is input.
        assertEquals(900000, TokenUsageUtils.extractContextTokens(usage, "gemini"));
    }

    @Test
    public void codexContextTokensUseInputOnly() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 180000);
        usage.addProperty("output_tokens", 2400);
        usage.addProperty("cached_input_tokens", 160000);

        assertEquals(180000, TokenUsageUtils.extractContextTokens(usage, "codex"));
    }

    /**
     * Verifies Codex lookup prefers the root current-context snapshot over nested historical usage.
     */
    @Test
    public void codexPrefersTopLevelContextUsageOverNestedHistoricalUsage() {
        JsonObject nestedUsage = new JsonObject();
        nestedUsage.addProperty("input_tokens", 22496533);
        JsonObject message = new JsonObject();
        message.add("usage", nestedUsage);

        JsonObject currentUsage = new JsonObject();
        currentUsage.addProperty("input_tokens", 127886);
        JsonObject raw = new JsonObject();
        raw.add("message", message);
        raw.add("usage", currentUsage);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT,
                "",
                raw
        );

        assertEquals(
                127886,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant), "codex")
                        .get("input_tokens").getAsInt()
        );
        assertEquals(
                22496533,
                TokenUsageUtils.findLastUsageFromSessionMessages(List.of(assistant))
                        .get("input_tokens").getAsInt()
        );
    }

    /**
     * Verifies a provider-reported context window overrides static configuration while malformed
     * or missing metadata retains the supplied fallback.
     */
    @Test
    public void extractMaxTokensPrefersTrustedProviderWindow() {
        JsonObject usage = new JsonObject();
        usage.addProperty("model_context_window", 258400);

        assertEquals(258400, TokenUsageUtils.extractMaxTokens(usage, 1_050_000));
        usage.addProperty("model_context_window", -1);
        assertEquals(1_050_000, TokenUsageUtils.extractMaxTokens(usage, 1_050_000));
        assertEquals(0, TokenUsageUtils.extractMaxTokens(null, -1));
    }

    /**
     * Verifies selection changes remove both supported context usage locations without
     * deleting historical per-turn usage or cost metadata.
     */
    @Test
    public void clearContextUsagePreservesTurnAccounting() {
        JsonObject raw = new JsonObject();
        raw.add("usage", usage(12000));
        raw.add("turnUsage", usage(345));
        raw.addProperty("turnCostUsd", 0.42);
        JsonObject nestedMessage = new JsonObject();
        nestedMessage.add("usage", usage(9000));
        raw.add("message", nestedMessage);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "answer", raw);

        TokenUsageUtils.clearContextUsageFromSessionMessages(List.of(assistant));

        assertFalse(raw.has("usage"));
        assertFalse(nestedMessage.has("usage"));
        assertTrue(raw.has("turnUsage"));
        assertTrue(raw.has("turnCostUsd"));
    }

    private static JsonObject usage(int inputTokens) {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", inputTokens);
        return usage;
    }
}
