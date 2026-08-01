package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Process-wide registry of resolvable permission / AskUserQuestion / Plan
 * interactions &mdash; the single shared backend that the desktop dialog path
 * and the Remote gateway both resolve through (Phase 2C-C §2, §4).
 *
 * <p>Replaces {@code PermissionHandler}'s former per-instance pending-future
 * maps with one authoritative store, so desktop and Remote compete to complete
 * the <em>same</em> {@link InteractionHandle} (first-wins, §5).
 *
 * <p>Indexes:
 * <ul>
 *   <li>{@code (sessionId, requestId) -> handle} &mdash; all types; used by the
 *       Remote endpoint (validated) and the desktop ask/plan path.</li>
 *   <li>{@code channelId -> handle} &mdash; permission only; used by the
 *       desktop JS decision path (the webview posts {@code channelId}).</li>
 * </ul>
 *
 * <p>Thread-safe. Single application-wide instance.
 */
public final class SharedInteractionResolver {

    /** Outcome of a resolve attempt, mapped by the caller to an HTTP status. */
    public enum ResolveOutcome {
        RESOLVED,           // 200 — this call completed the future
        ALREADY_RESOLVED,   // 409 — interaction was already resolved
        NOT_FOUND,          // 404 — no pending interaction for this id
        TYPE_MISMATCH,      // 409 — id exists but is a different interaction kind
        MISMATCH            // 409 — belongs to a different project/tab/task
    }

    private static final SharedInteractionResolver INSTANCE = new SharedInteractionResolver();

    /** Max resolved handles retained for late-race ALREADY_RESOLVED (Phase 2C-C.1 §6). */
    private static final int MAX_RESOLVED_TOMBSTONES = 256;

    private final ConcurrentHashMap<String, InteractionHandle> byRequest = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, InteractionHandle> byChannel = new ConcurrentHashMap<>();

    private SharedInteractionResolver() {
    }

    public static SharedInteractionResolver getInstance() {
        return INSTANCE;
    }

    public void register(InteractionHandle handle) {
        if (handle == null || handle.getSessionId() == null || handle.getRequestId() == null) {
            return;
        }
        byRequest.put(key(handle.getSessionId(), handle.getRequestId()), handle);
        if (handle.getChannelId() != null) {
            byChannel.put(handle.getChannelId(), handle);
        }
        // Self-bounded: every new registration triggers a check so resolved
        // tombstones never exceed MAX_RESOLVED_TOMBSTONES regardless of
        // whether cancelAllForSession / finalizeTask ever fire
        // (Phase 2C-C.1 closure §1).
        pruneResolved();
    }

    public InteractionHandle get(String sessionId, String requestId) {
        if (sessionId == null || requestId == null) {
            return null;
        }
        return byRequest.get(key(sessionId, requestId));
    }

    public InteractionHandle getByChannelId(String channelId) {
        if (channelId == null) {
            return null;
        }
        return byChannel.get(channelId);
    }

    /**
     * Attach Remote source identity to the handle. Returns true if the handle
     * was found and the source was attached; false means the handle was NOT
     * found (observer/caller must NOT publish a requested event for this
     * interaction — Phase 2C-C.1 §7).
     */
    public boolean attachSource(String sessionId, String requestId,
                                 String projectId, String tabId, String taskId) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return false;
        }
        h.attachSource(projectId, tabId, taskId);
        return true;
    }

    /** @return true if the handle was found and the questions were attached */
    public boolean attachQuestions(String sessionId, String requestId, JsonObject questions) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return false;
        }
        h.attachQuestions(questions);
        return true;
    }

    /** @return true if the handle was found and the plan was attached */
    public boolean attachPlan(String sessionId, String requestId, JsonObject plan) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return false;
        }
        h.attachPlan(plan);
        return true;
    }

    public InteractionHandle remove(String sessionId, String requestId) {
        InteractionHandle h = byRequest.remove(key(sessionId, requestId));
        if (h != null && h.getChannelId() != null) {
            byChannel.remove(h.getChannelId());
        }
        return h;
    }

    private void removeHandle(InteractionHandle h) {
        if (h == null) {
            return;
        }
        byRequest.remove(key(h.getSessionId(), h.getRequestId()), h);
        if (h.getChannelId() != null) {
            byChannel.remove(h.getChannelId(), h);
        }
    }

    // ── Desktop paths (trusted JS: no source validation) ───────────────

    /**
     * Desktop permission decision: looked up by {@code channelId}. Resolved
     * handles are intentionally <em>kept</em> (marked resolved) so a racing or
     * duplicate late decision observes {@link ResolveOutcome#ALREADY_RESOLVED}
     * rather than NOT_FOUND (Phase 2C-C §5 first-wins). Cleanup happens on
     * session switch / abort / task terminal via {@link #cancelAllForSession}.
     */
    public ResolveOutcome completePermissionByChannelId(String channelId, int responseValue) {
        InteractionHandle h = byChannel.get(channelId);
        if (h == null) {
            return ResolveOutcome.NOT_FOUND;
        }
        if (h.getType() != InteractionHandle.Type.PERMISSION) {
            return ResolveOutcome.TYPE_MISMATCH;
        }
        boolean won = h.tryComplete(responseValue);
        if (won) { pruneResolved(); }
        return won ? ResolveOutcome.RESOLVED : ResolveOutcome.ALREADY_RESOLVED;
    }

    /** Desktop AskUserQuestion response: looked up by {@code (sessionId, requestId)}. */
    public ResolveOutcome completeAskByRequestId(String sessionId, String requestId, JsonObject answers) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return ResolveOutcome.NOT_FOUND;
        }
        if (h.getType() != InteractionHandle.Type.QUESTION) {
            return ResolveOutcome.TYPE_MISMATCH;
        }
        boolean won = h.tryComplete(answers);
        if (won) { pruneResolved(); }
        return won ? ResolveOutcome.RESOLVED : ResolveOutcome.ALREADY_RESOLVED;
    }

    /** Desktop Plan-Approval response: looked up by {@code (sessionId, requestId)}. */
    public ResolveOutcome completePlanByRequestId(String sessionId, String requestId, JsonObject result) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return ResolveOutcome.NOT_FOUND;
        }
        if (h.getType() != InteractionHandle.Type.PLAN) {
            return ResolveOutcome.TYPE_MISMATCH;
        }
        boolean won = h.tryComplete(result);
        if (won) { pruneResolved(); }
        return won ? ResolveOutcome.RESOLVED : ResolveOutcome.ALREADY_RESOLVED;
    }

    // ── Remote paths (validated against source identity) ───────────────

    /**
     * Resolve a permission interaction from the Remote endpoint. Validates the
     * handle exists, is a permission, and belongs to the caller's
     * project/tab/task before completing.
     */
    public ResolveOutcome resolvePermission(String sessionId, String requestId,
                                            String projectId, String tabId, String taskId,
                                            int responseValue) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return ResolveOutcome.NOT_FOUND;
        }
        if (h.getType() != InteractionHandle.Type.PERMISSION) {
            return ResolveOutcome.TYPE_MISMATCH;
        }
        if (!h.matchesSource(projectId, tabId, taskId)) {
            return ResolveOutcome.MISMATCH;
        }
        boolean won = h.tryComplete(responseValue);
        return won ? ResolveOutcome.RESOLVED : ResolveOutcome.ALREADY_RESOLVED;
    }

    /** Resolve an AskUserQuestion interaction from the Remote endpoint. */
    public ResolveOutcome resolveAsk(String sessionId, String requestId,
                                     String projectId, String tabId, String taskId,
                                     JsonObject answers) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return ResolveOutcome.NOT_FOUND;
        }
        if (h.getType() != InteractionHandle.Type.QUESTION) {
            return ResolveOutcome.TYPE_MISMATCH;
        }
        if (!h.matchesSource(projectId, tabId, taskId)) {
            return ResolveOutcome.MISMATCH;
        }
        boolean won = h.tryComplete(answers);
        if (won) { pruneResolved(); }
        return won ? ResolveOutcome.RESOLVED : ResolveOutcome.ALREADY_RESOLVED;
    }

    /** Resolve a Plan-Approval interaction from the Remote endpoint. */
    public ResolveOutcome resolvePlan(String sessionId, String requestId,
                                      String projectId, String tabId, String taskId,
                                      JsonObject result) {
        InteractionHandle h = get(sessionId, requestId);
        if (h == null) {
            return ResolveOutcome.NOT_FOUND;
        }
        if (h.getType() != InteractionHandle.Type.PLAN) {
            return ResolveOutcome.TYPE_MISMATCH;
        }
        if (!h.matchesSource(projectId, tabId, taskId)) {
            return ResolveOutcome.MISMATCH;
        }
        boolean won = h.tryComplete(result);
        if (won) { pruneResolved(); }
        return won ? ResolveOutcome.RESOLVED : ResolveOutcome.ALREADY_RESOLVED;
    }

    /**
     * Cancel (deny / null / reject) every pending interaction belonging to
     * {@code sessionId}. Used by {@code clearPendingRequests} (session switch)
     * and the abort path (Phase 2C-C §16, §22). Returns the number of
     * interactions that this call actually cancelled.
     */
    public int cancelAllForSession(String sessionId, String reason) {
        if (sessionId == null) {
            return 0;
        }
        int count = 0;
        // Snapshot to avoid concurrent-modification while removing.
        List<InteractionHandle> snapshot = new ArrayList<>(byRequest.values());
        for (InteractionHandle h : snapshot) {
            if (sessionId.equals(h.getSessionId())) {
                if (h.cancel(reason)) {
                    count++;
                }
                removeHandle(h);
            }
        }
        pruneResolved();
        return count;
    }

    public int size() {
        return byRequest.size();
    }

    /**
     * Trim the oldest resolved handles if the total exceeds the tombstone cap.
     * Resolved handles are kept to serve late-race ALREADY_RESOLVED responses,
     * but an unbounded long-running desktop session would accumulate them. This
     * method is called by bulk cleanup paths ({@link #cancelAllForSession},
     * {@code finalizeTask}) to bound the lifetime.
     */
    /**
     * Ensure resolved tombstones do not exceed {@link #MAX_RESOLVED_TOMBSTONES}.
     * Synchronized so concurrent resolve threads are serialized — the last caller
     * to exit is guaranteed to see the final correct count (Phase 2C-C.1c §1).
     *
     * <p>Only resolved handles are candidates; pending handles are never evicted.
     */
    public synchronized void pruneResolved() {
        // Fast path: count resolved entries first.
        int resolvedCount = 0;
        for (InteractionHandle h : byRequest.values()) {
            if (h.isResolved()) {
                resolvedCount++;
            }
        }
        if (resolvedCount <= MAX_RESOLVED_TOMBSTONES) {
            return;
        }
        // Evict oldest resolved until at or below the cap.
        List<InteractionHandle> snapshot = new ArrayList<>(byRequest.values());
        snapshot.sort(java.util.Comparator.comparingLong(InteractionHandle::getCreatedAt));
        int toRemove = resolvedCount - MAX_RESOLVED_TOMBSTONES;
        for (InteractionHandle h : snapshot) {
            if (toRemove <= 0) {
                break;
            }
            if (h.isResolved()) {
                removeHandle(h);
                toRemove--;
            }
        }
    }

    public void clearForTest() {
        byRequest.clear();
        byChannel.clear();
    }

    private static String key(String sessionId, String requestId) {
        return sessionId + "::" + requestId;
    }
}
