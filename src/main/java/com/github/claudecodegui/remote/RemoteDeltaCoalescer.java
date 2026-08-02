package com.github.claudecodegui.remote;

import com.intellij.openapi.diagnostic.Logger;

import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Per-task content-delta coalescer for the Remote SSE stream.
 *
 * <p>The {@link com.github.claudecodegui.session.CallbackHandler} fan-out hands
 * this coalescer the <b>raw</b> {@code content_delta} strings (the 33ms desktop
 * throttler lives in {@code SessionCallbackAdapter} and is not shared). This
 * coalescer is the Remote protocol's own batching layer — independent of the
 * desktop throttler — so the wire is not flooded with one event per token.
 *
 * <p>Flush conditions (any one):
 * <ol>
 *   <li>pending text ends with a newline, or</li>
 *   <li>pending text ends with a sentence terminator ({@code . ! ? 。 ！ ？}), or</li>
 *   <li>pending length reaches {@code maxChunk}, or</li>
 *   <li>{@code maxWaitMs} elapses since the last flush (scheduled), or</li>
 *   <li>explicit {@link #flush()} (called on stream end / block reset / task terminal).</li>
 * </ol>
 *
 * <p>Thread-safe. The flush consumer (which publishes the {@code assistant.content}
 * event) is invoked <em>outside</em> the internal lock and must be non-blocking.
 * Never receives thinking content — the tap never appends thinking deltas here.
 */
public final class RemoteDeltaCoalescer {

    private static final Logger LOG = Logger.getInstance(RemoteDeltaCoalescer.class);

    private final Object lock = new Object();
    private final StringBuilder pending = new StringBuilder();
    private final RemoteDeltaFlushScheduler scheduler;
    private final LongSupplier clock;
    private final long maxWaitMs;
    private final int maxChunk;
    private final Consumer<String> flushConsumer;
    private boolean scheduled = false;
    private long lastFlushAtMs;
    private boolean disposed = false;

    public RemoteDeltaCoalescer(RemoteDeltaFlushScheduler scheduler,
                                LongSupplier clock,
                                long maxWaitMs,
                                int maxChunk,
                                Consumer<String> flushConsumer) {
        this.scheduler = scheduler;
        this.clock = clock;
        this.maxWaitMs = maxWaitMs;
        this.maxChunk = maxChunk;
        this.flushConsumer = flushConsumer;
        this.lastFlushAtMs = clock.getAsLong();
    }

    /** Append a raw content delta. May trigger an immediate flush. */
    public void append(String delta) {
        if (delta == null || delta.isEmpty()) {
            return;
        }
        boolean shouldFlush = false;
        synchronized (lock) {
            if (disposed) {
                return;
            }
            pending.append(delta);
            if (shouldFlushByContent()) {
                shouldFlush = true;
            } else {
                ensureScheduled();
            }
        }
        if (shouldFlush) {
            flush();
        }
    }

    /** Force-flush whatever is pending. Called on stream end / block reset / terminal. */
    public void flush() {
        String text = takePending();
        if (text != null) {
            deliver(text);
        }
    }

    /** Permanently stop the coalescer; cancels any pending scheduled flush. */
    public void dispose() {
        synchronized (lock) {
            disposed = true;
            scheduled = false;
            pending.setLength(0);
        }
        scheduler.cancel();
    }

    private String takePending() {
        synchronized (lock) {
            scheduler.cancel();
            scheduled = false;
            if (pending.length() == 0) {
                lastFlushAtMs = clock.getAsLong();
                return null;
            }
            String text = pending.toString();
            pending.setLength(0);
            lastFlushAtMs = clock.getAsLong();
            return text;
        }
    }

    private void deliver(String text) {
        try {
            flushConsumer.accept(text);
        } catch (Throwable t) {
            LOG.warn("[RemoteGateway] coalescer flush consumer threw: " + t.getMessage(), t);
        }
    }

    /** Called by the scheduler when the time-based flush fires. */
    private void onScheduledFlush() {
        String text = takePending();
        if (text != null) {
            deliver(text);
        }
    }

    private boolean shouldFlushByContent() {
        if (pending.length() >= maxChunk) {
            return true;
        }
        int len = pending.length();
        char last = pending.charAt(len - 1);
        return last == '\n' || last == '\r' || isSentenceEnd(last);
    }

    private static boolean isSentenceEnd(char c) {
        return c == '.' || c == '!' || c == '?' || c == '。' || c == '！' || c == '？';
    }

    private void ensureScheduled() {
        if (scheduled) {
            return;
        }
        scheduled = true;
        long delay = Math.max(0L, maxWaitMs - (clock.getAsLong() - lastFlushAtMs));
        scheduler.schedule(this::onScheduledFlush, delay);
    }
}
