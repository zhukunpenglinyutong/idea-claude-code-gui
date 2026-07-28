package com.github.claudecodegui.provider.pricing;

/**
 * Claude per-model pricing (USD per 1M tokens), with an optional above-200K tier.
 *
 * <p>Shared single source of truth used by both the Usage Statistics aggregator
 * ({@code ClaudeUsageAggregator}) and the per-turn message footer cost
 * ({@code UsageCostCalculator}) via {@link ClaudePricingTable}.
 */
public record ClaudePricing(
        double inputCostPer1M,
        double outputCostPer1M,
        double cacheWriteCostPer1M,
        double cacheReadCostPer1M,
        Double inputCostPer1MAbove200K,
        Double outputCostPer1MAbove200K,
        Double cacheWriteCostPer1MAbove200K,
        Double cacheReadCostPer1MAbove200K
) {

    private static final double ONE_MILLION = 1_000_000.0;
    static final long TIER_THRESHOLD = 200_000;

    public ClaudePricing(double input, double output, double cacheWrite, double cacheRead) {
        this(input, output, cacheWrite, cacheRead, null, null, null, null);
    }

    /**
     * Bill a usage breakdown at this pricing. The above-200K tier applies when the whole
     * request (input + output + cache write + cache read) exceeds {@link #TIER_THRESHOLD}.
     */
    public double costUsd(long inputTokens, long outputTokens, long cacheWriteTokens, long cacheReadTokens) {
        long requestTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
        return bill(inputTokens, rate(requestTokens, inputCostPer1M, inputCostPer1MAbove200K))
                + bill(outputTokens, rate(requestTokens, outputCostPer1M, outputCostPer1MAbove200K))
                + bill(cacheWriteTokens, rate(requestTokens, cacheWriteCostPer1M, cacheWriteCostPer1MAbove200K))
                + bill(cacheReadTokens, rate(requestTokens, cacheReadCostPer1M, cacheReadCostPer1MAbove200K));
    }

    private static double rate(long requestTokens, double baseRate, Double tierRate) {
        return requestTokens > TIER_THRESHOLD && tierRate != null ? tierRate : baseRate;
    }

    private static double bill(long tokens, double ratePer1M) {
        return (tokens / ONE_MILLION) * ratePer1M;
    }
}
