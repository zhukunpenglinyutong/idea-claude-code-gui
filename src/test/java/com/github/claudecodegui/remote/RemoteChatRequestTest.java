package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteChatRequest} body parsing and validation.
 * No HTTP server, no IntelliJ platform.
 */
public class RemoteChatRequestTest {

    @Test
    public void parsesValidMessage() {
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"message\":\"hello world\"}");
        assertTrue(r.isValid());
        assertEquals("hello world", r.getMessage());
        assertNull(r.getErrorCode());
    }

    @Test
    public void trimsMessage() {
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"message\":\"   hi   \"}");
        assertTrue(r.isValid());
        assertEquals("hi", r.getMessage());
    }

    @Test
    public void ignoresExtraFields() {
        // sessionId/provider/model etc. must be ignored — the tab's state is used.
        RemoteChatRequest.Result r = RemoteChatRequest.parseText(
            "{\"message\":\"ok\",\"sessionId\":\"x\",\"provider\":\"claude\",\"model\":\"m\"}");
        assertTrue(r.isValid());
        assertEquals("ok", r.getMessage());
    }

    @Test
    public void rejectsMissingMessage() {
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"foo\":\"bar\"}");
        assertFalse(r.isValid());
        assertEquals(RemoteErrors.Code.BAD_REQUEST, r.getErrorCode());
    }

    @Test
    public void rejectsNullMessage() {
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"message\":null}");
        assertFalse(r.isValid());
        assertEquals(RemoteErrors.Code.BAD_REQUEST, r.getErrorCode());
    }

    @Test
    public void rejectsEmptyMessage() {
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"message\":\"   \"}");
        assertFalse(r.isValid());
        assertEquals(RemoteErrors.Code.BAD_REQUEST, r.getErrorCode());
    }

    @Test
    public void rejectsNonStringMessage() {
        assertFalse(RemoteChatRequest.parseText("{\"message\":123}").isValid());
        assertFalse(RemoteChatRequest.parseText("{\"message\":[1,2]}").isValid());
        assertFalse(RemoteChatRequest.parseText("{\"message\":{}}").isValid());
        assertFalse(RemoteChatRequest.parseText("{\"message\":true}").isValid());
    }

    @Test
    public void rejectsNonObjectBody() {
        assertFalse(RemoteChatRequest.parseText("\"just a string\"").isValid());
        assertFalse(RemoteChatRequest.parseText("[1,2,3]").isValid());
        assertFalse(RemoteChatRequest.parseText("42").isValid());
    }

    @Test
    public void rejectsInvalidJson() {
        assertFalse(RemoteChatRequest.parseText("{not json").isValid());
        assertFalse(RemoteChatRequest.parseText("").isValid());
        assertFalse(RemoteChatRequest.parseText("   ").isValid());
        assertFalse(RemoteChatRequest.parseText(null).isValid());
    }

    @Test
    public void rejectsOversizedMessage() {
        StringBuilder sb = new StringBuilder(RemoteChatLimits.MAX_MESSAGE_LENGTH + 1);
        for (int i = 0; i < RemoteChatLimits.MAX_MESSAGE_LENGTH + 1; i++) {
            sb.append('a');
        }
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"message\":\"" + sb + "\"}");
        assertFalse(r.isValid());
        assertEquals(RemoteErrors.Code.BAD_REQUEST, r.getErrorCode());
    }

    @Test
    public void acceptsMessageAtExactLimit() {
        StringBuilder sb = new StringBuilder(RemoteChatLimits.MAX_MESSAGE_LENGTH);
        for (int i = 0; i < RemoteChatLimits.MAX_MESSAGE_LENGTH; i++) {
            sb.append('a');
        }
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"message\":\"" + sb + "\"}");
        assertTrue(r.isValid());
        assertEquals(RemoteChatLimits.MAX_MESSAGE_LENGTH, r.getMessage().length());
    }

    @Test
    public void parseBytesHandlesNullAndEmpty() {
        assertFalse(RemoteChatRequest.parse(null).isValid());
        assertFalse(RemoteChatRequest.parse(new byte[0]).isValid());
    }

    @Test
    public void errorMessageDoesNotEchoBody() {
        // Even on a parse failure, the error message is generic — never the body text.
        RemoteChatRequest.Result r = RemoteChatRequest.parseText("{\"message\":\"secret-value-123\"}");
        assertTrue(r.isValid()); // this one is valid
        // An invalid one:
        RemoteChatRequest.Result bad = RemoteChatRequest.parseText("{bad syntax with secret-value-123}");
        assertFalse(bad.isValid());
        assertFalse(bad.getErrorMessage().contains("secret-value-123"));
    }
}
