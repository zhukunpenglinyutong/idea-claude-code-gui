package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.SessionTurnGate;
import org.junit.Before;
import org.junit.Test;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for the refactored {@link RemoteTaskRegistry} (metadata
 * registry — the lock is now {@link com.github.claudecodegui.session.SessionTurnGate}).
 */
public class RemoteTaskRegistryTest {

    @Before
    public void setUp() {
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
    }

    private RemoteTask newTask(String tabId, String sessionId) {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(UUID.randomUUID().toString(), "pid", tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(),
                new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
    }

    @Test
    public void registerAndGetByTab() {
        RemoteTask task = newTask("tab1", "s1");
        assertTrue(RemoteTaskRegistry.getInstance().register(task));
        assertEquals(task, RemoteTaskRegistry.getInstance().get(task.taskId));
        assertEquals(task, RemoteTaskRegistry.getInstance().getActiveByTab("tab1"));
        assertEquals(task, RemoteTaskRegistry.getInstance().getActiveBySession("s1"));
        assertTrue(RemoteTaskRegistry.getInstance().hasActiveTab("tab1"));
    }

    @Test
    public void registerSecondTaskForSameTabFails() {
        RemoteTask first = newTask("tab1", "s1");
        assertTrue(RemoteTaskRegistry.getInstance().register(first));
        RemoteTask second = newTask("tab1", "s2");
        assertFalse(RemoteTaskRegistry.getInstance().register(second));
        // First task is still active.
        assertEquals(first, RemoteTaskRegistry.getInstance().getActiveByTab("tab1"));
    }

    @Test
    public void nullSessionIdIndexedLater() {
        RemoteTask task = newTask("tab1", null);
        assertTrue(RemoteTaskRegistry.getInstance().register(task));
        assertNull(RemoteTaskRegistry.getInstance().getActiveBySession(null));
        // sessionId arrives during the turn
        RemoteTaskRegistry.getInstance().indexSession(task.taskId, "s-late");
        assertEquals(task, RemoteTaskRegistry.getInstance().getActiveBySession("s-late"));
        assertEquals("s-late", task.getSessionId());
    }

    @Test
    public void differentSessionIdsDoNotMatch() {
        // Simulate BUG A: PermissionService uses bridgeSessionId, but the
        // RemoteTask was created with null sessionId (state.sessionId was
        // not yet set) and later indexed with the daemon's sessionId.
        RemoteTask task = newTask("tab1", null);
        RemoteTaskRegistry.getInstance().register(task);
        String bridgeSessionId = "bridge-random-uuid";
        String daemonSessionId = "a91ed037-0721-4525-b8ce-4075ffb31fad";

        // At registration time, the task is NOT indexed by sessionId (null).
        assertNull(RemoteTaskRegistry.getInstance().getActiveBySession(bridgeSessionId));
        assertNull(RemoteTaskRegistry.getInstance().getActiveBySession(daemonSessionId));

        // Later, onSessionIdReceived indexes with the daemon's sessionId.
        RemoteTaskRegistry.getInstance().indexSession(task.taskId, daemonSessionId);

        // Now findable by daemon's sessionId, but NOT by bridge's.
        assertNotNull(RemoteTaskRegistry.getInstance().getActiveBySession(daemonSessionId));
        assertNull("BUG A: bridge sessionId still misses the task",
                RemoteTaskRegistry.getInstance().getActiveBySession(bridgeSessionId));
        assertEquals(daemonSessionId, task.getSessionId());
    }

    @Test
    public void taskWithMatchingSessionIdIsFound() {
        // The fix: state.sessionId is synced to bridge sessionId at
        // setupPermissionService time, so the task is indexed under the
        // same id the observer uses.
        String sessionId = "a91ed037-0721-4525-b8ce-4075ffb31fad";
        RemoteTask task = newTask("tab1", sessionId);
        RemoteTaskRegistry.getInstance().register(task);
        assertNotNull(RemoteTaskRegistry.getInstance().getActiveBySession(sessionId));
        assertEquals(sessionId, task.getSessionId());
    }

    @Test
    public void removeClearsAllIndexes() {
        RemoteTask task = newTask("tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);
        RemoteTaskRegistry.getInstance().remove(task);
        assertNull(RemoteTaskRegistry.getInstance().get(task.taskId));
        assertNull(RemoteTaskRegistry.getInstance().getActiveByTab("tab1"));
        assertNull(RemoteTaskRegistry.getInstance().getActiveBySession("s1"));
        assertFalse(RemoteTaskRegistry.getInstance().hasActiveTab("tab1"));
    }

    @Test
    public void differentTabsIndependent() {
        RemoteTask a = newTask("tabA", "sA");
        RemoteTask b = newTask("tabB", "sB");
        RemoteTaskRegistry.getInstance().register(a);
        RemoteTaskRegistry.getInstance().register(b);
        assertEquals(a, RemoteTaskRegistry.getInstance().getActiveByTab("tabA"));
        assertEquals(b, RemoteTaskRegistry.getInstance().getActiveByTab("tabB"));
        assertEquals(2, RemoteTaskRegistry.getInstance().activeCount());
    }

    @Test
    public void newTaskIdIsUuid() {
        String id = RemoteTaskRegistry.getInstance().newTaskId();
        try {
            UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            throw new AssertionError("newTaskId not a UUID: " + id);
        }
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
