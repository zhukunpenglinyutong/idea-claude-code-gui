package com.github.claudecodegui.util;

import com.github.claudecodegui.provider.CustomPricingProvider;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Calculates estimated per-turn usage cost using the same pricing tables as usage statistics.
 */
public final class UsageCostCalculator {

    private static final double ONE_MILLION = 1_000_000.0;

    private static final long CLAUDE_TIER_THRESHOLD = 200_000;
    private static final ClaudePricing CLAUDE_DEFAULT_PRICING = new ClaudePricing(3.0, 15.0, 3.75, 0.30);
    private static final ClaudePricing CLAUDE_TIERED_SONNET_PRICING = new ClaudePricing(3.0, 15.0, 3.75, 0.30, 6.0, 22.5, 7.5, 0.60);
    private static final ClaudePricing CLAUDE_LEGACY_OPUS_PRICING = new ClaudePricing(15.0, 75.0, 18.75, 1.50);
    private static final ClaudePricing CLAUDE_OPUS_4_5_PRICING = new ClaudePricing(5.0, 25.0, 6.25, 0.50);
    private static final ClaudePricing CLAUDE_FABLE_5_PRICING = new ClaudePricing(10.0, 50.0, 12.5, 1.0);
    private static final ClaudePricing CLAUDE_HAIKU_4_5_PRICING = new ClaudePricing(1.0, 5.0, 1.25, 0.10);
    private static final Map<String, ClaudePricing> CLAUDE_MODEL_PRICING = Map.ofEntries(
            Map.entry("claude-opus-4", CLAUDE_LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-1", CLAUDE_LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-20250514", CLAUDE_LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-5", CLAUDE_OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-6", CLAUDE_OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-7", CLAUDE_OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-8", CLAUDE_OPUS_4_5_PRICING),
            Map.entry("claude-fable-5", CLAUDE_FABLE_5_PRICING),
            Map.entry("claude-sonnet-4", CLAUDE_TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-20250514", CLAUDE_TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-5", CLAUDE_TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-6", CLAUDE_DEFAULT_PRICING),
            Map.entry("claude-sonnet-5", CLAUDE_DEFAULT_PRICING),
            Map.entry("claude-haiku-4", CLAUDE_HAIKU_4_5_PRICING),
            Map.entry("claude-haiku-4-5", CLAUDE_HAIKU_4_5_PRICING)
    );
    private static final List<String> CLAUDE_MODEL_PREFIXES = List.of(
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

    private static final Pattern CODEX_SNAPSHOT_SUFFIX = Pattern.compile("-\\d{4}-\\d{2}-\\d{2}$");
    private static final CodexPricing CODEX_DEFAULT_PRICING = new CodexPricing(1.25, 10.0, 0.125);
    private static final Map<String, CodexPricing> CODEX_MODEL_PRICING = Map.ofEntries(
            Map.entry("gpt-5", CODEX_DEFAULT_PRICING),
            Map.entry("gpt-5.1", CODEX_DEFAULT_PRICING),
            Map.entry("gpt-5-codex", CODEX_DEFAULT_PRICING),
            Map.entry("gpt-5.1-codex", CODEX_DEFAULT_PRICING),
            Map.entry("gpt-5.2-codex", new CodexPricing(1.75, 14.0, 0.175)),
            Map.entry("gpt-5.4", new CodexPricing(2.5, 15.0, 0.25)),
            Map.entry("gpt-5.4-mini", new CodexPricing(0.75, 4.5, 0.075))
    );
    private static final Map<String, String> CODEX_MODEL_ALIASES = Map.of(
            "gpt-5-codex", "gpt-5",
            "gpt-5.3-codex", "gpt-5.2-codex"
    );
    private static final List<String> CODEX_MODEL_PREFIXES = List.of(
            "gpt-5.4-mini",
            "gpt-5.4",
            "gpt-5.3-codex",
            "gpt-5.2-codex",
            "gpt-5.1-codex",
            "gpt-5-codex",
            "gpt-5.1",
            "gpt-5"
    );

    private UsageCostCalculator() {
    }

    public static Double calculateTurnCostUsd(String provider, JsonObject turnUsage, String model) {
        if (turnUsage == null) {
            return null;
        }
        long inputTokens = readLong(turnUsage, "input_tokens");
        long outputTokens = readLong(turnUsage, "output_tokens");
        long cacheWriteTokens = readLong(turnUsage, "cache_creation_input_tokens");
        long cacheReadTokens = readLong(turnUsage, "cache_read_input_tokens", "cached_input_tokens");
        if ("codex".equalsIgnoreCase(provider)) {
            return calculateCodexTurnCost(inputTokens, outputTokens, cacheReadTokens, model);
        }
        return calculateClaudeCost(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, model);
    }

    private static Double calculateClaudeCost(
            long inputTokens,
            long outputTokens,
            long cacheWriteTokens,
            long cacheReadTokens,
            String model
    ) {
        ClaudePricing pricing = resolveClaudePricing(model);
        if (pricing == null) {
            return null;
        }
        long requestTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
        return bill(inputTokens, pricing.inputRate(requestTokens))
                + bill(outputTokens, pricing.outputRate(requestTokens))
                + bill(cacheWriteTokens, pricing.cacheWriteRate(requestTokens))
                + bill(cacheReadTokens, pricing.cacheReadRate(requestTokens));
    }

    private static Double calculateCodexTurnCost(long inputTokensExcludingCache, long outputTokens, long cacheReadTokens, String model) {
        CodexPricing pricing = resolveCodexPricing(model);
        if (pricing == null) {
            return null;
        }
        return bill(inputTokensExcludingCache, pricing.inputCostPer1M)
                + bill(outputTokens, pricing.outputCostPer1M)
                + bill(cacheReadTokens, pricing.cacheReadCostPer1M);
    }

    private static ClaudePricing resolveClaudePricing(String model) {
        ClaudePricing customPricing = resolveCustomClaudePricing(model);
        if (customPricing != null) {
            return customPricing;
        }
        String normalizedModel = normalizeClaudeModel(model);
        return normalizedModel == null ? null : CLAUDE_MODEL_PRICING.get(normalizedModel);
    }

    private static ClaudePricing resolveCustomClaudePricing(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        return CustomPricingProvider.getInstance().getPricing("claude", model)
                .map(p -> new ClaudePricing(
                        p.inputCostPer1M() != null ? p.inputCostPer1M() : CLAUDE_DEFAULT_PRICING.inputCostPer1M,
                        p.outputCostPer1M() != null ? p.outputCostPer1M() : CLAUDE_DEFAULT_PRICING.outputCostPer1M,
                        p.cacheWriteCostPer1M() != null ? p.cacheWriteCostPer1M() : CLAUDE_DEFAULT_PRICING.cacheWriteCostPer1M,
                        p.cacheReadCostPer1M() != null ? p.cacheReadCostPer1M() : CLAUDE_DEFAULT_PRICING.cacheReadCostPer1M,
                        null, null, null, null))
                .orElse(null);
    }

    private static String normalizeClaudeModel(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        return CLAUDE_MODEL_PREFIXES.stream()
                .filter(model::startsWith)
                .findFirst()
                .orElse(model);
    }

    private static CodexPricing resolveCodexPricing(String model) {
        CodexPricing customPricing = resolveCustomCodexPricing(model);
        if (customPricing != null) {
            return customPricing;
        }
        String normalizedModel = normalizeCodexModel(model);
        return normalizedModel == null ? null : CODEX_MODEL_PRICING.get(normalizedModel);
    }

    private static CodexPricing resolveCustomCodexPricing(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        return CustomPricingProvider.getInstance().getPricing("codex", model)
                .map(p -> new CodexPricing(
                        p.inputCostPer1M() != null ? p.inputCostPer1M() : CODEX_DEFAULT_PRICING.inputCostPer1M,
                        p.outputCostPer1M() != null ? p.outputCostPer1M() : CODEX_DEFAULT_PRICING.outputCostPer1M,
                        p.cacheReadCostPer1M() != null ? p.cacheReadCostPer1M() : CODEX_DEFAULT_PRICING.cacheReadCostPer1M))
                .orElse(null);
    }

    private static String normalizeCodexModel(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        String normalized = CODEX_MODEL_ALIASES.getOrDefault(CODEX_SNAPSHOT_SUFFIX.matcher(model).replaceFirst(""), model);
        return CODEX_MODEL_PREFIXES.stream()
                .filter(normalized::startsWith)
                .findFirst()
                .map(prefix -> CODEX_MODEL_ALIASES.getOrDefault(prefix, prefix))
                .orElse(normalized);
    }

    private static double bill(long tokens, double ratePer1M) {
        return (tokens / ONE_MILLION) * ratePer1M;
    }

    private static long readLong(JsonObject json, String... keys) {
        if (json == null) {
            return 0;
        }
        for (String key : keys) {
            if (json.has(key) && !json.get(key).isJsonNull()) {
                return Math.max(0, json.get(key).getAsLong());
            }
        }
        return 0;
    }

    private record ClaudePricing(
            double inputCostPer1M,
            double outputCostPer1M,
            double cacheWriteCostPer1M,
            double cacheReadCostPer1M,
            Double inputCostPer1MAbove200K,
            Double outputCostPer1MAbove200K,
            Double cacheWriteCostPer1MAbove200K,
            Double cacheReadCostPer1MAbove200K
    ) {
        private ClaudePricing(double input, double output, double cacheWrite, double cacheRead) {
            this(input, output, cacheWrite, cacheRead, null, null, null, null);
        }

        private double inputRate(long requestTokens) {
            return rate(requestTokens, inputCostPer1M, inputCostPer1MAbove200K);
        }

        private double outputRate(long requestTokens) {
            return rate(requestTokens, outputCostPer1M, outputCostPer1MAbove200K);
        }

        private double cacheWriteRate(long requestTokens) {
            return rate(requestTokens, cacheWriteCostPer1M, cacheWriteCostPer1MAbove200K);
        }

        private double cacheReadRate(long requestTokens) {
            return rate(requestTokens, cacheReadCostPer1M, cacheReadCostPer1MAbove200K);
        }

        private double rate(long requestTokens, double baseRate, Double tierRate) {
            return requestTokens > CLAUDE_TIER_THRESHOLD && tierRate != null ? tierRate : baseRate;
        }
    }

    private record CodexPricing(double inputCostPer1M, double outputCostPer1M, double cacheReadCostPer1M) {
    }
}
