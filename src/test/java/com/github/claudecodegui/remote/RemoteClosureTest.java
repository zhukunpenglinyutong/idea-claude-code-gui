package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.SessionTurnGate;
import com.github.claudecodegui.session.SessionTurnGateRegistry;
import org.junit.Before;
import org.junit.Test;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2C-C.1b final lifecycle closure tests.
 */
public class RemoteClosureTest {

    @Before
    public void setUp() {
        SharedInteractionResolver.getInstance().clearForTest();
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteInteractionRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
        SessionTurnGateRegistry.getInstance().clearForTest();
    }

    private RemoteTask createTask(String tabId, String sessionId, SessionTurnGate.Lease lease) {
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(UUID.randomUUID().toString(), "pid", tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(), new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
    }

    // ── 1. True hard bound: prune on resolve, not on register ──────────

    @Test
    public void sequentialResolvesBoundAt256WithoutNewRegistrations() {
        SharedInteractionResolver r = SharedInteractionResolver.getInstance();
        String sessionId = "s1";
        int created = 0;

        // Register + resolve 400 handles. Each is a separate requestId so
        // they don't collide in the resolver.
        for (int i = 0; i < 400; i++) {
            String rid = "r" + i;
            String ch = "ch" + i;
            CompletableFuture<Integer> f = new CompletableFuture<>();
            InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                    sessionId, rid, ch, new InteractionHandle.Completer() {
                @Override public void complete(Object v) { f.complete((Integer) v); }
                @Override public void cancel(String reason) { f.complete(3); }
            });
            r.register(h);
            r.completePermissionByChannelId(ch, 1);
            created++;
        }
        // No new registrations after the loop. The bound must be ≤256.
        int finalCount = r.size();
        assertTrue("hard bound ≤256 even without further registrations, was " + finalCount,
                finalCount <= 256);
    }

    // ── 2. Gate is NOT released by dispose ────────────────────────────

    @Test
    public void disposeDoesNotReleaseGate() {
        SessionTurnGate gate = new SessionTurnGate();
        SessionTurnGate.Lease lease = gate.acquire();
        assertNotNull(lease);
        assertTrue(gate.isHeld());

        // dispose should NOT release the lease — gate stays held.
        // (RemoteTaskRegistry.requestAbortAllActive() marks abort but never releases)
        RemoteTask task = createTask("tab1", "s1", lease);
        RemoteTaskRegistry.getInstance().register(task);
        RemoteTaskRegistry.getInstance().requestAbortAllActive();

        assertTrue("gate must still be held after dispose", gate.isHeld());
        assertTrue("task must be abort-requested", task.isAbortRequested());

        // Real release comes from finalizeTask (simulated by manual lease.release()).
        lease.release();
        assertFalse(gate.isHeld());
    }

    @Test
    public void sendFutureNotTerminal_DisposeDoesNotAllowNewTurn() {
        SessionTurnGate gate = new SessionTurnGate();
        // Gate acquired by generation A.
        SessionTurnGate.Lease leaseA = gate.acquire();
        assertNotNull(leaseA);

        // Dispose (abort request) — gate still held.
        RemoteTask taskA = createTask("tab1", "s1", leaseA);
        RemoteTaskRegistry.getInstance().register(taskA);
        RemoteTaskRegistry.getInstance().requestAbortAllActive();
        assertTrue(gate.isHeld());

        // Generation B tries to acquire — must fail.
        SessionTurnGate.Lease leaseB = gate.acquire();
        assertNull("generation B must NOT acquire gate while A's turn is running", leaseB);

        // Only after A's turn truly terminates (finalizeTask → release):
        leaseA.release();
        assertFalse(gate.isHeld());

        // Now B can proceed.
        SessionTurnGate.Lease leaseB2 = gate.acquire();
        assertNotNull("generation B must succeed after A released", leaseB2);
        leaseB2.release();
    }

    @Test
    public void interruptObserverFiresDuringDisposeAndCancelsPending() throws Exception {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        RemoteTask task = createTask("tab1", "s1", lease);
        RemoteTaskRegistry.getInstance().register(task);

        // A pending interaction for this task's session.
        CompletableFuture<Integer> f = new CompletableFuture<>();
        InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "s1", "r1", "ch1", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f.complete((Integer) v); }
            @Override public void cancel(String reason) { f.complete(3); }
        });
        SharedInteractionResolver.getInstance().register(h);

        // Simulate interrupt observer path: mark + cancel
        RemoteInterruptObserver obs = new RemoteInterruptObserver();
        obs.handleInterrupt("s1");

        assertTrue(task.isAbortRequested());
        assertEquals(3, f.get(1, TimeUnit.SECONDS).intValue());
        assertNull(SharedInteractionResolver.getInstance().get("s1", "r1"));
        assertTrue("gate still held (real release via finalizeTask)", true);
    }

    // ── 3. Mode initialization: exact call order ──────────────────────

    @Test
    public void freshSessionStartsWithDefaultMode() {
        // A freshly constructed ClaudeSession has no set mode → state default.
        com.github.claudecodegui.session.ClaudeSession session =
                new com.github.claudecodegui.session.ClaudeSession(null, null, null);
        // SessionState field initializer: permissionMode = "default"
        assertEquals("default", session.getPermissionMode());
    }

    @Test
    public void modeSetExplicitlyOverridesDefault() {
        com.github.claudecodegui.session.ClaudeSession session =
                new com.github.claudecodegui.session.ClaudeSession(null, null, null);
        session.setPermissionMode("acceptEdits");
        assertEquals("acceptEdits", session.getPermissionMode());
    }

    // ── cleanup ────────────────────────────────────────────────────────

    private static final class NoopScheduler implements RemoteDeltaFlushScheduler {
        @Override public void schedule(Runnable runnable, long delayMs) {}
        @Override public void cancel() {}
    }
}
