package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.lang.reflect.Proxy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class HistoryMessageInjectorTest {

    @Test
    public void handleLoadSessionUsesPayloadProviderAndResolvedCodexSessionId() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        boolean[] callbackInvoked = {false};

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-codex\",\"provider\":\"codex\"}",
                "claude",
                (sessionId, projectPath, provider) -> callbackInvoked[0] = true
        );

        assertEquals("hist-codex", injector.loadedCodexSessionId);
        assertFalse(callbackInvoked[0]);
    }

    @Test
    public void handleLoadSessionUsesPayloadProviderForClaudeEvenWhenCurrentProviderIsCodex() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        String[] callbackArgs = new String[3];

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-claude\",\"provider\":\"claude\"}",
                "codex",
                (sessionId, projectPath, provider) -> {
                    callbackArgs[0] = sessionId;
                    callbackArgs[1] = projectPath;
                    callbackArgs[2] = provider;
                }
        );

        assertNull(injector.loadedCodexSessionId);
        assertEquals("hist-claude", callbackArgs[0]);
        assertEquals("D:/project/demo", callbackArgs[1]);
        assertEquals("claude", callbackArgs[2]);
    }

    @Test
    public void handleLoadSessionCompletesHistoryLoadWhenProjectPathMissing() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext(null));
        boolean[] callbackInvoked = {false};

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-codex\",\"provider\":\"codex\"}",
                "claude",
                (sessionId, projectPath, provider) -> callbackInvoked[0] = true
        );

        assertNull(injector.loadedCodexSessionId);
        assertFalse(callbackInvoked[0]);
        assertEquals(1, injector.historyLoadCompleteCount);
    }

    @Test
    public void handleLoadSessionCompletesHistoryLoadWhenClaudeCallbackMissing() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-claude\",\"provider\":\"claude\"}",
                "codex",
                null
        );

        assertNull(injector.loadedCodexSessionId);
        assertEquals(1, injector.historyLoadCompleteCount);
    }

    @Test
    public void convertCodexMessagesDeduplicatesDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("user", result.get(0).get("type").getAsString());
        assertEquals("hello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesDeduplicatesDualRecordedUserMessageWithDifferentTimestamps() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:27.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
    }

    @Test
    public void convertCodexMessagesKeepsTwoIdenticalUserTurnsWithoutAssistantBetweenThem() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:27.701Z", "hello"));
        messages.add(responseItemUserMessage("2026-04-30T09:40:28.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:29.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
    }

    @Test
    public void convertCodexMessagesDeduplicatesImageWrappedDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "<image name=[Image #1]>\n</image>\nhello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("hello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesStripsAgentsInstructionsFromDuplicatedUserMessage() {
        String text = "<agents-instructions>\n"
                + "# Global Instructions\n\n"
                + "请默认使用中文（简体）回复。\n"
                + "</agents-instructions>\n\n"
                + "hello";
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", text));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", text));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("hello", result.get(0).get("content").getAsString());
        assertEquals("hello", result.get(0)
                .getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject()
                .get("text")
                .getAsString());
    }

    @Test
    public void convertCodexMessagesRestoresLocalImagesFromEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:02:20.861Z", "hello", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("image/png", contentBlocks.get(0).getAsJsonObject().get("mediaType").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("hello", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesFiltersDeveloperRoleMessages() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemDeveloperMessage("2026-05-14T10:00:00.000Z", "internal developer instructions"));
        messages.add(responseItemAssistantMessage("2026-05-14T10:00:01.000Z", "visible assistant reply"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("assistant", result.get(0).get("type").getAsString());
        assertEquals("visible assistant reply", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesReplaysBatchExecAsOriginalCommandGroup() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "exec-call",
                "exec",
                "const cmds = [\n"
                    + "  {command:\"\\\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell"
                    + "\\\\v1.0\\\\powershell.exe\\\" -Command \\\"Write-Output one\\\"\","
                    + "workdir:\"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\demo\",timeout_ms:10000},\n"
                    + "  {command:'echo second',workdir:'D:/demo',timeout_ms:10000},\n"
                    + "  {command:\"npm test\",workdir:\"D:/demo\",timeout_ms:10000}\n"
                    + "];\n"
                    + "const results = await Promise.all(cmds.map(c => tools.shell_command(c)));\n"
                    + "results.forEach((r,i)=>{ text(`---${i+1}---`); text(r); });"
        ));
        messages.add(customToolCallOutput(
                "2026-07-23T02:00:01.000Z",
                "exec-call",
                outputTextBlocks(
                        "Script completed\nWall time 1.2 seconds\nOutput:\n",
                        "---1---",
                        "Exit code: 0\nWall time: 0.2 seconds\nOutput:\none",
                        "---2---",
                        "Exit code: 0\nWall time: 0.2 seconds\nOutput:\nsecond",
                        "---3---",
                        "Script error:\nExit code: 1\nWall time: 0.2 seconds\nOutput:\ntests failed"
                )
        ));
        messages.add(functionCall("2026-07-23T02:00:02.000Z", "wait-call", "wait",
                "{\"cell_id\":5,\"terminate\":true,\"max_tokens\":10000}"));
        messages.add(functionCallOutput("2026-07-23T02:00:03.000Z", "wait-call", "completed"));
        messages.add(responseItemAssistantMessage("2026-07-23T02:00:04.000Z", "visible assistant reply"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(3, result.size());
        JsonArray toolUses = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(3, toolUses.size());
        assertEquals("tool_use", toolUses.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("bash", toolUses.get(0).getAsJsonObject().get("name").getAsString());
        assertEquals("bash", toolUses.get(1).getAsJsonObject().get("name").getAsString());
        assertEquals("bash", toolUses.get(2).getAsJsonObject().get("name").getAsString());
        JsonObject firstInput = toolUses.get(0).getAsJsonObject().getAsJsonObject("input");
        assertTrue(firstInput.get("command").getAsString().startsWith("\"C:\\Windows\\System32"));
        assertTrue(firstInput.get("description").getAsString().startsWith("Run \"C:\\Windows"));
        assertEquals("\\\\wsl.localhost\\Ubuntu\\home\\demo", firstInput.get("workdir").getAsString());
        assertEquals(10000, firstInput.get("timeout_ms").getAsInt());

        JsonArray toolResults = result.get(1).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(3, toolResults.size());
        assertFalse(toolResults.get(0).getAsJsonObject().get("is_error").getAsBoolean());
        assertFalse(toolResults.get(1).getAsJsonObject().get("is_error").getAsBoolean());
        assertTrue(toolResults.get(2).getAsJsonObject().get("is_error").getAsBoolean());
        assertTrue(toolResults.get(0).getAsJsonObject().get("content").getAsString().contains("one"));
        assertEquals(
                toolUses.get(2).getAsJsonObject().get("id").getAsString(),
                toolResults.get(2).getAsJsonObject().get("tool_use_id").getAsString()
        );
        assertEquals("visible assistant reply", result.get(2).get("content").getAsString());
        assertFalse(result.toString().contains("const cmds"));
        assertFalse(result.toString().contains("cell_id"));
        assertFalse(result.toString().contains("max_tokens"));
    }

    @Test
    public void convertCodexMessagesReplaysSingleExecWithLiveDescriptionAndResult() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "exec-1",
                "exec",
                "const r = await tools.shell_command({"
                    + "command:'git status',workdir:'D:/demo',timeout_ms:5000"
                    + "}); text(r);"
        ));
        messages.add(customToolCallOutput(
                "2026-07-23T02:00:01.000Z",
                "exec-1",
                outputTextBlocks(
                        "Script completed\nWall time 0.2 seconds\nOutput:\n",
                        "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nOn branch main"
                )
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
        JsonObject toolUse = getOnlyRawContentBlock(result.get(0));
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("bash", toolUse.get("name").getAsString());
        assertEquals("git status", toolUse.getAsJsonObject("input").get("command").getAsString());
        assertEquals("Check git status", toolUse.getAsJsonObject("input").get("description").getAsString());
        JsonObject toolResult = getOnlyRawContentBlock(result.get(1));
        assertFalse(toolResult.get("is_error").getAsBoolean());
        assertTrue(toolResult.get("content").getAsString().contains("On branch main"));
    }

    @Test
    public void convertCodexMessagesSkipsWaitAndNonShellExecProtocolCards() {
        JsonArray messages = new JsonArray();
        messages.add(customToolCall(
                "2026-07-23T02:00:00.000Z",
                "patch-wrapper",
                "exec",
                "await tools.apply_patch('*** Begin Patch\\n*** End Patch');"
        ));
        messages.add(customToolCallOutput("2026-07-23T02:00:01.000Z", "patch-wrapper", "completed"));
        messages.add(functionCall("2026-07-23T02:00:02.000Z", "wait-running", "wait",
                "{\"cell_id\":9,\"terminate\":false,\"max_tokens\":10000}"));
        messages.add(responseItemAssistantMessage("2026-07-23T02:00:03.000Z", "done"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("done", result.get(0).get("content").getAsString());
        assertFalse(result.toString().contains("exec"));
        assertFalse(result.toString().contains("cell_id"));
        assertFalse(result.toString().contains("max_tokens"));
    }

    @Test
    public void convertCodexMessagesKeepsImageOnlyEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image-only", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:03:20.861Z", "", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            assertEquals("", result.get(0).get("content").getAsString());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(1, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesStripsAppendedProjectModulesContext() {
        JsonArray messages = new JsonArray();
        messages.add(eventUserMessage(
                "2026-05-11T09:03:20.861Z",
                "只保留用户输入\n\n## Project Modules\n\nThis project contains multiple modules:\n- `idea-claude-code-gui`\n"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("只保留用户输入", result.get(0).get("content").getAsString());
        JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(1, contentBlocks.size());
        assertEquals("只保留用户输入", contentBlocks.get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void paginatesCompleteCodexTurnsWithoutPermanentlyDroppingEarlierHistory() {
        JsonArray history = createTurnHistory(65);

        HistoryMessageInjector.CodexHistoryPage latest =
                HistoryMessageInjector.paginateCodexMessages(history, null, 30);
        HistoryMessageInjector.CodexHistoryPage previous =
                HistoryMessageInjector.paginateCodexMessages(history, latest.fromTurn, 30);
        HistoryMessageInjector.CodexHistoryPage first =
                HistoryMessageInjector.paginateCodexMessages(history, previous.fromTurn, 30);

        assertEquals(65, latest.totalTurns);
        assertEquals(35, latest.fromTurn);
        assertEquals(65, latest.toTurn);
        assertEquals("user-35", latest.messages.get(0).get("content").getAsString());
        assertEquals("assistant-64", latest.messages.get(latest.messages.size() - 1).get("content").getAsString());

        assertEquals(5, previous.fromTurn);
        assertEquals(35, previous.toTurn);
        assertEquals("user-5", previous.messages.get(0).get("content").getAsString());

        assertEquals(0, first.fromTurn);
        assertEquals(5, first.toTurn);
        assertEquals("user-0", first.messages.get(0).get("content").getAsString());
        assertEquals("assistant-4", first.messages.get(first.messages.size() - 1).get("content").getAsString());
    }

    @Test
    public void resetsToLatestPageWhenCodexHistoryCursorExceedsCurrentFile() {
        HistoryMessageInjector.CodexHistoryPage page =
                HistoryMessageInjector.paginateCodexMessages(createTurnHistory(40), 60, 30);

        assertTrue(page.cursorReset);
        assertEquals(10, page.fromTurn);
        assertEquals(40, page.toTurn);
        assertEquals("user-10", page.messages.get(0).get("content").getAsString());
    }

    @Test
    public void convertsCustomToolCallOutputToToolResult() {
        JsonArray history = new JsonArray();
        history.add(responseItemCustomToolOutput("2026-04-30T09:40:26.701Z", "call-1", "tool output"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(history);

        assertEquals(1, result.size());
        JsonObject block = result.get(0).getAsJsonObject("raw")
                .getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_result", block.get("type").getAsString());
        assertEquals("call-1", block.get("tool_use_id").getAsString());
        assertEquals("tool output", block.get("content").getAsString());
    }

    @Test
    public void partitionsHistoryByMessageCountAndTargetPayloadSize() {
        List<JsonObject> messages = new java.util.ArrayList<>();
        for (int i = 0; i < 120; i++) {
            messages.add(frontendMessage(
                    i % 2 == 0 ? "user" : "assistant",
                    "message-" + i + "-" + "x".repeat(4000),
                    "text"));
        }

        List<List<JsonObject>> batches = HistoryMessageInjector.partitionHistoryMessages(messages);

        assertTrue(batches.size() > 2);
        assertEquals(120, batches.stream().mapToInt(List::size).sum());
        for (List<JsonObject> batch : batches) {
            assertTrue(batch.size() <= HistoryMessageInjector.HISTORY_BATCH_MESSAGE_LIMIT);
            assertTrue(com.github.claudecodegui.util.JsUtils.escapeJs(
                    new com.google.gson.Gson().toJson(batch)).length()
                    <= HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT);
        }
    }

    @Test
    public void oversizedSingleMessageIsNotDroppedByPartitioning() {
        JsonObject oversized = frontendMessage(
                "user",
                "x".repeat(HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT + 1),
                "text");

        List<List<JsonObject>> batches = HistoryMessageInjector.partitionHistoryMessages(List.of(oversized));

        assertEquals(1, batches.size());
        assertEquals(1, batches.get(0).size());
        assertEquals(oversized, batches.get(0).get(0));

        String payload = new com.google.gson.Gson().toJson(batches.get(0));
        List<String> chunks = HistoryMessageInjector.splitHistoryPayload(payload);
        assertTrue(chunks.size() > 1);
        assertEquals(payload, String.join("", chunks));
        for (String chunk : chunks) {
            assertTrue(com.github.claudecodegui.util.JsUtils.escapeJs(chunk).length()
                    <= HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT);
        }
    }

    @Test
    public void payloadChunksPreserveUnicodeAndStayWithinEscapedLimit() {
        String payload = ("\u2028😃</script>'\"\\").repeat(20_000);

        List<String> chunks = HistoryMessageInjector.splitHistoryPayload(payload);

        assertTrue(chunks.size() > 1);
        assertEquals(payload, String.join("", chunks));
        for (String chunk : chunks) {
            assertTrue(com.github.claudecodegui.util.JsUtils.escapeJs(chunk).length()
                    <= HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT);
            if (!chunk.isEmpty()) {
                assertFalse(Character.isHighSurrogate(chunk.charAt(chunk.length() - 1)));
                assertFalse(Character.isLowSurrogate(chunk.charAt(0)));
            }
        }
    }

    private static JsonObject frontendMessage(String type, String content, String blockType) {
        JsonObject message = new JsonObject();
        message.addProperty("type", type);
        message.addProperty("content", content);
        JsonObject raw = new JsonObject();
        JsonArray blocks = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", blockType);
        blocks.add(block);
        raw.add("content", blocks);
        message.add("raw", raw);
        return message;
    }

    private static JsonObject responseItemUserMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "user", "input_text", text);
    }

    private static JsonObject responseItemDeveloperMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "developer", "text", text);
    }

    private static JsonObject responseItemAssistantMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "assistant", "output_text", text);
    }

    private static JsonObject responseItemCustomToolOutput(String timestamp, String callId, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call_output");
        payload.addProperty("call_id", callId);
        JsonArray output = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "input_text");
        block.addProperty("text", text);
        output.add(block);
        payload.add("output", output);
        line.add("payload", payload);
        return line;
    }

    private static JsonArray createTurnHistory(int turnCount) {
        JsonArray history = new JsonArray();
        for (int i = 0; i < turnCount; i++) {
            String timestamp = "2026-04-30T09:40:" + i + ".001Z";
            history.add(responseItemUserMessage(timestamp, "user-" + i));
            history.add(eventUserMessage(timestamp, "user-" + i));
            history.add(responseItemAssistantMessage(timestamp, "assistant-" + i));
        }
        return history;
    }

    private static JsonObject responseItemMessage(String timestamp, String role, String blockType, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "message");
        payload.addProperty("role", role);

        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", blockType);
        block.addProperty("text", text);
        content.add(block);

        payload.add("content", content);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "event_msg");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "user_message");
        payload.addProperty("message", text);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text, String localImagePath) {
        JsonObject line = eventUserMessage(timestamp, text);
        JsonArray localImages = new JsonArray();
        localImages.add(localImagePath);
        line.getAsJsonObject("payload").add("local_images", localImages);
        return line;
    }

    private static JsonObject functionCall(
            String timestamp,
            String callId,
            String name,
            String arguments
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("call_id", callId);
        payload.addProperty("name", name);
        payload.addProperty("arguments", arguments);
        return responseItem(timestamp, payload);
    }

    private static JsonObject functionCallOutput(String timestamp, String callId, String output) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call_output");
        payload.addProperty("call_id", callId);
        payload.addProperty("output", output);
        return responseItem(timestamp, payload);
    }

    private static JsonObject customToolCall(
            String timestamp,
            String callId,
            String name,
            String input
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call");
        payload.addProperty("call_id", callId);
        payload.addProperty("name", name);
        payload.addProperty("input", input);
        return responseItem(timestamp, payload);
    }

    private static JsonObject customToolCallOutput(String timestamp, String callId, String output) {
        return customToolCallOutput(timestamp, callId, new JsonPrimitive(output));
    }

    private static JsonObject customToolCallOutput(
            String timestamp,
            String callId,
            JsonElement output
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "custom_tool_call_output");
        payload.addProperty("call_id", callId);
        payload.add("output", output);
        return responseItem(timestamp, payload);
    }

    private static JsonArray outputTextBlocks(String... texts) {
        JsonArray blocks = new JsonArray();
        for (String text : texts) {
            JsonObject block = new JsonObject();
            block.addProperty("type", "input_text");
            block.addProperty("text", text);
            blocks.add(block);
        }
        return blocks;
    }

    private static JsonObject responseItem(String timestamp, JsonObject payload) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");
        line.add("payload", payload);
        return line;
    }

    private static JsonObject getOnlyRawContentBlock(JsonObject frontendMessage) {
        JsonArray blocks = frontendMessage.getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(1, blocks.size());
        return blocks.get(0).getAsJsonObject();
    }

    private static HandlerContext createContext(String basePath) {
        Project project = (Project) Proxy.newProxyInstance(
                HistoryMessageInjectorTest.class.getClassLoader(),
                new Class[]{Project.class},
                (proxy, method, args) -> {
                    if ("getBasePath".equals(method.getName())) {
                        return basePath;
                    }
                    if ("isDisposed".equals(method.getName())) {
                        return false;
                    }
                    Class<?> returnType = method.getReturnType();
                    if (returnType.equals(boolean.class)) {
                        return false;
                    }
                    if (returnType.equals(int.class)) {
                        return 0;
                    }
                    if (returnType.equals(long.class)) {
                        return 0L;
                    }
                    return null;
                }
        );

        return new HandlerContext(project, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    private static final class RecordingHistoryMessageInjector extends HistoryMessageInjector {
        private String loadedCodexSessionId;
        private int historyLoadCompleteCount;

        private RecordingHistoryMessageInjector(HandlerContext context) {
            super(context);
        }

        @Override
        void loadCodexSession(String sessionId) {
            this.loadedCodexSessionId = sessionId;
        }

        @Override
        void notifyHistoryLoadComplete() {
            historyLoadCompleteCount++;
        }
    }
}
