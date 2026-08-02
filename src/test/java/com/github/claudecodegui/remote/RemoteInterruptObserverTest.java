package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.SessionTurnGate;
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
 * Pure-logic tests for {@link RemoteInterruptObserver} + the shared abort mark
 * on {@link RemoteTask} (Phase 2C-C §21, §22, §35).
 */
public class RemoteInterruptObserverTest {

    @Before
    public void setUp() {
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
        SharedInteractionResolver.getInstance().clearForTest();
    }

    private RemoteTask newTask(String tabId, String sessionId) {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(UUID.randomUUID().toString(), "pid", tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(), new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
    }

    @Test
    public void desktopInterruptMarksActiveRemoteTaskAndEmitsOnce() throws Exception {
        RemoteTask task = newTask("tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe("tab1");

        RemoteInterruptObserver observer = new RemoteInterruptObserver();
        observer.handleInterrupt("s1");

        assertTrue("task must be marked abort-requested", task.isAbortRequested());
        RemoteEvent evt = sub.poll(500);
        assertNotNull(evt);
        assertEquals("task.abort_requested", evt.getEvent());
        assertTrue("event must carry the task id", evt.toEnvelopeJson().contains(task.taskId));

        // Second interrupt does not emit again (first-wins).
        observer.handleInterrupt("s1");
        assertNull("no second abort_requested event", sub.poll(200));
    }

    @Test
    public void interruptWithNoRemoteTaskIsNoOp() throws Exception {
        // Desktop-only turn: no active Remote task → observer must not touch anything.
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe("tab1");
        new RemoteInterruptObserver().handleInterrupt("s-desktop-only");
        assertNull(sub.poll(200));
    }

    @Test
    public void desktopInterruptDoesNotAffectNoRemoteDesktopTurn() {
        // No task registered → nothing marked, no exception.
        new RemoteInterruptObserver().handleInterrupt("s-none");
        // No assertions to break on; the contract is "no side effects, no throw".
    }

    @Test
    public void interruptCancelsPendingInteractionsForSession() throws Exception {
        RemoteTask task = newTask("tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);

        // Register a pending permission interaction for this session.
        CompletableFuture<Integer> future = new CompletableFuture<>();
        InteractionHandle handle = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "s1", "r1", "c1", new InteractionHandle.Completer() {
                    @Override
                    public void complete(Object value) {
                        future.complete((Integer) value);
                    }
                    @Override
                    public void cancel(String reason) {
                        future.complete(PermissionService.PermissionResponse.DENY.getValue());
                    }
                });
        SharedInteractionResolver.getInstance().register(handle);

        new RemoteInterruptObserver().handleInterrupt("s1");

        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                future.get(1, TimeUnit.SECONDS).intValue());
        assertNull("pending interaction must be removed from the resolver",
                SharedInteractionResolver.getInstance().get("s1", "r1"));
    }

    @Test
    public void abortRequestedClassifiesAsAborted() {
        // The terminal classifier must map abortRequested → ABORTED even if a
        // failure was also observed (abort takes precedence).
        RemoteTask task = newTask("tab1", "s1");
        task.markAbortRequested();
        task.markFailureObserved();
        assertEquals(RemoteTaskState.ABORTED,
                RemoteTaskOutcomeClassifier.classify(task.isAbortRequested(), task.isFailureObserved(), false));
    }

    @Test
    public void markAbortRequestedFirstTimeIsCas() {
        RemoteTask task = newTask("tab1", "s1");
        assertTrue(task.markAbortRequestedFirstTime());
        assertFalse(task.markAbortRequestedFirstTime());
        assertFalse(task.markAbortRequestedFirstTime());
        assertTrue(task.isAbortRequested());
    }

    private static final class NoopScheduler implements RemoteDeltaFlushScheduler {
        @Override
        public void schedule(Runnable runnable, long delayMs) {
            // no-op
        }

        @Override
        public void cancel() {
            // no-op
        }
    }
}
