package com.github.claudecodegui.remote;

/**
 * Encodes {@link RemoteEvent}s and heartbeats into SSE wire frames.
 *
 * <pre>
 * id: 42
 * event: task.started
 * data: {"eventId":42,"event":"task.started",...}
 *
 * </pre>
 * and the heartbeat:
 * <pre>
 * : keepalive
 *
 * </pre>
 *
 * <p>Pure logic — testable without a socket. The {@code data} JSON is produced
 * by {@link RemoteEvent#toEnvelopeJson()} which is single-line (Gson escapes
 * embedded newlines), so a frame never breaks the SSE protocol.
 */
public final class RemoteSseEncoder {

    private RemoteSseEncoder() {
    }

    /** Full SSE frame for an event (terminated by a blank line). */
    public static String frame(RemoteEvent event) {
        StringBuilder sb = new StringBuilder(128);
        sb.append("id: ").append(event.getEventId()).append('\n');
        sb.append("event: ").append(event.getEvent()).append('\n');
        sb.append("data: ").append(event.toEnvelopeJson()).append('\n');
        sb.append('\n');
        return sb.toString();
    }

    /** SSE comment frame used as a heartbeat (no event id, no task identity). */
    public static String heartbeat() {
        return ": keepalive\n\n";
    }

    /** SSE frame for an ad-hoc event without an id (e.g. overflow terminator). */
    public static String frameWithoutId(String event, String dataJson) {
        StringBuilder sb = new StringBuilder(128);
        sb.append("event: ").append(event).append('\n');
        sb.append("data: ").append(dataJson).append('\n');
        sb.append('\n');
        return sb.toString();
    }
}
