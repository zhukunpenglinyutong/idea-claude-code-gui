package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class UsageCostCalculatorTest {

    @Test
    public void calculatesClaudeTurnCostWithCacheBreakdown() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 1200);
        usage.addProperty("cache_creation_input_tokens", 4096);
        usage.addProperty("cache_read_input_tokens", 363100);
        usage.addProperty("output_tokens", 4560);

        double cost = UsageCostCalculator.calculateTurnCostUsd("claude", usage, "claude-sonnet-4-6");

        assertEquals(0.19629, cost, 0.000001);
    }

    @Test
    public void calculatesCodexTurnCostFromNormalizedTurnUsage() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 690);
        usage.addProperty("cache_creation_input_tokens", 0);
        usage.addProperty("cache_read_input_tokens", 36310);
        usage.addProperty("output_tokens", 353);

        double cost = UsageCostCalculator.calculateTurnCostUsd("codex", usage, "gpt-5.1");

        assertEquals(0.00893125, cost, 0.0000001);
    }

    @Test
    public void acceptsCodexCachedInputTokenAliasForTurnCost() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 690);
        usage.addProperty("cached_input_tokens", 36310);
        usage.addProperty("output_tokens", 353);

        double cost = UsageCostCalculator.calculateTurnCostUsd("codex", usage, "gpt-5.1");

        assertEquals(0.00893125, cost, 0.0000001);
    }

    @Test
    public void returnsNullWhenNoBuiltInOrCustomPriceMatches() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 1200);
        usage.addProperty("output_tokens", 456);

        assertNull(UsageCostCalculator.calculateTurnCostUsd("claude", usage, "custom-claude-without-pricing"));
        assertNull(UsageCostCalculator.calculateTurnCostUsd("codex", usage, "custom-codex-without-pricing"));
        assertNull(UsageCostCalculator.calculateTurnCostUsd("codex", usage, null));
    }
}
