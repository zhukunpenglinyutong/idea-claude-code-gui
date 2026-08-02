package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.SessionTurnGate;
import com.github.claudecodegui.session.SessionTurnGateRegistry;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2C-C.1 generation-ownership closure: deterministic proof that (a) the
 * subscribe/close lifecycle is atomic — no open subscriber of a disposed generation
 * survives {@code close()} — and (b) gateway generation is an ownership token carried
 * by handlers, not a late {@code bus.currentGeneration()} snapshot, so a request/SSE
 * handler accepted by gateway G can never be re-attributed to a newer generation.
 *
 * <p>Uses Latch/CountDownLatch synchronization — no {@code sleep}.
 */
public class RemoteGenerationOwnershipTest {

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

    // ── 1. Late Gen-A subscriber cannot remain registered after close ─────

    @Test
    public void lateGenASubscriber_afterClose_cannotRemainRegistered() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long genA = bus.currentGeneration(); // 1
        bus.close(); // rotate to 2

        // A late Gen-A handler subscribing with its (now-stale) token is rejected.
        RemoteEventSubscriber sub = bus.subscribe("tab1", genA);
        assertNull("late Gen-A subscribe must be rejected after close", sub);
        assertEquals("no subscriber may remain registered for the disposed generation",
                0, bus.subscriberCount("tab1"));

        // A Gen-B handler subscribing with the current token still works and is tagged B.
        RemoteEventSubscriber subB = bus.subscribe("tab1", bus.currentGeneration());
        assertNotNull(subB);
        assertEquals(bus.currentGeneration(), subB.getGeneration());
    }

    // ── 2. subscribe() racing close(): no old open subscriber survives ────

    /**
     * Concurrently races {@code subscribe(tabId, genA)} against {@code close()} under a
     * shared start latch (true simultaneity, no sleep). Because both critical sections
     * hold the bus lifecycle lock, exactly one ordering occurs each iteration; in every
     * case the invariant holds: after both complete, no OPEN Gen-A subscriber remains
     * registered. Repeated 100× to exercise both interleavings.
     */
    @Test
    public void subscribeRacesWithClose_noOldOpenSubscriberSurvives() throws Exception {
        for (int i = 0; i < 100; i++) {
            RemoteEventBus bus = RemoteEventBus.getInstance();
            bus.clearForTest(); // gen 1
            long genA = bus.currentGeneration();
            final String tabId = "tab1";

            CountDownLatch start = new CountDownLatch(1);
            CountDownLatch done = new CountDownLatch(2);
            AtomicReference<RemoteEventSubscriber> subRef = new AtomicReference<>();

            Thread subThread = new Thread(() -> {
                try {
                    start.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                try {
                    subRef.set(bus.subscribe(tabId, genA));
                } finally {
                    done.countDown();
                }
            }, "ownership-test-subscribe");
            Thread closeThread = new Thread(() -> {
                try {
                    start.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                try {
                    bus.close();
                } finally {
                    done.countDown();
                }
            }, "ownership-test-close");

            subThread.start();
            closeThread.start();
            start.countDown(); // release both simultaneously
            assertTrue("race must complete", done.await(5, TimeUnit.SECONDS));
            subThread.join(1000);
            closeThread.join(1000);

            // Invariant: after close has run, no OPEN Gen-A subscriber remains.
            RemoteEventSubscriber sub = subRef.get();
            if (sub != null) {
                // subscribe won the race (ran before close): close must have closed it.
                assertTrue("Gen-A subscriber that won the race must be closed by close",
                        sub.isClosed());
            }
            assertEquals("no subscriber may remain registered for the disposed generation",
                    0, bus.subscriberCount(tabId));
            assertTrue("close must have rotated generation",
                    bus.currentGeneration() > genA);
        }
    }

    // ── 3. Gen-A request dispatched after rotation never becomes a Gen-B task

    @Test
    public void genARequest_dispatchAfterRotation_neverBecomesGenBTask() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long genALong = bus.currentGeneration(); // 1
        RemoteGatewayGeneration genA = new RemoteGatewayGeneration(genALong);
        bus.close(); // rotate to 2 — Gen-A gateway is disposed (bus rotated past token)

        // A Gen-A dispatch arriving late is REJECTED (stale), before any tab/gate/turn.
        RemoteChatDispatcher dispatcher = new RemoteChatDispatcher();
        RemoteChatResult result = dispatcher.dispatch(null, "tab1", "hi", genA);
        assertEquals("stale Gen-A dispatch must be rejected, never become a Gen-B task",
                RemoteChatResult.Status.UNAVAILABLE, result.status);
        assertNull("no task may be registered for a rejected stale dispatch",
                RemoteTaskRegistry.getInstance().getActiveByTab("tab1"));

        // And a Gen-A-tagged task (admitted before rotation) keeps its Gen-A ownership,
        // never silently becoming Gen-B, even though the bus has moved on.
        RemoteTask task = createTask("tab1", "s1", genALong);
        assertEquals("task must stay owned by its gateway generation G1",
                genALong, task.busGeneration);
        assertFalse("task must NOT adopt the new current generation",
                task.busGeneration == bus.currentGeneration());
    }

    // ── 4. Gen-A SSE handler subscribing after rotation never becomes Gen-B

    @Test
    public void genASseHandler_subscribesAfterRotation_neverBecomesGenBSubscriber() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long genA = bus.currentGeneration(); // 1
        bus.close(); // rotate to 2

        // A late Gen-A SSE handler subscribing with its stale token is rejected (null),
        // NOT silently re-owned as a Gen-B subscriber.
        RemoteEventSubscriber sub = bus.subscribe("tab1", genA);
        assertNull("Gen-A SSE handler must not become a subscriber after rotation", sub);
        assertEquals(0, bus.subscriberCount("tab1"));

        // A Gen-B SSE handler subscribing with the current token is a Gen-B subscriber.
        RemoteEventSubscriber subB = bus.subscribe("tab1", bus.currentGeneration());
        assertNotNull(subB);
        assertEquals(bus.currentGeneration(), subB.getGeneration());
    }

    // ── 5. Gen-B request + subscriber work normally (no over-rejection) ────

    @Test
    public void genBRequestAndSubscriber_workNormally() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long genB = bus.currentGeneration(); // 1
        RemoteGatewayGeneration gen = new RemoteGatewayGeneration(genB);

        // Gen-B subscriber receives Gen-B events.
        RemoteEventSubscriber sub = bus.subscribe("tab1", genB);
        assertNotNull(sub);
        assertEquals(genB, sub.getGeneration());
        bus.publishForGeneration(genB, "pid", "tab1", "task.started", "t1", "s1", new JsonObject());
        RemoteEvent evt = sub.poll(500);
        assertNotNull("Gen-B subscriber must receive Gen-B events", evt);
        assertEquals("task.started", evt.getEvent());

        // Gen-B dispatch is admitted (NOT stale-rejected). With a null project it falls
        // through to NOT_FOUND (resolve(null) is a safe no-op) — proving the admission
        // check passed and did not return UNAVAILABLE.
        RemoteChatDispatcher dispatcher = new RemoteChatDispatcher();
        RemoteChatResult result = dispatcher.dispatch(null, "tab1", "hi", gen);
        assertEquals("Gen-B dispatch must be admitted (not stale-rejected)",
                RemoteChatResult.Status.NOT_FOUND, result.status);
    }

    // ── 6. Same-generation publish still works ────────────────────────────

    @Test
    public void sameGenerationPublishStillWorks() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long gen = bus.currentGeneration();
        RemoteEventSubscriber sub = bus.subscribe("tab1", gen);
        assertNotNull(sub);
        assertEquals(gen, sub.getGeneration());

        bus.publishForGeneration(gen, "pid", "tab1", "task.completed", "t1", "s1", new JsonObject());
        RemoteEvent evt = sub.poll(500);
        assertNotNull("same-generation event must reach subscriber", evt);
        assertEquals("task.completed", evt.getEvent());
    }

    // ── 7. Old-generation task cleanup still works (ownership preserved) ──

    @Test
    public void oldGenerationTaskCleanupStillWorks() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long genA = bus.currentGeneration(); // 1

        SessionTurnGate gate = new SessionTurnGate();
        SessionTurnGate.Lease lease = gate.acquire();
        assertNotNull(lease);
        assertTrue(gate.isHeld());

        RemoteTask task = RemoteTask.create(UUID.randomUUID().toString(), "pid", "tab1", "s1",
                "claude", lease, bus, new NoopScheduler(), new AtomicLong(1L)::get, genA);
        RemoteTaskRegistry.getInstance().register(task);
        assertEquals("task is owned by Gen-A at admission", genA, task.busGeneration);

        // A pending interaction in the shared resolver that finalizeTask must clean.
        java.util.concurrent.CompletableFuture<Integer> f = new java.util.concurrent.CompletableFuture<>();
        InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "s1", "rid", "ch", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f.complete((Integer) v); }
            @Override public void cancel(String reason) { f.complete(3); }
        });
        SharedInteractionResolver.getInstance().register(h);

        bus.close(); // rotate to 2 — task.busGeneration (1) is now stale
        assertTrue("stale gen must differ from current", bus.currentGeneration() != task.busGeneration);
        // Ownership is immutable: the task did NOT follow the rotation.
        assertEquals("task must remain owned by Gen-A across the rotation", genA, task.busGeneration);

        // finalizeTask on the stale-gen task: transport suppressed, cleanup unconditional.
        new RemoteChatDispatcher().finalizeTask(task, false);

        assertFalse("gate MUST be released even for stale-gen finalize", gate.isHeld());
        assertNull("task MUST be removed from registry",
                RemoteTaskRegistry.getInstance().get(task.taskId));
        assertNull("resolver MUST be cleaned",
                SharedInteractionResolver.getInstance().get("s1", "rid"));
        assertEquals("ownership tag unchanged through terminal", genA, task.busGeneration);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static final class NoopScheduler implements RemoteDeltaFlushScheduler {
        @Override public void schedule(Runnable runnable, long delayMs) { /* no-op */ }
        @Override public void cancel() { /* no-op */ }
    }
}
