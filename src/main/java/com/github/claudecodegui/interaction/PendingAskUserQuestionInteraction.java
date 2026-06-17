package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;

/**
 * A pending AskUserQuestion interaction. The future completes with the answers object, or
 * {@code null} on session change — the caller distinguishes "no answer" from an empty answers
 * object by reading {@code null} (see {@code PermissionService.handleAskUserQuestion}).
 */
public final class PendingAskUserQuestionInteraction implements PendingUserInteraction {

    private final String requestId;
    private final CompletableFuture<JsonObject> future = new CompletableFuture<>();

    public PendingAskUserQuestionInteraction(String requestId) {
        if (requestId == null || requestId.trim().isEmpty()) {
            throw new IllegalArgumentException("requestId must not be empty");
        }
        this.requestId = requestId;
    }

    @Override
    public UserInteractionType type() {
        return UserInteractionType.ASK_USER_QUESTION;
    }

    @Override
    public String id() {
        return requestId;
    }

    public CompletableFuture<JsonObject> future() {
        return future;
    }

    @Override
    public boolean completeFromBridgeResponse(JsonObject payload) {
        JsonObject answers = payload.has("answers") && !payload.get("answers").isJsonNull()
                ? payload.get("answers").getAsJsonObject()
                : new JsonObject();
        return future.complete(answers);
    }

    @Override
    public boolean cancelSessionChanged() {
        return future.complete(null);
    }

    @Override
    public boolean timeout() {
        return future.complete(new JsonObject());
    }

    @Override
    public boolean dialogFailed() {
        return future.complete(new JsonObject());
    }
}
