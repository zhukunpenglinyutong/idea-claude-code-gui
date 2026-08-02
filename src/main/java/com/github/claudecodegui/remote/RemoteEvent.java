package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;

/**
 * Immutable Remote event envelope published to the {@link RemoteEventBus} and
 * serialized onto the SSE stream.
 *
 * <pre>
 * { "eventId": 42, "event": "assistant.content", "timestamp": 1690...,
 *   "projectId": "...", "tabId": "...", "sessionId": "...", "taskId": "...",
 *   "payload": { ... } }
 * </pre>
 *
 * <p>{@code taskId}/{@code sessionId} are omitted from the JSON when null/empty
 * (a new tab's first turn has no sessionId yet). No apiKey/baseUrl/token or
 * other secret ever appears in {@code payload}; the payload is built by the
 * producer and already redacted.
 */
public final class RemoteEvent {

    private final long eventId;
    private final String event;
    private final long timestamp;
    private final String projectId;
    private final String tabId;
    private final String taskId;
    private final String sessionId;
    private final JsonObject payload;

    public RemoteEvent(long eventId, String event, long timestamp,
                       String projectId, String tabId, String taskId,
                       String sessionId, JsonObject payload) {
        this.eventId = eventId;
        this.event = event;
        this.timestamp = timestamp;
        this.projectId = projectId;
        this.tabId = tabId;
        this.taskId = taskId;
        this.sessionId = sessionId;
        this.payload = payload;
    }

    public long getEventId() {
        return eventId;
    }

    public String getEvent() {
        return event;
    }

    public String getTabId() {
        return tabId;
    }

    /** Compact single-line JSON for the SSE {@code data:} field. */
    public String toEnvelopeJson() {
        JsonObject obj = new JsonObject();
        obj.addProperty("eventId", eventId);
        obj.addProperty("event", event);
        obj.addProperty("timestamp", timestamp);
        if (projectId != null && !projectId.isEmpty()) {
            obj.addProperty("projectId", projectId);
        }
        if (tabId != null && !tabId.isEmpty()) {
            obj.addProperty("tabId", tabId);
        }
        if (taskId != null && !taskId.isEmpty()) {
            obj.addProperty("taskId", taskId);
        }
        if (sessionId != null && !sessionId.isEmpty()) {
            obj.addProperty("sessionId", sessionId);
        }
        if (payload != null) {
            obj.add("payload", payload);
        } else {
            obj.add("payload", new JsonObject());
        }
        // Gson escapes newlines inside strings as \n, so this stays single-line.
        return obj.toString();
    }
}
