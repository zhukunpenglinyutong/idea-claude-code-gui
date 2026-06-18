package com.github.claudecodegui.interaction;

import com.github.claudecodegui.session.ClaudeSession;

import java.util.function.Supplier;

/**
 * Permission decision target for the SDK-session-callback path: routes the decision back through
 * {@code ClaudeSession.handlePermissionDecision(...)} / {@code handlePermissionDecisionAlways(...)},
 * which eventually completes the {@code PermissionRequest} the SDK is blocked on.
 *
 * <p>The session is resolved lazily via a supplier (the handler's {@code context::getSession}) so the
 * decision goes to whichever session is current at answer time — matching the behaviour of the old
 * inline session fallback.
 *
 * <p>These interactions are left untouched on session change ({@link SessionChangePolicy#KEEP_ON_SESSION_CHANGE}),
 * preserving today's behaviour where session-callback prompts are not tracked by the registry and
 * therefore not auto-denied when the user switches sessions.
 */
public final class SessionPermissionDecisionTarget implements PermissionDecisionTarget {

    private final Supplier<ClaudeSession> sessionSupplier;
    private final String channelId;
    private final Runnable deniedCallback;

    /**
     * @param deniedCallback run when the request is denied via {@link #deny()} (dialog failure),
     *                       mirroring the {@code notifyPermissionDenied()} the handler used to call
     *                       inline. Not run on a normal {@link #decide} — that deny path is already
     *                       notified by {@code PermissionHandler.handlePermissionDecision}.
     */
    public SessionPermissionDecisionTarget(Supplier<ClaudeSession> sessionSupplier, String channelId,
                                           Runnable deniedCallback) {
        this.sessionSupplier = sessionSupplier;
        this.channelId = channelId;
        this.deniedCallback = deniedCallback;
    }

    @Override
    public void decide(boolean allow, boolean remember, String rejectMessage) {
        ClaudeSession session = sessionSupplier.get();
        if (session == null) {
            return;
        }
        if (remember) {
            session.handlePermissionDecisionAlways(channelId, allow);
        } else {
            session.handlePermissionDecision(channelId, allow, false, rejectMessage);
        }
    }

    @Override
    public void deny() {
        ClaudeSession session = sessionSupplier.get();
        if (session != null) {
            // deny() is the failure path (dialog could not be shown), not an explicit user denial,
            // so report a reason that reflects that rather than a normal rejection.
            session.handlePermissionDecision(channelId, false, false, "Failed to show permission dialog");
        }
        if (deniedCallback != null) {
            deniedCallback.run();
        }
    }

    @Override
    public SessionChangePolicy sessionChangePolicy() {
        return SessionChangePolicy.KEEP_ON_SESSION_CHANGE;
    }
}
