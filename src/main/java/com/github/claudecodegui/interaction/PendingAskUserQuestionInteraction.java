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
    private final JsonObject questionsData;
    private final CompletableFuture<JsonObject> future = new CompletableFuture<>();

    public PendingAskUserQuestionInteraction(String requestId, JsonObject questionsData) {
        if (requestId == null || requestId.trim().isEmpty()) {
            throw new IllegalArgumentException("requestId must not be empty");
        }
        this.requestId = requestId;
        this.questionsData = questionsData;
    }

    public CompletableFuture<JsonObject> future() {
        return future;
    }

    @Override
    public UserInteractionType type() {
        return UserInteractionType.ASK_USER_QUESTION;
    }

    @Override
    public String id() {
        return requestId;
    }

    @Override
    public SessionChangePolicy sessionChangePolicy() {
        return SessionChangePolicy.DENY_ON_SESSION_CHANGE;
    }

    @Override
    public String frontendFunctionName() {
        return "showAskUserQuestionDialog";
    }

    @Override
    public JsonObject toFrontendPayload() {
        return questionsData;
    }

    @Override
    public void completeFromBridgeResponse(JsonObject payload) {
        JsonObject answers = payload.has("answers") && !payload.get("answers").isJsonNull()
                ? payload.get("answers").getAsJsonObject()
                : new JsonObject();
        future.complete(answers);
    }

    @Override
    public void cancelSessionChanged() {
        future.complete(null);
    }

    @Override
    public void timeout() {
        future.complete(new JsonObject());
    }

    @Override
    public void dialogFailed() {
        future.complete(new JsonObject());
    }
}
