package com.github.claudecodegui.remote;

/**
 * One observed permission / AskUserQuestion / Plan Approval interaction,
 * captured at the source-aware hook ({@code PermissionService.dispatch*}).
 *
 * <p>{@code sourceTaskId} is the active Remote task whose session matched the
 * interaction's {@code sessionId} — this is how a request is reliably tied to a
 * Remote task even when {@code PermissionDialogRouter} displays the dialog in a
 * different window (Phase 2C-A.1 §5).
 *
 * <p>{@code interactionId} is {@code channelId} (permission) or {@code requestId}
 * (ask/plan). {@code requestId} is only session-scoped unique, so the registry
 * key is always {@code (sessionId, interactionId)}.
 */
public final class RemoteInteraction {

    public enum Type { PERMISSION, QUESTION, PLAN }

    private final Type type;
    private final String interactionId;
    private final String requestId;     // daemon requestId; null for permission (channelId used)
    private final String sessionId;
    private final String sourceProjectId;
    private final String sourceTabId;
    private final String sourceTaskId;
    private final long createdAt;

    public RemoteInteraction(Type type, String interactionId, String requestId,
                             String sessionId, String sourceProjectId,
                             String sourceTabId, String sourceTaskId, long createdAt) {
        this.type = type;
        this.interactionId = interactionId;
        this.requestId = requestId;
        this.sessionId = sessionId;
        this.sourceProjectId = sourceProjectId;
        this.sourceTabId = sourceTabId;
        this.sourceTaskId = sourceTaskId;
        this.createdAt = createdAt;
    }

    public Type getType() { return type; }
    public String getInteractionId() { return interactionId; }
    public String getRequestId() { return requestId; }
    public String getSessionId() { return sessionId; }
    public String getSourceTaskId() { return sourceTaskId; }
    public String getSourceTabId() { return sourceTabId; }
    public String getSourceProjectId() { return sourceProjectId; }
    public long getCreatedAt() { return createdAt; }
}
