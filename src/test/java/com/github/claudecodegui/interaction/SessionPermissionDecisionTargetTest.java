package com.github.claudecodegui.interaction;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link SessionPermissionDecisionTarget}, focused on the denied-callback contract:
 * {@link SessionPermissionDecisionTarget#deny()} (dialog failure) must run the callback, while a
 * normal {@link SessionPermissionDecisionTarget#decide} must not (that deny path is notified by the
 * handler). The session supplier returns {@code null} here so no real session is required.
 */
public class SessionPermissionDecisionTargetTest {

    @Test
    public void denyRunsDeniedCallback() {
        boolean[] denied = {false};
        SessionPermissionDecisionTarget target =
                new SessionPermissionDecisionTarget(() -> null, "ch", () -> denied[0] = true);

        target.deny();

        assertTrue("deny() must run the denied callback (mirrors the old inline notify)", denied[0]);
    }

    @Test
    public void decideDoesNotRunDeniedCallback() {
        boolean[] denied = {false};
        SessionPermissionDecisionTarget target =
                new SessionPermissionDecisionTarget(() -> null, "ch", () -> denied[0] = true);

        target.decide(false, false, "rejected");

        assertFalse("decide() must not run the denied callback; the handler notifies that path", denied[0]);
    }

    @Test
    public void sessionChangePolicyIsKeep() {
        SessionPermissionDecisionTarget target =
                new SessionPermissionDecisionTarget(() -> null, "ch", () -> { });

        assertEquals(SessionChangePolicy.KEEP_ON_SESSION_CHANGE, target.sessionChangePolicy());
    }
}
