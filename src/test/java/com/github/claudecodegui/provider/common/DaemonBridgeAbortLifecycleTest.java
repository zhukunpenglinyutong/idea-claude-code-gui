package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Provider-abort final closure (PART A): the stale-abort-vs-next-turn race.
 *
 * <p>Proves that T1's {@link DaemonBridge#sendAbort()} cleanup (pending sweep,
 * {@code pendingRequests.clear()}, {@code activeRequestCount} reset) — now entirely under
 * {@code abortLock} — cannot remove, abort, or reset bookkeeping belonging to a
 * subsequent T2 commit. Uses a {@link TestDaemonBridge} whose {@code ensureRunning}
 * returns true and {@code writeRaw} is a no-op, so the real {@code sendCommandChecked}
 * commits (registers a pending request) without a live daemon process. Latch-based, no
 * {@code sleep}.
 */
public class DaemonBridgeAbortLifecycleTest {

    private static final JsonObject PARAMS = new JsonObject();

    @Test
    public void oldAbortCleanup_cannotTouchNextTurn() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        // T1 commits R1 (pending, awaiting daemon response).
        CompletableFuture<Boolean> f1 = db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        assertFalse(f1.isDone());
        assertEquals(1, db.getActiveRequestCount());

        // T1 abort: sweep R1, clear, reset — all under abortLock.
        db.sendAbort();
        assertEquals(0, db.getActiveRequestCount());
        assertTrue("T1 request aborted", f1.get(1, TimeUnit.SECONDS).equals(Boolean.FALSE));
        assertTrue(db.isAborted());

        // Send-chain completion clears the abort flag (simulates ClaudeSession.send whenComplete).
        db.clearAbort();
        assertFalse(db.isAborted());

        // T2 commits R2.
        CompletableFuture<Boolean> f2 = db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        assertFalse("T2 request must remain pending (registered, not aborted)", f2.isDone());
        assertEquals("T2 activeRequestCount must be 1 — T1's reset must not stick to T2",
                1, db.getActiveRequestCount());
    }

    /**
     * T1's abort cleanup is paused mid-flight (holding abortLock). The send-chain
     * completion's clearAbort (which gates T2's commit) MUST block until T1's cleanup
     * releases abortLock. Then T2 commits safely. Proves T2 cannot commit until T1's
     * abort cleanup is finished.
     */
    @Test
    public void nextTurnCannotCommitUntilPriorAbortCleanupSafe() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        db.sendCommandChecked("claude.send", PARAMS, noopCallback()); // T1 R1 pending

        CountDownLatch sweepReached = new CountDownLatch(1);
        CountDownLatch resumeCleanup = new CountDownLatch(1);
        CountDownLatch clearDone = new CountDownLatch(1);

        db.abortCleanupHook = () -> {
            sweepReached.countDown(); // T1 abort cleanup reached the post-sweep point (holds abortLock)
            try {
                resumeCleanup.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        };

        Thread abort = new Thread(() -> db.sendAbort(), "abort");
        Thread clearer = new Thread(() -> {
            try {
                assertTrue(sweepReached.await(5, TimeUnit.SECONDS));
                // clearAbort (send-chain completion) needs abortLock — T1 still holds it.
                db.clearAbort();
                clearDone.countDown();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "clearer");

        abort.start();
        clearer.start();
        // T1's abort cleanup is paused holding abortLock ⇒ clearAbort cannot complete.
        assertTrue(sweepReached.await(5, TimeUnit.SECONDS));
        assertTrue("clearAbort must block while T1 abort cleanup holds abortLock",
                clearDone.getCount() > 0);

        resumeCleanup.countDown(); // release T1's cleanup
        abort.join(5000);
        clearer.join(5000);
        assertTrue("clearAbort must complete after T1 cleanup releases", clearDone.await(2, TimeUnit.SECONDS));
        assertFalse(db.isAborted());

        // T2 commits now that the flag is cleared and T1's cleanup is finished.
        CompletableFuture<Boolean> f2 = db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        assertFalse("T2 request must remain pending (not aborted by T1's stale cleanup)", f2.isDone());
        assertEquals(1, db.getActiveRequestCount());
    }

    @Test
    public void activeRequestCount_nextTurnNotResetByOldAbort() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        assertEquals(1, db.getActiveRequestCount());
        db.sendAbort();               // resets to 0
        assertEquals(0, db.getActiveRequestCount());
        db.clearAbort();
        db.sendCommandChecked("claude.send", PARAMS, noopCallback()); // T2
        assertEquals("T2 count must be 1, not 0 (T1 reset must not bleed into T2)",
                1, db.getActiveRequestCount());
        db.sendCommandChecked("claude.send", PARAMS, noopCallback()); // T2 second request
        assertEquals(2, db.getActiveRequestCount());
    }

    @Test
    public void repeatedAbort_doesNotPoisonNextTurn() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        db.sendAbort();
        db.sendAbort(); // repeated abort during the same T1 lifecycle
        assertTrue(db.isAborted());
        db.clearAbort();
        assertFalse(db.isAborted());

        CompletableFuture<Boolean> f2 = db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        assertFalse("T2 after repeated abort + clearAbort must commit and stay pending", f2.isDone());
        assertEquals(1, db.getActiveRequestCount());
    }

    // ── PART A: non-Agent sendCommand vs abort serialization ────────────────

    /**
     * A non-Agent command (sendCommand) cannot register during sendAbort cleanup.
     * Pause the abort cleanup mid-sweep (holding abortLock). The non-Agent
     * sendCommand must block at its own abortLock entry until the cleanup
     * releases — it cannot interleave and have its bookkeeping corrupted.
     */
    @Test
    public void nonAgentCommand_cannotRegisterDuringAbortCleanup() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        db.sendCommandChecked("claude.send", PARAMS, noopCallback()); // T1 pending

        CountDownLatch sweepReached = new CountDownLatch(1);
        CountDownLatch resumeCleanup = new CountDownLatch(1);
        CountDownLatch nonAgentDone = new CountDownLatch(1);
        db.abortCleanupHook = () -> {
            sweepReached.countDown();
            try {
                resumeCleanup.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        };

        Thread abort = new Thread(() -> db.sendAbort(), "abort");
        Thread nonAgent = new Thread(() -> {
            try {
                assertTrue(sweepReached.await(5, TimeUnit.SECONDS));
                // Non-Agent command (e.g., getContextUsage). Must block on abortLock
                // while abort cleanup holds it, not register mid-sweep.
                CompletableFuture<Boolean> f = db.sendCommand("claude.getContextUsage", PARAMS, noopCallback());
                nonAgentDone.countDown();
                f.get(2, TimeUnit.SECONDS);
            } catch (Throwable t) {
                // ignored
            }
        }, "non-agent");

        abort.start();
        nonAgent.start();
        assertTrue(sweepReached.await(5, TimeUnit.SECONDS));
        // Non-Agent thread is blocked on abortLock — it must NOT have completed.
        assertTrue("non-Agent command must block during abort cleanup (abortLock held)",
                nonAgentDone.getCount() > 0);

        resumeCleanup.countDown(); // release abort cleanup
        abort.join(5000);
        nonAgent.join(5000);
        assertTrue("non-Agent command must complete after abort cleanup releases abortLock",
                nonAgentDone.await(2, TimeUnit.SECONDS));
    }

    /**
     * After a prior turn's abort + clearAbort, a non-Agent command's
     * bookkeeping (pendingRequests, activeRequestCount) must not be affected
     * by the old abort's cleanup. The non-Agent command commits AFTER
     * clearAbort, so abortLock serialization ensures the old cleanup is done.
     */
    @Test
    public void oldAbortCleanup_cannotClearNonAgentNextRequest() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        db.sendCommandChecked("claude.send", PARAMS, noopCallback()); // T1
        db.sendAbort();
        assertEquals(0, db.getActiveRequestCount());
        db.clearAbort();

        // Non-Agent command after T1 completion — must register safely.
        CompletableFuture<Boolean> f = db.sendCommand("claude.setPermissionMode", PARAMS, noopCallback());
        assertFalse("non-Agent request must be pending (registered, not aborted)", f.isDone());
        assertEquals("non-Agent activeRequestCount must be 1",
                1, db.getActiveRequestCount());
    }

    /**
     * activeRequestCount for a non-Agent request is not reset by a prior
     * turn's stale abort cleanup — only the Agent sendCommandChecked path
     * is subject to the abort flag.
     */
    @Test
    public void activeRequestCount_nonAgentRequestNotResetByOldAbort() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        // Submit a non-Agent request (e.g., getContextUsage).
        CompletableFuture<Boolean> f = db.sendCommand("claude.getContextUsage", PARAMS, noopCallback());
        assertEquals(1, db.getActiveRequestCount());

        // sendAbort must reset activeRequestCount to 0 after sweeping.
        db.sendAbort();
        assertEquals(0, db.getActiveRequestCount());
        assertTrue(f.get(1, TimeUnit.SECONDS).equals(Boolean.FALSE)); // was swept
        db.clearAbort();

        // Next non-Agent request must start fresh at 1, not 0 from old reset.
        CompletableFuture<Boolean> f2 = db.sendCommand("claude.getContextUsage", PARAMS, noopCallback());
        assertEquals("non-Agent T2 count must be 1, not 0 (T1 reset must not bleed)",
                1, db.getActiveRequestCount());
    }

    /**
     * Both sendCommandChecked (Agent) and sendCommand (non-Agent) share the
     * same commit boundary (abortLock). After clearAbort, an Agent command
     * sees abort=false and commits; a concurrent non-Agent command also
     * serializes safely.
     */
    @Test
    public void agentCheckedAndNormalCommands_shareAbortCommitBoundary() throws Exception {
        DaemonBridge db = new TestDaemonBridge();
        db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        db.sendAbort();
        db.clearAbort();

        // Both commit paths work after abort lifecycle reset.
        CompletableFuture<Boolean> agentF = db.sendCommandChecked("claude.send", PARAMS, noopCallback());
        CompletableFuture<Boolean> nonAgentF = db.sendCommand("claude.setPermissionMode", PARAMS, noopCallback());

        assertFalse("Agent request must be pending (committed, not aborted)", agentF.isDone());
        assertFalse("Non-Agent request must be pending (committed)", nonAgentF.isDone());
        assertEquals("Both requests in activeRequestCount", 2, db.getActiveRequestCount());

        // An abort now sweeps both (they share the same pendingRequests map).
        db.sendAbort();
        assertEquals(0, db.getActiveRequestCount());
        assertTrue(agentF.get(1, TimeUnit.SECONDS).equals(Boolean.FALSE));
        assertTrue(nonAgentF.get(1, TimeUnit.SECONDS).equals(Boolean.FALSE));
    }

    private static DaemonBridge.DaemonOutputCallback noopCallback() {
        return new DaemonBridge.DaemonOutputCallback() {
            @Override public void onLine(String line) { }
            @Override public void onStderr(String text) { }
            @Override public void onError(String error) { }
            @Override public void onComplete(boolean success) { }
            @Override public void onAbort() { }
        };
    }

    private static final class TestDaemonBridge extends DaemonBridge {
        TestDaemonBridge() {
            super(null, null, null);
        }

        @Override
        public boolean ensureRunning() {
            return true; // simulate a live daemon without starting a real process
        }

        @Override
        protected void writeRaw(String json) {
            // no-op: don't touch daemonStdin (null in tests); the commit (pendingRequests.put)
            // still runs, which is what these tests exercise.
        }
    }
}
