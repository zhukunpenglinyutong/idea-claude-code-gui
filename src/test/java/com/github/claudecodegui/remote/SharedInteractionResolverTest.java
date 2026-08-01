package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
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
 * Pure-logic tests for {@link SharedInteractionResolver} — the shared first-wins
 * interaction backend (Phase 2C-C §5, §7, §32).
 */
public class SharedInteractionResolverTest {

    private static final String PID = "pid";
    private static final String TAB = "tab1";
    private static final String TASK = "task1";

    @Before
    public void setUp() {
        SharedInteractionResolver.getInstance().clearForTest();
    }

    // ── handle factories with recording completers ─────────────────────

    private static final class PermHandle {
        final String channelId;
        final CompletableFuture<Integer> future = new CompletableFuture<>();
        final InteractionHandle handle;

        PermHandle(String sessionId, String requestId, String channelId) {
            this.channelId = channelId;
            handle = new InteractionHandle(InteractionHandle.Type.PERMISSION,
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
        }
    }

    private static final class AskHandle {
        final CompletableFuture<JsonObject> future = new CompletableFuture<>();
        final InteractionHandle handle;

        AskHandle(String sessionId, String requestId) {
            handle = new InteractionHandle(InteractionHandle.Type.QUESTION,
                    sessionId, requestId, null,
                    new InteractionHandle.Completer() {
                        @Override
                        public void complete(Object value) {
                            future.complete((JsonObject) value);
                        }
                        @Override
                        public void cancel(String reason) {
                            future.complete(null);
                        }
                    });
        }
    }

    private PermHandle registerPerm(String sessionId, String requestId, String channelId) {
        PermHandle p = new PermHandle(sessionId, requestId, channelId);
        SharedInteractionResolver.getInstance().register(p.handle);
        SharedInteractionResolver.getInstance()
                .attachSource(sessionId, requestId, PID, TAB, TASK);
        return p;
    }

    private static int allowValue() {
        return PermissionService.PermissionResponse.ALLOW.getValue();
    }

    private static int allowAlwaysValue() {
        return PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue();
    }

    private static int denyValue() {
        return PermissionService.PermissionResponse.DENY.getValue();
    }

    // ── single-decision resolve-once ───────────────────────────────────

    @Test
    public void allowResolvesOnce() throws Exception {
        PermHandle p = registerPerm("s1", "r1", "c1");
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r1", PID, TAB, TASK, allowValue()));
        assertEquals(allowValue(), p.future.get(1, TimeUnit.SECONDS).intValue());
        // Second resolve is already-resolved.
        assertEquals(SharedInteractionResolver.ResolveOutcome.ALREADY_RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r1", PID, TAB, TASK, allowValue()));
        // Future completes exactly once (CompletableFuture.complete is atomic).
        assertFalse(p.future.complete(denyValue()));
    }

    @Test
    public void allowAlwaysResolvesOnce() throws Exception {
        PermHandle p = registerPerm("s1", "r2", "c2");
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r2", PID, TAB, TASK, allowAlwaysValue()));
        assertEquals(allowAlwaysValue(), p.future.get(1, TimeUnit.SECONDS).intValue());
    }

    @Test
    public void denyResolvesOnce() throws Exception {
        PermHandle p = registerPerm("s1", "r3", "c3");
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r3", PID, TAB, TASK, denyValue()));
        assertEquals(denyValue(), p.future.get(1, TimeUnit.SECONDS).intValue());
    }

    // ── validation ─────────────────────────────────────────────────────

    @Test
    public void wrongTaskIdRejectedAsMismatch() {
        PermHandle p = registerPerm("s1", "r4", "c4");
        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r4", PID, TAB, "other-task", allowValue()));
        assertFalse("future must not complete on a mismatched resolve", p.future.isDone());
    }

    @Test
    public void wrongTabRejectedAsMismatch() {
        PermHandle p = registerPerm("s1", "r5", "c5");
        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r5", PID, "other-tab", TASK, allowValue()));
        assertFalse(p.future.isDone());
    }

    @Test
    public void wrongProjectRejectedAsMismatch() {
        PermHandle p = registerPerm("s1", "r5b", "c5b");
        assertEquals(SharedInteractionResolver.ResolveOutcome.MISMATCH,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r5b", "other-proj", TAB, TASK, allowValue()));
        assertFalse(p.future.isDone());
    }

    @Test
    public void notFoundForUnknownInteraction() {
        assertEquals(SharedInteractionResolver.ResolveOutcome.NOT_FOUND,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "unknown", PID, TAB, TASK, allowValue()));
    }

    @Test
    public void typeMismatchWhenResolvingPermissionOnAskHandle() {
        AskHandle a = new AskHandle("s1", "r6");
        SharedInteractionResolver.getInstance().register(a.handle);
        SharedInteractionResolver.getInstance().attachSource("s1", "r6", PID, TAB, TASK);
        assertEquals(SharedInteractionResolver.ResolveOutcome.TYPE_MISMATCH,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r6", PID, TAB, TASK, allowValue()));
        assertFalse(a.future.isDone());
    }

    // ── same requestId, different sessions do not collide ──────────────

    @Test
    public void sameRequestIdDifferentSessionsAreIndependent() throws Exception {
        PermHandle a = registerPerm("sA", "shared-rid", "cA");
        PermHandle b = registerPerm("sB", "shared-rid", "cB");
        // Resolving session A does not affect session B.
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("sA", "shared-rid", PID, TAB, TASK, allowValue()));
        assertEquals(allowValue(), a.future.get(1, TimeUnit.SECONDS).intValue());
        assertFalse(b.future.isDone());
        // Session B is still resolvable.
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("sB", "shared-rid", PID, TAB, TASK, denyValue()));
        assertEquals(denyValue(), b.future.get(1, TimeUnit.SECONDS).intValue());
    }

    // ── desktop + remote share the same handle / future ────────────────

    @Test
    public void desktopChannelIdAndRemoteRequestIdResolveSameFuture() throws Exception {
        PermHandle p = registerPerm("s1", "r7", "c7");
        // Desktop path (by channelId) and Remote path (by requestId) both target
        // the same underlying future; whichever runs first wins.
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance().completePermissionByChannelId("c7", allowValue()));
        assertEquals(allowValue(), p.future.get(1, TimeUnit.SECONDS).intValue());
        // Remote resolve now sees it already resolved.
        assertEquals(SharedInteractionResolver.ResolveOutcome.ALREADY_RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r7", PID, TAB, TASK, denyValue()));
    }

    // ── cleanup ────────────────────────────────────────────────────────

    @Test
    public void resolvedHandleStaysUntilCancelAllForSession() {
        // Resolved handles are kept (so late/racing resolves see ALREADY_RESOLVED,
        // §5) until an explicit cleanup (session switch / abort / task terminal).
        PermHandle p = registerPerm("s1", "r8", "c8");
        assertEquals(SharedInteractionResolver.ResolveOutcome.RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r8", PID, TAB, TASK, allowValue()));
        assertTrue(p.handle.isResolved());
        assertNotNull(SharedInteractionResolver.getInstance().get("s1", "r8"));
        // Late resolve sees ALREADY_RESOLVED, not NOT_FOUND.
        assertEquals(SharedInteractionResolver.ResolveOutcome.ALREADY_RESOLVED,
                SharedInteractionResolver.getInstance().resolvePermission("s1", "r8", PID, TAB, TASK, allowValue()));
        // Cleanup removes it.
        SharedInteractionResolver.getInstance().cancelAllForSession("s1", "terminal");
        assertNull(SharedInteractionResolver.getInstance().get("s1", "r8"));
        assertNull(SharedInteractionResolver.getInstance().getByChannelId("c8"));
    }

    // ── races: only one resolver wins ──────────────────────────────────

    @Test
    public void remoteVsRemoteRaceOnlyOneWins() throws Exception {
        PermHandle p = registerPerm("s1", "r9", "c9");
        int threads = 16;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(threads);
        AtomicInteger resolvedCount = new AtomicInteger(0);
        AtomicInteger alreadyCount = new AtomicInteger(0);
        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                try {
                    start.await();
                    SharedInteractionResolver.ResolveOutcome out =
                            SharedInteractionResolver.getInstance()
                                    .resolvePermission("s1", "r9", PID, TAB, TASK, allowValue());
                    if (out == SharedInteractionResolver.ResolveOutcome.RESOLVED) {
                        resolvedCount.incrementAndGet();
                    } else if (out == SharedInteractionResolver.ResolveOutcome.ALREADY_RESOLVED) {
                        alreadyCount.incrementAndGet();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        assertTrue("race did not finish", done.await(5, TimeUnit.SECONDS));
        pool.shutdownNow();
        assertEquals("exactly one resolver must win", 1, resolvedCount.get());
        assertEquals("all others must see already-resolved", threads - 1, alreadyCount.get());
        assertEquals(allowValue(), p.future.get(1, TimeUnit.SECONDS).intValue());
    }

    @Test
    public void desktopVsRemoteRaceOnlyOneWins() throws Exception {
        PermHandle p = registerPerm("s1", "r10", "c10");
        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(threads);
        AtomicInteger wins = new AtomicInteger(0);
        for (int i = 0; i < threads; i++) {
            final boolean desktop = (i % 2 == 0);
            pool.submit(() -> {
                try {
                    start.await();
                    SharedInteractionResolver.ResolveOutcome out;
                    if (desktop) {
                        out = SharedInteractionResolver.getInstance()
                                .completePermissionByChannelId("c10", allowValue());
                    } else {
                        out = SharedInteractionResolver.getInstance()
                                .resolvePermission("s1", "r10", PID, TAB, TASK, allowValue());
                    }
                    if (out == SharedInteractionResolver.ResolveOutcome.RESOLVED) {
                        wins.incrementAndGet();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        assertTrue("race did not finish", done.await(5, TimeUnit.SECONDS));
        pool.shutdownNow();
        assertEquals("exactly one of desktop/remote must win", 1, wins.get());
        assertEquals(allowValue(), p.future.get(1, TimeUnit.SECONDS).intValue());
    }

    // ── cancelAllForSession (abort / clearPendingRequests) ─────────────

    @Test
    public void cancelAllForSessionDeniesPermissionAndNullsAsk() throws Exception {
        PermHandle perm = registerPerm("s1", "rp", "cp");
        AskHandle ask = new AskHandle("s1", "rq");
        SharedInteractionResolver.getInstance().register(ask.handle);
        SharedInteractionResolver.getInstance().attachSource("s1", "rq", PID, TAB, TASK);

        int cancelled = SharedInteractionResolver.getInstance().cancelAllForSession("s1", "aborted");
        assertEquals(2, cancelled);
        assertEquals(denyValue(), perm.future.get(1, TimeUnit.SECONDS).intValue());
        assertNull(ask.future.get(1, TimeUnit.SECONDS));
        assertNull(SharedInteractionResolver.getInstance().get("s1", "rp"));
        assertNull(SharedInteractionResolver.getInstance().get("s1", "rq"));
    }

    @Test
    public void cancelAllForSessionDoesNotTouchOtherSessions() {
        PermHandle a = registerPerm("sA", "ra", "ca");
        PermHandle b = registerPerm("sB", "rb", "cb");
        SharedInteractionResolver.getInstance().cancelAllForSession("sA", "aborted");
        assertTrue("cancelled session A future", a.future.isDone());
        assertFalse("other session must be untouched", b.future.isDone());
    }

    @Test
    public void cancelIsFirstWinsAndIdempotent() {
        PermHandle p = registerPerm("s1", "rc", "cc");
        assertTrue(p.handle.cancel("aborted"));
        assertFalse("second cancel is a no-op", p.handle.cancel("again"));
        assertTrue(p.future.isDone());
    }
}
