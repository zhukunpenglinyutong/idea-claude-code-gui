package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for the {@code 202 Accepted} JSON envelope built by
 * {@link RemoteChatResult#toAcceptedJson}.
 */
public class RemoteChatResultTest {

    private static final String PID = "0b0dcb1be3f66a8155c856a24174aef3";
    private static final String TAB = "e2afd226-d07a-45aa-9598-90176518ad19";

    @Test
    public void acceptedEnvelopeIncludesSessionIdWhenPresent() {
        RemoteChatResult r = RemoteChatResult.accepted("task-1", "session-abc");
        String json = r.toAcceptedJson(PID, TAB);
        assertTrue(json.contains("\"taskId\":\"task-1\""));
        assertTrue(json.contains("\"projectId\":\"" + PID + "\""));
        assertTrue(json.contains("\"tabId\":\"" + TAB + "\""));
        assertTrue(json.contains("\"sessionId\":\"session-abc\""));
        assertTrue(json.contains("\"status\":\"accepted\""));
    }

    @Test
    public void acceptedEnvelopeOmitsSessionIdForNewTab() {
        RemoteChatResult r = RemoteChatResult.accepted("task-2", null);
        String json = r.toAcceptedJson(PID, TAB);
        assertTrue(json.contains("\"taskId\":\"task-2\""));
        assertTrue(json.contains("\"status\":\"accepted\""));
        assertFalse(json.contains("sessionId"));
    }

    @Test
    public void acceptedEnvelopeOmitsEmptySessionId() {
        RemoteChatResult r = RemoteChatResult.accepted("task-3", "");
        String json = r.toAcceptedJson(PID, TAB);
        assertFalse(json.contains("sessionId"));
    }
}
