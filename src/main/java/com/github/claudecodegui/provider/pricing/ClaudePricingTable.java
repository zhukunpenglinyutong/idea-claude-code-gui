package com.github.claudecodegui.provider.pricing;

import com.github.claudecodegui.provider.CustomPricingProvider;

import java.util.List;
import java.util.Map;

/**
 * Single source of truth for Claude built-in pricing, model normalization, and
 * user-configured pricing resolution. Both {@code ClaudeUsageAggregator} (Usage
 * Statistics) and {@code UsageCostCalculator} (per-turn footer) resolve pricing
 * through here so the two can never disagree.
 */
public final class ClaudePricingTable {

    public static final String DEFAULT_MODEL = "claude-sonnet-4-6";

    private static final ClaudePricing DEFAULT_PRICING = new ClaudePricing(3.0, 15.0, 3.75, 0.30);
    private static final ClaudePricing TIERED_SONNET_PRICING = new ClaudePricing(3.0, 15.0, 3.75, 0.30, 6.0, 22.5, 7.5, 0.60);
    private static final ClaudePricing LEGACY_OPUS_PRICING = new ClaudePricing(15.0, 75.0, 18.75, 1.50);
    private static final ClaudePricing OPUS_4_5_PRICING = new ClaudePricing(5.0, 25.0, 6.25, 0.50);
    private static final ClaudePricing FABLE_5_PRICING = new ClaudePricing(10.0, 50.0, 12.5, 1.0);
    private static final ClaudePricing HAIKU_4_5_PRICING = new ClaudePricing(1.0, 5.0, 1.25, 0.10);

    private static final Map<String, ClaudePricing> MODEL_PRICING = Map.ofEntries(
            Map.entry("claude-opus-4", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-1", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-20250514", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-5", OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-6", OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-7", OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-8", OPUS_4_5_PRICING),
            Map.entry("claude-fable-5", FABLE_5_PRICING),
            Map.entry("claude-sonnet-4", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-20250514", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-5", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-6", DEFAULT_PRICING),
            Map.entry("claude-sonnet-5", DEFAULT_PRICING),
            Map.entry("claude-haiku-4", HAIKU_4_5_PRICING),
            Map.entry("claude-haiku-4-5", HAIKU_4_5_PRICING)
    );
    private static final List<String> MODEL_PREFIXES = List.of(
            "claude-fable-5",
            "claude-opus-4-20250514",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-opus-4-5",
            "claude-opus-4-1",
            "claude-opus-4",
            "claude-sonnet-4-20250514",
            "claude-sonnet-5",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-sonnet-4",
            "claude-haiku-4-5",
            "claude-haiku-4"
    );

    private ClaudePricingTable() {
    }

    /**
     * Built-in or user-configured pricing for {@code model}, or {@code null} when the model
     * matches neither. Callers that must always show a number use {@link #resolveOrDefault}.
     */
    public static ClaudePricing resolve(String model) {
        ClaudePricing builtin = builtinFor(model);
        ClaudePricing custom = customFor(model, builtin);
        return custom != null ? custom : builtin;
    }

    /** Like {@link #resolve} but falls back to the default model's pricing when nothing matches. */
    public static ClaudePricing resolveOrDefault(String model) {
        ClaudePricing pricing = resolve(model);
        return pricing != null ? pricing : DEFAULT_PRICING;
    }

    private static ClaudePricing builtinFor(String model) {
        String normalized = normalize(model);
        return normalized == null ? null : MODEL_PRICING.get(normalized);
    }

    /**
     * User-configured pricing, or {@code null} if none. Unspecified dimensions fall back to the
     * overridden model's OWN built-in rate when it is a known model, otherwise 0 — never the
     * generic default model's rate, which would turn a partial custom price into an over-estimate.
     */
    private static ClaudePricing customFor(String model, ClaudePricing builtin) {
        if (model == null || model.isBlank()) {
            return null;
        }
        return CustomPricingProvider.getInstance().getPricing("claude", model)
                .map(p -> new ClaudePricing(
                        p.inputCostPer1M() != null ? p.inputCostPer1M() : (builtin != null ? builtin.inputCostPer1M() : 0.0),
                        p.outputCostPer1M() != null ? p.outputCostPer1M() : (builtin != null ? builtin.outputCostPer1M() : 0.0),
                        p.cacheWriteCostPer1M() != null ? p.cacheWriteCostPer1M() : (builtin != null ? builtin.cacheWriteCostPer1M() : 0.0),
                        p.cacheReadCostPer1M() != null ? p.cacheReadCostPer1M() : (builtin != null ? builtin.cacheReadCostPer1M() : 0.0),
                        null, null, null, null))
                .orElse(null);
    }

    private static String normalize(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }

        String normalized = model.toLowerCase();
        int claudeIndex = normalized.indexOf("claude-");
        if (claudeIndex >= 0) {
            normalized = normalized.substring(claudeIndex);
        }

        final String candidate = normalized;
        return MODEL_PREFIXES.stream()
                .filter(candidate::startsWith)
                .findFirst()
                .orElse(candidate);
    }
}
