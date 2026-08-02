package com.github.claudecodegui.remote;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * One SSE subscriber's bounded queue for a tab.
 *
 * <p>Each {@code GET /events} connection gets its own subscriber so multiple
 * clients can stream the same tab independently. The queue is bounded
 * ({@link RemoteGatewayLimits#MAX_EVENTS_PER_SUBSCRIBER}); a slow client that
 * lets the queue fill is marked {@link #isOverflowed()} and the SSE writer
 * closes the connection after emitting a {@code stream.overflow} event.
 *
 * <p>Thread-safe: producers ({@link RemoteEventBus}) {@link #offer}, the SSE
 * writer thread {@link #poll} drains.
 */
public final class RemoteEventSubscriber {

    private final String tabId;
    private final ArrayBlockingQueue<RemoteEvent> queue;
    private volatile boolean overflowed = false;
    private volatile boolean closed = false;

    /**
     * The bus generation this subscriber was created in (Phase 2C-C.1
     * generation-atomicity closure). Immutable. A subscriber created in
     * generation G can only ever receive events whose expected generation is G;
     * {@link RemoteEventBus#publishForGeneration} enforces this at offer time.
     * Because the tag is final, the generation check and the offer form a single
     * atomic decision relative to {@code close()}/generation rotation — there is
     * no check-then-publish window for a stale event to slip through.
     */
    final long generation;

    public RemoteEventSubscriber(String tabId, int capacity, long generation) {
        this.tabId = tabId;
        this.queue = new ArrayBlockingQueue<>(Math.max(1, capacity));
        this.generation = generation;
    }

    public String getTabId() {
        return tabId;
    }

    /** The bus generation this subscriber belongs to (immutable). */
    public long getGeneration() {
        return generation;
    }

    /** Non-blocking offer. Returns false (and marks overflow) if the queue is full. */
    public boolean offer(RemoteEvent event) {
        if (closed || event == null) {
            return false;
        }
        boolean added = queue.offer(event);
        if (!added) {
            overflowed = true;
        }
        return added;
    }

    /** Blocking poll with timeout for the SSE writer loop. Returns null on timeout. */
    public RemoteEvent poll(long timeoutMs) throws InterruptedException {
        return queue.poll(timeoutMs, TimeUnit.MILLISECONDS);
    }

    public boolean isOverflowed() {
        return overflowed;
    }

    public boolean isClosed() {
        return closed;
    }

    public void close() {
        closed = true;
    }

    public int queueSize() {
        return queue.size();
    }
}
