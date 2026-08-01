package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Pure-logic tests for {@link PermissionModeService} (Phase 2C-C §25, §27, §37).
 *
 * <p>The platform-dependent side effects (PropertiesComponent, ClaudeNotifier,
 * live push) are each wrapped in try/catch so they degrade gracefully without
 * the IntelliJ application; the meaningful, testable contract is that the
 * session runtime state is updated and validation is enforced identically for
 * desktop and Remote.
 */
public class PermissionModeServiceTest {

    private ClaudeSession newSession() {
        return new ClaudeSession(null, null, null);
    }

    @Test
    public void applyUpdatesSessionRuntimeMode() {
        ClaudeSession session = newSession();
        String applied = PermissionModeService.apply(session, null, "acceptEdits", null, "claude");
        assertEquals("acceptEdits", applied);
        assertEquals("acceptEdits", session.getPermissionMode());
    }

    @Test
    public void applyEachValidMode() {
        for (String mode : new String[]{"default", "plan", "acceptEdits", "autoEdit", "bypassPermissions"}) {
            ClaudeSession session = newSession();
            String applied = PermissionModeService.apply(session, null, mode, null, "claude");
            assertEquals(mode, applied);
            assertEquals(mode, session.getPermissionMode());
        }
    }

    @Test
    public void applyRejectsInvalidModeAndLeavesSessionUnchanged() {
        ClaudeSession session = newSession();
        session.setPermissionMode("plan");
        assertNull(PermissionModeService.apply(session, null, "auto", null, "claude"));
        assertEquals("plan", session.getPermissionMode());
    }

    @Test
    public void applyRejectsNullSession() {
        assertNull(PermissionModeService.apply(null, null, "default", null, "claude"));
    }

    @Test
    public void applyRejectsNullMode() {
        assertNull(PermissionModeService.apply(newSession(), null, null, null, "claude"));
    }

    @Test
    public void bypassPermissionsFollowsSameGuardAsDesktop() {
        // No Remote-specific opt-in: the daemon-side allowDangerouslySkipPermissions
        // argv flag remains the enforcer. The service accepts bypassPermissions
        // exactly like the desktop handler (subject to SessionState validation).
        ClaudeSession session = newSession();
        String applied = PermissionModeService.apply(session, null, "bypassPermissions", null, "claude");
        assertEquals("bypassPermissions", applied);
        assertEquals("bypassPermissions", session.getPermissionMode());
    }

    @Test
    public void currentReturnsSessionModeWhenSet() {
        ClaudeSession session = newSession();
        session.setPermissionMode("plan");
        assertEquals("plan", PermissionModeService.current(session));
    }

    @Test
    public void currentDefaultsToDefaultForFreshSession() {
        // No session mode set; PropertiesComponent is unavailable in unit tests,
        // so the fallback returns "default".
        assertEquals("default", PermissionModeService.current(newSession()));
    }

    @Test
    public void codexProviderSkipsLivePushButStillAppliesRuntimeMode() {
        // Codex rebuilds thread options per turn — live push is Claude-only — but
        // the runtime mode is still applied (so a later Claude switch sees it).
        ClaudeSession session = newSession();
        session.setProvider("codex");
        String applied = PermissionModeService.apply(session, null, "acceptEdits", null, "codex");
        assertEquals("acceptEdits", applied);
        assertEquals("acceptEdits", session.getPermissionMode());
    }
}
