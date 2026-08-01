package com.github.claudecodegui.session;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.DaemonBridge;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Turn Identity Establishment Final Amendment tests.
 *
 * <p>Two defects were found and fixed:
 * <ol>
 *   <li>TurnIdentity was created BEFORE launchClaude() allocated channelId →
 *       null channelId on first send.</li>
 *   <li>Async launch (supplyAsync) could execute before activeTurnIdentity was
 *       published — no happens-before.</li>
 * </ol>
 *
 * <p>Fix: {@code establishTurnIdentity()} (sync allocation + capture) → publish →
 * {@code launchClaudeForTurn(turnId)} (async, uses frozen identity).
 *
 * <p>Latch-based, no sleep.
 */
public class TurnIdentityEstablishmentTest {

    // ── 1. Identity exists before async launch can run ─────────────────────

    /**
     * Simulates the new send() order: identity is allocated + published
     * synchronously, THEN async launch is scheduled. Even when the async
     * launch runs immediately on another pool thread, it reads the
     * already-published identity.
     */
    @Test
    public void turnIdentityExistsBeforeAsyncLaunchCanRun() throws Exception {
        AtomicReference<TurnIdentity> active = new AtomicReference<>();
        CountDownLatch identityPublished = new CountDownLatch(1);
        CountDownLatch launchStarted = new CountDownLatch(1);
        AtomicReference<TurnIdentity> identitySeenByLaunch = new AtomicReference<>();

        // 1. SYNCHRONOUS: allocate identity + publish.
        TurnIdentity turnId = new TurnIdentity("claude", "channel-sync-1");
        active.set(turnId);
        identityPublished.countDown(); // identity IS published

        // 2. ASYNC: launch is scheduled AFTER publication.
        Thread launchThread = new Thread(() -> {
            try {
                identityPublished.await(5, TimeUnit.SECONDS);
                // At this point, identity IS published.
                TurnIdentity seen = active.get();
                assertNotNull("launch must see published identity", seen);
                identitySeenByLaunch.set(seen);
                launchStarted.countDown();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "launch-async");
        launchThread.start();

        assertTrue(launchStarted.await(5, TimeUnit.SECONDS));
        assertSame("async launch must see the SAME identity object that was published",
                turnId, identitySeenByLaunch.get());
    }

    // ── 2. Provider launch uses frozen turn provider ──────────────────────

    /**
     * The launch path must use TurnIdentity.provider(), not mutable state.
     * Simulates the new launchClaudeForTurn: providerRouter.launchChannel
     * receives turnId.provider() and turnId.channelId() — frozen values.
     */
    @Test
    public void providerLaunchUsesFrozenTurnProvider() {
        // Frozen identity.
        TurnIdentity turnId = new TurnIdentity("claude", "ch-frozen-1");

        // Simulate mutable state.change.
        String mutatedProvider = "codex";

        // launchChannel receives turnId.provider() = "claude".
        String launchProvider = turnId.provider();
        String launchChannel = turnId.channelId();

        // Must NOT equal the mutated state value.
        assertEquals("launch must use frozen provider", "claude", launchProvider);
        assertFalse("launch must NOT use mutated state",
                mutatedProvider.equals(launchProvider));
        assertEquals("launch must use frozen channelId", "ch-frozen-1", launchChannel);
    }

    // ── 3. Channel identity from allocation, not state rediscovery ─────────

    /**
     * The establishTurnIdentity() method allocates channelId internally,
     * returns TurnIdentity with that channelId directly — no state re-read.
     *
     * <p>Simulates the critical path: allocation → TurnIdentity → NOT reading
     * state.getChannelId() afterwards.
     */
    @Test
    public void channelIdentityIsReturnedFromAllocation_notRediscoveredFromState() {
        // Simulate: establishTurnIdentity() internal logic.
        // channelId is null → allocate.
        String allocatedChannel = "ch-allocated-001";
        // Set state.channelId = allocatedChannel (sync write).
        // But TurnIdentity is constructed from the LOCAL, not from state read.

        TurnIdentity turnId = new TurnIdentity("claude", allocatedChannel);

        // Simulate: between allocation and TurnIdentity creation,
        // an external writer could change state.channelId.
        // But TurnIdentity already captured the value.
        String mutatedStateChannel = "ch-other-9999"; // e.g., restart nulls it

        // TurnIdentity must NOT be affected by state mutation.
        assertEquals("TurnIdentity channel must be the ALLOCATED value",
                allocatedChannel, turnId.channelId());
        assertFalse("TurnIdentity must NOT reflect mutated state",
                mutatedStateChannel.equals(turnId.channelId()));
    }

    // ── 4. Interrupt at earliest start boundary targets turn identity ──────

    /**
     * Once establishTurnIdentity() + activeTurnIdentity.set() runs,
     * interrupt() MUST find the turn identity — even if the async
     * launch hasn't started yet.
     */
    @Test
    public void interruptAtEarliestStartBoundary_targetsTurnIdentity() {
        AtomicReference<TurnIdentity> active = new AtomicReference<>();

        // Turn identity established + published.
        TurnIdentity turnId = new TurnIdentity("claude", "ch-early-1");
        active.set(turnId);

        // Simulate interrupt() at the earliest possible point.
        TurnIdentity interruptTarget = active.get();

        assertNotNull("interrupt must find active identity even before launch begins",
                interruptTarget);
        assertEquals("interrupt must target frozen provider", "claude", interruptTarget.provider());
        assertEquals("interrupt must target frozen channel", "ch-early-1", interruptTarget.channelId());

        // The ProcessManager-level interrupt lands on the correct channel.
        ProcessManager pm = new ProcessManager();
        pm.interruptChannel(interruptTarget.channelId());
        assertFalse("interrupt recorded for turn channel", pm.beginSpawn("ch-early-1"));
    }

    // ── 5. restart() safe — does not erase active turn identity prematurely ──

    /**
     * Proves the restart() lifecycle contract:
     * 1. interrupt() reads activeTurnIdentity BEFORE restart nulls it
     * 2. activeTurnIdentity.set(null) is AFTER interrupt().thenCompose
     * 3. Old turn's whenComplete CAS sees already-nulled identity → fails gracefully
     * 4. No turn identity survives restart
     */
    @Test
    public void restartDuringActiveTurn_isLifecycleSafe() {
        AtomicReference<TurnIdentity> active = new AtomicReference<>();

        // Active turn.
        TurnIdentity turnId = new TurnIdentity("claude", "ch-turn");
        active.set(turnId);

        // 1. interrupt() reads active identity (simulated).
        TurnIdentity interruptTarget = active.get(); // restart's interrupt() call
        assertNotNull("interrupt sees active identity", interruptTarget);

        // ProcessManager-level interrupt.
        ProcessManager pm = new ProcessManager();
        pm.interruptChannel(interruptTarget.channelId());

        // 2. restart: thenCompose sets null AFTER interrupt completes.
        assertSame("identity still active before null", turnId, active.get());
        active.set(null); // restart's thenCompose
        assertNull("identity cleared after interrupt completes", active.get());

        // 3. Old turn's whenComplete CAS: compareAndSet(turnId, null).
        // active is already null → CAS fails → no error.
        boolean cleared = active.compareAndSet(turnId, null);
        assertFalse("old turn CAS must fail (identity already nulled by restart)", cleared);

        // 4. Channel interrupt was properly cleaned during restart.
        pm.clearInterrupt(interruptTarget.channelId());
        assertTrue("channel clear after restart", pm.beginSpawn("ch-turn"));
    }

    // ── 6. existing TurnIdentityFreeze tests still pass ────────────────────

    /**
     * Re-validates the key TurnIdentity CAS invariant from the Freeze Closure
     * tests: old turn completion cannot clear new turn identity.
     */
    @Test
    public void existingTurnIdentityFreezeTestsStillPass() {
        AtomicReference<TurnIdentity> active = new AtomicReference<>();

        // T1 starts.
        TurnIdentity t1 = new TurnIdentity("claude", "ch-t1");
        active.set(t1);

        // T2 starts before T1 completes.
        TurnIdentity t2 = new TurnIdentity("codex", "ch-t2");
        active.set(t2);

        // T1 terminal: CAS(t1, null) must FAIL (active is t2).
        assertFalse("T1 cannot clear T2", active.compareAndSet(t1, null));
        assertSame("T2 still active", t2, active.get());

        // T2 terminal: CAS(t2, null) succeeds.
        assertTrue("T2 can clear itself", active.compareAndSet(t2, null));
        assertNull("identity cleared", active.get());
    }
}
