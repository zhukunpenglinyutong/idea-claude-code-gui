package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class MessageParserTest {

    @Test
    public void parseServerMessageKeepsUserMessageWithOnlyImageBlocks() {
        MessageParser parser = new MessageParser();

        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");
        imageBlock.addProperty("src", "data:image/png;base64,abc123");

        JsonArray content = new JsonArray();
        content.add(imageBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.add("message", message);

        ClaudeSession.Message parsed = parser.parseServerMessage(raw);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.USER, parsed.type);
        assertEquals("", parsed.content);
        assertEquals(raw, parsed.raw);
    }

    @Test
    public void parseServerMessageUnwrapsNormalizedToolUseRawPayload() {
        MessageParser parser = new MessageParser();

        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", "call-1");
        toolUse.addProperty("name", "glob");
        JsonObject input = new JsonObject();
        input.addProperty("command", "rg TODO");
        toolUse.add("input", input);

        JsonArray content = new JsonArray();
        content.add(toolUse);

        JsonObject normalizedRaw = new JsonObject();
        normalizedRaw.add("content", content);
        normalizedRaw.addProperty("role", "assistant");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.addProperty("content", "Tool: glob");
        envelope.add("raw", normalizedRaw);

        ClaudeSession.Message parsed = parser.parseServerMessage(envelope);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, parsed.type);
        assertEquals("Tool: glob", parsed.content);
        assertEquals(normalizedRaw, parsed.raw);
        assertFalse(parsed.raw.has("raw"));
        assertEquals("tool_use", parsed.raw.getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
    }

    @Test
    public void parseServerMessageKeepsNormalizedImageOnlyMessage() {
        MessageParser parser = new MessageParser();

        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");
        imageBlock.addProperty("src", "data:image/png;base64,abc123");

        JsonArray content = new JsonArray();
        content.add(imageBlock);

        JsonObject normalizedRaw = new JsonObject();
        normalizedRaw.add("content", content);
        normalizedRaw.addProperty("role", "user");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "user");
        envelope.addProperty("content", "");
        envelope.add("raw", normalizedRaw);

        ClaudeSession.Message parsed = parser.parseServerMessage(envelope);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.USER, parsed.type);
        assertEquals("", parsed.content);
        assertEquals(normalizedRaw, parsed.raw);
    }

    @Test
    public void parseServerMessageStampsTranscriptTimestampDeterministically() {
        MessageParser parser = new MessageParser();

        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        message.addProperty("content", "hello");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.addProperty("timestamp", "2026-07-15T12:00:00.123Z");
        envelope.add("message", message);

        ClaudeSession.Message first = parser.parseServerMessage(envelope);
        ClaudeSession.Message second = parser.parseServerMessage(envelope.deepCopy());

        assertNotNull(first);
        assertNotNull(second);
        // Deterministic across reloads (the webview's smart merge keys on it)
        // and equal to the transcript's own time, not the parse time.
        assertEquals(1784116800123L, first.timestamp);
        assertEquals(first.timestamp, second.timestamp);
    }

    @Test
    public void parseServerMessageKeepsParseTimeStampWithoutTranscriptTimestamp() {
        MessageParser parser = new MessageParser();

        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        message.addProperty("content", "hello");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.add("message", message);

        long before = System.currentTimeMillis();
        ClaudeSession.Message parsed = parser.parseServerMessage(envelope);
        long after = System.currentTimeMillis();

        assertNotNull(parsed);
        assertTrue(parsed.timestamp >= before && parsed.timestamp <= after);
    }

    @Test
    public void parseServerMessageIgnoresUnparseableTranscriptTimestamp() {
        MessageParser parser = new MessageParser();

        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        message.addProperty("content", "hello");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.addProperty("timestamp", "not-a-timestamp");
        envelope.add("message", message);

        long before = System.currentTimeMillis();
        ClaudeSession.Message parsed = parser.parseServerMessage(envelope);
        long after = System.currentTimeMillis();

        assertNotNull(parsed);
        assertTrue(parsed.timestamp >= before && parsed.timestamp <= after);
    }
}
