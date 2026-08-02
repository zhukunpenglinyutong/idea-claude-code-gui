package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Path-parsing tests for the tab routes. Exercises the static
 * {@link RemoteApiRouter#matchTabRoute(String)} without starting an HTTP server
 * or the IntelliJ platform.
 */
public class RemoteApiRouterPathTest {

    private static final String PID = "0b0dcb1be3f66a8155c856a24174aef3";

    @Test
    public void matchesTabsListRoute() {
        RemoteApiRouter.TabRouteMatch m = RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID + "/tabs");
        assertNotNull(m);
        assertTrue(m.shapeValid);
        assertEquals(PID, m.projectId);
        assertNull(m.tabId);
    }

    @Test
    public void matchesSingleTabRoute() {
        RemoteApiRouter.TabRouteMatch m =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID + "/tabs/abc-123");
        assertNotNull(m);
        assertTrue(m.shapeValid);
        assertEquals(PID, m.projectId);
        assertEquals("abc-123", m.tabId);
    }

    @Test
    public void rejectsMalformedProjectId() {
        // Not 32 lowercase hex -> shapeValid=false so router returns 400.
        RemoteApiRouter.TabRouteMatch m =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/not-a-valid-id/tabs");
        assertNotNull(m);
        assertFalse(m.shapeValid);
    }

    @Test
    public void rejectsNonTabProjectRoute() {
        // /api/v1/projects/{id} with no /tabs suffix is not a tab route.
        assertNull(RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID));
    }

    @Test
    public void rejectsUnrelatedPaths() {
        assertNull(RemoteApiRouter.matchTabRoute("/api/v1/health"));
        assertNull(RemoteApiRouter.matchTabRoute("/api/v1/projects"));
        assertNull(RemoteApiRouter.matchTabRoute("/api/v1/status"));
        assertNull(RemoteApiRouter.matchTabRoute("/api/v1/projects/" + PID + "/sessions"));
        assertNull(RemoteApiRouter.matchTabRoute(null));
        assertNull(RemoteApiRouter.matchTabRoute(""));
        assertNull(RemoteApiRouter.matchTabRoute("/api/v1/projects/"));
    }

    @Test
    public void rejectsUppercaseOrWrongLengthProjectId() {
        // Uppercase / wrong-length ids are not 32 lowercase hex; they parse as a
        // tab route shape but with shapeValid=false so the router returns 400.
        RemoteApiRouter.TabRouteMatch upper =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/ABC/tabs");
        assertNotNull(upper);
        assertFalse(upper.shapeValid);

        RemoteApiRouter.TabRouteMatch shortId =
            RemoteApiRouter.matchTabRoute("/api/v1/projects/0b0dcb1be3f66a8155c856a24174aef/tabs");
        assertNotNull(shortId);
        assertFalse(shortId.shapeValid);
    }

    private static <T> void assertNotNull(T t) {
        org.junit.Assert.assertNotNull(t);
    }
}
