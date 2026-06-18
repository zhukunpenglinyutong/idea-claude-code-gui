package com.github.claudecodegui.interaction;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;

/**
 * A pending permission decision. Holds the presentation data plus a {@link PermissionDecisionTarget}
 * that knows how to deliver the decision (future-backed file-watcher path vs. session-callback path).
 */
public final class PendingPermissionInteraction implements PendingUserInteraction {

    private final String channelId;
    private final String toolName;
    private final JsonObject inputs;
    private final JsonObject suggestions;
    private final Project project;
    private final PermissionDecisionTarget target;

    public PendingPermissionInteraction(String channelId, String toolName, JsonObject inputs,
                                        JsonObject suggestions, Project project,
                                        PermissionDecisionTarget target) {
        if (channelId == null || channelId.trim().isEmpty()) {
            throw new IllegalArgumentException("channelId must not be empty");
        }
        if (target == null) {
            throw new IllegalArgumentException("target must not be null");
        }
        this.channelId = channelId;
        this.toolName = toolName;
        this.inputs = inputs;
        this.suggestions = suggestions;
        this.project = project;
        this.target = target;
    }

    @Override
    public UserInteractionType type() {
        return UserInteractionType.PERMISSION;
    }

    @Override
    public String id() {
        return channelId;
    }

    @Override
    public SessionChangePolicy sessionChangePolicy() {
        return target.sessionChangePolicy();
    }

    @Override
    public Project targetProject() {
        return project;
    }

    @Override
    public String frontendFunctionName() {
        return "showPermissionDialog";
    }

    @Override
    public JsonObject toFrontendPayload() {
        JsonObject payload = new JsonObject();
        payload.addProperty("channelId", channelId);
        payload.addProperty("toolName", toolName);
        if (inputs != null) {
            payload.add("inputs", inputs);
        }
        if (suggestions != null) {
            payload.add("suggestions", suggestions);
        }
        return payload;
    }

    @Override
    public void completeFromBridgeResponse(JsonObject payload) {
        boolean allow = payload.get("allow").getAsBoolean();
        boolean remember = payload.get("remember").getAsBoolean();
        String rejectMessage = payload.has("rejectMessage") && !payload.get("rejectMessage").isJsonNull()
                ? payload.get("rejectMessage").getAsString()
                : "";
        target.decide(allow, remember, rejectMessage);
    }

    @Override
    public void cancelSessionChanged() {
        target.deny();
    }

    @Override
    public void timeout() {
        target.deny();
    }

    @Override
    public void dialogFailed() {
        target.deny();
    }
}
