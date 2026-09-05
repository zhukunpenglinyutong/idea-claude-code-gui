package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

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
    public void parseServerMessageDropsNoResponseRequestedAssistantPlaceholder() {
        MessageParser parser = new MessageParser();

        JsonObject contentBlock = new JsonObject();
        contentBlock.addProperty("type", "text");
        contentBlock.addProperty("text", "No response requested.");

        JsonArray content = new JsonArray();
        content.add(contentBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", message);

        assertNull(parser.parseServerMessage(raw));
    }

    @Test
    public void parseServerMessageExtractsCodeBuddyInputOutputTextBlocks() {
        MessageParser parser = new MessageParser();

        JsonArray userContent = new JsonArray();
        JsonObject userText = new JsonObject();
        userText.addProperty("type", "input_text");
        userText.addProperty("text", "你好");
        userContent.add(userText);

        JsonObject userMessage = new JsonObject();
        userMessage.add("content", userContent);

        JsonObject userRaw = new JsonObject();
        userRaw.addProperty("type", "user");
        userRaw.add("message", userMessage);

        ClaudeSession.Message userParsed = parser.parseServerMessage(userRaw);
        assertNotNull(userParsed);
        assertEquals(ClaudeSession.Message.Type.USER, userParsed.type);
        assertEquals("你好", userParsed.content);

        JsonArray assistantContent = new JsonArray();
        JsonObject assistantText = new JsonObject();
        assistantText.addProperty("type", "output_text");
        assistantText.addProperty("text", "你好！有什么我可以帮你的吗？");
        assistantContent.add(assistantText);

        JsonObject assistantMessage = new JsonObject();
        assistantMessage.add("content", assistantContent);

        JsonObject assistantRaw = new JsonObject();
        assistantRaw.addProperty("type", "assistant");
        assistantRaw.add("message", assistantMessage);

        ClaudeSession.Message assistantParsed = parser.parseServerMessage(assistantRaw);
        assertNotNull(assistantParsed);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, assistantParsed.type);
        assertEquals("你好！有什么我可以帮你的吗？", assistantParsed.content);
    }
}
