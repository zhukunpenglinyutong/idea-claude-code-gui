package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;

/**
 * A single in-flight user interaction awaiting a response from the frontend.
 *
 * <p>The three concrete kinds (permission / askUserQuestion / planApproval) share one lifecycle —
 * <em>registered -&gt; (answered | session-changed | timeout | dialog-failed)</em> — but each
 * resolves its own {@code CompletableFuture} with a type-specific payload. That payload logic lives
 * entirely in the concrete classes, so {@link PendingUserInteractions} and {@code PermissionHandler}
 * only ever call these common lifecycle methods on the abstraction and never have to downcast.
 *
 * <p>Each method returns the result of the underlying {@code CompletableFuture.complete(...)} so the
 * atomic winner/loser contract that the safety-net timers rely on is preserved.
 */
public interface PendingUserInteraction {

    UserInteractionType type();

    String id();

    /** Resolve the future from a frontend bridge response payload. */
    boolean completeFromBridgeResponse(JsonObject payload);

    /** Resolve the future with a default-deny / reject payload because the session changed. */
    boolean cancelSessionChanged();

    /** Resolve the future with a default-deny / reject payload because the dialog timed out. */
    boolean timeout();

    /** Resolve the future with a default-deny / reject payload because the dialog failed to show. */
    boolean dialogFailed();
}
