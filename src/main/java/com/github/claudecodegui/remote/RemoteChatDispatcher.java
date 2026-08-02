package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.session.SessionTurnGate;
import com.github.claudecodegui.session.SessionTurnGateRegistry;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Orchestrates a Remote chat send into an existing CC GUI tab, going through the
 * shared {@link SessionTurnGate} so desktop and Remote cannot concurrently drive
 * the same {@link ClaudeSession}.
 *
 * <p>Flow (Phase 2C-B):
 * <ol>
 *   <li>Resolve the live tab by {@code tabId} on the EDT.</li>
 *   <li>Atomically acquire the session's {@link SessionTurnGate} (the
 *       authoritative single-turn mutex). Fail → 409 TAB_BUSY.</li>
 *   <li>Create + register a {@link RemoteTask}; install the long-lived
 *       {@link RemoteEventTap} (idempotent).</li>
 *   <li>Emit {@code task.accepted} then {@code task.started}.</li>
 *   <li>Call the existing {@link ClaudeSession#send} (same shared orchestration
 *       the desktop WebView uses).</li>
 *   <li>Return 202 immediately; on the send future's terminal completion,
 *       {@link #finalizeTask(RemoteTask, boolean)} classifies the outcome,
 *       emits the terminal event, and releases the gate.</li>
 * </ol>
 *
 * <p>The gate (not a busy-flag read) is the mutual-exclusion authority, so there
 * is no TOCTOU window. The Remote task registry now holds only metadata — it is
 * no longer a second lock.
 */
final class RemoteChatDispatcher {

    private static final Logger LOG = Logger.getInstance(RemoteChatDispatcher.class);

    private final RemoteEventBus bus = RemoteEventInfra.getInstance().bus();
    private final RemoteDeltaFlushScheduler scheduler = RemoteEventInfra.getInstance().coalescerScheduler();
    private final java.util.function.LongSupplier clock = RemoteEventInfra.getInstance().clock();

    RemoteChatResult dispatch(Project project, String tabId, String message,
                              RemoteGatewayGeneration gen) {
        // Ownership admission fast path (Phase 2C-C.1 generation-ownership closure):
        // the request belongs to the gateway generation that accepted it (the handler's
        // immutable token). If this gateway is already closing, or the bus has rotated
        // past the token (owning gateway disposed), REJECT before any tab resolution /
        // gate acquisition / ClaudeSession.send. Read-only; the authoritative start
        // boundary check is under gen.startLock below.
        if (gen.isClosing() || gen.generation() != bus.currentGeneration()) {
            return RemoteChatResult.unavailable();
        }

        RemoteTabResolver.ResolveResult resolved = RemoteTabResolver.resolve(project, tabId);
        switch (resolved.status) {
            case TIMEOUT:
                return RemoteChatResult.timeout();
            case NOT_FOUND:
                return RemoteChatResult.notFound();
            case FOUND:
            default:
                break;
        }

        if (resolved.window == null || resolved.window.isDisposed() || resolved.session == null) {
            return RemoteChatResult.notFound();
        }

        ClaudeSession session = resolved.session;
        String projectId = RemoteProjectId.of(project.getBasePath());

        // Authoritative single-turn gate (covers desktop + remote, no TOCTOU).
        // Acquired BEFORE the start boundary so a request that loses the boundary
        // race (closing wins) can release its never-used lease and reject cleanly.
        SessionTurnGate.Lease lease = SessionTurnGateRegistry.getInstance().acquire(session);
        if (lease == null) {
            return RemoteChatResult.busy();
        }

        String provider = safeProvider(session);
        String taskId = RemoteTaskRegistry.getInstance().newTaskId();
        // The task is bound to the gateway's immutable generation token — NOT a late
        // bus.currentGeneration() snapshot. Ownership freeze: the task stays owned by
        // gateway generation G for its whole lifecycle (Phase 2C-C.1 generation-ownership
        // closure, §2/§7). RemoteTask freezes this into a final field and the coalescer
        // closure captures the same value, so all task events target one G.
        RemoteTask task = RemoteTask.create(taskId, projectId, tabId, resolved.sessionId,
                provider, lease, bus, scheduler, clock, gen.generation());
        task.session = session; // for dispose-time interrupt (Phase 2C-C.1c §2)

        // BUG B fix: snapshot the session's existing tool_use/tool_result IDs as
        // a baseline into the fresh tracker's seen sets. Must happen BEFORE the
        // tap is installed so the very first onMessageUpdate (which delivers the
        // full session history) does not replay old tool lifecycle events with
        // the new taskId.
        List<ClaudeSession.Message> history = session.getState().getMessages();
        List<JsonObject> raws = new ArrayList<>();
        for (ClaudeSession.Message m : history) {
            if (m != null && m.raw != null) {
                raws.add(m.raw);
            }
        }
        task.toolTracker.markSeen(raws);
        task.assistantContentTracker.markBaseline(history);

        // Long-lived tap (idempotent) — must be installed before send so no early
        // event is missed. Installed outside the start boundary; if the boundary is
        // lost (closing wins) the tap simply has no active task to feed (no-op).
        RemoteEventTap.install(session, projectId, tabId, bus, RemoteTaskRegistry.getInstance());

        // ── START BOUNDARY (Phase 2C-C.1 turn-start/dispose closure) ──────
        // "start a real Remote turn" is made atomic relative to "gateway generation
        // begins closing" via gen.tryStartTurn / gen.beginClosing (mutually exclusive
        // on gen.startLock). The start action registers the task (visible to dispose's
        // abort) AND establishes the real send lifecycle — ClaudeSession.send sets the
        // channel id in its SYNCHRONOUS portion, under the lock. Therefore a dispose
        // that follows beginClosing always finds an already-established channel for a
        // turn that crossed (interrupt lands → genuine abort, OPTION A), and a turn
        // that hasn't crossed can never start after closing (closing wins → no send,
        // lease released, no orphan). The lock is held only across the synchronous
        // start action, not for the turn's duration (send's EDT/context work is async,
        // after send returns).
        final boolean[] registered = new boolean[1];
        boolean startWon;
        try {
            startWon = gen.tryStartTurn(() -> {
                if (!RemoteTaskRegistry.getInstance().register(task)) {
                    // Defensive: tab already has an active task (gate should prevent).
                    return;
                }
                registered[0] = true;
                task.markStarted();
                // emit task.accepted (only after the gate was won + task registered)
                JsonObject accepted = new JsonObject();
                accepted.addProperty("state", RemoteTaskState.ACCEPTED.name());
                bus.publishForTask(task, projectId, tabId, "task.accepted",
                        taskId, task.getSessionId(), accepted);
                // emit task.started — this task is about to enter ClaudeSession.send
                bus.publishForTask(task, projectId, tabId, "task.started",
                        taskId, task.getSessionId(), statePayload(RemoteTaskState.STARTED));

                ensureCwd(session, project);
                // Establish the real send lifecycle under the lock. send()'s synchronous
                // portion sets state.channelId; the async launch/context/sendMessage run
                // after send returns (outside the lock). A dispose interrupt that follows
                // beginClosing thus finds a live channel.
                CompletableFuture<Void> future = session.send(message, null, null, null, null, null, null);
                task.markRunning();
                future.whenComplete((v, ex) -> finalizeTask(task, false));
            });
        } catch (Throwable t) {
            LOG.warn("[RemoteGateway] Remote send failed to start for tab " + tabId
                    + ": " + t.getMessage(), t);
            // send threw synchronously after the task was registered: finalize (releases
            // gate, removes task). If register never succeeded, finalizeTask is a safe
            // no-op on an unregistered task's cleanup except lease release — so guard it.
            if (registered[0]) {
                finalizeTask(task, true);
            } else {
                lease.release();
            }
            return RemoteChatResult.internalError();
        }

        if (!startWon) {
            // Closing won the race: generation marked CLOSING before we could cross.
            // MUST NOT send. Release the never-used lease. No task registered, no orphan.
            lease.release();
            return RemoteChatResult.unavailable();
        }
        if (!registered[0]) {
            // Defensive register-fail (gate should prevent): no task, release lease.
            lease.release();
            return RemoteChatResult.busy();
        }
        return RemoteChatResult.accepted(taskId, resolved.sessionId);
    }

    /**
     * Terminal finalization: flush, classify outcome, emit terminal event,
     * release the gate, unregister the task. Runs on the send future's
     * completion thread (or synchronously on a send-start exception).
     *
     * <p>Package-private so the generation-atomicity closure test can drive it
     * directly with a stale-generation task and assert cleanup still runs.
     */
    void finalizeTask(RemoteTask task, boolean syncException) {
        try {
            task.coalescer.flush();
            task.coalescer.dispose();
            task.toolTracker.reset();

            boolean pendingInteractions =
                    RemoteInteractionRegistry.getInstance().hasPending(task.taskId);

            RemoteTaskState outcome = RemoteTaskOutcomeClassifier.classify(
                    task.isAbortRequested(), task.isFailureObserved(), syncException);
            if (pendingInteractions && outcome == RemoteTaskState.COMPLETED) {
                // Unresolved interactions at terminal ⇒ the turn did not finish
                // cleanly (timeout / clearPendingRequests / abnormal completion).
                outcome = RemoteTaskState.FAILED;
            }
            task.setState(outcome);

            String eventName;
            if (outcome == RemoteTaskState.ABORTED) {
                eventName = "task.aborted";
            } else if (outcome == RemoteTaskState.FAILED) {
                eventName = "task.failed";
            } else {
                eventName = "task.completed";
            }
            JsonObject payload = statePayload(outcome);
            if (pendingInteractions) {
                payload.addProperty("unresolvedInteractions", true);
            }
            // Route the terminal event through the centralized generation-safe
            // primitive. A stale terminal event (bus rotated since the task was
            // created) is filtered out at offer time and must not leak into a
            // new generation's subscribers (Phase 2C-C.1 generation-atomicity).
            // Cleanup in the finally block below is unconditional — it must NOT
            // depend on whether the event was published.
            bus.publishForGeneration(task.busGeneration, task.projectId, task.tabId, eventName,
                    task.taskId, task.getSessionId(), payload);
        } catch (Throwable t) {
            LOG.warn("[RemoteGateway] finalizeTask error for task " + task.taskId
                    + ": " + t.getMessage(), t);
        } finally {
            // Clean the shared resolver of this task's resolved/pending interaction
            // handles so they do not accumulate across turns. cancelAllForSession
            // is a no-op on already-resolved handles (CAS) and denies any leftover
            // pending ones, then removes them all.
            try {
                com.github.claudecodegui.permission.SharedInteractionResolver.getInstance()
                        .cancelAllForSession(task.getSessionId(), "task terminal");
            } catch (Throwable ignored) {
            }
            RemoteTaskRegistry.getInstance().remove(task);
            try {
                task.lease.release();
            } catch (Throwable ignored) {
            }
        }
    }

    private static JsonObject statePayload(RemoteTaskState state) {
        JsonObject p = new JsonObject();
        p.addProperty("state", state.name());
        return p;
    }

    private static String safeProvider(ClaudeSession session) {
        try {
            SessionState state = session.getState();
            return state != null ? state.getProvider() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Minimal cwd guard: only set a cwd when the tab has none (a brand-new tab
     * that has never sent). Falls back to the project base path — the desktop
     * {@code determineWorkingDirectory}'s own final fallback. The full
     * settings-based / active-file resolution is intentionally NOT duplicated.
     */
    private static void ensureCwd(ClaudeSession session, Project project) {
        if (session == null) {
            return;
        }
        SessionState state = session.getState();
        if (state == null) {
            return;
        }
        String cwd = state.getCwd();
        if (cwd != null && !cwd.isEmpty()) {
            return;
        }
        if (project == null || project.isDisposed()) {
            return;
        }
        String basePath = project.getBasePath();
        if (basePath != null && !basePath.isEmpty()) {
            state.setCwd(basePath);
        }
    }
}
