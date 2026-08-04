package com.github.claudecodegui.util;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for provider-aware usage extraction and context-snapshot lifecycle.
 */
public class TokenUsageUtilsTest {

    /**
     * Verifies that provider switching removes both supported context usage
     * locations without deleting historical per-turn usage or cost metadata.
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
                ClaudeSession.Message.Type.ASSISTANT,
                "answer",
                raw
        );

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
