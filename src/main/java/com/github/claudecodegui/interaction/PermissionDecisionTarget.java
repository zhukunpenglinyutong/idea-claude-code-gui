package com.github.claudecodegui.interaction;

/**
 * Where a permission decision is delivered once the user answers.
 *
 * <p>A {@link PendingPermissionInteraction} shares the same lifecycle regardless of which path
 * created it; only the completion differs. The file-watcher path completes a
 * {@code CompletableFuture<Integer>} that {@code PermissionService} awaits; the SDK-session path
 * routes the decision back through {@code ClaudeSession.handlePermissionDecision(...)}. Each target
 * also declares its {@link SessionChangePolicy}, so the registry knows whether the interaction may
 * be auto-denied on session change.
 */
public interface PermissionDecisionTarget {

    /** Deliver the user's decision. */
    void decide(boolean allow, boolean remember, String rejectMessage);

    /** Deliver a default deny (timeout / dialog failure / forced deny). */
    void deny();

    SessionChangePolicy sessionChangePolicy();
}
