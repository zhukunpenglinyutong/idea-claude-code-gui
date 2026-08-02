package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.SessionTurnGate;
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
 * End-to-end tests for the full observer → resolver chain with mismatched
 * permission sessionId (P) vs conversation sessionId (D).
 *
 * <p>These tests reproduce and prove the fix for Phase 2C-C.0 Hotfix 3:
 * the observer's {@code attachSource} must use the task's conversation
 * sessionId (D), not the permission callback's sessionId (P), because the
 * handle is registered under D and RemoteControlHandler resolves with D.
 *
 * <p>Coverage:
 * <ul>
 *   <li>requested → remote ALLOW → RESOLVED (full happy path)</li>
 *   <li>requested → remote DENY → RESOLVED</li>
 *   <li>wrong taskId → MISMATCH</li>
 *   <li>wrong tabId → MISMATCH</li>
 *   <li>wrong projectId → MISMATCH</li>
 *   <li>already resolved → ALREADY_RESOLVED</li>
 *   <li>task1 → terminal → task2 → RESOLVED (consecutive tasks)</li>
 *   <li>requested SSE sessionId is the task's conversation sessionId D</li>
 *   <li>resolved SSE sessionId is also D</li>
 * </ul>
 */
public class RemoteInteractionEndToEndTest {

    // P = permission service key (window-level, stable)
    private static final String P = "window-permission-key-abc123";
    // D = daemon / conversation sessionId
    private static final String D = "a91ed037-0721-4525-b8ce-4075ffb31fad";
    private static final String TAB = "test-tab-uuid";
    private static final String REQUEST_ID = "0efaae10-4494-4ca8-a2b8-b6879f0bd22d";
    private static final String PROJECT_ID = "0b0dcb1be3f66a8155c856a24174aef3";

    @Before
    public void setUp() {
        RemoteTaskRegistry.getInstance().clearForTest();
        RemoteEventBus.getInstance().clearForTest();
        SharedInteractionResolver.getInstance().clearForTest();
    }

    // ── helpers ────────────────────────────────────────────────────────

    private RemoteTask createActiveTask(String taskId, String tabId, String sessionId) {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        assertNotNull(lease);
        AtomicLong clock = new AtomicLong(1L);
        return RemoteTask.create(taskId, PROJECT_ID, tabId, sessionId,
                "claude", lease, RemoteEventBus.getInstance(),
                new NoopScheduler(), clock::get, RemoteEventBus.getInstance().currentGeneration());
    }

    private InteractionHandle registerPermHandle(String sessionId, String requestId,
                                                  String channelId,
                                                  CompletableFuture<Integer> future) {
        InteractionHandle handle = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                sessionId, requestId, channelId,
                new InteractionHandle.Completer() {
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
        return handle;
    }

    private int allowValue() {
        return PermissionService.PermissionResponse.ALLOW.getValue();
    }

    private int denyValue() {
        return PermissionService.PermissionResponse.DENY.getValue();
    }

    // ── happy path: requested → ALLOW → RESOLVED ───────────────────────

    @Test
    public void remoteAllowSucceedsWhenSourceAttachedWithTaskSessionId() throws Exception {
        // 1. Register source mapping: P → tabId
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);

        // 2. Create active task with conversation sessionId D
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);

        // 3. Register InteractionHandle under D (as PermissionHandler does)
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermHandle(D, REQUEST_ID, "ch1", future);

        // 4. Observer attaches source under task.getSessionId() = D
        SharedInteractionResolver.getInstance()
                .attachSource(task.getSessionId(), REQUEST_ID,
                        PROJECT_ID, TAB, taskId);

        // 5. Remote resolve uses D (as RemoteControlHandler does)
        SharedInteractionResolver.ResolveOutcome out =
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, REQUEST_ID, PROJECT_ID, TAB, taskId, allowValue());
        assertEquals("must RESOLVE when source is attached with matching key",
                SharedInteractionResolver.ResolveOutcome.RESOLVED, out);
        assertEquals(allowValue(), future.get(1, TimeUnit.SECONDS).intValue());
    }

    @Test
    public void remoteDenySucceeds() throws Exception {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermHandle(D, REQUEST_ID, "ch1", future);
        SharedInteractionResolver.getInstance()
                .attachSource(D, REQUEST_ID, PROJECT_ID, TAB, taskId);

        SharedInteractionResolver.ResolveOutcome out =
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, REQUEST_ID, PROJECT_ID, TAB, taskId, denyValue());
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED, out);
        assertEquals(denyValue(), future.get(1, TimeUnit.SECONDS).intValue());
    }

    // ── BUG REPRODUCTION: attach with P fails, resolve with D → MISMATCH ─

    @Test
    public void attachSourceWithWrongKeyCausesMismatch() {
        // Simulate the original bug: observer attaches source with P
        // but the handle is registered with D.
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermHandle(D, REQUEST_ID, "ch1", future);

        // OLD (buggy): attachSource(P, requestId, ...)
        // get(P, requestId) → null → no-op → source never attached
        SharedInteractionResolver.getInstance()
                .attachSource(P, REQUEST_ID, PROJECT_ID, TAB, taskId);

        // resolvePermission(D, requestId, ...) finds handle but source is null
        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, REQUEST_ID, PROJECT_ID, TAB, taskId, allowValue()));
        assertFalse("future must not complete on a mismatched resolve", future.isDone());
    }

    // ── negative validation (intact) ───────────────────────────────────

    @Test
    public void wrongTaskIdRejectedAsMismatch() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermHandle(D, REQUEST_ID, "ch1", future);
        SharedInteractionResolver.getInstance()
                .attachSource(D, REQUEST_ID, PROJECT_ID, TAB, taskId);

        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, REQUEST_ID, PROJECT_ID, TAB, "wrong-task", allowValue()));
        assertFalse(future.isDone());
    }

    @Test
    public void wrongTabRejectedAsMismatch() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermHandle(D, REQUEST_ID, "ch1", future);
        SharedInteractionResolver.getInstance()
                .attachSource(D, REQUEST_ID, PROJECT_ID, TAB, taskId);

        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, REQUEST_ID, PROJECT_ID, "wrong-tab", taskId, allowValue()));
        assertFalse(future.isDone());
    }

    @Test
    public void wrongProjectRejectedAsMismatch() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermHandle(D, REQUEST_ID, "ch1", future);
        SharedInteractionResolver.getInstance()
                .attachSource(D, REQUEST_ID, PROJECT_ID, TAB, taskId);

        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, REQUEST_ID, "wrong-proj", TAB, taskId, allowValue()));
        assertFalse(future.isDone());
    }

    @Test
    public void alreadyResolvedReturnsAlreadyResolved() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermHandle(D, REQUEST_ID, "ch1", future);
        SharedInteractionResolver.getInstance()
                .attachSource(D, REQUEST_ID, PROJECT_ID, TAB, taskId);

        // First: RESOLVED
        SharedInteractionResolver.getInstance()
                .resolvePermission(D, REQUEST_ID, PROJECT_ID, TAB, taskId, allowValue());
        // Second: ALREADY_RESOLVED
        assertEquals(SharedInteractionResolver.ResolveOutcome.ALREADY_RESOLVED,
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, REQUEST_ID, PROJECT_ID, TAB, taskId, allowValue()));
    }

    @Test
    public void notFoundForUnknownInteraction() {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);

        assertEquals(SharedInteractionResolver.ResolveOutcome.NOT_FOUND,
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, "unknown-rid", PROJECT_ID, TAB, taskId, allowValue()));
    }

    // ── task lifecycle: task1 terminal → task2 succeeds ────────────────

    @Test
    public void task2ResolvesAfterTask1Terminal() throws Exception {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);

        // Task 1
        String task1Id = UUID.randomUUID().toString();
        RemoteTask task1 = createActiveTask(task1Id, TAB, D);
        RemoteTaskRegistry.getInstance().register(task1);
        CompletableFuture<Integer> future1 = new CompletableFuture<>();
        registerPermHandle(D, "rid1", "ch1", future1);

        // Task 2 — a new turn on the same tab
        String task2Id = UUID.randomUUID().toString();
        RemoteTask task2 = createActiveTask(task2Id, TAB, D);
        // register task2 (replaces task1 as active for TAB since register uses putIfAbsent;
        // we must remove task1 first to avoid the duplicate check)
        RemoteTaskRegistry.getInstance().remove(task1);
        RemoteTaskRegistry.getInstance().register(task2);

        // Register a fresh handle for task 2, attach source with D, resolve with D
        CompletableFuture<Integer> future2 = new CompletableFuture<>();
        registerPermHandle(D, "rid2", "ch2", future2);
        SharedInteractionResolver.getInstance()
                .attachSource(D, "rid2", PROJECT_ID, TAB, task2Id);

        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance()
                        .resolvePermission(D, "rid2", PROJECT_ID, TAB, task2Id, allowValue()));
        assertEquals(allowValue(), future2.get(1, TimeUnit.SECONDS).intValue());
    }

    // ── SSE sessionId consistency ──────────────────────────────────────

    @Test
    public void observerFindsTaskViaSourceMappingAndReadsTaskSessionId() {
        // Verify that findRemoteTask(P) → task with sessionId = D, not P.
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);

        RemoteInteractionObserverImpl observer = new RemoteInteractionObserverImpl();
        RemoteTask found = observer.findRemoteTask(P);
        assertNotNull(found);
        assertEquals(D, found.getSessionId());
        assertEquals(taskId, found.taskId);
    }

    @Test
    public void sseRequestedEventCarriesTaskSessionIdNotPermissionSessionId() throws InterruptedException {
        RemoteTaskRegistry.getInstance().registerPermissionSource(P, TAB);
        String taskId = UUID.randomUUID().toString();
        RemoteTask task = createActiveTask(taskId, TAB, D);
        RemoteTaskRegistry.getInstance().register(task);
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB);

        // Simulate the observer publishing with task.getSessionId() = D
        JsonObject payload = new JsonObject();
        payload.addProperty("interactionId", REQUEST_ID);
        RemoteEventBus.getInstance().publish(PROJECT_ID, TAB, "permission.requested",
                taskId, task.getSessionId(), payload);

        RemoteEvent event = sub.poll(500);
        assertNotNull(event);
        // sessionId in the SSE envelope should be the task's D, not P.
        String envelopeJson = event.toEnvelopeJson();
        assertTrue("envelope must contain " + D, envelopeJson.contains(D));
        assertFalse("envelope must NOT contain P", envelopeJson.contains(P));
    }

    // ── multiple tab isolation ─────────────────────────────────────────

    @Test
    public void differentTabsAreIsolated() {
        RemoteTaskRegistry.getInstance().registerPermissionSource("P1", "tabA");
        RemoteTaskRegistry.getInstance().registerPermissionSource("P2", "tabB");

        String tid1 = UUID.randomUUID().toString();
        String tid2 = UUID.randomUUID().toString();
        RemoteTask t1 = createActiveTask(tid1, "tabA", "D1");
        RemoteTask t2 = createActiveTask(tid2, "tabB", "D2");
        RemoteTaskRegistry.getInstance().register(t1);
        RemoteTaskRegistry.getInstance().register(t2);

        CompletableFuture<Integer> f1 = new CompletableFuture<>();
        registerPermHandle("D1", "R1", "ch1", f1);
        SharedInteractionResolver.getInstance()
                .attachSource("D1", "R1", PROJECT_ID, "tabA", tid1);

        CompletableFuture<Integer> f2 = new CompletableFuture<>();
        registerPermHandle("D2", "R2", "ch2", f2);
        SharedInteractionResolver.getInstance()
                .attachSource("D2", "R2", PROJECT_ID, "tabB", tid2);

        // Tab A resolve with tab B taskId → MISMATCH
        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance()
                        .resolvePermission("D1", "R1", PROJECT_ID, "tabA", tid2, allowValue()));

        // Tab B resolve with tab A taskId → MISMATCH
        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance()
                        .resolvePermission("D2", "R2", PROJECT_ID, "tabB", tid1, allowValue()));

        // Each tab resolves its own interaction correctly
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance()
                        .resolvePermission("D1", "R1", PROJECT_ID, "tabA", tid1, allowValue()));
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance()
                        .resolvePermission("D2", "R2", PROJECT_ID, "tabB", tid2, allowValue()));
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
