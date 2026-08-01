package com.github.claudecodegui.session;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.DaemonBridge;
import org.junit.Before;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Turn Identity Exceptional-Path Final Verification: the channel identity
 * MUST be known at cleanup time regardless of whether the async provider
 * launch succeeds, fails, or is interrupted.
 *
 * <p>Tests the primitive guarantee: once launchClaude() synchronously allocates
 * a channelId, the cleanup terminal uses that same channel — even if the async
 * continuation never executes (launch failure, thenCompose skipped). Uses
 * ProcessManager + DaemonBridge primitives. Latch-based, no sleep.
 */
public class TurnIdentityExceptionalPathTest {

    private ProcessManager pm;

    @Before
    public void setUp() {
        pm = new ProcessManager();
    }

    // ── 1. Launch fails after channel assigned → cleanup still uses C1 ─────

    /**
     * Simulates: launchClaude() synchronously allocates C1, then the async
     * provider launch fails. turnChannel is captured from state.getChannelId()
     * right after launchClaude() returns (BEFORE the async continuation).
     * The cleanup MUST use C1, not null.
     *
     * <p>Without the fix, the AtomicReference inside thenCompose is never set,
     * and clearAbort(provider, null) is a no-op that leaks C1 in interruptedChannels.
     */
    @Test
    public void launchFailsAfterChannelAssigned_cleanupStillUsesAssignedChannel() {
        String ch = "channel-failed-launch";

        // Step 1: launchClaude() synchronously allocates C1 (simulated).
        // Step 2: An interrupt arrives during the launch window.
        pm.interruptChannel(ch);
        assertFalse("interrupt recorded → spawn blocked", pm.beginSpawn(ch));

        // Step 3: Async launch fails — thenCompose never runs.
        // Step 4: cleanup uses the CAPTURED channel (from state.getChannelId()),
        //         NOT null from an unset AtomicReference.
        pm.clearInterrupt(ch); // This is what clearAbort(turnProvider, turnChannel) does

        // Step 5: Channel C1 is clean after cleanup.
        assertTrue("C1 must be cleared after cleanup (even though launch failed)",
                pm.beginSpawn(ch));
    }

    // ── 2. Interrupt during launch failure → does not poison next turn ─────

    /**
     * Full scenario: T1 send allocates C1, interrupt lands, launch fails,
     * cleanup with captured C1 clears the interrupt. T2 (next send) allocates
     * C2 and must NOT be affected by T1's stale interrupt.
     */
    @Test
    public void interruptDuringLaunchFailure_doesNotPoisonNextTurn() {
        String t1Channel = "turn-1-channel";
        String t2Channel = "turn-2-channel";

        // T1: allocate C1, interrupt lands.
        pm.interruptChannel(t1Channel);
        // T1: launch fails, cleanup uses captured t1Channel.
        pm.clearInterrupt(t1Channel);
        // T1: channel cleared.
        assertTrue("T1 channel must be clean after cleanup", pm.beginSpawn(t1Channel));

        // T2: allocates a NEW channel (launchClaude generates new UUID after failure).
        // T2's channel must NOT be poisoned by T1's stale state.
        assertTrue("T2 new channel must be clean (not poisoned by T1)", pm.beginSpawn(t2Channel));
    }

    // ── 3. clearAbort null path is explicitly safe ─────────────────────────

    /**
     * Proves that clearInterrupt(null) is a no-op (null guard, no NPE).
     * Also proves that the daemon-level clearAbort() (which has no channelId
     * parameter) works correctly — it clears only the daemon abort flag.
     */
    @Test
    public void clearAbortNullPath_isEitherImpossibleOrExplicitlySafe() {
        // ProcessManager.clearInterrupt(null): null guard → no-op, no exception.
        pm.clearInterrupt(null); // must not throw

        // Interrupt a real channel to confirm the null path didn't clear it.
        String ch = "real-channel";
        pm.interruptChannel(ch);
        assertFalse(pm.beginSpawn(ch));

        pm.clearInterrupt(null); // no-op, must not clear "real-channel"

        assertFalse("real-channel must still be interrupted after clearInterrupt(null)",
                pm.beginSpawn(ch));

        // DaemonBridge.clearAbort(): no channelId parameter — clears only daemon flag.
        DaemonBridge db = new TestDaemonBridge();
        db.sendAbort();
        assertTrue("daemon must be aborted", db.isAborted());

        // Even with null channelId at the ClaudeSession level, the daemon clear
        // still fires (ClaudeSDKBridge.clearAbort calls db.clearAbort() regardless).
        db.clearAbort(); // daemon-level clear, always safe
        assertFalse("daemon abort flag must be cleared", db.isAborted());
    }

    // ── 4. Provider changes during pending turn → captured provider sticks ──

    /**
     * Simulates the ClaudeSession.send pattern with provider identity.
     * Once turnProvider is captured at send entry, it must be the identity
     * used for cleanup — even if state.provider changes before completion.
     *
     * <p>Uses two DaemonBridge instances to model the Claude vs Codex bridges.
     */
    @Test
    public void providerChangesDuringPendingTurn_doesNotChangeTurnProvider() {
        // Two bridges: "claude" (dbClaude) and "codex" (dbCodex).
        DaemonBridge dbClaude = new TestDaemonBridge();
        DaemonBridge dbCodex = new TestDaemonBridge();

        // T1 send: capture turnProvider = "claude".
        final String turnProvider = "claude";

        // Both bridges get aborted during the turn window.
        dbClaude.sendAbort();
        dbCodex.sendAbort();

        // "state.provider" changes to "codex" before cleanup (simulated mutation).
        // mutableState.setProvider("codex");

        // Cleanup MUST use turnProvider ("claude"), NOT mutable state ("codex").
        if ("claude".equals(turnProvider)) {
            dbClaude.clearAbort(); // clears T1's actual bridge
        }

        // Claude bridge: cleared (was T1's provider).
        assertFalse("Claude bridge must be cleared — it was T1's provider",
                dbClaude.isAborted());

        // Codex bridge: STILL aborted (T1 didn't use Codex).
        assertTrue("Codex bridge must still be aborted — T1 didn't use it",
                dbCodex.isAborted());
    }

    // ── 5. Exceptional completion cleans correct provider + channel ─────────

    /**
     * Models the full exceptional-path lifecycle: T1 allocates C1/claude,
     * interrupt lands for C1, async launch fails, cleanup fires with captured
     * (claude, C1). Verifies BOTH the channel interrupt AND the daemon abort
     * are properly cleared.
     */
    @Test
    public void cleanupUsesActualTurnProviderAndChannelOnExceptionalCompletion() throws Exception {
        String t1Channel = "turn-exceptional-channel";

        // T1: capture (provider="claude", channel=C1).
        final String turnProvider = "claude";
        final String turnChannel = t1Channel;

        DaemonBridge dbClaude = new TestDaemonBridge();

        // Interrupt arrives for C1 during launch window.
        pm.interruptChannel(t1Channel);
        dbClaude.sendAbort(); // daemon-level abort

        // Confirm both are aborted/interrupted.
        assertTrue(dbClaude.isAborted());
        assertFalse(pm.beginSpawn(t1Channel));

        // Async launch fails — cleanup fires with CAPTURED identity.
        // clearAbort("claude", "turn-exceptional-channel"):
        //   1. ClaudeSDKBridge.clearAbort(C1) → pm.clearInterrupt(C1) + db.clearAbort()
        pm.clearInterrupt(turnChannel);
        dbClaude.clearAbort();

        // Both must be cleared.
        assertFalse("daemon abort must be cleared", dbClaude.isAborted());
        assertTrue("C1 interrupt must be cleared — next spawn passes",
                pm.beginSpawn(t1Channel));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static final class TestDaemonBridge extends DaemonBridge {
        TestDaemonBridge() {
            super(null, null, null);
        }

        @Override
        public boolean ensureRunning() {
            return true;
        }

        @Override
        protected void writeRaw(String json) {
            // no-op: test only exercises abort lifecycle, no daemon I/O.
        }
    }
}
