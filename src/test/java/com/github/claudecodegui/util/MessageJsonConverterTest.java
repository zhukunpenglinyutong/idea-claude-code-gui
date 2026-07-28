package com.github.claudecodegui.util;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class MessageJsonConverterTest {

    @Test
    public void convertMessagesToJsonKeepsOnlyFrontendRelevantRawFields() {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", "Hello from Claude");

        JsonArray content = new JsonArray();
        content.add(textBlock);

        JsonObject message = new JsonObject();
        message.addProperty("id", "msg-1");
        message.addProperty("model", "claude-sonnet-4-6");
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 321);
        message.add("usage", usage);
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("uuid", "uuid-1");
        raw.addProperty("type", "assistant");
        raw.addProperty("sessionId", "session-1");
        raw.addProperty("parentUuid", "parent-1");
        raw.add("message", message);
        JsonObject turnUsage = new JsonObject();
        turnUsage.addProperty("input_tokens", 1200);
        turnUsage.addProperty("cache_read_input_tokens", 36310);
        turnUsage.addProperty("output_tokens", 456);
        raw.add("turnUsage", turnUsage);
        raw.addProperty("turnCostUsd", 0.0123);

        ClaudeSession.Message sessionMessage = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT,
                "Hello from Claude",
                raw
        );

        JsonArray transportMessages = JsonParser.parseString(
                MessageJsonConverter.convertMessagesToJson(List.of(sessionMessage))
        ).getAsJsonArray();

        JsonObject transportRaw = transportMessages.get(0).getAsJsonObject().getAsJsonObject("raw");
        assertEquals("uuid-1", transportRaw.get("uuid").getAsString());
        assertEquals("assistant", transportRaw.get("type").getAsString());
        assertFalse(transportRaw.has("sessionId"));
        assertFalse(transportRaw.has("parentUuid"));

        // turnUsage (whole-turn aggregate) is transported for the per-turn token display
        assertTrue(transportRaw.has("turnUsage"));
        assertEquals(1200, transportRaw.getAsJsonObject("turnUsage").get("input_tokens").getAsInt());
        assertTrue(transportRaw.has("turnCostUsd"));
        assertEquals(0.0123, transportRaw.get("turnCostUsd").getAsDouble(), 0.000001);

        JsonObject transportMessage = transportRaw.getAsJsonObject("message");
        assertTrue(transportMessage.has("content"));
        assertFalse(transportMessage.has("id"));
        assertFalse(transportMessage.has("model"));
        // message.usage feeds the status bar only and must NOT be transported per message
        assertFalse(transportMessage.has("usage"));
    }

    @Test
    public void truncateRawForTransportPreservesToolResultBlocksWhileDroppingOuterMetadata() {
        JsonObject toolResult = new JsonObject();
        toolResult.addProperty("type", "tool_result");
        toolResult.addProperty("tool_use_id", "tool-1");
        toolResult.addProperty("content", "x".repeat(25000));

        JsonArray content = new JsonArray();
        content.add(toolResult);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.addProperty("uuid", "uuid-2");
        raw.addProperty("cwd", "/workspace");
        raw.addProperty("parentUuid", "parent-2");
        raw.add("message", message);

        JsonObject transportRaw = MessageJsonConverter.truncateRawForTransport(raw);

        assertFalse(transportRaw.has("cwd"));
        assertFalse(transportRaw.has("parentUuid"));

        JsonObject transportToolResult = transportRaw
                .getAsJsonObject("message")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject();

        assertEquals("tool-1", transportToolResult.get("tool_use_id").getAsString());
        assertTrue(transportToolResult.get("content").getAsString().contains("truncated"));
    }
}
