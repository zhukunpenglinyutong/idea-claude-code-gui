package com.github.claudecodegui.session;

import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

/**
 * Shared permission-mode apply/get logic (Phase 2C-C §25).
 *
 * <p>Extracted from {@code PermissionModeHandler} so the desktop handler and the
 * Remote gateway invoke <em>one</em> business method that performs the full
 * desktop mode-change side-effect chain:
 * <ol>
 *   <li>{@link SessionState#setPermissionMode} (runtime + {@code PermissionManager}).</li>
 *   <li>Application {@link PropertiesComponent} ({@code claude.code.permission.mode}).</li>
 *   <li>{@link ClaudeNotifier#setMode} notification.</li>
 *   <li>Claude live push ({@code ClaudeSDKBridge.setPermissionModeLive}) &mdash;
 *       Claude provider only; Codex rebuilds thread options per turn.</li>
 * </ol>
 *
 * <p>{@code bypassPermissions} is subject to the same guard as the desktop: it
 * is only accepted because {@link SessionState#setPermissionMode} validates
 * against {@link SessionState#VALID_PERMISSION_MODES}; the daemon-side
 * {@code allowDangerouslySkipPermissions} argv flag (frozen at process start)
 * remains the ultimate enforcer. No Remote-specific bypass is introduced
 * (Phase 2C-C §27).
 */
public final class PermissionModeService {

    private static final Logger LOG = Logger.getInstance(PermissionModeService.class);

    /** Application-level persistent key mirroring the desktop handler. */
    public static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";

    private PermissionModeService() {
    }

    /**
     * Apply {@code mode} to the session + global state + live runtime. Returns
     * the applied (trimmed) mode, or {@code null} if the mode is invalid.
     *
     * @param session      the target tab's session (drives runtime + live push)
     * @param project      the project (for the notifier)
     * @param mode         the requested mode string
     * @param claudeBridge the Claude SDK bridge for live push (null if unavailable)
     * @param provider     the effective provider (used for the Claude-only live guard)
     */
    public static String apply(ClaudeSession session, Project project, String mode,
                               ClaudeSDKBridge claudeBridge, String provider) {
        if (session == null || mode == null || !SessionState.isValidPermissionMode(mode)) {
            return null;
        }
        String trimmed = mode.trim();

        // 1. Runtime state + PermissionManager mapping (deny/accept-edits/allow-all).
        session.setPermissionMode(trimmed);

        // 2. Global application persistence.
        try {
            PropertiesComponent.getInstance().setValue(PERMISSION_MODE_PROPERTY_KEY, trimmed);
        } catch (Throwable t) {
            LOG.warn("[PermissionModeService] Failed to persist mode: " + t.getMessage());
        }

        // 3. Opt-in system notification.
        try {
            ClaudeNotifier.setMode(project, trimmed);
        } catch (Throwable t) {
            LOG.warn("[PermissionModeService] Notifier setMode failed: " + t.getMessage());
        }

        // 4. Live push to the running daemon (Claude only).
        pushLive(session, claudeBridge, trimmed, provider);

        return trimmed;
    }

    /**
     * Read the effective current mode for a session, falling back to the
     * persisted global value when the session has no mode set.
     */
    public static String current(ClaudeSession session) {
        if (session != null) {
            String sessionMode = session.getPermissionMode();
            if (sessionMode != null && !sessionMode.trim().isEmpty()) {
                return sessionMode;
            }
        }
        try {
            String saved = PropertiesComponent.getInstance().getValue(PERMISSION_MODE_PROPERTY_KEY);
            if (saved != null && !saved.trim().isEmpty()) {
                return saved.trim();
            }
        } catch (Throwable t) {
            LOG.debug("[PermissionModeService] PropertiesComponent read failed: " + t.getMessage());
        }
        return "default";
    }

    private static void pushLive(ClaudeSession session, ClaudeSDKBridge claudeBridge,
                                 String mode, String provider) {
        try {
            String effectiveProvider = (provider == null || provider.isEmpty())
                    ? "claude" : provider;
            // Only the Claude persistent runtime supports hot-swapping the mode on a
            // live query today; Codex rebuilds thread options per turn.
            if (!"claude".equals(effectiveProvider)) {
                return;
            }
            if (claudeBridge == null || session == null) {
                return;
            }
            String sessionId = session.getSessionId();
            String epoch = session.getRuntimeSessionEpoch();
            claudeBridge.setPermissionModeLive(sessionId, epoch, mode)
                    .exceptionally(ex -> {
                        LOG.warn("[PermissionModeService] Live mode push failed: " + ex.getMessage());
                        return null;
                    });
        } catch (Throwable t) {
            LOG.warn("[PermissionModeService] Live mode push skipped: " + t.getMessage());
        }
    }
}
