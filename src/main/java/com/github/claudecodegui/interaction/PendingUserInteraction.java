package com.github.claudecodegui.interaction;

import java.util.concurrent.CompletableFuture;

/**
 * A single in-flight user interaction awaiting a response from the frontend.
 *
 * <p>Encapsulates the {@link CompletableFuture} that the backend caller is blocked on, together
 * with the interaction's {@link UserInteractionType type} and request id. Concrete subclasses
 * only have to declare the value used to resolve the future when the session changes underneath
 * a still-open dialog (see {@link #cancelSessionChanged()}).
 *
 * @param <T> the type the future completes with ({@code Integer} for permission decisions,
 *            {@code JsonObject} for question / plan responses).
 */
public abstract class PendingUserInteraction<T> {

    private final UserInteractionType type;
    private final String id;
    private final CompletableFuture<T> future = new CompletableFuture<>();

    protected PendingUserInteraction(UserInteractionType type, String id) {
        if (type == null) {
            throw new IllegalArgumentException("type must not be null");
        }
        if (id == null || id.trim().isEmpty()) {
            throw new IllegalArgumentException("id must not be empty");
        }
        this.type = type;
        this.id = id;
    }

    public UserInteractionType type() {
        return type;
    }

    public String id() {
        return id;
    }

    public CompletableFuture<T> future() {
        return future;
    }

    /**
     * Resolve the future with the given value.
     *
     * <p>Returns the result of {@link CompletableFuture#complete(Object)} so callers can rely on
     * the atomic winner/loser contract the safety-net timers depend on.
     */
    public boolean complete(T value) {
        return future.complete(value);
    }

    /**
     * The value used to resolve the future when the user switches sessions while this interaction
     * is still on screen. Must be a default-deny / reject style payload so the issuing agent does
     * not hang until the backend safety-net timer fires.
     */
    protected abstract T sessionChangedValue();

    /** Resolve the future with {@link #sessionChangedValue()}. */
    public void cancelSessionChanged() {
        future.complete(sessionChangedValue());
    }
}
