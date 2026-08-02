package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class RemoteErrorsTest {

    @Test
    public void bodyHasCanonicalEnvelope() {
        String body = RemoteErrors.body(RemoteErrors.Code.UNAUTHORIZED);
        assertEquals("{\"error\":{\"code\":\"UNAUTHORIZED\",\"message\":\"Unauthorized\"}}", body);
    }

    @Test
    public void bodyCanOverrideMessage() {
        String body = RemoteErrors.body(RemoteErrors.Code.BAD_REQUEST, "missing field 'message'");
        assertTrue(body.contains("\"code\":\"BAD_REQUEST\""));
        assertTrue(body.contains("\"message\":\"missing field 'message'\""));
    }

    @Test
    public void nullMessageFallsBackToDefault() {
        String body = RemoteErrors.body(RemoteErrors.Code.NOT_FOUND, null);
        assertTrue(body.contains("\"message\":\"Not found\""));
    }

    @Test
    public void codesMapToExpectedHttpStatuses() {
        assertEquals(400, RemoteErrors.Code.BAD_REQUEST.status());
        assertEquals(401, RemoteErrors.Code.UNAUTHORIZED.status());
        assertEquals(403, RemoteErrors.Code.FORBIDDEN.status());
        assertEquals(404, RemoteErrors.Code.NOT_FOUND.status());
        assertEquals(405, RemoteErrors.Code.METHOD_NOT_ALLOWED.status());
        assertEquals(500, RemoteErrors.Code.INTERNAL_ERROR.status());
    }
}
