package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.SessionTurnGate;
import org.junit.Before;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/**
 * Tests the permission-session → tabId source mapping lifecycle across
 * multiple Remote tasks on the same tab (Phase 2C-C.0 BUG A fix).
 *
 * <p>These tests verify that {@code RemoteInteractionObserverImpl.findRemoteTask}
 * uses the stable tabId mapping (not sessionId equality) to locate the active
 * RemoteTask, so task 2, task 3, ... are all found correctly even though
 * {@code SessionState.sessionId} changes to the daemon's value after the first
 * task.
 */
public class RemotePermissionSourceMappingTest {

    private static final String PERMISSION_SESSION_ID = "window-permission-key-abc123";
    private static final String DAEMON_SESSION_ID = "a91ed037-0721-4525-b8ce-4075ffb31fad";
    private static final String TAB_ID = "test-tab-uuid";

    @Before
    public void setUp() {
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
    }

    private RemoteTask newTask(String tabId, String sessionId) {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(java.util.UUID.randomUUID().toString(), "pid",
                tabId, sessionId, "claude", lease, RemoteEventBus.getInstance(),
                new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
    }

    // ── mapping lifecycle across tasks ─────────────────────────────────

    @Test
    public void task1FoundViaSourceMapping() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(PERMISSION_SESSION_ID, TAB_ID);
        RemoteTask task1 = newTask(TAB_ID, PERMISSION_SESSION_ID); // initially P
        RemoteTaskRegistry.getInstance().register(task1);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        RemoteTask found = observer.findRemoteTask(PERMISSION_SESSION_ID);
        assertNotNull("task1 must be found via permissionSessionId → tabId → activeByTab",
                found);
        assertEquals(task1.taskId, found.taskId);
    }

    @Test
    public void task1StillFoundAfterDaemonSessionIdUpdate() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(PERMISSION_SESSION_ID, TAB_ID);
        RemoteTask task1 = newTask(TAB_ID, PERMISSION_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task1);

        // Daemon later sends its own sessionId, overwriting state.
        RemoteTaskRegistry.getInstance().indexSession(task1.taskId, DAEMON_SESSION_ID);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        RemoteTask found = observer.findRemoteTask(PERMISSION_SESSION_ID);
        assertNotNull("task1 still found via source mapping after daemon session change",
                found);
        assertEquals(task1.taskId, found.taskId);
        assertEquals(DAEMON_SESSION_ID, task1.getSessionId());
    }

    @Test
    public void interactionSessionResolutionReturnsActiveDaemonSessionId() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(PERMISSION_SESSION_ID, TAB_ID);
        RemoteTask task = newTask(TAB_ID, PERMISSION_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task);
        RemoteTaskRegistry.getInstance().indexSession(task.taskId, DAEMON_SESSION_ID);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        assertEquals(DAEMON_SESSION_ID,
                observer.resolveInteractionSessionId(null, PERMISSION_SESSION_ID));
    }

    @Test
    public void interactionSessionResolutionReturnsNullWithoutRemoteTask() {
        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        assertNull(observer.resolveInteractionSessionId(null, PERMISSION_SESSION_ID));
    }

    @Test
    public void task2FoundAfterTask1Terminal() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(PERMISSION_SESSION_ID, TAB_ID);

        // --- task 1 ---
        RemoteTask task1 = newTask(TAB_ID, PERMISSION_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task1);
        RemoteTaskRegistry.getInstance().indexSession(task1.taskId, DAEMON_SESSION_ID);
        // Terminal cleanup.
        RemoteTaskRegistry.getInstance().remove(task1);

        // --- task 2: SessionState still has D, but permission source → tabId = TAB_ID ---
        RemoteTask task2 = newTask(TAB_ID, DAEMON_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task2);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        RemoteTask found = observer.findRemoteTask(PERMISSION_SESSION_ID);
        assertNotNull("task2 must be found via source mapping → tab → activeByTab", found);
        assertEquals("task2 should be found, not stale task1", task2.taskId, found.taskId);
    }

    @Test
    public void task3AlsoFoundAfterTask2Terminal() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(PERMISSION_SESSION_ID, TAB_ID);

        // task1
        RemoteTask t1 = newTask(TAB_ID, PERMISSION_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(t1);
        RemoteTaskRegistry.getInstance().remove(t1);

        // task2
        RemoteTask t2 = newTask(TAB_ID, DAEMON_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(t2);
        RemoteTaskRegistry.getInstance().remove(t2);

        // task3
        RemoteTask t3 = newTask(TAB_ID, DAEMON_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(t3);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        assertEquals(t3.taskId, observer.findRemoteTask(PERMISSION_SESSION_ID).taskId);
    }

    @Test
    public void sourceMappingIsTabScoped() {
        // Two tabs with different permission sessionIds and tabIds.
        RemoteTaskRegistry.getInstance().registerPermissionSource("p-tab1", "tabA");
        RemoteTaskRegistry.getInstance().registerPermissionSource("p-tab2", "tabB");

        RemoteTask taskA = newTask("tabA", "p-tab1");
        RemoteTaskRegistry.getInstance().register(taskA);
        RemoteTask taskB = newTask("tabB", "p-tab2");
        RemoteTaskRegistry.getInstance().register(taskB);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        assertEquals(taskA.taskId, observer.findRemoteTask("p-tab1").taskId);
        assertEquals(taskB.taskId, observer.findRemoteTask("p-tab2").taskId);
    }

    @Test
    public void unregisterRemovesMapping() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(PERMISSION_SESSION_ID, TAB_ID);
        RemoteTask task = newTask(TAB_ID, PERMISSION_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        assertNotNull(observer.findRemoteTask(PERMISSION_SESSION_ID));

        RemoteTaskRegistry.getInstance().unregisterPermissionSource(PERMISSION_SESSION_ID);
        assertNull("after unregister, source mapping gone",
                observer.findRemoteTask(PERMISSION_SESSION_ID));
    }

    @Test
    public void noMappingReturnsNull() {
        RemoteTask task = newTask(TAB_ID, PERMISSION_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task);

        // No source mapping registered — observer cannot find the task.
        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        assertNull(observer.findRemoteTask(PERMISSION_SESSION_ID));
    }

    @Test
    public void mappingExistsButNoActiveTaskReturnsNull() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(PERMISSION_SESSION_ID, TAB_ID);
        // No task registered on this tab.

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        assertNull(observer.findRemoteTask(PERMISSION_SESSION_ID));
    }

    // ── the old sessionId-based lookup was UNRELIABLE (BUG A) ──────────

    @Test
    public void sessionIdLookupFailsWhenDaemonChangesSessionId() {
        // Simulate the old behavior: task registered under P, then daemon changes
        // state to D, and a second task uses D. The old sessionId index (P→task1)
        // is stale after task1 is removed.
        RemoteTask task1 = newTask(TAB_ID, PERMISSION_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task1);
        RemoteTaskRegistry.getInstance().indexSession(task1.taskId, DAEMON_SESSION_ID);
        RemoteTaskRegistry.getInstance().remove(task1);

        // task2 registers under D (from state).
        RemoteTask task2 = newTask(TAB_ID, DAEMON_SESSION_ID);
        RemoteTaskRegistry.getInstance().register(task2);

        // sessionId P only maps to dead task1 entry → byTaskId returns null.
        assertNull("BUG A: sessionId P can no longer find task2",
                RemoteTaskRegistry.getInstance().getActiveBySession(PERMISSION_SESSION_ID));
        // sessionId D correctly finds task2.
        assertEquals(task2.taskId,
                RemoteTaskRegistry.getInstance().getActiveBySession(DAEMON_SESSION_ID).taskId);
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
