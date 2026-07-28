package com.github.claudecodegui.provider.pricing;

import com.github.claudecodegui.provider.CustomPricingProvider;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Single source of truth for Codex built-in pricing, model normalization (snapshot suffix,
 * aliases, prefixes), and user-configured pricing resolution. Both {@code CodexUsageAggregator}
 * (Usage Statistics) and {@code UsageCostCalculator} (per-turn footer) resolve pricing through
 * here so the two can never disagree.
 */
public final class CodexPricingTable {

    public static final String DEFAULT_MODEL = "gpt-5.1";

    private static final Pattern SNAPSHOT_SUFFIX = Pattern.compile("-\\d{4}-\\d{2}-\\d{2}$");

    private static final CodexPricing DEFAULT_PRICING = new CodexPricing(1.25, 10.0, 0.125);
    private static final Map<String, CodexPricing> MODEL_PRICING = Map.ofEntries(
            Map.entry("gpt-5", DEFAULT_PRICING),
            Map.entry("gpt-5.1", DEFAULT_PRICING),
            Map.entry("gpt-5-codex", DEFAULT_PRICING),
            Map.entry("gpt-5.1-codex", DEFAULT_PRICING),
            Map.entry("gpt-5.2-codex", new CodexPricing(1.75, 14.0, 0.175)),
            Map.entry("gpt-5.4", new CodexPricing(2.5, 15.0, 0.25)),
            Map.entry("gpt-5.4-mini", new CodexPricing(0.75, 4.5, 0.075)),
            Map.entry("gpt-5.6-sol", new CodexPricing(5.0, 30.0, 0.5)),
            Map.entry("gpt-5.6-terra", new CodexPricing(2.5, 15.0, 0.25)),
            Map.entry("gpt-5.6-luna", new CodexPricing(1.0, 6.0, 0.1))
    );
    private static final Map<String, String> MODEL_ALIASES = Map.of(
            "gpt-5-codex", "gpt-5",
            "gpt-5.3-codex", "gpt-5.2-codex",
            "gpt-5.6", "gpt-5.6-sol"
    );
    private static final List<String> MODEL_PREFIXES = List.of(
            "gpt-5.6-terra",
            "gpt-5.6-sol",
            "gpt-5.6-luna",
            "gpt-5.6",
            "gpt-5.4-mini",
            "gpt-5.4",
            "gpt-5.3-codex",
            "gpt-5.2-codex",
            "gpt-5.1-codex",
            "gpt-5-codex",
            "gpt-5.1",
            "gpt-5"
    );

    private CodexPricingTable() {
    }

    /**
     * Built-in or user-configured pricing for {@code model}, or {@code null} when the model
     * matches neither. Callers that must always show a number use {@link #resolveOrDefault}.
     */
    public static CodexPricing resolve(String model) {
        CodexPricing builtin = builtinFor(model);
        CodexPricing custom = customFor(model, builtin);
        return custom != null ? custom : builtin;
    }

    /** Like {@link #resolve} but falls back to the default model's pricing when nothing matches. */
    public static CodexPricing resolveOrDefault(String model) {
        CodexPricing pricing = resolve(model);
        return pricing != null ? pricing : DEFAULT_PRICING;
    }

    private static CodexPricing builtinFor(String model) {
        String normalized = normalize(model);
        return normalized == null ? null : MODEL_PRICING.get(normalized);
    }

    /**
     * User-configured pricing, or {@code null} if none. Unspecified dimensions fall back to the
     * overridden model's OWN built-in rate when it is a known model, otherwise 0.
     */
    private static CodexPricing customFor(String model, CodexPricing builtin) {
        if (model == null || model.isBlank()) {
            return null;
        }
        return CustomPricingProvider.getInstance().getPricing("codex", model)
                .map(p -> new CodexPricing(
                        p.inputCostPer1M() != null ? p.inputCostPer1M() : (builtin != null ? builtin.inputCostPer1M() : 0.0),
                        p.outputCostPer1M() != null ? p.outputCostPer1M() : (builtin != null ? builtin.outputCostPer1M() : 0.0),
                        p.cacheReadCostPer1M() != null ? p.cacheReadCostPer1M() : (builtin != null ? builtin.cacheReadCostPer1M() : 0.0)))
                .orElse(null);
    }

    private static String normalize(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }

        String normalized = MODEL_ALIASES.getOrDefault(SNAPSHOT_SUFFIX.matcher(model).replaceFirst(""), model);
        return MODEL_PREFIXES.stream()
                .filter(normalized::startsWith)
                .findFirst()
                .map(prefix -> MODEL_ALIASES.getOrDefault(prefix, prefix))
                .orElse(normalized);
    }
}
