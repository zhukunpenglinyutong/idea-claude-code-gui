package com.github.claudecodegui.provider.common;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DaemonBridgeTest {

    // HEARTBEAT_TIMEOUT_MS = 45_000; just over threshold triggers unresponsive
    private static final long JUST_OVER_HEARTBEAT_THRESHOLD = 46_000;
    // ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000; well over for active-request timeout
    private static final long OVER_ACTIVE_REQUEST_THRESHOLD = 190_000;
    // Recent activity within threshold
    private static final long RECENT_ACTIVITY = 5_000;

    @Test
    public void staleHeartbeatWithoutActiveRequestsIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, JUST_OVER_HEARTBEAT_THRESHOLD, 0));
    }

    @Test
    public void activeRequestWithRecentOutputGetsGraceWindow() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, RECENT_ACTIVITY, 1));
    }

    @Test
    public void activeRequestWithNoRecentOutputEventuallyTimesOut() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(OVER_ACTIVE_REQUEST_THRESHOLD, OVER_ACTIVE_REQUEST_THRESHOLD, 1));
    }

    /**
     * Regression test for issue #1512: after a daemon restart the heartbeat
     * baseline is reset, so a fresh heartbeat age must NOT be flagged as
     * unresponsive even when there are no active requests.
     */
    @Test
    public void freshHeartbeatAfterRestartIsNotUnresponsive() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(RECENT_ACTIVITY, RECENT_ACTIVITY, 0));
    }

    /**
     * Documents the exact restart-storm scenario from issue #1512: a stale
     * heartbeat age (left over from the previous dead process) combined with
     * a fresh activity age and no active requests IS treated as unresponsive.
     * The fix prevents this stale value from ever reaching the check by
     * resetting lastHeartbeatResponse when a new process is spawned.
     */
    @Test
    public void staleHeartbeatWithFreshActivityIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(297_132, 149, 0));
    }
}
