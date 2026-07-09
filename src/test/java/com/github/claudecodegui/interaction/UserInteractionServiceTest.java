package com.github.claudecodegui.interaction;

import com.github.claudecodegui.permission.PermissionService;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link UserInteractionService}: the single lifecycle both permission paths,
 * AskUserQuestion and PlanApproval flow through.
 *
 * <p>The file-watcher permission path uses {@link FuturePermissionDecisionTarget} (DENY-on-change);
 * the session-callback path uses a session target (KEEP-on-change). Here the session target is a
 * {@link RecordingTarget} so we can assert the routing without a real {@code ClaudeSession}.
 */
public class UserInteractionServiceTest {

    private UserInteractionService service;
    private List<PendingUserInteraction> requested;

    @Before
    public void setUp() {
        service = new UserInteractionService();
        requested = new ArrayList<>();
        service.addListener(requested::add);
    }

    private static JsonObject decision(boolean allow, boolean remember, String rejectMessage) {
        JsonObject json = new JsonObject();
        json.addProperty("allow", allow);
        json.addProperty("remember", remember);
        if (rejectMessage != null) {
            json.addProperty("rejectMessage", rejectMessage);
        }
        return json;
    }

    @Test
    public void filePathPermissionFiresRequestedAndCompletesFutureWithAllow() throws Exception {
        FuturePermissionDecisionTarget target = new FuturePermissionDecisionTarget();
        service.requestPermission("ch-1", "Edit", new JsonObject(), null, null, target);

        assertEquals(1, requested.size());
        assertEquals(UserInteractionType.PERMISSION, requested.get(0).type());

        assertTrue(service.answer(UserInteractionType.PERMISSION, "ch-1", decision(true, false, null)));
        assertEquals(PermissionService.PermissionResponse.ALLOW.getValue(),
                target.future().get(1, TimeUnit.SECONDS).intValue());
        assertEquals(0, service.count(UserInteractionType.PERMISSION));
    }

    @Test
    public void filePathPermissionRemembersAsAllowAlways() throws Exception {
        FuturePermissionDecisionTarget target = new FuturePermissionDecisionTarget();
        service.requestPermission("ch-2", "Bash", new JsonObject(), null, null, target);

        assertTrue(service.answer(UserInteractionType.PERMISSION, "ch-2", decision(true, true, null)));
        assertEquals(PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue(),
                target.future().get(1, TimeUnit.SECONDS).intValue());
    }

    @Test
    public void sessionPathPermissionFiresRequestedAndRoutesDecisionToTarget() {
        RecordingTarget target = new RecordingTarget(SessionChangePolicy.KEEP_ON_SESSION_CHANGE);
        service.requestPermission("ch-3", "Write", new JsonObject(), null, null, target);

        assertEquals(1, requested.size());
        assertEquals(UserInteractionType.PERMISSION, requested.get(0).type());

        assertTrue(service.answer(UserInteractionType.PERMISSION, "ch-3", decision(false, false, "nope")));
        assertTrue(target.decideCalled);
        assertFalse(target.allow);
        assertFalse(target.remember);
        assertEquals("nope", target.rejectMessage);
    }

    @Test
    public void cancelAllSessionChangedDeniesDenyPolicyButKeepsSessionPermissions() throws Exception {
        FuturePermissionDecisionTarget filePerm = new FuturePermissionDecisionTarget();
        service.requestPermission("ch-deny", "Edit", new JsonObject(), null, null, filePerm);

        RecordingTarget sessionPerm = new RecordingTarget(SessionChangePolicy.KEEP_ON_SESSION_CHANGE);
        service.requestPermission("ch-keep", "Edit", new JsonObject(), null, null, sessionPerm);

        CompletableFuture<JsonObject> ask = service.requestAskUserQuestion("auq-1", new JsonObject());

        service.cancelAllSessionChanged();

        // DENY-policy interactions are resolved and dropped.
        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                filePerm.future().get(1, TimeUnit.SECONDS).intValue());
        assertNull("askUser session-change resolves with null", ask.get(1, TimeUnit.SECONDS));
        assertEquals(0, service.count(UserInteractionType.ASK_USER_QUESTION));

        // The KEEP-policy session permission is left in place and not auto-denied.
        assertFalse("session permission must not be auto-denied", sessionPerm.denyCalled);
        assertEquals(1, service.count(UserInteractionType.PERMISSION));
    }

    @Test
    public void answerForUnknownInteractionReturnsFalse() {
        assertFalse(service.answer(UserInteractionType.PERMISSION, "missing", decision(true, false, null)));
    }

    /** Fake permission target that records how the decision was routed. */
    private static final class RecordingTarget implements PermissionDecisionTarget {
        private final SessionChangePolicy policy;
        private boolean decideCalled;
        private boolean denyCalled;
        private boolean allow;
        private boolean remember;
        private String rejectMessage;

        private RecordingTarget(SessionChangePolicy policy) {
            this.policy = policy;
        }

        @Override
        public void decide(boolean allow, boolean remember, String rejectMessage) {
            this.decideCalled = true;
            this.allow = allow;
            this.remember = remember;
            this.rejectMessage = rejectMessage;
        }

        @Override
        public void deny() {
            this.denyCalled = true;
        }

        @Override
        public SessionChangePolicy sessionChangePolicy() {
            return policy;
        }
    }
}
