package com.github.claudecodegui.interaction;

import java.util.Set;

/**
 * Observer notified about the lifecycle of in-flight user interactions.
 *
 * <p>This is the seam that decouples "an interaction needs to be presented / announced / torn down"
 * from how it is handled. The webview presentation (PR-1c), the manual-action sound (#1336, PR-2) and
 * the webview force-close / AskUserQuestion reminder (re-integrated from v0.4.7) attach here as
 * listeners instead of being wired directly into {@code PermissionHandler}.
 */
public interface UserInteractionListener {

    void userInteractionRequested(PendingUserInteraction interaction);

    /**
     * A single interaction was auto-resolved by its safety-net timeout. Used to force-close the
     * still-open webview dialog for exactly this interaction (issue #1360).
     */
    default void userInteractionTimedOut(PendingUserInteraction interaction) {
    }

    /**
     * On session change, the given interaction types had at least one {@code DENY_ON_SESSION_CHANGE}
     * interaction resolved and dropped. Used to force-close all open webview dialogs of those types
     * (issue #1360; type-based sweep, matching v0.4.7's {@code forceClose<Type>Dialog(null)}).
     */
    default void userInteractionsClearedBySessionChange(Set<UserInteractionType> drainedTypes) {
    }
}
