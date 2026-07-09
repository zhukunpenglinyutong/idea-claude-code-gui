package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.interaction.FuturePermissionDecisionTarget;
import com.github.claudecodegui.interaction.SessionPermissionDecisionTarget;
import com.github.claudecodegui.interaction.UserInteractionService;
import com.github.claudecodegui.interaction.UserInteractionType;
import com.github.claudecodegui.permission.PermissionService;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link WebviewUserInteractionPresenter}.
 *
 * <p>Drives the presenter through the {@link UserInteractionService} seam and captures the JS that
 * would be sent to the current window. The session-callback (project window) path needs a real
 * IDE tool window and is not exercised here.
 */
public class WebviewUserInteractionPresenterTest {

    @Test
    public void presentsPermissionWithRetryWrapperOnCurrentWindow() {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);

        service.requestPermission("ch-1", "Edit", new JsonObject(), null, null,
                new FuturePermissionDecisionTarget());

        assertEquals(1, ctx.scripts.size());
        String js = ctx.scripts.get(0);
        assertTrue("calls the permission frontend function", js.contains("window.showPermissionDialog("));
        assertTrue("uses the retry wrapper for the current window", js.contains("retryShowDialog"));
    }

    @Test
    public void presentsAskUserQuestionFunction() {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);

        service.requestAskUserQuestion("auq-1", new JsonObject());

        assertEquals(1, ctx.scripts.size());
        assertTrue(ctx.scripts.get(0).contains("window.showAskUserQuestionDialog("));
    }

    @Test
    public void presentsPlanApprovalFunction() {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);

        service.requestPlanApproval("plan-1", new JsonObject());

        assertEquals(1, ctx.scripts.size());
        assertTrue(ctx.scripts.get(0).contains("window.showPlanApprovalDialog("));
    }

    @Test
    public void presentationFailureResolvesInteractionAsDeny() throws Exception {
        ThrowingContext ctx = new ThrowingContext();
        UserInteractionService service = wirePresenter(ctx);

        FuturePermissionDecisionTarget target = new FuturePermissionDecisionTarget();
        service.requestPermission("ch-fail", "Edit", new JsonObject(), null, null, target);

        // The presenter caught the failure and resolved the interaction via the service.
        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                target.future().get(1, TimeUnit.SECONDS).intValue());
    }

    // --- force-close (#1360) re-integration via the observer seam ---

    @Test
    public void timeoutForceClosesTheDialogById() {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);
        service.requestPermission("ch-1", "Edit", new JsonObject(), null, null,
                new FuturePermissionDecisionTarget());

        boolean handled = service.timeout(UserInteractionType.PERMISSION, "ch-1");

        assertTrue(handled);
        assertTrue("timeout force-closes exactly this permission dialog by id",
                anyScriptContains(ctx, "window.forceClosePermissionDialog('ch-1')"));
    }

    @Test
    public void sessionChangeForceClosesEachDrainedTypeWithEmptyId() {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);
        service.requestPermission("ch-p", "Edit", new JsonObject(), null, null,
                new FuturePermissionDecisionTarget());
        service.requestAskUserQuestion("auq-1", new JsonObject());
        service.requestPlanApproval("plan-1", new JsonObject());

        service.cancelAllSessionChanged();

        assertTrue(anyScriptContains(ctx, "window.forceClosePermissionDialog('')"));
        assertTrue(anyScriptContains(ctx, "window.forceCloseAskUserQuestionDialog('')"));
        assertTrue(anyScriptContains(ctx, "window.forceClosePlanApprovalDialog('')"));
    }

    @Test
    public void onlyKeepPermissionIsNotForceClosedAndStaysRegistered() {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);
        // Session-callback permission: KEEP_ON_SESSION_CHANGE policy (null session supplier is fine).
        service.requestPermission("ch-keep", "Edit", new JsonObject(), null, null,
                new SessionPermissionDecisionTarget(() -> null, "ch-keep", () -> { }));

        service.cancelAllSessionChanged();

        assertFalse("KEEP-only session change force-closes nothing", anyScriptContains(ctx, "forceClose"));
        assertEquals("KEEP interaction stays registered", 1, service.count(UserInteractionType.PERMISSION));
    }

    @Test
    public void denyPlusKeepPermissionForceClosesTypeAndKeepsKeepRegistered() throws Exception {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);
        FuturePermissionDecisionTarget deny = new FuturePermissionDecisionTarget();
        service.requestPermission("ch-deny", "Edit", new JsonObject(), null, null, deny);
        service.requestPermission("ch-keep", "Edit", new JsonObject(), null, null,
                new SessionPermissionDecisionTarget(() -> null, "ch-keep", () -> { }));

        service.cancelAllSessionChanged();

        assertTrue("a drained DENY permission force-closes the whole permission type",
                anyScriptContains(ctx, "window.forceClosePermissionDialog('')"));
        assertEquals("the DENY interaction was resolved with DENY",
                PermissionService.PermissionResponse.DENY.getValue(), deny.future().get(1, TimeUnit.SECONDS).intValue());
        assertEquals("the KEEP interaction stays registered", 1, service.count(UserInteractionType.PERMISSION));
    }

    @Test
    public void answerThenTimeoutDoesNotForceClose() {
        CapturingContext ctx = new CapturingContext();
        UserInteractionService service = wirePresenter(ctx);
        service.requestPermission("ch-x", "Edit", new JsonObject(), null, null,
                new FuturePermissionDecisionTarget());

        assertTrue(service.answer(UserInteractionType.PERMISSION, "ch-x", permissionDecision(true, false)));
        boolean timedOut = service.timeout(UserInteractionType.PERMISSION, "ch-x");

        assertFalse("a late timeout after an answer finds nothing (atomic-remove race-guard)", timedOut);
        assertFalse("no force-close is pushed for the already-answered interaction",
                anyScriptContains(ctx, "forceClose"));
    }

    private static JsonObject permissionDecision(boolean allow, boolean remember) {
        JsonObject json = new JsonObject();
        json.addProperty("allow", allow);
        json.addProperty("remember", remember);
        return json;
    }

    private static boolean anyScriptContains(CapturingContext ctx, String needle) {
        return ctx.scripts.stream().anyMatch(s -> s.contains(needle));
    }

    private static UserInteractionService wirePresenter(HandlerContext ctx) {
        UserInteractionService service = new UserInteractionService();
        service.addListener(new WebviewUserInteractionPresenter(ctx, service));
        return service;
    }

    private static HandlerContext.JsCallback identityJsCallback() {
        return new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        };
    }

    /** Captures the JS the presenter would post to the current window. */
    private static final class CapturingContext extends HandlerContext {
        private final List<String> scripts = new ArrayList<>();

        private CapturingContext() {
            super(null, null, null, null, identityJsCallback());
        }

        @Override
        public void executeJavaScriptOnEDT(String jsCode) {
            scripts.add(jsCode);
        }
    }

    /** Simulates a presentation failure so the catch path can be verified. */
    private static final class ThrowingContext extends HandlerContext {
        private ThrowingContext() {
            super(null, null, null, null, identityJsCallback());
        }

        @Override
        public void executeJavaScriptOnEDT(String jsCode) {
            throw new RuntimeException("boom");
        }
    }
}
