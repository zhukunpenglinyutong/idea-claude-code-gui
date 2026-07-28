package com.github.claudecodegui.ui.toolwindow;

/**
 * Serializes webview message dispatch against tool-window disposal.
 *
 * <p>The JCEF UI thread calls {@link #runInDispatch(Runnable)} for each inbound message; the EDT
 * calls {@link #beginTeardown()} at the start of {@code ClaudeChatWindow.dispose()}. Both contend
 * the same monitor, so teardown waits for any in-flight dispatch to finish before flipping
 * {@code disposed}, and no dispatch can start once teardown has begun.</p>
 *
 * <p>This restores the dispatch/dispose lifecycle exclusion that the lock-free version removed,
 * without reintroducing the EDT&lt;-&gt;JCEF deadlock: {@code beginTeardown()} only holds this
 * gate's monitor for the check-and-set, so the heavy teardown that follows (browser.dispose,
 * process cleanup) runs outside any monitor the JCEF callback needs. A JCEF message arriving after
 * teardown began acquires the gate, sees {@code disposed}, and returns immediately - it never waits
 * on the EDT.</p>
 *
 * <p>The class is pure Java with no platform dependencies so its concurrency contract can be
 * exercised deterministically with latches/barriers.</p>
 *
 * <p>Dispatch tasks must not synchronously block on the EDT (e.g. via {@code invokeAndWait}):
 * {@code runInDispatch} holds the gate monitor while the task runs, and dispose's
 * {@code beginTeardown()} waits for that monitor, so a task that waits on the EDT while the EDT is
 * entering teardown would deadlock the two threads. Handlers already offload EDT work via
 * {@code invokeLater} or background threads; this constraint keeps that invariant explicit.</p>
 */
public final class MessageDispatchGate {

    private boolean disposed = false;

    /**
     * Run a dispatch section while holding the gate.
     *
     * @param task the dispatch work to run under the gate monitor.
     * @return {@code true} if the task ran; {@code false} if teardown has already begun (the task
     *         did not run and no handler side effect is possible).
     */
    public synchronized boolean runInDispatch(Runnable task) {
        if (this.disposed) {
            return false;
        }
        task.run();
        return true;
    }

    /**
     * Begin teardown: atomically mark the gate disposed and wait for any in-flight dispatch to
     * drain. Acquiring this monitor blocks until the currently running dispatch (if any) releases
     * it, so once this returns no dispatch is in flight and none can start.
     *
     * @return {@code true} if this call flipped the gate to disposed; {@code false} if teardown had
     *         already begun (idempotent re-entry).
     */
    public synchronized boolean beginTeardown() {
        if (this.disposed) {
            return false;
        }
        this.disposed = true;
        return true;
    }

    /**
     * @return whether teardown has begun.
     */
    public synchronized boolean isDisposed() {
        return this.disposed;
    }
}
