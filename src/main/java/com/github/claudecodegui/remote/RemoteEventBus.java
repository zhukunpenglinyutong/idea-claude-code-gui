package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Tab-keyed pub/sub bus for {@link RemoteEvent}s.
 *
 * <p>Producers ({@code RemoteEventTap}, {@code RemoteChatDispatcher}, the
 * interaction observer) call {@link #publish}; each {@code GET /events}
 * connection holds one {@link RemoteEventSubscriber} that the SSE writer drains.
 *
 * <p>The bus never holds {@code ClaudeChatWindow}/{@code ClaudeSession}
 * references — it is keyed by opaque {@code tabId} strings only. Subscribers
 * must be {@link #unsubscribe}d on disconnect so they can be GC'd.
 *
 * <p>Single application-wide instance. Thread-safe.
 */
public final class RemoteEventBus {

    private static final RemoteEventBus INSTANCE = new RemoteEventBus();

    private final ConcurrentHashMap<String, CopyOnWriteArrayList<RemoteEventSubscriber>> subscribers =
            new ConcurrentHashMap<>();
    private final AtomicLong eventIdSeq = new AtomicLong();
    private final AtomicLong generationSeq = new AtomicLong(1);

    /**
     * Guards the subscribe/close lifecycle so that generation validation + subscriber
     * registration form one atomic operation relative to {@code close()} + generation
     * rotation (Phase 2C-C.1 generation-ownership closure).
     *
     * <p>Held ONLY by {@link #subscribe(String)} / {@link #subscribe(String, long)} /
     * {@link #close()} / {@link #clearForTest()}. The publish hot path
     * ({@link #publishForGeneration}) stays lock-free — the immutable per-subscriber
     * generation tag makes cross-generation delivery provably impossible without a lock,
     * and {@code subscribers} is a {@link ConcurrentHashMap} of {@link CopyOnWriteArrayList}
     * so publish's read-only iteration is safe concurrently with a locked close.
     */
    private final Object lifecycleLock = new Object();

    public static RemoteEventBus getInstance() {
        return INSTANCE;
    }

    private RemoteEventBus() {
    }

    /**
     * Current bus generation — incremented on every {@link #close()}.
     *
     * <p>This is the ownership-capture point: a starting gateway reads it ONCE (under its
     * start lock, which excludes {@code dispose}/{@code close}) to obtain its immutable
     * gateway-generation token. Handlers then carry that token and pass it to
     * {@link #subscribe(String, long)} / dispatch — they never re-read
     * {@code currentGeneration()} to decide ownership, so a request accepted by gateway G
     * can never be re-attributed to a later generation merely because the bus rotated
     * before dispatch/subscribe executed (Phase 2C-C.1 generation-ownership closure, §2/§4).
     */
    public long currentGeneration() {
        return generationSeq.get();
    }

    /**
     * Publish an event owned by {@code task}. Delegates to
     * {@link #publishForGeneration} with the task's captured bus generation.
     *
     * @return true if the event reached at least one same-generation subscriber,
     *         false if suppressed (stale generation / no matching subscriber)
     */
    public boolean publishForTask(RemoteTask task, String projectId, String tabId,
                                   String event, String taskId, String sessionId,
                                   JsonObject payload) {
        if (task == null) {
            return false;
        }
        return publishForGeneration(task.busGeneration, projectId, tabId, event, taskId, sessionId, payload);
    }

    /**
     * Centralized generation-safe publication primitive (Phase 2C-C.1
     * generation-atomicity closure).
     *
     * <p>Delivers the event <em>only</em> to subscribers whose immutable
     * {@link RemoteEventSubscriber#generation} equals {@code expectedGeneration}.
     * This is the single concurrency-safe operation that unifies generation
     * validation with delivery-domain selection: there is no separate
     * check-then-publish step, so no {@code close()}/generation rotation can
     * interpose between "this event is eligible for generation G" and "this
     * event is offered to a subscriber." A subscriber created in a later
     * generation (after {@code close()} rotated the bus) carries a different
     * immutable tag and is skipped; an event whose generation has been closed
     * can only reach same-generation (already-closed) subscribers, which drop
     * it. Cross-generation delivery is therefore impossible regardless of
     * thread interleaving.
     *
     * <p>All task-owned event producers MUST route through this primitive
     * (directly or via {@link #publishForTask}) — no ad-hoc
     * {@code currentGeneration()} pre-checks.
     *
     * @return true if the event reached at least one same-generation subscriber,
     *         false otherwise (stale generation / no matching subscriber)
     */
    public boolean publishForGeneration(long expectedGeneration, String projectId, String tabId,
                                        String event, String taskId, String sessionId,
                                        JsonObject payload) {
        long id = eventIdSeq.incrementAndGet();
        RemoteEvent e = new RemoteEvent(id, event, System.currentTimeMillis(),
                projectId, tabId, taskId, sessionId, payload);
        List<RemoteEventSubscriber> list = subscribers.get(tabId);
        if (list == null || list.isEmpty()) {
            return false;
        }
        boolean delivered = false;
        for (RemoteEventSubscriber sub : list) {
            if (sub.generation == expectedGeneration) {
                sub.offer(e);
                delivered = true;
            }
        }
        return delivered;
    }

    /**
     * Register a new subscriber for {@code tabId}, tagged with the <em>current</em>
     * generation. Atomic relative to {@link #close()}: the generation read and the
     * registration happen under the same lifecycle lock, so this can never produce a
     * subscriber that outlives a concurrent {@code close()} of the same generation.
     *
     * <p>Test/legacy convenience — production SSE handlers must use
     * {@link #subscribe(String, long)} with their immutable gateway-generation token so
     * ownership is the handler's, not a late snapshot of mutable bus state.
     */
    public RemoteEventSubscriber subscribe(String tabId) {
        synchronized (lifecycleLock) {
            long g = generationSeq.get();
            RemoteEventSubscriber sub = new RemoteEventSubscriber(tabId,
                    RemoteGatewayLimits.MAX_EVENTS_PER_SUBSCRIBER, g);
            subscribers.computeIfAbsent(tabId, k -> new CopyOnWriteArrayList<>()).add(sub);
            return sub;
        }
    }

    /**
     * Register a new subscriber for {@code tabId} owned by generation
     * {@code expectedGeneration} (the caller's immutable gateway-generation token).
     *
     * <p>Generation validation and subscriber registration are one atomic operation
     * relative to {@link #close()}: both happen under {@link #lifecycleLock}. If the bus
     * has already rotated past {@code expectedGeneration} (the owning gateway was
     * disposed), this returns {@code null} — the caller MUST treat that as "my
     * generation is gone; do not become a subscriber of a newer generation." It is
     * therefore impossible for a subscriber owned by a disposed generation to remain
     * registered after {@code close()} returns, and impossible for a Gateway-A handler
     * to accidentally subscribe as a Gateway-B subscriber (Phase 2C-C.1
     * generation-ownership closure, §3).
     *
     * @return the new subscriber, or {@code null} if {@code expectedGeneration} is stale
     */
    public RemoteEventSubscriber subscribe(String tabId, long expectedGeneration) {
        synchronized (lifecycleLock) {
            if (expectedGeneration != generationSeq.get()) {
                return null; // owning generation already disposed — reject, do not re-own
            }
            RemoteEventSubscriber sub = new RemoteEventSubscriber(tabId,
                    RemoteGatewayLimits.MAX_EVENTS_PER_SUBSCRIBER, expectedGeneration);
            subscribers.computeIfAbsent(tabId, k -> new CopyOnWriteArrayList<>()).add(sub);
            return sub;
        }
    }

    /** Remove a subscriber (on disconnect/close). */
    public void unsubscribe(RemoteEventSubscriber sub) {
        if (sub == null) {
            return;
        }
        List<RemoteEventSubscriber> list = subscribers.get(sub.getTabId());
        if (list != null) {
            list.remove(sub);
            sub.close();
        }
    }

    /**
     * Build and route an event to every live subscriber for {@code tabId}.
     *
     * <p>Delegates to {@link #publishForGeneration} with the current generation.
     * Because {@code close()} clears the subscriber map before rotating the
     * generation, every live subscriber always carries the current generation
     * tag, so this is equivalent to "offer to all current subscribers" while
     * still routing through the single generation-safe primitive — there is no
     * production path that bypasses generation validation. Non-blocking: a full
     * queue marks that subscriber overflowed (the SSE writer closes it).
     */
    public void publish(String projectId, String tabId, String event,
                        String taskId, String sessionId, JsonObject payload) {
        publishForGeneration(generationSeq.get(), projectId, tabId, event, taskId, sessionId, payload);
    }

    /** @return number of live subscribers for {@code tabId} */
    public int subscriberCount(String tabId) {
        List<RemoteEventSubscriber> list = subscribers.get(tabId);
        return list == null ? 0 : list.size();
    }

    /**
     * Close all subscriber queues — every SSE connection draining a subscriber
     * will see the queue as drained/closed. Called during gateway shutdown so
     * no stale subscriber survives into generation B (Phase 2C-C.1b §2).
     *
     * <p>Under {@link #lifecycleLock}: closing subscribers, clearing the map, and
     * rotating the generation are one atomic operation relative to
     * {@link #subscribe(String, long)}. Once this returns, no subscriber owned by the
     * closed generation can remain registered — a concurrent late
     * {@code subscribe(tabId, oldGen)} either completed before this (its subscriber was
     * closed and cleared here) or is blocked on the lock and will then fail the
     * generation check (oldGen ≠ new current) and return {@code null}.
     */
    public void close() {
        synchronized (lifecycleLock) {
            for (CopyOnWriteArrayList<RemoteEventSubscriber> list : subscribers.values()) {
                for (RemoteEventSubscriber sub : list) {
                    sub.close();
                }
            }
            subscribers.clear();
            generationSeq.incrementAndGet(); // stale events from disposed generation filtered by publish()
        }
    }

    /** Test only: drop all subscribers and reset generation. */
    public void clearForTest() {
        synchronized (lifecycleLock) {
            subscribers.clear();
            generationSeq.set(1);
        }
    }
}
