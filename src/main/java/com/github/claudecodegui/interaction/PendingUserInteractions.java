package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registry of in-flight {@link PendingUserInteraction}s, keyed by type + id.
 *
 * <p>Holds the common abstraction in a single map and drives interactions only through their shared
 * lifecycle methods. It never returns or inspects a concrete subtype, so there are no casts, no
 * {@code instanceof}, and no {@code @SuppressWarnings} — the type-specific completion logic lives in
 * the interaction objects themselves.
 *
 * <p>Each mutating lookup removes the entry atomically before resolving it, so a frontend response
 * racing the safety-net timer can never double-complete a future: whichever thread wins the
 * {@link ConcurrentHashMap#remove} is the only one that resolves it.
 *
 * <p>The single {@link #register} seam is also where a future "manual action required" notification
 * can hook in.
 */
public final class PendingUserInteractions {

    private final Map<String, PendingUserInteraction> interactions = new ConcurrentHashMap<>();

    private static String key(UserInteractionType type, String id) {
        return type.name() + ":" + id;
    }

    public void register(PendingUserInteraction interaction) {
        interactions.put(key(interaction.type(), interaction.id()), interaction);
    }

    /**
     * Resolve the interaction identified by {@code type}/{@code id} from a frontend bridge response.
     *
     * @return {@code true} if a pending interaction was found and resolved, {@code false} otherwise
     *         (e.g. it already completed, or the request belongs to the session handler instead).
     */
    public boolean completeFromBridgeResponse(UserInteractionType type, String id, JsonObject payload) {
        PendingUserInteraction interaction = interactions.remove(key(type, id));
        if (interaction == null) {
            return false;
        }
        interaction.completeFromBridgeResponse(payload);
        return true;
    }

    /** Resolve the interaction with its timeout payload. @return whether one was found. */
    public boolean timeout(UserInteractionType type, String id) {
        PendingUserInteraction interaction = interactions.remove(key(type, id));
        if (interaction == null) {
            return false;
        }
        interaction.timeout();
        return true;
    }

    /** Resolve the interaction with its dialog-failed payload, if it is still pending. */
    public void dialogFailed(UserInteractionType type, String id) {
        PendingUserInteraction interaction = interactions.remove(key(type, id));
        if (interaction != null) {
            interaction.dialogFailed();
        }
    }

    /**
     * Resolve and drop every interaction whose {@link SessionChangePolicy} is
     * {@link SessionChangePolicy#DENY_ON_SESSION_CHANGE}; leave {@code KEEP} interactions registered.
     * Called on session switch so issuing agents do not hang on dialogs from the old session, while
     * session-callback permissions (owned by the SDK session) are left untouched as they are today.
     *
     * <p>Note: {@code KEEP} entries that are never answered remain in this map for the registry's
     * lifetime (a small, bounded accumulation; see {@link SessionChangePolicy#KEEP_ON_SESSION_CHANGE}).
     * This method is the natural place for an eviction policy should that ever need bounding.
     */
    public void cancelAllSessionChanged() {
        interactions.values().removeIf(interaction -> {
            if (interaction.sessionChangePolicy() == SessionChangePolicy.DENY_ON_SESSION_CHANGE) {
                interaction.cancelSessionChanged();
                return true;
            }
            return false;
        });
    }

    public int size() {
        return interactions.size();
    }

    public int count(UserInteractionType type) {
        int count = 0;
        for (PendingUserInteraction interaction : interactions.values()) {
            if (interaction.type() == type) {
                count++;
            }
        }
        return count;
    }
}
