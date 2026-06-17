package com.github.claudecodegui.interaction;

import com.github.claudecodegui.permission.PermissionService;

/**
 * A pending permission decision. The future completes with a
 * {@link PermissionService.PermissionResponse} value.
 */
public final class PendingPermissionInteraction extends PendingUserInteraction<Integer> {

    public PendingPermissionInteraction(String channelId) {
        super(UserInteractionType.PERMISSION, channelId);
    }

    @Override
    protected Integer sessionChangedValue() {
        return PermissionService.PermissionResponse.DENY.getValue();
    }
}
