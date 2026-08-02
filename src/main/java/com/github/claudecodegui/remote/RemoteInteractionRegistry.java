package com.github.claudecodegui.remote;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tracks active (unresolved) permission / question / plan interactions.
 *
 * <p>Keyed by {@code (sessionId, interactionId)} because {@code requestId} is
 * only session-scoped unique (Phase 2C-A.1 §5). Used to:
 * <ul>
 *   <li>Drive task waiting state (WAITING_PERMISSION / USER_INPUT / PLAN_APPROVAL).</li>
 *   <li>Guard terminal classification: an unresolved interaction at terminal
 *       time means the turn did not complete cleanly.</li>
 * </ul>
 *
 * <p>Thread-safe. Single application-wide instance.
 */
public final class RemoteInteractionRegistry {

    private static final RemoteInteractionRegistry INSTANCE = new RemoteInteractionRegistry();

    private final ConcurrentHashMap<String, RemoteInteraction> active = new ConcurrentHashMap<>();

    public static RemoteInteractionRegistry getInstance() {
        return INSTANCE;
    }

    private RemoteInteractionRegistry() {
    }

    public void register(RemoteInteraction interaction) {
        if (interaction == null || interaction.getSessionId() == null) {
            return;
        }
        active.put(key(interaction.getSessionId(), interaction.getInteractionId()), interaction);
    }

    public RemoteInteraction remove(String sessionId, String interactionId) {
        if (sessionId == null || interactionId == null) {
            return null;
        }
        return active.remove(key(sessionId, interactionId));
    }

    public RemoteInteraction get(String sessionId, String interactionId) {
        if (sessionId == null || interactionId == null) {
            return null;
        }
        return active.get(key(sessionId, interactionId));
    }

    /** @return unresolved interactions belonging to {@code taskId} */
    public List<RemoteInteraction> getPendingForTask(String taskId) {
        List<RemoteInteraction> out = new ArrayList<>();
        if (taskId == null) {
            return out;
        }
        for (RemoteInteraction i : active.values()) {
            if (taskId.equals(i.getSourceTaskId())) {
                out.add(i);
            }
        }
        return out;
    }

    public boolean hasPending(String taskId) {
        return !getPendingForTask(taskId).isEmpty();
    }

    public int size() {
        return active.size();
    }

    /** Clear all runtime entries. Called during gateway dispose. */
    public void dispose() {
        active.clear();
    }

    public void clearForTest() {
        active.clear();
    }

    private static String key(String sessionId, String interactionId) {
        return sessionId + "::" + interactionId;
    }
}
