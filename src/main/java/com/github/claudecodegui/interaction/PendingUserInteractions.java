package com.github.claudecodegui.interaction;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registry of in-flight {@link PendingUserInteraction}s, keyed by type + request id.
 *
 * <p>Replaces the three separate pending-request maps that used to live in
 * {@code PermissionHandler}. The single registration point ({@link #register}) is also the place
 * a future "manual action required" sound notification can hook into.
 *
 * <p>Because the storage key is prefixed with the interaction type, an entry stored under a given
 * type is always the matching concrete subclass, so the downcasts in the typed removers are safe.
 */
public final class PendingUserInteractions {

    private final Map<String, PendingUserInteraction<?>> interactions = new ConcurrentHashMap<>();

    private static String key(UserInteractionType type, String id) {
        return type.name() + ":" + id;
    }

    public void register(PendingUserInteraction<?> interaction) {
        interactions.put(key(interaction.type(), interaction.id()), interaction);
    }

    public PendingPermissionInteraction removePermission(String channelId) {
        return (PendingPermissionInteraction) interactions.remove(
                key(UserInteractionType.PERMISSION, channelId));
    }

    public PendingAskUserQuestionInteraction removeAskUserQuestion(String requestId) {
        return (PendingAskUserQuestionInteraction) interactions.remove(
                key(UserInteractionType.ASK_USER_QUESTION, requestId));
    }

    public PendingPlanApprovalInteraction removePlanApproval(String requestId) {
        return (PendingPlanApprovalInteraction) interactions.remove(
                key(UserInteractionType.PLAN_APPROVAL, requestId));
    }

    public int size() {
        return interactions.size();
    }

    public int count(UserInteractionType type) {
        int count = 0;
        for (PendingUserInteraction<?> interaction : interactions.values()) {
            if (interaction.type() == type) {
                count++;
            }
        }
        return count;
    }

    /**
     * Resolve every in-flight interaction with its session-changed payload and drain the registry.
     * Called on session switch so issuing agents do not hang on dialogs from the old session.
     */
    public void cancelAllSessionChanged() {
        for (PendingUserInteraction<?> interaction : interactions.values()) {
            interaction.cancelSessionChanged();
        }
        interactions.clear();
    }
}
