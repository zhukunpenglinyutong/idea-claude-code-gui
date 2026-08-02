package com.github.claudecodegui.remote;

/**
 * Immutable gateway-generation ownership token + the start/closing lifecycle
 * boundary that serializes "start a real Remote turn" with "the gateway
 * generation begins closing" (Phase 2C-C.1 turn-start/dispose closure).
 *
 * <p>A gateway captures one instance at start
 * ({@code generation = RemoteEventBus.currentGeneration()}) and every handler /
 * dispatcher for that gateway carries it. {@link #generation()} is the immutable
 * ownership token (bound into {@code RemoteTask.busGeneration} and subscribers).
 * The {@link #startLock} + {@code closing} flag form the start boundary.
 *
 * <p>{@link #tryStartTurn(Runnable)} and {@link #beginClosing()} are mutually
 * exclusive on {@link #startLock}. A turn either crosses the start boundary —
 * its start action (which establishes the real {@code ClaudeSession.send} channel
 * synchronously) runs to completion under the lock — <em>before</em> closing is
 * marked, or closing is marked first and the turn's {@code tryStartTurn} returns
 * {@code false} (it must NOT send). This makes the post-dispose turn-start race
 * impossible:
 * <ul>
 *   <li>If start wins, the channel is already established when dispose's abort
 *       (which follows {@code beginClosing}) runs, so {@code session.interrupt()}
 *       finds a live channel and genuinely aborts the turn (OPTION A).</li>
 *   <li>If closing wins, the turn never calls {@code send}; it releases its
 *       never-used lease and rejects. No orphan task, no leaked gate.</li>
 * </ul>
 *
 * <p>The lock is held ONLY across the synchronous start action (channel
 * establishment) — NOT for the duration of the turn, NOT across EDT tab
 * resolution or context collection (those run outside {@code tryStartTurn} /
 * asynchronously after {@code send} returns).
 */
final class RemoteGatewayGeneration {

    private final long generation;
    private final Object startLock = new Object();
    private volatile boolean closing = false;

    RemoteGatewayGeneration(long generation) {
        this.generation = generation;
    }

    /** The immutable ownership token for this gateway (bound into tasks/subscribers). */
    long generation() {
        return generation;
    }

    /** True once {@link #beginClosing()} has marked this generation as closing. */
    boolean isClosing() {
        return closing;
    }

    /**
     * Attempt to cross the start boundary for a new turn.
     *
     * <p>Runs {@code startAction} UNDER {@link #startLock} only if this generation is
     * still open. The action must register the task and establish the real send
     * lifecycle (call {@code ClaudeSession.send}, whose synchronous portion sets the
     * channel id). Holding the lock across the action's channel-establishing step
     * guarantees that a later {@link #beginClosing()} → abort interrupt lands on a
     * live channel (start wins), and that if closing was marked first the action
     * never runs (closing wins). The action may throw to signal a synchronous
     * send-start failure; the caller handles cleanup.
     *
     * @return true if the action ran (turn started); false if the generation is
     *         closing (the caller must NOT send and must release any acquired lease)
     */
    boolean tryStartTurn(Runnable startAction) {
        synchronized (startLock) {
            if (closing) {
                return false;
            }
            startAction.run();
            return true;
        }
    }

    /**
     * Mark this generation as closing. After this returns, no new turn may cross
     * the start boundary ({@link #tryStartTurn} will return {@code false}). Turns
     * that already crossed (registered + channel established under the lock, before
     * this call acquired it) remain visible to the abort lifecycle that the caller
     * runs next (e.g. {@code RemoteTaskRegistry.requestAbortAllActive()}).
     */
    void beginClosing() {
        synchronized (startLock) {
            closing = true;
        }
    }
}
