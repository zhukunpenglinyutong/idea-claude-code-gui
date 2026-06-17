package com.github.claudecodegui.interaction;

/**
 * Observer notified when a user interaction is requested (registered and awaiting a response).
 *
 * <p>This is the seam that decouples "an interaction needs to be presented / announced" from how it
 * is handled. The webview presentation (PR-1c) and the manual-action sound (#1336, PR-2) attach here
 * as listeners instead of being wired directly into {@code PermissionHandler}.
 */
public interface UserInteractionListener {

    void userInteractionRequested(PendingUserInteraction interaction);
}
