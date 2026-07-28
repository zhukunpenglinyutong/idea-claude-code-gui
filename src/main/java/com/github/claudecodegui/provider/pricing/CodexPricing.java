package com.github.claudecodegui.provider.pricing;

/**
 * Codex per-model pricing (USD per 1M tokens). Cache reads are billed separately; input
 * tokens passed to {@link #costUsd} are expected to already exclude cached input.
 *
 * <p>Shared single source of truth used by both {@code CodexUsageAggregator} and
 * {@code UsageCostCalculator} via {@link CodexPricingTable}.
 */
public record CodexPricing(double inputCostPer1M, double outputCostPer1M, double cacheReadCostPer1M) {

    private static final double ONE_MILLION = 1_000_000.0;

    public double costUsd(long inputTokensExcludingCache, long outputTokens, long cacheReadTokens) {
        return bill(inputTokensExcludingCache, inputCostPer1M)
                + bill(outputTokens, outputCostPer1M)
                + bill(cacheReadTokens, cacheReadCostPer1M);
    }

    private static double bill(long tokens, double ratePer1M) {
        return (tokens / ONE_MILLION) * ratePer1M;
    }
}
