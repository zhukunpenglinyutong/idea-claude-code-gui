package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.SessionTurnGate;
import org.junit.Before;
import org.junit.Test;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteControlHandler#abortTask} (Phase 2C-C §17,
 * §18, §20). The endpoint is invoked with a null project: for active tasks the
 * tab resolver returns NOT_FOUND (no EDT), so interrupt is skipped but the
 * abort-mark + emit + cancel + 202 still run — exercising the outcome logic.
 */
public class RemoteAbortTest {

    private RemoteControlHandler handler = new RemoteControlHandler();

    @Before
    public void setUp() {
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
        handler = new RemoteControlHandler();
    }

    private RemoteTask newTask(String projectId, String tabId, String sessionId) {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(UUID.randomUUID().toString(), projectId, tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(), new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
    }

    @Test
    public void abortActiveTaskReturnsAborting() {
        RemoteTask task = newTask("pid", "tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);

        RemoteControlHandler.Outcome out = handler.abortTask(null, "pid", "tab1", task.taskId);
        assertEquals(202, out.status);
        assertTrue(out.body.contains("\"aborting\""));
        assertTrue(task.isAbortRequested());
    }

    @Test
    public void secondAbortIsIdempotent() {
        RemoteTask task = newTask("pid", "tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);

        RemoteControlHandler.Outcome first = handler.abortTask(null, "pid", "tab1", task.taskId);
        assertEquals(202, first.status);
        assertTrue(first.body.contains("\"aborting\""));

        RemoteControlHandler.Outcome second = handler.abortTask(null, "pid", "tab1", task.taskId);
        assertEquals(202, second.status);
        assertTrue(second.body.contains("\"abort_already_requested\""));
    }

    @Test
    public void unknownTaskReturnsTaskNotFound() {
        RemoteControlHandler.Outcome out = handler.abortTask(null, "pid", "tab1", "does-not-exist");
        assertEquals(404, out.status);
        assertTrue(out.body.contains("TASK_NOT_FOUND"));
    }

    @Test
    public void wrongProjectReturnsTaskNotFound() {
        // Don't leak that the task exists for another project/tab.
        RemoteTask task = newTask("pid", "tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);
        RemoteControlHandler.Outcome out = handler.abortTask(null, "other-pid", "tab1", task.taskId);
        assertEquals(404, out.status);
        assertTrue(out.body.contains("TASK_NOT_FOUND"));
        assertTrue("must not mark the task when project mismatches", !task.isAbortRequested());
    }

    @Test
    public void wrongTabReturnsTaskNotFound() {
        RemoteTask task = newTask("pid", "tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);
        RemoteControlHandler.Outcome out = handler.abortTask(null, "pid", "other-tab", task.taskId);
        assertEquals(404, out.status);
        assertTrue(out.body.contains("TASK_NOT_FOUND"));
        assertTrue(!task.isAbortRequested());
    }

    @Test
    public void terminalTaskReturnsTaskNotActive() {
        RemoteTask task = newTask("pid", "tab1", "s1");
        RemoteTaskRegistry.getInstance().register(task);
        task.setState(RemoteTaskState.ABORTED);

        RemoteControlHandler.Outcome out = handler.abortTask(null, "pid", "tab1", task.taskId);
        assertEquals(409, out.status);
        assertTrue(out.body.contains("TASK_NOT_ACTIVE"));
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
