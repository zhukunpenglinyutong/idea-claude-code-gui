package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;

/**
 * A pending plan-approval interaction. The future completes with the approval result, or a
 * rejection payload on session change / timeout / dialog failure.
 */
public final class PendingPlanApprovalInteraction implements PendingUserInteraction {

    private final String requestId;
    private final JsonObject planData;
    private final CompletableFuture<JsonObject> future = new CompletableFuture<>();

    public PendingPlanApprovalInteraction(String requestId, JsonObject planData) {
        if (requestId == null || requestId.trim().isEmpty()) {
            throw new IllegalArgumentException("requestId must not be empty");
        }
        this.requestId = requestId;
        this.planData = planData;
    }

    public CompletableFuture<JsonObject> future() {
        return future;
    }

    @Override
    public UserInteractionType type() {
        return UserInteractionType.PLAN_APPROVAL;
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
    public JsonObject toFrontendPayload() {
        return planData;
    }

    @Override
    public void completeFromBridgeResponse(JsonObject payload) {
        boolean approved = payload.has("approved") && payload.get("approved").getAsBoolean();
        String targetMode = payload.has("targetMode") ? payload.get("targetMode").getAsString() : "default";
        JsonObject result = new JsonObject();
        result.addProperty("approved", approved);
        result.addProperty("targetMode", targetMode);
        future.complete(result);
    }

    @Override
    public void cancelSessionChanged() {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("approved", false);
        rejected.addProperty("message", "Session changed");
        future.complete(rejected);
    }

    @Override
    public void timeout() {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("approved", false);
        rejected.addProperty("targetMode", "default");
        rejected.addProperty("message", "Plan approval timed out");
        future.complete(rejected);
    }

    @Override
    public void dialogFailed() {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("approved", false);
        rejected.addProperty("targetMode", "default");
        rejected.addProperty("message", "Error showing plan approval dialog");
        future.complete(rejected);
    }
}
