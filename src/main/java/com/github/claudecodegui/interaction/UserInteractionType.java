package com.github.claudecodegui.interaction;

/**
 * The kinds of in-flight user interactions the frontend can be waiting on.
 *
 * <p>All three share the same lifecycle (registered -&gt; answered | session-changed | timeout)
 * and are managed together by {@link PendingUserInteractions}.
 */
public enum UserInteractionType {
    PERMISSION,
    ASK_USER_QUESTION,
    PLAN_APPROVAL
}
