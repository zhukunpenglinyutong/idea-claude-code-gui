package com.github.claudecodegui.session;

import com.google.gson.JsonObject;
import org.junit.Test;



import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the raw-payload retention policy in {@link SessionState}.
 *
 * <p>Raw SDK JSON (tool_result file contents, base64 images) is the dominant
 * memory cost of a long session; only the last couple of messages ever need
 * it (streaming merge + completion notification preview), so everything older
 * must be dropped.
 */
public class SessionStateTrimRawTest {

    private static JsonObject rawOf(int approximateBytes) {
        JsonObject raw = new JsonObject();
        raw.addProperty("pad", "x".repeat(Math.max(1, approximateBytes)));
        return raw;
    }

    @Test
    public void trimKeepsOnlyTheLastKeepLastRawPayloads() {
        SessionState state = new SessionState();
        for (int i = 0; i < 6; i++) {
            state.addMessage(new ClaudeSession.Message(
                    ClaudeSession.Message.Type.ASSISTANT, "m" + i, rawOf(10)));
        }

        state.trimRawHistory(2);

        assertNull(state.getMessages().get(0).raw);
        assertNull(state.getMessages().get(1).raw);
        assertNull(state.getMessages().get(2).raw);
        assertNull(state.getMessages().get(3).raw);
        assertEquals("x".repeat(10), state.getMessages().get(4).raw.get("pad").getAsString());
        assertEquals("x".repeat(10), state.getMessages().get(5).raw.get("pad").getAsString());
    }

    @Test
    public void trimWithKeepLastLargerThanSizeIsANoOp() {
        SessionState state = new SessionState();
        state.addMessage(new ClaudeSession.Message(
                ClaudeSession.Message.Type.USER, "m0", rawOf(5)));

        state.trimRawHistory(10);

        assertEquals("x".repeat(5), state.getMessages().get(0).raw.get("pad").getAsString());
    }

    @Test
    public void addMessageLazilyTrimsOlderRawPayloads() {
        SessionState state = new SessionState();
        for (int i = 0; i < 8; i++) {
            state.addMessage(new ClaudeSession.Message(
                    ClaudeSession.Message.Type.ASSISTANT, "m" + i, rawOf(10)));
            int size = state.getMessages().size();
            for (int j = 0; j < size - SessionState.RAW_RETENTION_COUNT; j++) {
                assertNull("message " + j + " should have been trimmed", state.getMessages().get(j).raw);
            }
        }
    }

    @Test
    public void longSessionRawMemoryIsBoundedToTheRetentionWindow() {
        SessionState state = new SessionState();
        int messageCount = 200;
        int rawBytes = 50_000;
        for (int i = 0; i < messageCount; i++) {
            state.addMessage(new ClaudeSession.Message(
                    ClaudeSession.Message.Type.ASSISTANT, "m" + i, rawOf(rawBytes)));
        }

        long retained = state.getMessages().stream()
                .filter(m -> m.raw != null)
                .mapToLong(m -> m.raw.toString().length())
                .sum();

        // 200 x 50KB would be ~10MB unbounded; retention must cap it at the
        // last RAW_RETENTION_COUNT payloads (plus JSON overhead slack).
        assertTrue("retained raw bytes should stay near the retention window, got " + retained,
                retained < rawBytes * (SessionState.RAW_RETENTION_COUNT + 1) * 2L);
    }
}
