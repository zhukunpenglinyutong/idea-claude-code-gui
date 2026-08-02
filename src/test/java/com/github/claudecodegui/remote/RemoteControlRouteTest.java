package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Path-parsing tests for the Phase 2C-C control sub-resources (mode /
 * permissions / questions / plans / tasks). Exercises static
 * {@link RemoteApiRouter#matchTabRoute(String)} without an HTTP server.
 */
public class RemoteControlRouteTest {

    private static final String PID = "0b0dcb1be3f66a8155c856a24174aef3";
    private static final String TAB = "e2afd226-d07a-45aa-9598-90176518ad19";
    private static final String IID = "f1e2d3c4-b5a6-7890-1234-567890abcdef";

    private RemoteApiRouter.TabRouteMatch match(String suffix) {
        return RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID + "/tabs/" + TAB + "/" + suffix);
    }

    @Test
    public void matchesModeRoute() {
        RemoteApiRouter.TabRouteMatch m = match("mode");
        assertNotNull(m);
        assertTrue(m.shapeValid);
        assertEquals(TAB, m.tabId);
        assertEquals("mode", m.suffix);
        assertNull(m.resourceId);
        assertNull(m.action);
    }

    @Test
    public void matchesPermissionDecisionRoute() {
        RemoteApiRouter.TabRouteMatch m = match("permissions/" + IID + "/decision");
        assertNotNull(m);
        assertEquals("permissions", m.suffix);
        assertEquals(IID, m.resourceId);
        assertEquals("decision", m.action);
    }

    @Test
    public void matchesQuestionAnswerRoute() {
        RemoteApiRouter.TabRouteMatch m = match("questions/" + IID + "/answer");
        assertNotNull(m);
        assertEquals("questions", m.suffix);
        assertEquals(IID, m.resourceId);
        assertEquals("answer", m.action);
    }

    @Test
    public void matchesPlanDecisionRoute() {
        RemoteApiRouter.TabRouteMatch m = match("plans/" + IID + "/decision");
        assertNotNull(m);
        assertEquals("plans", m.suffix);
        assertEquals("decision", m.action);
    }

    @Test
    public void matchesTaskAbortRoute() {
        RemoteApiRouter.TabRouteMatch m = match("tasks/" + IID + "/abort");
        assertNotNull(m);
        assertEquals("tasks", m.suffix);
        assertEquals(IID, m.resourceId);
        assertEquals("abort", m.action);
    }

    @Test
    public void rejectsTrailingSegmentAfterAction() {
        assertNull(match("permissions/" + IID + "/decision/extra"));
        assertNull(match("tasks/" + IID + "/abort/extra"));
    }

    @Test
    public void rejectsMissingAction() {
        assertNull(match("permissions/" + IID));
        assertNull(match("tasks/" + IID));
    }

    @Test
    public void rejectsWrongActionForResource() {
        // permissions only accepts /decision; tasks only accepts /abort.
        assertNull(match("permissions/" + IID + "/answer"));
        assertNull(match("tasks/" + IID + "/decision"));
    }

    @Test
    public void rejectsChatWithTrailing() {
        // Existing contract: /chat takes no trailing segment.
        assertNull(match("chat/extra"));
        assertNull(match("unknown"));
    }
}
