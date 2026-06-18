package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Owns the lifecycle of in-flight {@link PendingUserInteraction}s.
 *
 * <p>Both permission paths (file-watcher and SDK-session-callback) as well as AskUserQuestion and
 * PlanApproval register here, so every requested interaction flows through one place and fires a
 * single {@link UserInteractionListener#userInteractionRequested} event. That event is the seam the
 * webview presenter (PR-1c) and the manual-action sound (#1336, PR-2) attach to.
 *
 * <p>Storage stays a separate component ({@link PendingUserInteractions}); this service adds the
 * request/answer API and the listener notification on top of it. It does not show dialogs and does
 * not schedule safety nets — those remain the caller's responsibility for now.
 */
public final class UserInteractionService {

    private static final Logger LOG = Logger.getInstance(UserInteractionService.class);

    private final PendingUserInteractions pendingInteractions = new PendingUserInteractions();
    private final List<UserInteractionListener> listeners = new CopyOnWriteArrayList<>();

    public void addListener(UserInteractionListener listener) {
        listeners.add(listener);
    }

    /**
     * Register a permission interaction. The {@link PermissionDecisionTarget} determines how the
     * decision is delivered (future-backed file-watcher path vs. session-callback path) and the
     * session-change policy. The caller reads the future from a {@link FuturePermissionDecisionTarget}
     * it created when one is needed.
     */
    public void requestPermission(String channelId, String toolName, JsonObject inputs,
                                  JsonObject suggestions, Project project,
                                  PermissionDecisionTarget target) {
        register(new PendingPermissionInteraction(channelId, toolName, inputs, suggestions, project, target));
    }

    public CompletableFuture<JsonObject> requestAskUserQuestion(String requestId, JsonObject questionsData) {
        PendingAskUserQuestionInteraction interaction =
                new PendingAskUserQuestionInteraction(requestId, questionsData);
        register(interaction);
        return interaction.future();
    }

    public CompletableFuture<JsonObject> requestPlanApproval(String requestId, JsonObject planData) {
        PendingPlanApprovalInteraction interaction =
                new PendingPlanApprovalInteraction(requestId, planData);
        register(interaction);
        return interaction.future();
    }

    private void register(PendingUserInteraction interaction) {
        pendingInteractions.register(interaction);
        // A faulty observer must never corrupt the (safety-critical) interaction lifecycle.
        for (UserInteractionListener listener : listeners) {
            try {
                listener.userInteractionRequested(interaction);
            } catch (Exception e) {
                LOG.warn("[UserInteraction] Listener failed for " + interaction.type() + " "
                        + interaction.id() + ": " + e.getClass().getSimpleName(), e);
            }
        }
    }

    /** @return whether a pending interaction was found and resolved. */
    public boolean answer(UserInteractionType type, String id, JsonObject payload) {
        return pendingInteractions.completeFromBridgeResponse(type, id, payload);
    }

    /** @return whether a pending interaction was found and resolved. */
    public boolean timeout(UserInteractionType type, String id) {
        return pendingInteractions.timeout(type, id);
    }

    public void dialogFailed(UserInteractionType type, String id) {
        pendingInteractions.dialogFailed(type, id);
    }

    public void cancelAllSessionChanged() {
        pendingInteractions.cancelAllSessionChanged();
    }

    public int size() {
        return pendingInteractions.size();
    }

    public int count(UserInteractionType type) {
        return pendingInteractions.count(type);
    }
}
