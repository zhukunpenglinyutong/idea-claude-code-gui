package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteSseEncoder}.
 */
public class RemoteSseEncoderTest {

    @Test
    public void frameHasIdEventDataBlankLine() {
        RemoteEvent e = new RemoteEvent(42, "task.started", 1000L, "pid", "tab", "task", "sess", new JsonObject());
        String frame = RemoteSseEncoder.frame(e);
        assertTrue(frame.startsWith("id: 42\n"));
        assertTrue(frame.contains("event: task.started\n"));
        assertTrue(frame.contains("data: "));
        assertTrue(frame.endsWith("\n\n"));
    }

    @Test
    public void dataIsSingleLine() {
        // A payload containing a newline must not break the SSE protocol — Gson
        // escapes embedded newlines as \n inside the JSON string.
        JsonObject payload = new JsonObject();
        payload.addProperty("text", "line1\nline2");
        RemoteEvent e = new RemoteEvent(1, "assistant.content", 1L, "pid", "tab", "task", "sess", payload);
        String frame = RemoteSseEncoder.frame(e);
        // The frame itself has exactly the structural newlines (id/event/data/blank).
        // Count newlines: 4 (after id, after event, after data, blank line). No raw
        // newline inside the data line.
        String dataLine = frame.split("\n", 3)[2]; // "data: ...\n\n" -> "data: ..."? careful
        // Extract the data line (the 3rd line, index 2 of split by \n with limit 3)
        // Simpler: assert the data JSON contains the escaped \n sequence, not a raw newline.
        assertTrue(frame.contains("line1\\nline2"));
        assertFalse(frame.contains("line1\nline2"));
    }

    @Test
    public void heartbeatIsComment() {
        assertEquals(": keepalive\n\n", RemoteSseEncoder.heartbeat());
    }

    @Test
    public void frameWithoutIdHasEventAndData() {
        String frame = RemoteSseEncoder.frameWithoutId("stream.overflow", "{\"reason\":\"x\"}");
        assertTrue(frame.startsWith("event: stream.overflow\n"));
        assertTrue(frame.contains("data: {\"reason\":\"x\"}\n"));
        assertTrue(frame.endsWith("\n\n"));
    }

    @Test
    public void envelopeOmitsNullTaskIdAndSessionId() {
        RemoteEvent e = new RemoteEvent(7, "task.accepted", 1L, "pid", "tab", null, null, new JsonObject());
        String frame = RemoteSseEncoder.frame(e);
        assertFalse(frame.contains("taskId"));
        assertFalse(frame.contains("sessionId"));
        assertTrue(frame.contains("projectId"));
        assertTrue(frame.contains("tabId"));
    }
}
