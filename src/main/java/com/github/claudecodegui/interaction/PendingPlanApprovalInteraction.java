package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;

/**
 * A pending plan-approval interaction. The future completes with the approval result, or a
 * rejection payload on session change.
 */
public final class PendingPlanApprovalInteraction extends PendingUserInteraction<JsonObject> {

    public PendingPlanApprovalInteraction(String requestId) {
        super(UserInteractionType.PLAN_APPROVAL, requestId);
    }

    @Override
    protected JsonObject sessionChangedValue() {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("approved", false);
        rejected.addProperty("message", "Session changed");
        return rejected;
    }
}
