package com.github.claudecodegui.remote;

import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Metadata registry for active Remote tasks.
 *
 * <p><b>Not</b> a concurrency lock — the authoritative single-turn mutex is
 * {@link com.github.claudecodegui.session.SessionTurnGate}. This registry only
 * holds task identity/metadata and indexes tasks so the
 * {@link RemoteEventTap} and the interaction observer can find the active task
 * for a tab or session.
 *
 * <p>Indexes:
 * <ul>
 *   <li>{@code taskId -> RemoteTask}</li>
 *   <li>{@code tabId -> active taskId} (at most one active Remote task per tab)</li>
 *   <li>{@code sessionId -> active taskId} (used by the interaction observer to
 *       match a permission/ask/plan request to its source task; null sessionId
 *       is indexed later via {@link #indexSession} once learned)</li>
 * </ul>
 *
 * <p>Single application-wide instance. Thread-safe.
 */
public final class RemoteTaskRegistry {

    private static final RemoteTaskRegistry INSTANCE = new RemoteTaskRegistry();

    private final ConcurrentHashMap<String, RemoteTask> byTaskId = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> activeTaskByTab = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> activeTaskBySession = new ConcurrentHashMap<>();
    // Maps PermissionService sessionId (the window-level "permission service key") to
    // the stable RemoteTabRegistry tabId. This allows the Remote interaction observer
    // to find the active RemoteTask for a tab regardless of daemon sessionId changes
    // (Phase 2C-C.0 BUG A fix — source mapping).
    private final ConcurrentHashMap<String, String> permissionSourceBySession = new ConcurrentHashMap<>();

    public static RemoteTaskRegistry getInstance() {
        return INSTANCE;
    }

    private RemoteTaskRegistry() {
    }

    /** Generate a fresh task id (UUID). */
    public String newTaskId() {
        return UUID.randomUUID().toString();
    }

    /**
     * Register an active task. Returns false (without storing) if the tab already
     * has an active task — a defensive guard that should never trigger because
     * the {@link com.github.claudecodegui.session.SessionTurnGate} is acquired
     * first.
     */
    public boolean register(RemoteTask task) {
        if (task == null) {
            return false;
        }
        if (activeTaskByTab.putIfAbsent(task.tabId, task.taskId) != null) {
            return false;
        }
        byTaskId.put(task.taskId, task);
        String sid = task.getSessionId();
        if (sid != null && !sid.isEmpty()) {
            activeTaskBySession.put(sid, task.taskId);
            task.getSessionAliases().add(sid);
        }
        return true;
    }

    public RemoteTask get(String taskId) {
        return byTaskId.get(taskId);
    }

    public RemoteTask getActiveByTab(String tabId) {
        String tid = activeTaskByTab.get(tabId);
        return tid == null ? null : byTaskId.get(tid);
    }

    public RemoteTask getActiveBySession(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        String tid = activeTaskBySession.get(sessionId);
        return tid == null ? null : byTaskId.get(tid);
    }

    /** Index a task by sessionId once its id is learned (new-tab first send). */
    public void indexSession(String taskId, String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }
        RemoteTask task = byTaskId.get(taskId);
        if (task == null) {
            return;
        }
        task.updateSessionId(sessionId);
        activeTaskBySession.putIfAbsent(sessionId, taskId);
    }

    /**
     * Clean EVERY session alias ever registered for {@code task} from the index.
     * Uses {@code remove(alias, taskId)} so a later task that happens to reuse the
     * same alias is never accidentally removed (Phase 2C-C.1 §4).
     */
    public void remove(RemoteTask task) {
        if (task == null) {
            return;
        }
        byTaskId.remove(task.taskId);
        activeTaskByTab.remove(task.tabId, task.taskId);
        // Remove ALL session aliases this task was ever indexed under. A task
        // accumulates aliases via register() (initial sessionId) and
        // indexSession() (daemon sessionId updates).
        for (String alias : task.getSessionAliases()) {
            activeTaskBySession.remove(alias, task.taskId);
        }
        task.getSessionAliases().clear();
    }

    public boolean hasActiveTab(String tabId) {
        return tabId != null && activeTaskByTab.containsKey(tabId);
    }

    public int activeCount() {
        return byTaskId.size();
    }

    /**
     * Register a stable source mapping from the window's permission-service
     * sessionId to the tab's RemoteTabRegistry tabId. The observer uses this
     * to find the active RemoteTask without requiring permissionSessionId ==
     * daemon sessionId (Phase 2C-C.0 BUG A fix).
     */
    public void registerPermissionSource(String permissionSessionId, String tabId) {
        if (permissionSessionId == null || permissionSessionId.isEmpty() || tabId == null) {
            return;
        }
        permissionSourceBySession.putIfAbsent(permissionSessionId, tabId);
    }

    /** Resolve the stable tabId for a permission-service sessionId. */
    public String getTabIdForPermissionSession(String permissionSessionId) {
        if (permissionSessionId == null) {
            return null;
        }
        return permissionSourceBySession.get(permissionSessionId);
    }

    /** Remove the source mapping (called on window dispose/gateway stop). */
    public void unregisterPermissionSource(String permissionSessionId) {
        if (permissionSessionId != null) {
            permissionSourceBySession.remove(permissionSessionId);
        }
    }

    /**
     * Real abort on every active task: mark + interrupt the session.
     * The InterruptObserver (still installed at this point in the dispose
     * sequence, Phase 2C-C.1c §2) will cancel pending interactions and
     * force-close desktop dialogs. Gates are NOT released — gate release
     * is owned by {@code finalizeTask}, which fires when the send future
     * completes.
     *
     * <p>After this call, each task's send future will reach terminal (or
     * timeout); {@code finalizeTask} releases the gate and removes the task
     * from the registry. New registrations for the same tabs are blocked
     * until then.
     */
    public void requestAbortAllActive() {
        for (RemoteTask task : byTaskId.values()) {
            task.markAbortRequested();
            if (task.session != null) {
                try {
                    task.session.interrupt();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /** Test/diagnostic cleanup. */
    public void clearRuntimeForTests() {
        byTaskId.clear();
        activeTaskByTab.clear();
        activeTaskBySession.clear();
        permissionSourceBySession.clear();
    }

    public void clearForTest() {
        byTaskId.clear();
        activeTaskByTab.clear();
        activeTaskBySession.clear();
        permissionSourceBySession.clear();
    }
}
