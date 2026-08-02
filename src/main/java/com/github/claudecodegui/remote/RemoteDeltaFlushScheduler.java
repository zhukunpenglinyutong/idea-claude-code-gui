package com.github.claudecodegui.remote;

/**
 * Scheduler hook for {@link RemoteDeltaCoalescer}'s time-based flush.
 *
 * <p>Production wires this to a shared {@link java.util.concurrent.ScheduledExecutorService};
 * tests inject a fake to drive flushes deterministically without
 * {@code Thread.sleep}.
 */
public interface RemoteDeltaFlushScheduler {

    /** Schedule (or reschedule) {@code runnable} to run after {@code delayMs}. */
    void schedule(Runnable runnable, long delayMs);

    /** Cancel the pending scheduled flush, if any. */
    void cancel();
}
