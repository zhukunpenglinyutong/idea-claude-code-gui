package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link PermissionHandler}.
 *
 * <p>Phase 2C-C: pending interactions now live in the shared
 * {@link SharedInteractionResolver} (no per-instance maps), so handles are
 * injected directly into the resolver instead of via reflection. The desktop
 * JS decision path and the Remote endpoint both complete the same handle.
 *
 * <p>Coverage:
 * <ul>
 *   <li>{@link PermissionHandler#getSupportedTypes()} — the IPC dispatch table.</li>
 *   <li>{@link PermissionHandler#handle(String, String)} — dispatch for each type.</li>
 *   <li>{@link PermissionHandler#clearPendingRequests()} — session-change safety net.</li>
 *   <li>The atomic {@link CompletableFuture#complete(Object)} contract the safety
 *       nets depend on.</li>
 *   <li>Safety-net timeout configuration + cancellation.</li>
 * </ul>
 */
public class PermissionHandlerTest {

    private static final String SID = "test-session-id";

    private PermissionHandler handler;
    private SharedInteractionResolver resolver;

    @Before
    public void setUp() {
        resolver = SharedInteractionResolver.getInstance();
        resolver.clearForTest();
        handler = new PermissionHandler(contextStub());
    }

    @Test
    public void getSupportedTypesReturnsTheThreeIpcMessageTypes() {
        String[] actual = handler.getSupportedTypes().clone();
        String[] expected = {
                "permission_decision",
                "ask_user_question_response",
                "plan_approval_response"
        };
        Arrays.sort(actual);
        Arrays.sort(expected);
        assertArrayEquals(expected, actual);
    }

    @Test
    public void handleReturnsFalseForUnknownType() {
        assertFalse(handler.handle("totally_unknown_type", "{}"));
    }

    @Test
    public void handleDispatchesPermissionDecisionAndCompletesAllowFuture() throws Exception {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermission("ch-allow", "r-allow", future);

        String content = "{\"channelId\":\"ch-allow\",\"allow\":true,\"remember\":false}";
        assertTrue(handler.handle("permission_decision", content));

        assertEquals(PermissionService.PermissionResponse.ALLOW.getValue(),
                future.get(2, TimeUnit.SECONDS).intValue());
        // Resolved handles are kept (first-wins) until clearPendingRequests; a
        // duplicate dispatch must not re-complete or fall back.
        assertNotNull(resolver.getByChannelId("ch-allow"));
        assertTrue(resolver.getByChannelId("ch-allow").isResolved());
    }

    @Test
    public void handleDispatchesPermissionDecisionAndCompletesAllowAlwaysFuture() throws Exception {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermission("ch-allow-always", "r-allow-always", future);

        String content = "{\"channelId\":\"ch-allow-always\",\"allow\":true,\"remember\":true}";
        assertTrue(handler.handle("permission_decision", content));

        assertEquals(PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue(),
                future.get(2, TimeUnit.SECONDS).intValue());
    }

    @Test
    public void handleDispatchesPermissionDeny() throws Exception {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        registerPermission("ch-deny", "r-deny", future);

        String content = "{\"channelId\":\"ch-deny\",\"allow\":false,\"remember\":false}";
        assertTrue(handler.handle("permission_decision", content));

        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                future.get(2, TimeUnit.SECONDS).intValue());
    }

    @Test
    public void handleDispatchesAskUserQuestionResponse() throws Exception {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        registerAsk("auq-1", future);

        String content = "{\"requestId\":\"auq-1\",\"answers\":{\"color\":\"red\"}}";
        assertTrue(handler.handle("ask_user_question_response", content));

        JsonObject result = future.get(2, TimeUnit.SECONDS);
        assertEquals("red", result.get("color").getAsString());
        assertNotNull(resolver.get(SID, "auq-1"));
        assertTrue(resolver.get(SID, "auq-1").isResolved());
    }

    @Test
    public void handleDispatchesPlanApprovalResponse() throws Exception {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        registerPlan("plan-1", future);

        String content = "{\"requestId\":\"plan-1\",\"approved\":true,\"targetMode\":\"default\"}";
        assertTrue(handler.handle("plan_approval_response", content));

        JsonObject result = future.get(2, TimeUnit.SECONDS);
        assertTrue(result.get("approved").getAsBoolean());
        assertEquals("default", result.get("targetMode").getAsString());
        assertNotNull(resolver.get(SID, "plan-1"));
        assertTrue(resolver.get(SID, "plan-1").isResolved());
    }

    // ── clearPendingRequests: session-change safety net ────────────────

    @Test
    public void clearPendingRequestsCompletesAllPermissionFuturesWithDeny() throws Exception {
        CompletableFuture<Integer> f1 = new CompletableFuture<>();
        CompletableFuture<Integer> f2 = new CompletableFuture<>();
        registerPermission("ch-1", "r-1", f1);
        registerPermission("ch-2", "r-2", f2);

        handler.clearPendingRequests();

        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                f1.get(1, TimeUnit.SECONDS).intValue());
        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                f2.get(1, TimeUnit.SECONDS).intValue());
        assertNull(resolver.getByChannelId("ch-1"));
        assertNull(resolver.getByChannelId("ch-2"));
    }

    @Test
    public void clearPendingRequestsCompletesAskUserQuestionFuturesWithNull() throws Exception {
        CompletableFuture<JsonObject> f1 = new CompletableFuture<>();
        CompletableFuture<JsonObject> f2 = new CompletableFuture<>();
        registerAsk("auq-1", f1);
        registerAsk("auq-2", f2);

        handler.clearPendingRequests();

        // null distinguishes "no answer" from an empty answers object.
        assertNull(f1.get(1, TimeUnit.SECONDS));
        assertNull(f2.get(1, TimeUnit.SECONDS));
        assertNull(resolver.get(SID, "auq-1"));
    }

    @Test
    public void clearPendingRequestsCompletesPlanApprovalFuturesWithRejection() throws Exception {
        CompletableFuture<JsonObject> f1 = new CompletableFuture<>();
        registerPlan("plan-1", f1);

        handler.clearPendingRequests();

        JsonObject result = f1.get(1, TimeUnit.SECONDS);
        assertNotNull(result);
        assertFalse("plan-approval default on session change must be reject",
                result.get("approved").getAsBoolean());
        assertEquals("Session changed", result.get("message").getAsString());
        assertNull(resolver.get(SID, "plan-1"));
    }

    @Test
    public void clearPendingRequestsOnEmptyIsHarmless() {
        // Called on every session switch including the very first one; must not throw.
        handler.clearPendingRequests();
        assertEquals(0, resolver.size());
    }

    // ── atomic complete contract (safety nets depend on this) ──────────

    @Test
    public void completableFutureCompleteIsAtomic_winnerGetsTrue_loserGetsFalse()
            throws ExecutionException, InterruptedException, TimeoutException {
        CompletableFuture<Integer> future = new CompletableFuture<>();

        boolean firstWon = future.complete(1);
        boolean secondWon = future.complete(2);

        assertTrue("first complete() must win the race", firstWon);
        assertFalse("second complete() must be a no-op", secondWon);
        assertEquals("winner's value must survive the race", Integer.valueOf(1),
                future.get(1, TimeUnit.SECONDS));
    }

    // ── safety-net timeout configuration ───────────────────────────────

    @Test
    public void safetyNetTimeoutUsesConfiguredDialogTimeoutPlusBuffer() {
        FakeSettingsService settingsService = new FakeSettingsService(120);
        PermissionHandler configuredHandler = new PermissionHandler(contextStub(settingsService));

        assertEquals(180L, configuredHandler.getSafetyNetTimeoutSeconds());
    }

    @Test
    public void safetyNetTimeoutFallsBackToDefaultPlusBufferWhenSettingsServiceIsNull() {
        PermissionHandler nullSettingsHandler = new PermissionHandler(contextStub());

        long expected = CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
        assertEquals(expected, nullSettingsHandler.getSafetyNetTimeoutSeconds());
    }

    @Test
    public void safetyNetTimeoutFallsBackToDefaultPlusBufferWhenSettingsServiceThrows() {
        PermissionHandler throwingHandler = new PermissionHandler(contextStub(new FailingSettingsService()));

        long expected = CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
        assertEquals(expected, throwingHandler.getSafetyNetTimeoutSeconds());
    }

    @Test
    public void safetyNetScheduleIsCancelledWhenFutureCompletesBeforeTimeout() {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(contextStub(new FakeSettingsService(120)), scheduler);
        CompletableFuture<Integer> future = new CompletableFuture<>();

        configuredHandler.scheduleSafetyNet(future, () -> future.complete(42));

        assertEquals(180L, scheduler.lastDelaySeconds);
        assertFalse(scheduler.task.cancelled);

        future.complete(7);

        assertTrue(scheduler.task.cancelled);
        assertEquals(Integer.valueOf(7), future.join());
    }

    @Test
    public void safetyNetTaskStillCompletesFutureWhenItWinsRace() {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(contextStub(new FakeSettingsService(30)), scheduler);
        CompletableFuture<Integer> future = new CompletableFuture<>();

        configuredHandler.scheduleSafetyNet(future, () -> future.complete(42));
        scheduler.runnable.run();

        assertEquals(Integer.valueOf(42), future.join());
        assertTrue(scheduler.task.cancelled);
    }

    // ── handle registration helpers (replace the former reflection injection) ──

    private void registerPermission(String channelId, String requestId, CompletableFuture<Integer> future) {
        InteractionHandle handle = new InteractionHandle(InteractionHandle.Type.PERMISSION,
                SID, requestId, channelId,
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
        resolver.register(handle);
    }

    private void registerAsk(String requestId, CompletableFuture<JsonObject> future) {
        InteractionHandle handle = new InteractionHandle(InteractionHandle.Type.QUESTION,
                SID, requestId, null,
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
        resolver.register(handle);
    }

    private void registerPlan(String requestId, CompletableFuture<JsonObject> future) {
        InteractionHandle handle = new InteractionHandle(InteractionHandle.Type.PLAN,
                SID, requestId, null,
                new InteractionHandle.Completer() {
                    @Override
                    public void complete(Object value) {
                        future.complete((JsonObject) value);
                    }
                    @Override
                    public void cancel(String reason) {
                        JsonObject rejected = new JsonObject();
                        rejected.addProperty("approved", false);
                        rejected.addProperty("message", reason != null ? reason : "Session changed");
                        future.complete(rejected);
                    }
                });
        resolver.register(handle);
    }

    // ── context stub ───────────────────────────────────────────────────

    private HandlerContext contextStub() {
        return contextStub(null);
    }

    private HandlerContext contextStub(CodemossSettingsService settingsService) {
        HandlerContext ctx = new HandlerContext(
                null,
                null,
                null,
                settingsService,
                new HandlerContext.JsCallback() {
                    @Override public void callJavaScript(String functionName, String... args) {}
                    @Override public String escapeJs(String str) { return str; }
                }
        );
        // PermissionHandler reads sessionId from the session to key ask/plan handles.
        ClaudeSession session = new ClaudeSession(null, null, null);
        session.getState().setSessionId(SID);
        ctx.setSession(session);
        return ctx;
    }

    private static class FakeSettingsService extends CodemossSettingsService {
        private final int timeoutSeconds;

        private FakeSettingsService(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }

        @Override
        public int getPermissionDialogTimeoutSeconds() throws IOException {
            return timeoutSeconds;
        }
    }

    private static class FailingSettingsService extends CodemossSettingsService {
        @Override
        public int getPermissionDialogTimeoutSeconds() throws IOException {
            throw new IOException("simulated settings read failure");
        }
    }

    private static class FakeSafetyNetScheduler implements PermissionHandler.SafetyNetScheduler {
        private Runnable runnable;
        private long lastDelaySeconds;
        private FakeCancellableTask task;

        @Override
        public PermissionHandler.CancellableTask schedule(Runnable task, long delaySeconds) {
            this.runnable = task;
            this.lastDelaySeconds = delaySeconds;
            this.task = new FakeCancellableTask();
            return this.task;
        }
    }

    private static class FakeCancellableTask implements PermissionHandler.CancellableTask {
        private boolean cancelled;

        @Override
        public void cancel() {
            cancelled = true;
        }
    }
}
