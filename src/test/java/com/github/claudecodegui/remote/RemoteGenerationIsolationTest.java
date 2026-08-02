package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2C-C.1c generation verification: bus subscriber lifecycle across
 * gateway dispose/restart, and task-based stale-event isolation.
 */
public class RemoteGenerationIsolationTest {

    @Before
    public void setUp() {
        RemoteEventBus.getInstance().clearForTest();
        RemoteTaskRegistry.getInstance().clearForTest();
    }

    // ── 1. B can subscribe after A close, gen increments ───────────────

    @Test
    public void generationB_canSubscribeAfterGenerationAClosed() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long genA = bus.currentGeneration();
        assertEquals(1, genA);
        bus.close();
        long genAfterClose = bus.currentGeneration();
        assertTrue("gen must increment after close", genAfterClose > genA);

        RemoteEventSubscriber subB = bus.subscribe("tab1");
        assertNotNull(subB);
    }

    // ── 2. After close, new subscriber works normally ──────────────────

    @Test
    public void afterClose_newSubscriberReceivesEvents() throws Exception {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        bus.close(); // gen 2
        RemoteEventSubscriber sub = bus.subscribe("tab1");
        assertNotNull(sub);

        bus.publish("pid", "tab1", "task.started", "task-G2", "sess", new JsonObject());
        RemoteEvent evt = sub.poll(500);
        assertNotNull(evt);
        assertEquals("task.started", evt.getEvent());
    }

    // ── 3. Task carries its own bus generation ─────────────────────────

    @Test
    public void taskCapturesBusGenerationAtCreation() {
        RemoteEventBus bus = RemoteEventBus.getInstance();
        long taskGen = bus.currentGeneration();

        com.github.claudecodegui.session.SessionTurnGate.Lease lease =
                new com.github.claudecodegui.session.SessionTurnGate().acquire();
        RemoteTask task = RemoteTask.create(java.util.UUID.randomUUID().toString(),
                "pid", "tab1", "s1", "claude", lease, bus, new NoopScheduler(), System::currentTimeMillis, taskGen);
        assertEquals(taskGen, task.busGeneration);

        // After close, gen changed.
        bus.close();
        assertTrue("after close gen != task gen", bus.currentGeneration() != task.busGeneration);
    }

    // ── 4. InterruptObserver: cancelAll always executes ────────────────

    @Test
    public void interruptObserverCleansPendingEvenWhenAbortAlreadyMarked() throws Exception {
        RemoteTaskRegistry.getInstance().registerPermissionSource("ps", "tab1");
        RemoteTask task = newTask("tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);
        task.markAbortRequested(); // already marked

        java.util.concurrent.CompletableFuture<Integer> f = new java.util.concurrent.CompletableFuture<>();
        com.github.claudecodegui.permission.InteractionHandle h =
                new com.github.claudecodegui.permission.InteractionHandle(
                        com.github.claudecodegui.permission.InteractionHandle.Type.PERMISSION,
                        "s1", "rid", "ch",
                        new com.github.claudecodegui.permission.InteractionHandle.Completer() {
                            @Override public void complete(Object v) { f.complete((Integer) v); }
                            @Override public void cancel(String r) { f.complete(3); }
                        });
        com.github.claudecodegui.permission.SharedInteractionResolver.getInstance().register(h);

        new RemoteInterruptObserver().handleInterrupt("s1");
        assertEquals("pending must be cancelled even when abort already marked",
                3, f.get(2, java.util.concurrent.TimeUnit.SECONDS).intValue());
    }

    private RemoteTask newTask(String tabId, String sessionId) {
        com.github.claudecodegui.session.SessionTurnGate.Lease lease =
                new com.github.claudecodegui.session.SessionTurnGate().acquire();
        assertNotNull(lease);
        RemoteTask task = RemoteTask.create(java.util.UUID.randomUUID().toString(),
                "pid", tabId, sessionId, "claude", lease, RemoteEventBus.getInstance(),
                new NoopScheduler(), System::currentTimeMillis, RemoteEventBus.getInstance().currentGeneration());
        return task;
    }

    private static final class NoopScheduler implements RemoteDeltaFlushScheduler {
        @Override public void schedule(Runnable r, long d) {}
        @Override public void cancel() {}
    }
}
