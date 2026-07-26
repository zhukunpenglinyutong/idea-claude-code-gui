package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Deterministic concurrency regression tests for {@link MessageDispatchGate}.
 *
 * <p>These pin down the lifecycle contract the gate restores after the lock-free dispatch was
 * reverted: dispatch and teardown serialize, teardown never deadlocks with an in-flight dispatch,
 * and no dispatch side effect can start once teardown has begun. Latches force the exact
 * interleavings the PR review called out - the race where a {@code send_message} dispatch could
 * schedule an async {@code session.send} after {@code dispose()} had already run process cleanup.
 *
 * <p>The gate is pure Java with no platform dependencies, so these tests run without constructing a
 * full {@code ClaudeChatWindow} (which needs a Project, JBCefBrowser, etc.). {@code ClaudeChatWindow}
 * delegates its dispatch/dispose exclusion to this gate, so the contract proven here is the one the
 * JCEF callback path relies on.
 */
public class MessageDispatchGateTest {

    /**
     * Teardown must not deadlock when a dispatch is in flight: {@code beginTeardown} blocks on the
     * gate monitor until the in-flight dispatch releases it, then proceeds. This is the
     * EDT&lt;-&gt;JCEF deadlock that the lock-free version was written to avoid - proven here not to
     * regress while still serializing dispatch against teardown.
     */
    @Test(timeout = 5000)
    public void teardownDoesNotDeadlockWithInFlightDispatch() throws Exception {
        MessageDispatchGate gate = new MessageDispatchGate();
        CountDownLatch dispatchEntered = new CountDownLatch(1);
        CountDownLatch releaseDispatch = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> dispatchFuture = executor.submit(() ->
                gate.runInDispatch(() -> {
                    dispatchEntered.countDown();
                    awaitUninterrupted(releaseDispatch);
                }));
            assertTrue("dispatch should enter the gate",
                    dispatchEntered.await(2, TimeUnit.SECONDS));

            Future<Boolean> teardownFuture = executor.submit(gate::beginTeardown);
            // Teardown is blocked behind the in-flight dispatch which holds the gate monitor.
            Thread.sleep(150);
            assertFalse("teardown must block while a dispatch is in flight",
                    teardownFuture.isDone());

            releaseDispatch.countDown();
            dispatchFuture.get(2, TimeUnit.SECONDS);
            assertTrue("teardown should complete once dispatch releases the gate",
                    teardownFuture.get(2, TimeUnit.SECONDS));
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    /**
     * Once teardown has begun, {@code runInDispatch} must refuse and the task must not run - no
     * handler side effect (e.g. scheduling an async {@code session.send}) can start after disposal.
     */
    @Test
    public void noDispatchSideEffectAfterTeardownBegun() {
        MessageDispatchGate gate = new MessageDispatchGate();
        AtomicBoolean ran = new AtomicBoolean(false);

        assertTrue("first teardown should flip the gate", gate.beginTeardown());
        assertFalse("a dispatch after teardown must be rejected",
                gate.runInDispatch(() -> ran.set(true)));
        assertFalse("the rejected task must not have executed", ran.get());
    }

    /**
     * {@code beginTeardown} is idempotent: a second call returns false without blocking, so a
     * repeated {@code dispose()} is a no-op.
     */
    @Test
    public void beginTeardownIsIdempotent() {
        MessageDispatchGate gate = new MessageDispatchGate();
        assertTrue(gate.beginTeardown());
        assertFalse(gate.beginTeardown());
        assertTrue(gate.isDisposed());
    }

    /**
     * The intended behavior for an already-in-flight dispatch is explicit: {@code beginTeardown}
     * does not return until the in-flight dispatch has finished, so teardown never overlaps a
     * handler. The dispatch body's completion flag must be visible by the time teardown returns.
     */
    @Test(timeout = 5000)
    public void inFlightDispatchCompletesBeforeTeardownReturns() throws Exception {
        MessageDispatchGate gate = new MessageDispatchGate();
        CountDownLatch dispatchEntered = new CountDownLatch(1);
        CountDownLatch releaseDispatch = new CountDownLatch(1);
        AtomicBoolean dispatchBodyFinished = new AtomicBoolean(false);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            executor.submit(() ->
                gate.runInDispatch(() -> {
                    dispatchEntered.countDown();
                    awaitUninterrupted(releaseDispatch);
                    dispatchBodyFinished.set(true);
                }));
            assertTrue(dispatchEntered.await(2, TimeUnit.SECONDS));

            Future<Boolean> teardownFuture = executor.submit(gate::beginTeardown);
            // Ensure teardown has started and is blocked on the gate monitor held by dispatch,
            // so the assertions below exercise "beginTeardown waits for in-flight dispatch"
            // rather than "dispatch finished before teardown started".
            Thread.sleep(150);
            assertFalse("teardown must block while dispatch holds the gate",
                    teardownFuture.isDone());
            releaseDispatch.countDown();
            assertTrue(teardownFuture.get(2, TimeUnit.SECONDS));
            assertTrue("dispatch body must finish before beginTeardown returns",
                    dispatchBodyFinished.get());
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    /**
     * A live gate runs the dispatch task and reports it ran.
     */
    @Test
    public void liveGateRunsDispatch() {
        MessageDispatchGate gate = new MessageDispatchGate();
        AtomicBoolean ran = new AtomicBoolean(false);
        assertTrue(gate.runInDispatch(() -> ran.set(true)));
        assertTrue(ran.get());
        assertFalse(gate.isDisposed());
    }

    private static void awaitUninterrupted(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
