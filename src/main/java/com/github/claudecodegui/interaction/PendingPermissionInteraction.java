package com.github.claudecodegui.interaction;

import com.github.claudecodegui.permission.PermissionService;
import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;

/**
 * A pending permission decision. The future completes with a
 * {@link PermissionService.PermissionResponse} value.
 */
public final class PendingPermissionInteraction implements PendingUserInteraction {

    private static final int DENY = PermissionService.PermissionResponse.DENY.getValue();

    private final String channelId;
    private final CompletableFuture<Integer> future = new CompletableFuture<>();

    public PendingPermissionInteraction(String channelId) {
        if (channelId == null || channelId.trim().isEmpty()) {
            throw new IllegalArgumentException("channelId must not be empty");
        }
        this.channelId = channelId;
    }

    @Override
    public UserInteractionType type() {
        return UserInteractionType.PERMISSION;
    }

    @Override
    public String id() {
        return channelId;
    }

    public CompletableFuture<Integer> future() {
        return future;
    }

    @Override
    public boolean completeFromBridgeResponse(JsonObject payload) {
        boolean allow = payload.get("allow").getAsBoolean();
        boolean remember = payload.get("remember").getAsBoolean();
        int responseValue;
        if (allow) {
            responseValue = remember
                    ? PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue()
                    : PermissionService.PermissionResponse.ALLOW.getValue();
        } else {
            responseValue = DENY;
        }
        return future.complete(responseValue);
    }

    @Override
    public boolean cancelSessionChanged() {
        return future.complete(DENY);
    }

    @Override
    public boolean timeout() {
        return future.complete(DENY);
    }

    @Override
    public boolean dialogFailed() {
        return future.complete(DENY);
    }
}
