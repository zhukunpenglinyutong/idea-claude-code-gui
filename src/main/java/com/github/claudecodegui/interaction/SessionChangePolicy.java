package com.github.claudecodegui.interaction;

/**
 * What should happen to a pending interaction when the user switches sessions while it is still
 * open (see {@code PermissionHandler.clearPendingRequests}).
 *
 * <p>Modelled explicitly rather than as an ad-hoc {@code if} so the difference between the two
 * permission paths is a declared property, not hidden control flow: registry/future-backed
 * interactions are resolved with a deny payload, while session-callback permissions are left in
 * place (their completion is owned by the SDK session, which is what happens today when they are
 * not tracked at all).
 */
public enum SessionChangePolicy {
    /** Resolve with a default-deny / reject payload and drop on session change. */
    DENY_ON_SESSION_CHANGE,
    /** Leave registered and untouched on session change. */
    KEEP_ON_SESSION_CHANGE
}
