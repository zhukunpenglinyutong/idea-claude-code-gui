package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Path-parsing tests for the chat sub-route and tabId validation. Exercises
 * static {@link RemoteApiRouter#matchTabRoute(String)} and
 * {@link RemoteApiRouter#isValidTabId(String)} without an HTTP server or the
 * IntelliJ platform.
 */
public class RemoteChatRouteTest {

    private static final String PID = "0b0dcb1be3f66a8155c856a24174aef3";
    private static final String TAB = "e2afd226-d07a-45aa-9598-90176518ad19";

    @Test
    public void matchesChatRoute() {
        RemoteApiRouter.TabRouteMatch m =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID + "/tabs/" + TAB + "/chat");
        assertNotNull(m);
        assertTrue(m.shapeValid);
        assertEquals(PID, m.projectId);
        assertEquals(TAB, m.tabId);
        assertEquals("chat", m.suffix);
    }

    @Test
    public void singleTabRouteHasNoSuffix() {
        RemoteApiRouter.TabRouteMatch m =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID + "/tabs/" + TAB);
        assertNotNull(m);
        assertTrue(m.shapeValid);
        assertEquals(TAB, m.tabId);
        assertNull(m.suffix);
    }

    @Test
    public void matchesEventsRoute() {
        // Phase 2C-B: /events is a known SSE sub-resource.
        RemoteApiRouter.TabRouteMatch m =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID + "/tabs/" + TAB + "/events");
        assertNotNull(m);
        assertTrue(m.shapeValid);
        assertEquals(TAB, m.tabId);
        assertEquals("events", m.suffix);
    }

    @Test
    public void rejectsUnknownSubResource() {
        // /tabs/{tabId}/chat/extra and other unknown suffixes -> null (404).
        assertNull(RemoteApiRouter.matchTabRoute(
            "/api/v1/projects/" + PID + "/tabs/" + TAB + "/chat/extra"));
        assertNull(RemoteApiRouter.matchTabRoute(
            "/api/v1/projects/" + PID + "/tabs/" + TAB + "/unknown"));
    }

    @Test
    public void rejectsChatRouteWithMalformedProjectId() {
        RemoteApiRouter.TabRouteMatch m =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/not-valid/tabs/" + TAB + "/chat");
        assertNotNull(m);
        assertFalse(m.shapeValid);
    }

    @Test
    public void tabIdUuidValidation() {
        assertTrue(RemoteApiRouter.isValidTabId("e2afd226-d07a-45aa-9598-90176518ad19"));
        // Case-insensitive: a client may send uppercase.
        assertTrue(RemoteApiRouter.isValidTabId("E2AFD226-D07A-45AA-9598-90176518AD19"));
        assertFalse(RemoteApiRouter.isValidTabId("abc-123"));
        assertFalse(RemoteApiRouter.isValidTabId("not-a-uuid"));
        assertFalse(RemoteApiRouter.isValidTabId(""));
        assertFalse(RemoteApiRouter.isValidTabId(null));
        assertFalse(RemoteApiRouter.isValidTabId("e2afd226-d07a-45aa-9598-90176518ad1")); // too short
        assertFalse(RemoteApiRouter.isValidTabId("e2afd226-d07a-45aa-9598-90176518ad199")); // too long
    }

    private static <T> void assertNotNull(T t) {
        org.junit.Assert.assertNotNull(t);
    }
}
