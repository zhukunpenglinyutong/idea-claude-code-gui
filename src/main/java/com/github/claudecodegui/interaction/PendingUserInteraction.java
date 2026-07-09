package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;

/**
 * A single in-flight user interaction awaiting a response from the frontend.
 *
 * <p>The three concrete kinds (permission / askUserQuestion / planApproval) share one lifecycle —
 * <em>registered -&gt; (answered | session-changed | timeout | dialog-failed)</em> — but each
 * resolves its own completion channel with a type-specific payload. That logic lives entirely in the
 * concrete classes, so {@link PendingUserInteractions} and {@code UserInteractionService} only ever
 * call these common methods and never have to downcast.
 *
 * <p>{@link #toFrontendPayload()} and {@link #targetProject()} expose what a presenter needs to show
 * the dialog, so the webview presentation can later move behind {@link UserInteractionListener}
 * without re-plumbing.
 */
public interface PendingUserInteraction {

    UserInteractionType type();

    String id();

    /** How this interaction should be treated on session change. */
    SessionChangePolicy sessionChangePolicy();

    /** The JSON payload a presenter passes to the frontend dialog. */
    JsonObject toFrontendPayload();

    /** The {@code window.<name>} JS function a presenter calls to show this interaction's dialog. */
    String frontendFunctionName();

    /** The project whose window should show the dialog, or {@code null} for the current window. */
    default Project targetProject() {
        return null;
    }

    /** Resolve from a frontend bridge response payload. */
    void completeFromBridgeResponse(JsonObject payload);

    /** Resolve with a default-deny / reject payload because the session changed. */
    void cancelSessionChanged();

    /** Resolve with a default-deny / reject payload because the dialog timed out. */
    void timeout();

    /** Resolve with a default-deny / reject payload because the dialog failed to show. */
    void dialogFailed();
}
