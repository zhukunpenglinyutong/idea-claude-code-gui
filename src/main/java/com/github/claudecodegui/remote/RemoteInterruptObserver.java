package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

/**
 * Shared interrupt observer installed on {@link ClaudeSession}.
 *
 * <p>Fires whenever {@link ClaudeSession#interrupt()} is invoked on a session
 * with a live channel &mdash; regardless of caller (desktop Stop button, tab
 * switch, Remote {@code /abort}, history delete, ...). If the session has an
 * active Remote task, the first interrupt marks it abort-requested and emits
 * {@code task.abort_requested} (once), and <em>always</em> cancels the task's
 * pending permission/ask/plan interactions so no desktop dialog is left
 * stranded on an aborted turn (Phase 2C-C §21, §22).
 *
 * <p>If no Remote task is active (a pure desktop turn), this is a no-op &mdash;
 * the desktop interrupt path is unaffected (Phase 2C-C §45).
 */
final class RemoteInterruptObserver implements ClaudeSession.InterruptObserver {

    private final RemoteEventBus bus = RemoteEventBus.getInstance();
    private final RemoteTaskRegistry registry = RemoteTaskRegistry.getInstance();
    private final SharedInteractionResolver resolver = SharedInteractionResolver.getInstance();

    @Override
    public void onInterrupt(ClaudeSession session) {
        if (session == null) {
            return;
        }
        String sessionId;
        try {
            sessionId = session.getSessionId();
        } catch (Throwable t) {
            return;
        }
        handleInterrupt(sessionId);
    }

    /**
     * Core logic, keyed by sessionId (extracted so it is unit-testable without a
     * real {@link ClaudeSession}). If the session has an active Remote task, the
     * first interrupt marks it abort-requested and emits
     * {@code task.abort_requested} (once); pending interactions are always
     * cancelled. No active task &rarr; no-op (desktop-only interrupt).
     */
    void handleInterrupt(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }
        RemoteTask task = registry.getActiveBySession(sessionId);
        if (task == null) {
            // No active Remote task on this session — desktop-only interrupt; leave it alone.
            return;
        }

        // First interrupt wins the emit. A Remote /abort that already marked the
        // task before calling interrupt() will lose this CAS (no double emit).
        if (task.markAbortRequestedFirstTime()) {
            JsonObject payload = new JsonObject();
            payload.addProperty("state", "aborting");
            bus.publishForTask(task, task.projectId, task.tabId, "task.abort_requested",
                    task.taskId, task.getSessionId(), payload);
        }

        // Always cancel pending interactions for this session so an aborted turn
        // cannot leave a desktop permission/ask/plan dialog waiting forever, and
        // the gate can release once the send future terminates.
        try {
            resolver.cancelAllForSession(sessionId, "aborted");
        } catch (Throwable t) {
            // Best-effort cleanup; never let it destabilize the interrupt path.
        }
    }
}
