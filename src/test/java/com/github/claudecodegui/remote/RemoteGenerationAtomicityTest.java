package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.SessionTurnGate;
import com.github.claudecodegui.session.SessionTurnGateRegistry;
import com.google.gson.JsonObject;
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
 * Phase 2C-C.1 generation-atomicity closure: deterministic proof that the
 * centralized {@code publishForGeneration} primitive makes cross-generation
 * event delivery impossible, plus the explicit race-window test that was
 * missing from the prior report.
 *
 * <p>Model: a subscriber is tagged at creation with the bus generation that was
 * current at that moment (immutable). {@code publishForGeneration(G)} offers
 * only to subscribers whose tag equals {@code G}. Because the tag is final,
 * generation validation and delivery-domain selection are one atomic decision
 * — there is no check-then-publish window for {@code close()} to interpose on.
 */
public class RemoteGenerationAtomicityTest {

    @Before
    public void setUp() {
        RemoteEventBus.getInstance().clearForTest();
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteInteractionRegistry.getInstance().clearForTest();
        SharedInteractionResolver.getInstance().clearForTest();
        SessionTurnGateRegistry.getInstance().clearForTest();
    }

    private RemoteTask createTask(String tabId, String sessionId, long busGeneration) {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(UUID.randomUUID().toString(), "pid", tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(),
                new NoopScheduler(), clock::get, busGeneration);
    }

    // ── 1. Old-gen assistant.content (coalescer) does not reach Gen-B ────

    @Test
    public void oldGenerationAssistantEvent_doesNotReachGenerationB() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        RemoteTask task = createTask("tab1", "s1", bus.currentGeneration()); // gen 1
        // Append WITHOUT a sentence terminator so the coalescer holds the text
        // pending (no immediate flush). The flush is forced manually below,
        // after the generation has rotated.
        task.coalescer.append("partial-stale");

        bus.close(); // rotate to gen 2
        RemoteEventSubscriber subB = bus.subscribe("tab1"); // gen 2
        assertEquals(2, subB.getGeneration());

        // Deferred Gen-A flush now fires through publishForGeneration(1).
        task.coalescer.flush();

        assertNull("Gen-A assistant.content must NOT reach Gen-B subscriber",
                subB.poll(300));
    }

    // ── 2. Old-gen tool / usage event does not reach Gen-B ───────────────

    @Test
    public void oldGenerationToolOrUsageEvent_doesNotReachGenerationB() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        RemoteTask task = createTask("tab1", "s1", bus.currentGeneration()); // gen 1
        RemoteTaskRegistry.getInstance().register(task);

        bus.close(); // rotate to gen 2
        RemoteEventSubscriber subB = bus.subscribe("tab1"); // gen 2

        RemoteEventTap tap = RemoteEventTap.forTest("pid", "tab1", bus,
                RemoteTaskRegistry.getInstance());
        // usage.updated routes through the tap's publish() helper → publishForTask
        // → publishForGeneration(task.busGeneration = 1). Gen-B (tag 2) is filtered.
        tap.onUsageUpdate(100, 1000);

        assertNull("Gen-A usage.updated must NOT reach Gen-B subscriber",
                subB.poll(300));
    }

    // ── 3. Old-gen interaction.resolved does not reach Gen-B ─────────────

    @Test
    public void oldGenerationInteractionResolved_doesNotReachGenerationB() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        RemoteTask task = createTask("tab1", "s1", bus.currentGeneration()); // gen 1
        RemoteTaskRegistry.getInstance().register(task);
        // Seed the interaction registry so the observer can resolve the source task.
        RemoteInteractionRegistry.getInstance().register(new RemoteInteraction(
                RemoteInteraction.Type.PERMISSION, "rid", "rid",
                "s1", "pid", "tab1", task.taskId, 0L));

        bus.close(); // rotate to gen 2
        RemoteEventSubscriber subB = bus.subscribe("tab1"); // gen 2

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        observer.onPermissionResolved("s1", "rid", true, false);

        assertNull("Gen-A permission.resolved must NOT reach Gen-B subscriber",
                subB.poll(300));
    }

    // ── 4. Same-generation events still reach the subscriber ────────────

    @Test
    public void sameGenerationEventsStillReachSubscriber() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long gen = bus.currentGeneration(); // 1
        RemoteEventSubscriber sub = bus.subscribe("tab1"); // gen 1
        assertEquals(gen, sub.getGeneration());

        RemoteTask task = createTask("tab1", "s1", gen);
        // assistant.content via coalescer
        task.coalescer.append("hello\n"); // newline → immediate flush → publishForGeneration(1)
        RemoteEvent e1 = sub.poll(500);
        assertNotNull("same-gen assistant.content must reach subscriber", e1);
        assertEquals("assistant.content", e1.getEvent());

        // a direct task event via publishForTask
        JsonObject payload = new JsonObject();
        payload.addProperty("state", "STARTED");
        bus.publishForTask(task, "pid", "tab1", "task.started", task.taskId, "s1", payload);
        RemoteEvent e2 = sub.poll(500);
        assertNotNull("same-gen task.started must reach subscriber", e2);
        assertEquals("task.started", e2.getEvent());
    }

    // ── 5. Old-gen finalize still cleans gate + registry + resolver ─────

    @Test
    public void oldGenerationFinalizeStillCleansGateAndRegistry() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        SessionTurnGate gate = new SessionTurnGate();
        SessionTurnGate.Lease lease = gate.acquire();
        assertNotNull(lease);
        assertTrue(gate.isHeld());

        // Build the task with THIS gate's lease so finalizeTask releasing it is
        // observable on `gate` (the createTask helper allocates its own gate).
        AtomicLong clock = new AtomicLong(1L);
        RemoteTask task = RemoteTask.create(UUID.randomUUID().toString(), "pid", "tab1", "s1",
                "claude", lease, bus, new NoopScheduler(), clock::get, bus.currentGeneration());
        RemoteTaskRegistry.getInstance().register(task);

        // A pending interaction in the shared resolver that finalizeTask must clean.
        CompletableFuture<Integer> f = new CompletableFuture<>();
        InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "s1", "rid", "ch", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f.complete((Integer) v); }
            @Override public void cancel(String reason) { f.complete(3); }
        });
        SharedInteractionResolver.getInstance().register(h);

        bus.close(); // rotate to gen 2 — task.busGeneration (1) is now stale
        assertTrue("stale gen must differ from current", bus.currentGeneration() != task.busGeneration);

        // finalizeTask runs with a stale generation. Publication is suppressed
        // (filtered), but cleanup in the finally block MUST still execute.
        new RemoteChatDispatcher().finalizeTask(task, false);

        assertFalse("gate MUST be released even for stale-gen finalize", gate.isHeld());
        assertNull("task MUST be removed from registry even for stale-gen finalize",
                RemoteTaskRegistry.getInstance().get(task.taskId));
        assertNull("resolver MUST be cleaned even for stale-gen finalize",
                SharedInteractionResolver.getInstance().get("s1", "rid"));
    }

    // ── 6. Explicit race-window test (Latch/Future synchronization) ─────

    /**
     * Reproduces the TOCTOU race window deliberately: a Gen-A task's
     * assistant.content event reaches the point between eligibility and
     * delivery (the coalescer's deferred flush), pauses (the captured flush
     * runnable is held), the generation rotates (Gateway A dispose), a Gen-B
     * subscriber subscribes, then the old publication resumes. The Gen-B
     * subscriber must receive nothing.
     *
     * <p>The {@link LatchScheduler} is the synchronization seam: it captures the
     * scheduled flush runnable without running it (the pause), and the test
     * fires it explicitly (the resume). No sleep.
     */
    @Test
    public void checkPassed_thenGenerationRotates_beforeDelivery_doesNotLeak() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long genA = bus.currentGeneration(); // 1

        LatchScheduler scheduler = new LatchScheduler();
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        RemoteTask task = RemoteTask.create(UUID.randomUUID().toString(), "pid", "tab1", "s1",
                "claude", lease, bus, scheduler, new AtomicLong(1L)::get, genA);

        // Eligibility: the Gen-A task appends content. No sentence terminator →
        // the coalescer schedules (does not immediately flush). The scheduled
        // runnable is captured by the LatchScheduler = the pause between
        // eligibility and delivery.
        task.coalescer.append("stale-pending");
        assertNotNull("a deferred flush must have been captured (pause point)",
                scheduler.captured);

        // Rotate generation (Gateway A dispose) and bring up a Gen-B subscriber.
        bus.close();
        long genB = bus.currentGeneration();
        assertTrue("generation must rotate", genB > genA);
        RemoteEventSubscriber subB = bus.subscribe("tab1"); // gen B
        assertEquals(genB, subB.getGeneration());

        // Resume the old publication: the deferred Gen-A flush fires through
        // publishForGeneration(genA). subB's tag is genB ≠ genA → filtered.
        scheduler.runCaptured();

        assertNull("Gen-B subscriber must NOT receive the resumed Gen-A event",
                subB.poll(300));

        // Control: a Gen-B event on the same tab DOES reach subB, proving subB
        // is live and the filter is generation-specific (not a broken subscriber).
        bus.publishForGeneration(genB, "pid", "tab1", "task.started", "t-b", "s-b", new JsonObject());
        RemoteEvent live = subB.poll(300);
        assertNotNull("Gen-B event must reach Gen-B subscriber (control)", live);
        assertEquals("task.started", live.getEvent());
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static final class NoopScheduler implements RemoteDeltaFlushScheduler {
        @Override public void schedule(Runnable runnable, long delayMs) { /* no-op */ }
        @Override public void cancel() { /* no-op */ }
    }

    /**
     * Captures the scheduled flush runnable without running it, so a test can
     * rotate the bus generation between eligibility (append) and delivery
     * (flush), then fire the flush explicitly. cancel() is a no-op so the
     * captured runnable survives takePending()'s internal cancel.
     */
    private static final class LatchScheduler implements RemoteDeltaFlushScheduler {
        volatile Runnable captured;

        @Override public void schedule(Runnable runnable, long delayMs) {
            this.captured = runnable;
        }

        @Override public void cancel() { /* no-op: keep captured */ }

        void runCaptured() {
            Runnable r = captured;
            if (r != null) {
                r.run();
            }
        }
    }
}
