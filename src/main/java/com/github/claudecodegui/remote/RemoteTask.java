package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.SessionTurnGate;
import com.google.gson.JsonObject;

import com.github.claudecodegui.session.ClaudeSession;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;

/**
 * Metadata + per-task runtime for one Remote chat task.
 *
 * <p>Holds the task identity, lifecycle state/timestamps, the
 * {@link SessionTurnGate.Lease} that authorizes the single turn, and the
 * per-task {@link RemoteDeltaCoalescer} / {@link RemoteToolEventTracker} used by
 * {@link RemoteEventTap}.
 *
 * <p>{@code sessionId} is an {@link AtomicReference} because it is null until
 * the first {@code onSessionIdReceived} for a new tab; the coalescer's flush
 * consumer reads it at flush time so events always carry the latest id.
 */
final class RemoteTask {

    final String taskId;
    final String projectId;
    final String tabId;
    final SessionTurnGate.Lease lease;
    final long createdAt;

    private final AtomicReference<String> sessionId;
    private final AtomicReference<String> provider;
    private final AtomicReference<RemoteTaskState> state;
    private final AtomicBoolean abortRequested = new AtomicBoolean(false);
    private final AtomicBoolean failureObserved = new AtomicBoolean(false);

    private volatile long startedAt = 0L;
    private volatile long terminalAt = 0L;

    final RemoteDeltaCoalescer coalescer;
    final RemoteToolEventTracker toolTracker;
    final RemoteAssistantContentTracker assistantContentTracker;

    /**
     * The session this task drives. Stored so gateway dispose can call
     * {@link ClaudeSession#interrupt()} on active tasks rather than just setting
     * a flag (Phase 2C-C.1c §2).
     */
    volatile ClaudeSession session;

    /**
     * Bus generation at task creation — <b>immutable</b>. Captured exactly once
     * at {@link #create} time (from {@code RemoteEventBus.currentGeneration()})
     * and threaded through the constructor so it can never be re-assigned later.
     * Every event this task emits — via {@code publishForTask}, the terminal
     * event in {@code finalizeTask}, and the coalescer's flush closure — uses
     * this single value as the {@code expectedGeneration} handed to
     * {@link RemoteEventBus#publishForGeneration}. Immutability guarantees the
     * task's events all target one generation: no later field overwrite can
     * split them across generations (Phase 2C-C.1 generation-atomicity closure).
     */
    final long busGeneration;

    /**
     * All sessionIds this task has ever been indexed under (initial register + every
     * later {@code indexSession} call). Used at {@code remove()} time to clean up
     * the {@code activeTaskBySession} index completely — no stale alias survives a
     * task terminal (Phase 2C-C.1 §4).
     */
    private final Set<String> sessionAliases = ConcurrentHashMap.newKeySet();

    private RemoteTask(String taskId, String projectId, String tabId,
                       SessionTurnGate.Lease lease,
                       AtomicReference<String> sessionId,
                       AtomicReference<String> provider,
                       RemoteDeltaCoalescer coalescer,
                       long busGeneration) {
        this.taskId = taskId;
        this.projectId = projectId;
        this.tabId = tabId;
        this.lease = lease;
        this.createdAt = System.currentTimeMillis();
        this.sessionId = sessionId;
        this.provider = provider;
        this.state = new AtomicReference<>(RemoteTaskState.ACCEPTED);
        this.coalescer = coalescer;
        this.toolTracker = new RemoteToolEventTracker();
        this.assistantContentTracker = new RemoteAssistantContentTracker();
        this.busGeneration = busGeneration;
    }

    /**
     * Create a task and wire its coalescer's flush consumer to publish
     * {@code assistant.content} on the bus. The coalescer reads the sessionId
     * reference at flush time, so it always emits the latest id.
     */
    static RemoteTask create(String taskId, String projectId, String tabId,
                             String sessionId, String provider,
                             SessionTurnGate.Lease lease,
                             RemoteEventBus bus,
                             RemoteDeltaFlushScheduler scheduler,
                             LongSupplier clock,
                             long busGeneration) {
        AtomicReference<String> sessionIdRef = new AtomicReference<>(sessionId);
        AtomicReference<String> providerRef = new AtomicReference<>(provider);
        RemoteDeltaCoalescer coalescer = new RemoteDeltaCoalescer(
                scheduler, clock,
                RemoteGatewayLimits.COALESCER_MAX_WAIT_MS,
                RemoteGatewayLimits.COALESCER_MAX_CHUNK,
                text -> {
                    // Route through the centralized generation-safe primitive so
                    // a deferred flush (timer firing after gateway dispose/rotate)
                    // cannot leak a stale-gen assistant.content event to a new-gen
                    // subscriber. The per-subscriber generation tag filter inside
                    // publishForGeneration replaces this ad-hoc check-then-publish
                    // (Phase 2C-C.1 generation-atomicity closure).
                    JsonObject payload = new JsonObject();
                    payload.addProperty("text", text);
                    bus.publishForGeneration(busGeneration, projectId, tabId, "assistant.content",
                            taskId, sessionIdRef.get(), payload);
                });
        RemoteTask task = new RemoteTask(taskId, projectId, tabId, lease, sessionIdRef, providerRef, coalescer,
                busGeneration);
        return task;
    }

    String getSessionId() {
        return sessionId.get();
    }

    void updateSessionId(String id) {
        if (id != null && !id.isEmpty()) {
            sessionId.set(id);
            sessionAliases.add(id);
        }
    }

    /**
     * Every sessionId this task has been indexed under. The registry uses this at
     * remove time to clean up {@code activeTaskBySession} completely.
     */
    Set<String> getSessionAliases() {
        return sessionAliases;
    }

    String getProvider() {
        return provider.get();
    }

    RemoteTaskState getState() {
        return state.get();
    }

    void setState(RemoteTaskState next) {
        state.set(next);
        if (next == RemoteTaskState.STARTED && startedAt == 0L) {
            startedAt = System.currentTimeMillis();
        }
        if (next.isTerminal()) {
            terminalAt = System.currentTimeMillis();
        }
    }

    void markStarted() {
        if (state.compareAndSet(RemoteTaskState.ACCEPTED, RemoteTaskState.STARTED)) {
            startedAt = System.currentTimeMillis();
        }
    }

    void markRunning() {
        state.compareAndSet(RemoteTaskState.STARTED, RemoteTaskState.RUNNING);
    }

    /** Enter a waiting state unless the task is already terminal. */
    void markWaiting(RemoteTaskState waiting) {
        RemoteTaskState s = state.get();
        if (!s.isTerminal() && s != RemoteTaskState.ACCEPTED) {
            state.set(waiting);
        }
    }

    void markFailureObserved() {
        failureObserved.set(true);
    }

    boolean isFailureObserved() {
        return failureObserved.get();
    }

    void markAbortRequested() {
        abortRequested.set(true);
    }

    /**
     * Atomically transition to abort-requested. Returns true if this call was
     * the first to request the abort (the caller owns emitting
     * {@code task.abort_requested}); false if an abort was already requested.
     * First-wins idempotency for the Remote {@code /abort} endpoint and the
     * shared interrupt observer (Phase 2C-C §20, §21).
     */
    boolean markAbortRequestedFirstTime() {
        return abortRequested.compareAndSet(false, true);
    }

    boolean isAbortRequested() {
        return abortRequested.get();
    }

    long getStartedAt() {
        return startedAt;
    }

    long getTerminalAt() {
        return terminalAt;
    }
}
