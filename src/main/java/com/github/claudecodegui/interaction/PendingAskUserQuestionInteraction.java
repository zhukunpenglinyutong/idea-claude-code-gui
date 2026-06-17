package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;

/**
 * A pending AskUserQuestion interaction. The future completes with the answers object, or
 * {@code null} on session change — the caller distinguishes "no answer" from an empty answers
 * object by reading {@code null} (see {@code PermissionService.handleAskUserQuestion}).
 */
public final class PendingAskUserQuestionInteraction extends PendingUserInteraction<JsonObject> {

    public PendingAskUserQuestionInteraction(String requestId) {
        super(UserInteractionType.ASK_USER_QUESTION, requestId);
    }

    @Override
    protected JsonObject sessionChangedValue() {
        return null;
    }
}
