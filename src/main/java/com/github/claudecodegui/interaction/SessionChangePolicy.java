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
    /**
     * Leave registered and untouched on session change.
     *
     * <p>Trade-off (accepted): a session-callback permission that is never answered keeps its
     * (small) registry entry for the handler's lifetime, since we deliberately do not auto-resolve
     * it — its completion is owned by the SDK session (matching the pre-existing behaviour where
     * these prompts were not tracked here at all). The accumulation is bounded in practice and its
     * impact is negligible; if it ever needs bounding, an eviction hook belongs in
     * {@link PendingUserInteractions#cancelAllSessionChanged()}. We intentionally avoid auto-denying
     * these here to not change permission-decision behaviour.
     */
    KEEP_ON_SESSION_CHANGE
}
