package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class RemoteGatewayConfigTest {

    @Test
    public void acceptsTruthyValuesCaseInsensitive() {
        assertTrue(RemoteGatewayConfig.isEnabled("1"));
        assertTrue(RemoteGatewayConfig.isEnabled("true"));
        assertTrue(RemoteGatewayConfig.isEnabled("TRUE"));
        assertTrue(RemoteGatewayConfig.isEnabled("yes"));
        assertTrue(RemoteGatewayConfig.isEnabled("Yes"));
        assertTrue(RemoteGatewayConfig.isEnabled("  true  "));
    }

    @Test
    public void rejectsNonTruthyValues() {
        assertFalse(RemoteGatewayConfig.isEnabled(null));
        assertFalse(RemoteGatewayConfig.isEnabled(""));
        assertFalse(RemoteGatewayConfig.isEnabled("   "));
        assertFalse(RemoteGatewayConfig.isEnabled("0"));
        assertFalse(RemoteGatewayConfig.isEnabled("false"));
        assertFalse(RemoteGatewayConfig.isEnabled("no"));
        assertFalse(RemoteGatewayConfig.isEnabled("on"));
        assertFalse(RemoteGatewayConfig.isEnabled("2"));
        assertFalse(RemoteGatewayConfig.isEnabled("enabled"));
    }
}
