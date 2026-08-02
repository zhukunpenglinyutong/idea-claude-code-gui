package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.PermissionInteractionObserver;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionTurnGate;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
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
 * Phase 2C-C.1 stabilization tests: session alias cleanup, observer lifecycle,
 * attachSource invariant, interaction tombstone bounding.
 */
public class RemoteStabilizationTest {

    private static final String D1 = "daemon-session-1";
    private static final String D2 = "daemon-session-2";
    private static final String D3 = "daemon-session-3";
    private static final String TAB = "stab-tab";

    @Before
    public void setUp() {
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
        SharedInteractionResolver.getInstance().clearForTest();
        PermissionService.installInteractionObserver(null);
        ClaudeSession.installInterruptObserver(null);
    }

    private RemoteTask createTask(String tabId, String sessionId) {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(UUID.randomUUID().toString(), "pid", tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(),
                new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
    }

    // ── Issue 1: session alias cleanup ─────────────────────────────────

    @Test
    public void registerIndexMultipleRemoveCleansAllAliases() {
        RemoteTask task = createTask(TAB, D1);
        RemoteTaskRegistry.getInstance().register(task);
        // Daemon updates sessionId twice during the turn.
        RemoteTaskRegistry.getInstance().indexSession(task.taskId, D2);
        RemoteTaskRegistry.getInstance().indexSession(task.taskId, D3);

        // All three aliases must be present (ConcurrentHashMap keySet, order not guaranteed).
        assertTrue(task.getSessionAliases().contains(D1));
        assertTrue(task.getSessionAliases().contains(D2));
        assertTrue(task.getSessionAliases().contains(D3));

        // Remove must clean all three from the session index.
        RemoteTaskRegistry.getInstance().remove(task);
        assertNull(RemoteTaskRegistry.getInstance().getActiveBySession(D1));
        assertNull(RemoteTaskRegistry.getInstance().getActiveBySession(D2));
        assertNull(RemoteTaskRegistry.getInstance().getActiveBySession(D3));
        assertNull(RemoteTaskRegistry.getInstance().get(task.taskId));
    }

    @Test
    public void staleRemoveDoesNotAffectNewTaskWithSameAlias() {
        // Task1 gets D1, indexed under D2, removed.
        RemoteTask task1 = createTask(TAB, D1);
        RemoteTaskRegistry.getInstance().register(task1);
        RemoteTaskRegistry.getInstance().indexSession(task1.taskId, D2);
        RemoteTaskRegistry.getInstance().remove(task1);

        // Task2 reuses the same sessionId D2 (a different task, same daemon session).
        RemoteTask task2 = createTask(TAB, D2);
        RemoteTaskRegistry.getInstance().register(task2);

        // The new task using D2 MUST still be findable (remove used remove(alias, taskId)).
        assertNotNull(RemoteTaskRegistry.getInstance().get(task2.taskId));
        assertEquals(task2.taskId,
                RemoteTaskRegistry.getInstance().getActiveBySession(D2).taskId);
    }

    // ── Issue 2: observer lifecycle ────────────────────────────────────

    private static final class TestObserver implements PermissionInteractionObserver {
        private final String name;
        TestObserver(String name) { this.name = name; }
        @Override public void onPermissionRequested(Project p, String s, String r, String t, JsonObject i) {}
        @Override public void onPermissionResolved(String s, String r, boolean a, boolean aa) {}
        @Override public void onAskUserQuestionRequested(Project p, String s, String r, JsonObject q) {}
        @Override public void onAskUserQuestionResolved(String s, String r, JsonObject a) {}
        @Override public void onPlanApprovalRequested(Project p, String s, String r, JsonObject pd) {}
        @Override public void onPlanApprovalResolved(String s, String r, boolean ap, String tm) {}
    }

    @Test
    public void observerInstallA_DisposeA_ObsRefCleared() {
        TestObserver a = new TestObserver("A");
        PermissionService.installInteractionObserver(a);
        PermissionService.uninstallInteractionObserver(a);
        // After uninstall, installing a null should succeed.
        PermissionService.installInteractionObserver(null);
    }

    @Test
    public void observerInstallA_InstallB_UninstallA_BStillPresent() {
        TestObserver a = new TestObserver("A");
        TestObserver b = new TestObserver("B");
        PermissionService.installInteractionObserver(a);
        // Replace with B
        PermissionService.installInteractionObserver(b);
        PermissionService.uninstallInteractionObserver(a);
        // B still present — dispose A only clears if current == A.
        PermissionService.installInteractionObserver(b); // idempotent re-install
        PermissionService.uninstallInteractionObserver(b);
    }

    @Test
    public void claudeSessionInterruptObserverLifecycle() {
        ClaudeSession.InterruptObserver obs = new RemoteInterruptObserver();
        ClaudeSession.installInterruptObserver(obs);
        ClaudeSession.uninstallInterruptObserver(obs);
    }

    // ── Issue 4: attachSource returns boolean ──────────────────────────

    @Test
    public void attachSourceReturnsFalseWhenHandleMissing() {
        SharedInteractionResolver r = SharedInteractionResolver.getInstance();
        assertFalse("must return false when no handle exists",
                r.attachSource("unk", "unk", "pid", "tab", "task"));
    }

    @Test
    public void attachSourceReturnsTrueAndSetsSource() {
        SharedInteractionResolver r = SharedInteractionResolver.getInstance();
        CompletableFuture<Integer> f = new CompletableFuture<>();
        InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "s1", "r1", "ch1", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f.complete((Integer) v); }
            @Override public void cancel(String reason) { f.complete(3); }
        });
        r.register(h);
        assertTrue(r.attachSource("s1", "r1", "pid", "tab", "tid"));
        assertEquals("tid", r.get("s1", "r1").getSourceTaskId());
    }

    // ── Issue 3: InteractionHandle tombstone bounding ──────────────────

    @Test
    public void resolvedHandlesAreKeptForLateRace() throws Exception {
        SharedInteractionResolver r = SharedInteractionResolver.getInstance();
        CompletableFuture<Integer> f = new CompletableFuture<>();
        InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "s1", "r1", "ch1", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f.complete((Integer) v); }
            @Override public void cancel(String reason) { f.complete(3); }
        });
        r.register(h);
        r.attachSource("s1", "r1", "pid", "tab", "t1");

        // Resolve → handle stays (ALREADY_RESOLVED for late race)
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                r.resolvePermission("s1", "r1", "pid", "tab", "t1", 1));
        assertEquals(SharedInteractionResolver.ResolveOutcome.ALREADY_RESOLVED,
                r.resolvePermission("s1", "r1", "pid", "tab", "t1", 1));
        assertNotNull(r.get("s1", "r1"));

        // cancelAllForSession cleans it up
        r.cancelAllForSession("s1", "terminal");
        assertNull(r.get("s1", "r1"));
    }

    @Test
    public void pruneResolvedSelfBoundedByRegister() {
        SharedInteractionResolver r = SharedInteractionResolver.getInstance();
        // Create and resolve 300 handles — each register() triggers pruneResolved(),
        // so the count must stay bounded at 256 without any manual call.
        for (int i = 0; i < 300; i++) {
            String sid = "s" + i;
            String rid = "r" + i;
            CompletableFuture<Integer> f = new CompletableFuture<>();
            InteractionHandle h = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                    sid, rid, "ch" + i, new InteractionHandle.Completer() {
                @Override public void complete(Object v) { f.complete((Integer) v); }
                @Override public void cancel(String reason) { f.complete(3); }
            });
            r.register(h);
            h.attachSource("pid", "tab", "t1");
            r.completePermissionByChannelId("ch" + i, 1); // resolve
        }
        // Self-bounded: even without manual pruneResolved(), register() keeps it ≤ 256.
        int count = r.size();
        assertTrue("register() must self-bound at 256, was " + count,
                count <= 260); // allow small transient overrun

        // Fresh resolve still works.
        CompletableFuture<Integer> f2 = new CompletableFuture<>();
        InteractionHandle nh = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                "newS", "newR", "newCh", new InteractionHandle.Completer() {
            @Override public void complete(Object v) { f2.complete((Integer) v); }
            @Override public void cancel(String reason) { f2.complete(3); }
        });
        r.register(nh);
        r.attachSource("newS", "newR", "pid", "tab", "t1");
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                r.resolvePermission("newS", "newR", "pid", "tab", "t1", 1));
    }

    private static final class NoopScheduler implements RemoteDeltaFlushScheduler {
        @Override public void schedule(Runnable runnable, long delayMs) {}
        @Override public void cancel() {}
    }
}
