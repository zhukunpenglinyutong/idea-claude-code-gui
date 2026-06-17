package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;

/**
 * A pending plan-approval interaction. The future completes with the approval result, or a
 * rejection payload on session change / timeout / dialog failure.
 */
public final class PendingPlanApprovalInteraction implements PendingUserInteraction {

    private final String requestId;
    private final CompletableFuture<JsonObject> future = new CompletableFuture<>();

    public PendingPlanApprovalInteraction(String requestId) {
        if (requestId == null || requestId.trim().isEmpty()) {
            throw new IllegalArgumentException("requestId must not be empty");
        }
        this.requestId = requestId;
    }

    @Override
    public UserInteractionType type() {
        return UserInteractionType.PLAN_APPROVAL;
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
        boolean approved = payload.has("approved") && payload.get("approved").getAsBoolean();
        String targetMode = payload.has("targetMode") ? payload.get("targetMode").getAsString() : "default";
        JsonObject result = new JsonObject();
        result.addProperty("approved", approved);
        result.addProperty("targetMode", targetMode);
        return future.complete(result);
    }

    @Override
    public boolean cancelSessionChanged() {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("approved", false);
        rejected.addProperty("message", "Session changed");
        return future.complete(rejected);
    }

    @Override
    public boolean timeout() {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("approved", false);
        rejected.addProperty("targetMode", "default");
        rejected.addProperty("message", "Plan approval timed out");
        return future.complete(rejected);
    }

    @Override
    public boolean dialogFailed() {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("approved", false);
        rejected.addProperty("targetMode", "default");
        rejected.addProperty("message", "Error showing plan approval dialog");
        return future.complete(rejected);
    }
}
