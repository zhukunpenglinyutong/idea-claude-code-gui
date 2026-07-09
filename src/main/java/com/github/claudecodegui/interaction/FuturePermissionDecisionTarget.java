package com.github.claudecodegui.interaction;

import com.github.claudecodegui.permission.PermissionService;

import java.util.concurrent.CompletableFuture;

/**
 * Permission decision target for the file-watcher path: completes a {@code CompletableFuture<Integer>}
 * with a {@link PermissionService.PermissionResponse} value, which {@code PermissionService} awaits
 * to write the permission response file.
 *
 * <p>These interactions are denied and dropped on session change ({@link SessionChangePolicy#DENY_ON_SESSION_CHANGE}).
 */
public final class FuturePermissionDecisionTarget implements PermissionDecisionTarget {

    private static final int DENY = PermissionService.PermissionResponse.DENY.getValue();

    private final CompletableFuture<Integer> future = new CompletableFuture<>();

    public CompletableFuture<Integer> future() {
        return future;
    }

    @Override
    public void decide(boolean allow, boolean remember, String rejectMessage) {
        int responseValue;
        if (allow) {
            responseValue = remember
                    ? PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue()
                    : PermissionService.PermissionResponse.ALLOW.getValue();
        } else {
            responseValue = DENY;
        }
        future.complete(responseValue);
    }

    @Override
    public void deny() {
        future.complete(DENY);
    }

    @Override
    public SessionChangePolicy sessionChangePolicy() {
        return SessionChangePolicy.DENY_ON_SESSION_CHANGE;
    }
}
