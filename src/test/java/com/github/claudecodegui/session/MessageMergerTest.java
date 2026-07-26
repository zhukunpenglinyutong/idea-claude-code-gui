package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class MessageMergerTest {

    @Test
    public void mergeAssistantMessageDoesNotDuplicateExistingTextWhenIncomingSnapshotIsCumulative() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                textBlock("让我先获取未提交的更改文件列表。"),
                toolUseBlock("bash-1", "run_command")
        );

        JsonObject newRaw = assistantMessage(
                textBlock("让我先获取未提交的更改文件列表。"),
                toolUseBlock("bash-1", "run_command"),
                textBlock("只有一个文件有更改。让我查看具体的 diff 和完整文件内容。"),
                toolUseBlock("read-1", "read_file")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(4, mergedContent.size());
        assertEquals("让我先获取未提交的更改文件列表。", mergedContent.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("bash-1", mergedContent.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals("只有一个文件有更改。让我查看具体的 diff 和完整文件内容。", mergedContent.get(2).getAsJsonObject().get("text").getAsString());
        assertEquals("read-1", mergedContent.get(3).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void mergeAssistantMessageKeepsMoreCompleteMatchingTextBlock() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                textBlock("让我获取未提交的更改文"),
                toolUseBlock("bash-1", "run_command")
        );

        JsonObject newRaw = assistantMessage(
                textBlock("让我获取未提交的更改文件列表。"),
                toolUseBlock("bash-1", "run_command")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(2, mergedContent.size());
        assertEquals("让我获取未提交的更改文件列表。", mergedContent.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("bash-1", mergedContent.get(1).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void mergeAssistantMessagePreservesExistingTextWhenIncomingSnapshotContainsOnlyToolUse() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                textBlock("让我先获取未提交的更改文件列表。")
        );

        JsonObject newRaw = assistantMessage(
                toolUseBlock("bash-1", "run_command")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(2, mergedContent.size());
        assertEquals("让我先获取未提交的更改文件列表。", mergedContent.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("bash-1", mergedContent.get(1).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void mergeAssistantMessageDoesNotDuplicateThinkingBlocks() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                thinkingBlock("Let me analyze this code carefully."),
                textBlock("这段代码有问题。")
        );

        JsonObject newRaw = assistantMessage(
                thinkingBlock("Let me analyze this code carefully."),
                textBlock("这段代码有问题。"),
                toolUseBlock("bash-1", "run_command")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(3, mergedContent.size());
        assertEquals("thinking", mergedContent.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("Let me analyze this code carefully.", mergedContent.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("这段代码有问题。", mergedContent.get(1).getAsJsonObject().get("text").getAsString());
        assertEquals("bash-1", mergedContent.get(2).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void mergeAssistantMessageKeepsMoreCompleteThinkingBlockTextMirror() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                thinkingBlock("Let me analyze"),
                textBlock("分析结果如下。")
        );

        JsonObject newRaw = assistantMessage(
                thinkingBlock("Let me analyze this code carefully."),
                textBlock("分析结果如下。")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(2, mergedContent.size());
        assertEquals("thinking", mergedContent.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("Let me analyze this code carefully.", mergedContent.get(0).getAsJsonObject().get("thinking").getAsString());
    }

    @Test
    public void mergeAssistantMessageDoesNotOverwriteThinkingWithEmptyContent() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                thinkingBlock("Deep analysis of the problem."),
                textBlock("结论。")
        );

        JsonObject newRaw = assistantMessage(
                thinkingBlock(""),
                textBlock("结论。")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        // The thinking block with content should be preserved, empty one should not overwrite
        boolean hasNonEmptyThinking = false;
        for (int i = 0; i < mergedContent.size(); i++) {
            JsonObject block = mergedContent.get(i).getAsJsonObject();
            if ("thinking".equals(block.get("type").getAsString())) {
                String thinking = block.has("thinking") && !block.get("thinking").isJsonNull()
                        ? block.get("thinking").getAsString() : "";
                if (!thinking.isEmpty()) {
                    hasNonEmptyThinking = true;
                    assertEquals("Deep analysis of the problem.", thinking);
                }
            }
        }
        assertTrue("Should preserve non-empty thinking content", hasNonEmptyThinking);
    }

    private static JsonObject assistantMessage(JsonObject... blocks) {
        JsonArray content = new JsonArray();
        for (JsonObject block : blocks) {
            content.add(block);
        }

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", message);
        return raw;
    }

    private static JsonObject textBlock(String text) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        return block;
    }

    private static JsonObject toolUseBlock(String id, String name) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", name);
        return block;
    }

    private static JsonObject thinkingBlock(String thinking) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "thinking");
        block.addProperty("thinking", thinking);
        block.addProperty("text", thinking);
        return block;
    }

    @Test
    public void mergeAssistantMessageDoesNotDuplicateThinkingBlock() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                thinkingBlock("Let me analyze this code."),
                textBlock("Here is my analysis.")
        );

        JsonObject newRaw = assistantMessage(
                thinkingBlock("Let me analyze this code."),
                textBlock("Here is my analysis."),
                toolUseBlock("bash-1", "run_command")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(3, mergedContent.size());
        assertEquals("thinking", mergedContent.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("Let me analyze this code.", mergedContent.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("Here is my analysis.", mergedContent.get(1).getAsJsonObject().get("text").getAsString());
        assertEquals("bash-1", mergedContent.get(2).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void mergeAssistantMessageKeepsMoreCompleteThinkingBlockFromSnapshot() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                thinkingBlock("Let me analyze"),
                textBlock("Result.")
        );

        JsonObject newRaw = assistantMessage(
                thinkingBlock("Let me analyze this code carefully."),
                textBlock("Result.")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(2, mergedContent.size());
        assertEquals("Let me analyze this code carefully.", mergedContent.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("Let me analyze this code carefully.", mergedContent.get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void mergeAssistantMessageHandlesEmptyThinkingBlock() {
        MessageMerger merger = new MessageMerger();

        JsonObject existingRaw = assistantMessage(
                thinkingBlock(""),
                textBlock("Some text.")
        );

        JsonObject newRaw = assistantMessage(
                thinkingBlock("Now I have thinking content."),
                textBlock("Some text.")
        );

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(2, mergedContent.size());
        assertEquals("Now I have thinking content.", mergedContent.get(0).getAsJsonObject().get("thinking").getAsString());
    }

    @Test
    public void mergeAssistantMessageFillsEmptyTextBlockWithIncomingSameSegmentText() {
        MessageMerger merger = new MessageMerger();

        // SDK first frame may carry an empty text placeholder; the next frame grows
        // it. The empty block must be filled in place rather than duplicated.
        JsonObject existingRaw = assistantMessage(textBlock(""));
        JsonObject newRaw = assistantMessage(textBlock("full answer"));

        JsonArray mergedContent = merger.mergeAssistantMessage(existingRaw, newRaw)
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(1, mergedContent.size());
        assertEquals("full answer", mergedContent.get(0).getAsJsonObject().get("text").getAsString());
    }
}
