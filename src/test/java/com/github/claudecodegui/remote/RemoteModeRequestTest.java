package com.github.claudecodegui.remote;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteModeRequest} (Phase 2C-C §24).
 */
public class RemoteModeRequestTest {

    private static byte[] b(String json) {
        return json.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void acceptsEachValidMode() {
        for (String mode : new String[]{"default", "plan", "acceptEdits", "autoEdit", "bypassPermissions"}) {
            RemoteModeRequest.Result r = RemoteModeRequest.parse(b("{\"mode\":\"" + mode + "\"}"));
            assertTrue("mode '" + mode + "' should be valid", r.valid);
            assertEquals(mode, r.mode);
        }
    }

    @Test
    public void rejectsAliases() {
        for (String alias : new String[]{"auto", "全自动", "allow_all", "always", "yes", "AcceptEdits"}) {
            RemoteModeRequest.Result r = RemoteModeRequest.parse(b("{\"mode\":\"" + alias + "\"}"));
            assertFalse("alias '" + alias + "' must be rejected", r.valid);
            assertEquals(RemoteErrors.Code.INVALID_MODE, r.errorCode);
        }
    }

    @Test
    public void rejectsMissingMode() {
        assertFalse(RemoteModeRequest.parse(b("{}")).valid);
        assertFalse(RemoteModeRequest.parse(b("")).valid);
        assertFalse(RemoteModeRequest.parse(null).valid);
    }

    @Test
    public void rejectsNonStringMode() {
        assertFalse(RemoteModeRequest.parse(b("{\"mode\":42}")).valid);
        assertFalse(RemoteModeRequest.parse(b("{\"mode\":null}")).valid);
    }

    @Test
    public void rejectsInvalidJson() {
        assertFalse(RemoteModeRequest.parse(b("not json")).valid);
    }
}
