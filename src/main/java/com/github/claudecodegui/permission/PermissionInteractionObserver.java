package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;

/**
 * Observer SPI for permission / AskUserQuestion / Plan Approval interactions.
 *
 * <p>Implemented by the Remote gateway and registered statically on
 * {@link PermissionService}. Notifications fire at the source-aware hook
 * ({@link PermissionService#dispatchPermissionDialog} and friends), where the
 * service knows the request's source {@code project} + {@code sessionId} +
 * {@code requestId} — independent of which window the dialog router ultimately
 * displays the dialog in (Phase 2C-A.1 §5).
 *
 * <p>Read-only observation this phase; the Remote side does not resolve
 * interactions (deferred to Phase 2C-C).
 */
public interface PermissionInteractionObserver {

    /**
     * Resolve the daemon session identity used by the shared interaction
     * registry for a request emitted by a window-scoped PermissionService.
     *
     * <p>The default keeps non-Remote observers source-compatible. The Remote
     * observer returns a value only while that window has an active Remote task.
     */
    default String resolveInteractionSessionId(Project project, String permissionSessionId) {
        return null;
    }

    void onPermissionRequested(Project project, String sessionId, String requestId,
                               String toolName, JsonObject inputs);

    void onPermissionResolved(String sessionId, String requestId,
                              boolean allow, boolean alwaysAllow);

    void onAskUserQuestionRequested(Project project, String sessionId, String requestId,
                                    JsonObject questions);

    void onAskUserQuestionResolved(String sessionId, String requestId, JsonObject answers);

    void onPlanApprovalRequested(Project project, String sessionId, String requestId,
                                 JsonObject planData);

    void onPlanApprovalResolved(String sessionId, String requestId,
                                boolean approved, String targetMode);
}
