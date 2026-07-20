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

    /**
     * A /compact (or any slash command) failing on an exhausted usage window is
     * recorded ONLY as a system/local_command record whose stderr carries the
     * limit notice (session 0d009806, line 1587). It must survive reloads as an
     * ERROR message — previously it was dropped, so the failure vanished from
     * the GUI and auto-resume-on-limit could never arm on it.
     */
    @Test
    public void parseServerMessageSurfacesLocalCommandUsageLimitAsError() {
        MessageParser parser = new MessageParser();

        JsonObject record = new JsonObject();
        record.addProperty("type", "system");
        record.addProperty("subtype", "local_command");
        record.addProperty("content",
            "<local-command-stderr>Error during compaction: You've hit your session limit"
                + " · resets 12:10am (Europe/Warsaw)</local-command-stderr>");
        record.addProperty("timestamp", "2026-07-20T22:09:45.123Z");

        ClaudeSession.Message parsed = parser.parseServerMessage(record);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.ERROR, parsed.type);
        assertEquals(
            "Error during compaction: You've hit your session limit · resets 12:10am (Europe/Warsaw)",
            parsed.content);
        // The raw record (with its transcript timestamp) rides along — the
        // webview's freshness gate reads raw.timestamp.
        assertEquals(record, parsed.raw);
    }

    @Test
    public void parseServerMessageDropsNonLimitLocalCommandStderr() {
        MessageParser parser = new MessageParser();

        JsonObject record = new JsonObject();
        record.addProperty("type", "system");
        record.addProperty("subtype", "local_command");
        record.addProperty("content",
            "<local-command-stderr>fatal: not a git repository</local-command-stderr>");

        assertNull(parser.parseServerMessage(record));
    }

    @Test
    public void parseServerMessageDropsOtherSystemRecords() {
        MessageParser parser = new MessageParser();

        JsonObject compactBoundary = new JsonObject();
        compactBoundary.addProperty("type", "system");
        compactBoundary.addProperty("subtype", "compact_boundary");
        compactBoundary.addProperty("content", "Conversation compacted");

        assertNull(parser.parseServerMessage(compactBoundary));

        JsonObject stdoutRecord = new JsonObject();
        stdoutRecord.addProperty("type", "system");
        stdoutRecord.addProperty("subtype", "local_command");
        stdoutRecord.addProperty("content", "<local-command-stdout>Compacted </local-command-stdout>");

        assertNull(parser.parseServerMessage(stdoutRecord));
    }

    @Test
    public void extractLocalCommandUsageLimitErrorRecognizesKnownPhrasings() {
        String[] limitTexts = {
            "Error during compaction: You've hit your session limit · resets 12:10am (Europe/Warsaw)",
            "You've hit your weekly limit ∙ resets 5pm (Europe/Warsaw)",
            "Claude AI usage limit reached|1750366800",
            "5-hour limit reached ∙ resets 3pm",
        };
        for (String text : limitTexts) {
            JsonObject record = new JsonObject();
            record.addProperty("type", "system");
            record.addProperty("subtype", "local_command");
            record.addProperty("content", "<local-command-stderr>" + text + "</local-command-stderr>");
            assertEquals(text, MessageParser.extractLocalCommandUsageLimitError(record));
        }

        JsonObject unrelated = new JsonObject();
        unrelated.addProperty("type", "system");
        unrelated.addProperty("content", "<local-command-stderr>rate limit exceeded, retry later</local-command-stderr>");
        assertNull("\"rate limit\" is deliberately NOT a usage-limit phrase",
            MessageParser.extractLocalCommandUsageLimitError(unrelated));
    }
}
