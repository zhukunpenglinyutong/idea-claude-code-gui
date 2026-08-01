package com.github.claudecodegui.session;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link SessionTurnGate} / {@link SessionTurnGateRegistry}.
 * Uses plain {@link Object} identity keys (no IntelliJ platform).
 */
public class SessionTurnGateTest {

    @Before
    public void setUp() {
        SessionTurnGateRegistry.getInstance().clearForTest();
    }

    @Test
    public void firstAcquireSucceeds() {
        Object session = new Object();
        SessionTurnGate.Lease lease = SessionTurnGateRegistry.getInstance().acquire(session);
        assertNotNull(lease);
        assertTrue(SessionTurnGateRegistry.getInstance().isHeld(session));
    }

    @Test
    public void secondAcquireOnSameSessionFails() {
        Object session = new Object();
        assertNotNull(SessionTurnGateRegistry.getInstance().acquire(session));
        assertNull(SessionTurnGateRegistry.getInstance().acquire(session));
        assertTrue(SessionTurnGateRegistry.getInstance().isHeld(session));
    }

    @Test
    public void releaseAllowsReacquire() {
        Object session = new Object();
        SessionTurnGate.Lease lease = SessionTurnGateRegistry.getInstance().acquire(session);
        assertNotNull(lease);
        assertTrue(lease.release());
        assertFalse(SessionTurnGateRegistry.getInstance().isHeld(session));
        assertNotNull(SessionTurnGateRegistry.getInstance().acquire(session));
    }

    @Test
    public void staleLeaseCannotReleaseNewerLease() {
        Object session = new Object();
        SessionTurnGate.Lease first = SessionTurnGateRegistry.getInstance().acquire(session);
        assertNotNull(first);
        assertTrue(first.release());

        SessionTurnGate.Lease second = SessionTurnGateRegistry.getInstance().acquire(session);
        assertNotNull(second);
        // Stale release of the old lease must NOT free the gate held by the new lease.
        assertFalse(first.release());
        assertTrue(SessionTurnGateRegistry.getInstance().isHeld(session));
        assertTrue(second.release());
    }

    @Test
    public void doubleReleaseIsNoOp() {
        Object session = new Object();
        SessionTurnGate.Lease lease = SessionTurnGateRegistry.getInstance().acquire(session);
        assertTrue(lease.release());
        assertFalse(lease.release());
    }

    @Test
    public void differentSessionsIndependent() {
        Object a = new Object();
        Object b = new Object();
        assertNotNull(SessionTurnGateRegistry.getInstance().acquire(a));
        assertNotNull(SessionTurnGateRegistry.getInstance().acquire(b));
        assertTrue(SessionTurnGateRegistry.getInstance().isHeld(a));
        assertTrue(SessionTurnGateRegistry.getInstance().isHeld(b));
    }

    @Test
    public void nullKeyReturnsNull() {
        assertNull(SessionTurnGateRegistry.getInstance().acquire(null));
        assertFalse(SessionTurnGateRegistry.getInstance().isHeld(null));
    }

    @Test
    public void concurrentAcquireOnlyOneWins() throws InterruptedException {
        Object session = new Object();
        int threads = 16;
        int perThread = 50;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger wins = new AtomicInteger();
        List<SessionTurnGate.Lease> held = new ArrayList<>();
        Object lock = new Object();

        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                try {
                    start.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                for (int j = 0; j < perThread; j++) {
                    SessionTurnGate.Lease lease = SessionTurnGateRegistry.getInstance().acquire(session);
                    if (lease != null) {
                        wins.incrementAndGet();
                        synchronized (lock) {
                            held.add(lease);
                        }
                    }
                }
            });
        }
        start.countDown();
        pool.shutdown();
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS));
        assertEquals(1, wins.get());
        assertEquals(1, held.size());
        // Clean up.
        held.get(0).release();
    }
}
