package com.github.claudecodegui.provider.pricing;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/**
 * Contract tests for the shared pricing tables that back both Usage Statistics and the
 * per-turn footer. {@code resolve} stays silent (null) for unknown models; {@code resolveOrDefault}
 * always returns a price.
 */
public class PricingTableTest {

    @Test
    public void claudeResolveReturnsNullForUnknownButDefaultOtherwise() {
        assertNull(ClaudePricingTable.resolve("custom-claude-without-pricing"));
        assertNull(ClaudePricingTable.resolve(null));
        // resolveOrDefault falls back to the default-model pricing (sonnet-4-6).
        assertNotNull(ClaudePricingTable.resolveOrDefault("custom-claude-without-pricing"));
        assertEquals(3.0, ClaudePricingTable.resolveOrDefault("totally-unknown").inputCostPer1M(), 1e-9);
    }

    @Test
    public void claudeNormalizesCaseAndProviderPrefix() {
        // Upper-case and a provider route prefix both normalize to claude-opus-4-8 (opus 4.5 tier).
        assertEquals(5.0, ClaudePricingTable.resolve("anthropic/CLAUDE-OPUS-4-8").inputCostPer1M(), 1e-9);
    }

    @Test
    public void claudeAppliesAbove200KTierForSonnet4() {
        ClaudePricing pricing = ClaudePricingTable.resolve("claude-sonnet-4");
        assertNotNull(pricing);
        // Under the 200K request threshold uses the base input rate (3.0); above it uses 6.0.
        double under = pricing.costUsd(1_000, 0, 0, 0);
        double over = pricing.costUsd(300_000, 0, 0, 0);
        assertEquals(1_000 / 1_000_000.0 * 3.0, under, 1e-9);
        assertEquals(300_000 / 1_000_000.0 * 6.0, over, 1e-9);
    }

    @Test
    public void codexResolveReturnsNullForUnknownButDefaultOtherwise() {
        assertNull(CodexPricingTable.resolve("custom-codex-without-pricing"));
        assertNull(CodexPricingTable.resolve(null));
        assertEquals(1.25, CodexPricingTable.resolveOrDefault("totally-unknown").inputCostPer1M(), 1e-9);
    }

    @Test
    public void codexAliasesBareGpt56ToSol() {
        // Bare "gpt-5.6" and a dated snapshot both resolve to gpt-5.6-sol pricing.
        assertEquals(5.0, CodexPricingTable.resolve("gpt-5.6").inputCostPer1M(), 1e-9);
        assertEquals(5.0, CodexPricingTable.resolve("gpt-5.6-sol-2026-01-15").inputCostPer1M(), 1e-9);
    }
}
