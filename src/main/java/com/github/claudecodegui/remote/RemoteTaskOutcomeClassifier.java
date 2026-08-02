package com.github.claudecodegui.remote;

/**
 * Classifies a Remote task's terminal state.
 *
 * <p>{@code ClaudeSession.send} returns a {@code CompletableFuture<Void>} whose
 * {@code .exceptionally} swallows turn errors and returns {@code null}, so
 * <b>future completion alone cannot distinguish success from failure</b>. The
 * classifier instead combines:
 * <ul>
 *   <li>{@code abortRequested} — set when an abort is requested (future phases).</li>
 *   <li>{@code failureObserved} — set when the tap observed an error during the
 *       turn ({@code onStateChange(error)} / {@code onError}).</li>
 *   <li>{@code syncException} — {@code send} threw synchronously before
 *       returning a future.</li>
 * </ul>
 *
 * <p>Priority: sync exception → FAILED; abortRequested → ABORTED; failureObserved
 * → FAILED; otherwise COMPLETED. {@code abortRequested} takes precedence over
 * {@code failureObserved} because an abort may surface as a provider error
 * while still being a user-initiated stop.
 *
 * <p>Pure logic — unit tested.
 */
public final class RemoteTaskOutcomeClassifier {

    private RemoteTaskOutcomeClassifier() {
    }

    public static RemoteTaskState classify(boolean abortRequested,
                                           boolean failureObserved,
                                           boolean syncException) {
        if (syncException) {
            return RemoteTaskState.FAILED;
        }
        if (abortRequested) {
            return RemoteTaskState.ABORTED;
        }
        if (failureObserved) {
            return RemoteTaskState.FAILED;
        }
        return RemoteTaskState.COMPLETED;
    }
}
