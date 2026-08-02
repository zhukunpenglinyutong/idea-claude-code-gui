package com.github.claudecodegui.remote;

/**
 * Lifecycle state of a Remote task. Terminal states are
 * {@link #COMPLETED}/{@link #FAILED}/{@link #ABORTED}.
 */
public enum RemoteTaskState {
    ACCEPTED,
    STARTED,
    RUNNING,
    WAITING_PERMISSION,
    WAITING_USER_INPUT,
    WAITING_PLAN_APPROVAL,
    COMPLETED,
    FAILED,
    ABORTED;

    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED || this == ABORTED;
    }
}
