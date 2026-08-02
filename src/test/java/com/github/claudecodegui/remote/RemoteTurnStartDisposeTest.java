package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.SessionTurnGate;
import com.github.claudecodegui.session.SessionTurnGateRegistry;
import org.junit.Before;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2C-C.1 turn-start vs gateway-dispose closure: deterministic proof that the
 * {@link RemoteGatewayGeneration} start/closing boundary makes the post-dispose
 * turn-start race impossible.
 *
 * <p>The bug: dispatch's early admission check could pass, then gateway dispose could
 * complete (bus.close + requestAbortAllActive — whose snapshot missed the not-yet-
 * registered task), then dispatch resumed and called {@code ClaudeSession.send} — a
 * Remote turn starting AFTER shutdown, escaping abort. The fix serializes "start a
 * real turn" ( {@code gen.tryStartTurn}, which establishes the send channel under
 * gen.startLock) with "generation begins closing" ({@code gen.beginClosing}, same
 * lock).
 *
 * <p>The start action inside {@code tryStartTurn} stands in for the real dispatch's
 * register+send: {@code taskRegistered} = RemoteTask registered (visible to abort),
 * {@code sendStarted} = {@code ClaudeSession.send} channel established. A real
 * {@link SessionTurnGate} lease models gate behavior. Latch/CountDownLatch
 * synchronization — no {@code sleep}.
 */
public class RemoteTurnStartDisposeTest {

    @Before
    public void setUp() {
        RemoteEventBus.getInstance().clearForTest();
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteInteractionRegistry.getInstance().clearForTest();
        SessionTurnGateRegistry.getInstance().clearForTest();
    }

    // ── 1. Dispose wins: send MUST NOT start after dispose completes ──────

    /**
     * CHAT-A passes early admission, reaches a controlled pause BEFORE the real start
     * boundary. DISPOSE closes Generation A completely (beginClosing + abort snapshot).
     * CHAT-A resumes. Assert: ClaudeSession.send was NOT started; no orphan task; no
     * leaked SessionTurnGate.
     */
    @Test
    public void disposeWins_sendDoesNotStartAfterDispose() throws Exception {
        RemoteGatewayGeneration gen = new RemoteGatewayGeneration(1);
        SessionTurnGate gate = new SessionTurnGate();
        SessionTurnGate.Lease lease = gate.acquire();
        assertNotNull(lease);
        assertTrue(gate.isHeld());

        AtomicBoolean sendStarted = new AtomicBoolean(false);
        AtomicBoolean taskRegistered = new AtomicBoolean(false);
        CountDownLatch chatPausedBeforeBoundary = new CountDownLatch(1);
        CountDownLatch disposeDone = new CountDownLatch(1);
        AtomicReference<Throwable> err = new AtomicReference<>();

        Thread chatA = new Thread(() -> {
            try {
                // early admission validation passes (gen still open)
                assertFalse("early admission: gen must be open", gen.isClosing());
                // controlled pause BEFORE the real start boundary
                chatPausedBeforeBoundary.countDown();
                assertTrue("resume after dispose", disposeDone.await(5, TimeUnit.SECONDS));
                // resume: cross the start boundary (the real send action)
                boolean startWon = gen.tryStartTurn(() -> {
                    taskRegistered.set(true); // = RemoteTask registered
                    sendStarted.set(true);    // = ClaudeSession.send (channel established)
                });
                if (!startWon) {
                    // dispatch: closing won — release the never-used lease, reject (503)
                    lease.release();
                }
            } catch (Throwable t) {
                err.set(t);
            }
        }, "chatA");

        Thread dispose = new Thread(() -> {
            try {
                assertTrue("CHAT-A paused before boundary",
                        chatPausedBeforeBoundary.await(5, TimeUnit.SECONDS));
                // close Generation A completely
                gen.beginClosing();
                // requestAbortAllActive snapshot: no task registered yet — abort misses it
                assertFalse("abort snapshot must see no active task (race window)",
                        taskRegistered.get());
                // (bus.close / observer uninstall would follow in real dispose)
            } catch (Throwable t) {
                err.set(t);
            }
        }, "dispose");

        chatA.start();
        dispose.start();
        dispose.join(5000);
        disposeDone.countDown(); // release CHAT-A to resume AFTER dispose completed
        chatA.join(5000);

        assertNull("no thread exception", err.get());
        assertFalse("ClaudeSession.send MUST NOT start after dispose completed",
                sendStarted.get());
        assertFalse("no orphan RemoteTask registered", taskRegistered.get());
        assertFalse("SessionTurnGate lease MUST be released (no leak)", gate.isHeld());
    }

    // ── 2. Start wins: dispose MUST see/abort the task, then real terminal ─

    /**
     * CHAT-A crosses the real start boundary first (register + send channel established
     * under gen.startLock), then the turn runs. DISPOSE then begins closing and its
     * abort snapshot MUST see the active task. The turn terminates and releases the
     * gate. Assert: send started; dispose saw the task; gate released after terminal.
     */
    @Test
    public void startWins_disposeSeesAndInterruptsTask_thenTerminalReleasesGate() throws Exception {
        RemoteGatewayGeneration gen = new RemoteGatewayGeneration(1);
        SessionTurnGate gate = new SessionTurnGate();
        SessionTurnGate.Lease lease = gate.acquire();
        assertNotNull(lease);
        assertTrue(gate.isHeld());

        AtomicBoolean sendStarted = new AtomicBoolean(false);
        AtomicBoolean taskRegistered = new AtomicBoolean(false);
        AtomicBoolean abortObserved = new AtomicBoolean(false);
        CountDownLatch startCrossed = new CountDownLatch(1);
        CountDownLatch abortDone = new CountDownLatch(1);
        AtomicReference<Throwable> err = new AtomicReference<>();

        Thread chatA = new Thread(() -> {
            try {
                // Cross the start boundary: register + establish send channel UNDER the
                // lock, then release it (send returns a future; the turn runs async).
                boolean startWon = gen.tryStartTurn(() -> {
                    taskRegistered.set(true); // = RemoteTask registered (visible to dispose)
                    sendStarted.set(true);    // = ClaudeSession.send channel established
                });
                assertTrue("start must win (dispose hasn't begun closing)", startWon);
                startCrossed.countDown(); // turn is now running (async, outside the lock)
                assertTrue("turn runs until abort", abortDone.await(5, TimeUnit.SECONDS));
                lease.release(); // real terminal (finalizeTask) releases the gate
            } catch (Throwable t) {
                err.set(t);
            }
        }, "chatA");

        Thread dispose = new Thread(() -> {
            try {
                assertTrue("wait for turn to cross boundary",
                        startCrossed.await(5, TimeUnit.SECONDS));
                gen.beginClosing(); // mark CLOSING — no new turn may start
                // requestAbortAllActive: task IS registered (crossed before closing) → visible
                assertTrue("dispose MUST see the active task to abort it",
                        taskRegistered.get());
                abortObserved.set(true); // = session.interrupt() lands on established channel
                abortDone.countDown();   // abort → terminal
            } catch (Throwable t) {
                err.set(t);
            }
        }, "dispose");

        chatA.start();
        dispose.start();
        chatA.join(5000);
        dispose.join(5000);

        assertNull("no thread exception", err.get());
        assertTrue("turn must cross the real start boundary first", sendStarted.get());
        assertTrue("dispose must see and abort the active task", abortObserved.get());
        assertFalse("gate MUST be released after real terminal", gate.isHeld());
    }

    // ── 3. Dispatch honors gen.closing (fast path, no send attempted) ─────

    @Test
    public void dispatch_afterGenerationClosing_rejectedBeforeSend() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        RemoteGatewayGeneration gen = new RemoteGatewayGeneration(bus.currentGeneration());
        gen.beginClosing();
        // null project would NOT_FOUND if admitted; closing → UNAVAILABLE before resolve.
        RemoteChatResult result = new RemoteChatDispatcher().dispatch(null, "tab1", "hi", gen);
        assertEquals("closing generation must reject dispatch before send",
                RemoteChatResult.Status.UNAVAILABLE, result.status);
    }

    // ── 4. Open generation still admits dispatch (no over-rejection) ──────

    @Test
    public void dispatch_openGeneration_admitted() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        RemoteGatewayGeneration gen = new RemoteGatewayGeneration(bus.currentGeneration());
        // open gen → passes stale check → null project → NOT_FOUND (not UNAVAILABLE).
        RemoteChatResult result = new RemoteChatDispatcher().dispatch(null, "tab1", "hi", gen);
        assertEquals("open generation must admit dispatch (not stale-rejected)",
                RemoteChatResult.Status.NOT_FOUND, result.status);
    }
}
