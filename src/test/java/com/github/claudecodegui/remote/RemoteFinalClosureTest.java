package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionTurnGate;
import com.github.claudecodegui.session.SessionTurnGateRegistry;
import org.junit.Before;
import org.junit.Test;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2C-C.1c final closure tests: concurrent tombstone hard bound,
 * dispose real-interrupt lifecycle.
 */
public class RemoteFinalClosureTest {

    @Before
    public void setUp() {
        SharedInteractionResolver.getInstance().clearForTest();
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteInteractionRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
        SessionTurnGateRegistry.getInstance().clearForTest();
    }

    private RemoteTask createTask(String tabId, String sessionId,
                                    SessionTurnGate.Lease lease, ClaudeSession session) {
        AtomicLong clock = new AtomicLong(1L);
        RemoteTask t = RemoteTask.create(UUID.randomUUID().toString(), "pid", tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(), new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
        t.session = session;
        return t;
    }

    // ── 1. Concurrent hard bound: after all threads, resolved ≤ 256 ──

    @Test
    public void concurrentResolvesQuiescentBound() throws Exception {
        SharedInteractionResolver r = SharedInteractionResolver.getInstance();
        String sessionId = "s1";

        // First, fill to near the bound with sequential resolves.
        for (int i = 0; i < 250; i++) {
            String rid = "pre" + i;
            String ch = "pre-ch" + i;
            CompletableFuture<Integer> f = new CompletableFuture<>();
            InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                    sessionId, rid, ch, new InteractionHandle.Completer() {
                @Override public void complete(Object v) { f.complete((Integer) v); }
                @Override public void cancel(String reason) { f.complete(3); }
            });
            r.register(h);
            r.completePermissionByChannelId(ch, 1);
        }

        // Now add 20 concurrent resolves — all should land, then prune to ≤256.
        int concurrency = 20;
        ExecutorService pool = Executors.newFixedThreadPool(concurrency);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(concurrency);
        for (int i = 0; i < concurrency; i++) {
            final int idx = i;
            pool.submit(() -> {
                try {
                    start.await();
                    String rid = "c" + idx;
                    String ch = "c-ch" + idx;
                    CompletableFuture<Integer> f = new CompletableFuture<>();
                    InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                            sessionId, rid, ch, new InteractionHandle.Completer() {
                        @Override public void complete(Object v) { f.complete((Integer) v); }
                        @Override public void cancel(String reason) { f.complete(3); }
                    });
                    r.register(h);
                    r.completePermissionByChannelId(ch, 1);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        assertTrue("concurrent resolves must finish", done.await(5, TimeUnit.SECONDS));
        pool.shutdownNow();

        // After ALL threads complete, resolved count must be ≤256.
        // No further register/resolve — quiescent assertion.
        int total = r.size();
        // Count resolved vs pending
        int resolved = 0;
        int pending = 0;
        for (int i = 0; i < 250 + concurrency; i++) {
            String rid = i < 250 ? "pre" + i : "c" + (i - 250);
            String ch = i < 250 ? "pre-ch" + i : "c-ch" + (i - 250);
            InteractionHandle h = r.getByChannelId(ch);
            if (h != null) {
                if (h.isResolved()) resolved++;
                else pending++;
            }
        }
        assertTrue("hard bound: resolved ≤ 256, was " + resolved, resolved <= 256);
        assertEquals("no pending after explicit resolve", 0, pending);
    }

    @Test
    public void pendingHandlesNotAffectedByConcurrentPrune() {
        SharedInteractionResolver r = SharedInteractionResolver.getInstance();

        // Fill resolved to 256, leave 50 pending.
        String sessionId = "s1";
        for (int i = 0; i < 256; i++) {
            CompletableFuture<Integer> f = new CompletableFuture<>();
            InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                    sessionId, "r" + i, "ch" + i, new InteractionHandle.Completer() {
                @Override public void complete(Object v) { f.complete((Integer) v); }
                @Override public void cancel(String reason) { f.complete(3); }
            });
            r.register(h);
            r.completePermissionByChannelId("ch" + i, 1);
        }
        for (int i = 0; i < 50; i++) {
            CompletableFuture<Integer> f = new CompletableFuture<>();
            InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                    sessionId, "p" + i, "p-ch" + i, new InteractionHandle.Completer() {
                @Override public void complete(Object v) { f.complete((Integer) v); }
                @Override public void cancel(String reason) { f.complete(3); }
            });
            r.register(h);
            // NOT resolved — stays pending.
        }

        // Trigger one more resolve (which prunes)
        CompletableFuture<Integer> f2 = new CompletableFuture<>();
        InteractionHandle nh = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                sessionId, "r-extra", "r-ch-extra", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f2.complete((Integer) v); }
            @Override public void cancel(String reason) { f2.complete(3); }
        });
        r.register(nh);
        r.completePermissionByChannelId("r-ch-extra", 1);

        // All 50 pending handles must still be present and resolvable.
        for (int i = 0; i < 50; i++) {
            InteractionHandle h = r.getByChannelId("p-ch" + i);
            assertNotNull("pending handle " + i + " must NOT be pruned", h);
            assertFalse("pending handle " + i + " must not be resolved", h.isResolved());
        }
    }

    // ── 2. Dispose réellement abort via session.interrupt() ──────────

    @Test
    public void requestAbortAllActiveInvokesInterrupt() {
        // Use a stub session that records interrupt calls.
        RecordingSession session = new RecordingSession();
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        RemoteTask task = createTask("tab1", "s1", lease, session);
        RemoteTaskRegistry.getInstance().register(task);

        assertFalse(session.interrupted);

        RemoteTaskRegistry.getInstance().requestAbortAllActive();
        assertTrue("session.interrupt must be called", session.interrupted);
        assertTrue("task must be abort-requested", task.isAbortRequested());
    }

    @Test
    public void disposeRealInterruptCancelsPending() throws Exception {
        // Verifies the InterruptObserver path that fires during dispose:
        // interrupt → observer.handleInterrupt → cancelAllForSession.
        RemoteTask task = createTask("tab1", "s1",
                new SessionTurnGate().acquire(), new ClaudeSession(null, null, null));
        task.getSessionAliases().add("s1");
        RemoteTaskRegistry.getInstance().register(task);

        // A pending interaction
        CompletableFuture<Integer> f = new CompletableFuture<>();
        InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "s1", "rid", "ch", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f.complete((Integer) v); }
            @Override public void cancel(String reason) { f.complete(3); }
        });
        SharedInteractionResolver.getInstance().register(h);

        // The observer path (called by real interrupt → onInterrupt → handleInterrupt)
        new RemoteInterruptObserver().handleInterrupt("s1");

        assertEquals(3, f.get(2, TimeUnit.SECONDS).intValue());
        assertNull(SharedInteractionResolver.getInstance().get("s1", "rid"));
        assertTrue(task.isAbortRequested());
    }

    @Test
    public void gateRemainsHeldDuringDispose() {
        SessionTurnGate gate = new SessionTurnGate();
        SessionTurnGate.Lease lease = gate.acquire();
        RecordingSession session = new RecordingSession();
        RemoteTask task = createTask("tab1", "s1", lease, session);
        RemoteTaskRegistry.getInstance().register(task);

        RemoteTaskRegistry.getInstance().requestAbortAllActive();
        assertTrue("gate MUST still be held after dispose", gate.isHeld());

        // Only releasing the lease frees the gate.
        lease.release();
        assertFalse(gate.isHeld());
    }

    @Test
    public void generationBBlockedWhileGateHeld() {
        SessionTurnGate gate = new SessionTurnGate();
        SessionTurnGate.Lease leaseA = gate.acquire();
        RecordingSession sessionA = new RecordingSession();
        RemoteTask taskA = createTask("tab1", "s1", leaseA, sessionA);
        RemoteTaskRegistry.getInstance().register(taskA);

        // Generation A dispose
        RemoteTaskRegistry.getInstance().requestAbortAllActive();
        assertTrue(gate.isHeld());

        // Generation B tries — blocked
        assertNull("B blocked while A's gate is held", gate.acquire());

        // A's turn finishes
        leaseA.release();
        assertFalse(gate.isHeld());

        // Now B succeeds
        SessionTurnGate.Lease leaseB = gate.acquire();
        assertNotNull("B succeeds after A released", leaseB);
        leaseB.release();
    }

    // ── stub session for interrupt recording ──────────────────────────

    private static final class RecordingSession extends ClaudeSession {
        boolean interrupted;

        RecordingSession() {
            super(null, null, null);
        }

        @Override
        public CompletableFuture<Void> interrupt() {
            interrupted = true;
            return CompletableFuture.completedFuture(null);
        }
    }

    private static final class NoopScheduler implements RemoteDeltaFlushScheduler {
        @Override public void schedule(Runnable runnable, long delayMs) {}
        @Override public void cancel() {}
    }
}
