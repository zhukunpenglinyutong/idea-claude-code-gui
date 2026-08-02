package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;

/**
 * Outcome of a Remote chat dispatch, mapped by the router to an HTTP response.
 *
 * <p>Carries no message body text — only identities (taskId/sessionId) and a
 * status. Safe to log.
 */
final class RemoteChatResult {

    enum Status { ACCEPTED, NOT_FOUND, BUSY, TIMEOUT, INTERNAL_ERROR, UNAVAILABLE }

    final Status status;
    final String taskId;
    final String sessionId; // current session id at resolve time; may be null for a new tab

    private RemoteChatResult(Status status, String taskId, String sessionId) {
        this.status = status;
        this.taskId = taskId;
        this.sessionId = sessionId;
    }

    static RemoteChatResult accepted(String taskId, String sessionId) {
        return new RemoteChatResult(Status.ACCEPTED, taskId, sessionId);
    }

    static RemoteChatResult notFound() {
        return new RemoteChatResult(Status.NOT_FOUND, null, null);
    }

    static RemoteChatResult busy() {
        return new RemoteChatResult(Status.BUSY, null, null);
    }

    static RemoteChatResult timeout() {
        return new RemoteChatResult(Status.TIMEOUT, null, null);
    }

    static RemoteChatResult internalError() {
        return new RemoteChatResult(Status.INTERNAL_ERROR, null, null);
    }

    /**
     * The request's owning gateway generation is already disposed (the bus has rotated
     * past the handler's immutable gateway-generation token). Returned before any tab
     * resolution / gate acquisition / {@code ClaudeSession.send} so a stale request
     * never starts a turn and never becomes a task of a newer generation (Phase 2C-C.1
     * generation-ownership closure, §6).
     */
    static RemoteChatResult unavailable() {
        return new RemoteChatResult(Status.UNAVAILABLE, null, null);
    }

    /** Build the 202 Accepted JSON body. Only valid for {@link Status#ACCEPTED}. */
    String toAcceptedJson(String projectId, String tabId) {
        JsonObject obj = new JsonObject();
        obj.addProperty("taskId", taskId);
        obj.addProperty("projectId", projectId);
        obj.addProperty("tabId", tabId);
        if (sessionId != null && !sessionId.isEmpty()) {
            obj.addProperty("sessionId", sessionId);
        }
        obj.addProperty("status", "accepted");
        return obj.toString();
    }
}
