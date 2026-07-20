package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Verifies usage values crossing the session callback JavaScript bridge are safe.
 */
public class SessionCallbackAdapterUsageTest {

    @Test
    public void normalizeUsageValueRejectsNegativeValues() {
        assertEquals(0, SessionCallbackAdapter.normalizeUsageValue(-1));
        assertEquals(42, SessionCallbackAdapter.normalizeUsageValue(42));
    }

    @Test
    public void calculateUsagePercentageHandlesInvalidCapacity() {
        assertEquals(0.0, SessionCallbackAdapter.calculateUsagePercentage(100, 0), 0.0);
        assertEquals(0.0, SessionCallbackAdapter.calculateUsagePercentage(100, -1), 0.0);
    }

    @Test
    public void calculateUsagePercentageIsBounded() {
        assertEquals(25.0, SessionCallbackAdapter.calculateUsagePercentage(250, 1000), 0.0);
        assertEquals(0.0, SessionCallbackAdapter.calculateUsagePercentage(0, 1000), 0.0);
        assertEquals(100.0, SessionCallbackAdapter.calculateUsagePercentage(1500, 1000), 0.0);
    }
}
