package com.github.claudecodegui.handler;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodexMessageConverterTest {

    // ---- convertFunctionCallOutputToToolResult ----

    @Test
    public void toolResultWithStringOutput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-1");
        payload.addProperty("output", "command executed successfully");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, "2026-04-20T00:00:00Z");

        assertEquals("user", result.get("type").getAsString());
        assertEquals("2026-04-20T00:00:00Z", result.get("timestamp").getAsString());

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("call-1", toolResult.get("tool_use_id").getAsString());
        assertEquals("command executed successfully", toolResult.get("content").getAsString());
    }

    @Test
    public void toolResultWithJsonObjectOutput() {
        JsonObject structured = new JsonObject();
        structured.addProperty("status", "ok");
        structured.addProperty("code", 200);

        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-2");
        payload.add("output", structured);

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        assertNull(result.get("timestamp"));

        JsonObject toolResult = extractFirstToolResult(result);
        String content = toolResult.get("content").getAsString();
        assertTrue("Should contain serialized JSON object", content.contains("\"status\":\"ok\""));
        assertTrue("Should contain serialized JSON object", content.contains("\"code\":200"));
    }

    @Test
    public void toolResultWithJsonArrayOutput() {
        JsonArray array = new JsonArray();
        array.add("item1");
        array.add("item2");

        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-3");
        payload.add("output", array);

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        String content = toolResult.get("content").getAsString();
        assertTrue("Should contain serialized JSON array", content.contains("item1"));
        assertTrue("Should contain serialized JSON array", content.contains("item2"));
    }

    @Test
    public void toolResultWithNullOutput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-4");
        payload.add("output", JsonNull.INSTANCE);

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("", toolResult.get("content").getAsString());
    }

    @Test
    public void toolResultWithMissingOutputField() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-5");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("", toolResult.get("content").getAsString());
    }

    @Test
    public void toolResultWithMissingCallId() {
        JsonObject payload = new JsonObject();
        payload.addProperty("output", "some output");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);

        JsonObject toolResult = extractFirstToolResult(result);
        assertEquals("unknown", toolResult.get("tool_use_id").getAsString());
    }

    @Test
    public void toolResultTimestampIncludedWhenProvided() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-6");
        payload.addProperty("output", "ok");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, "2026-01-01T12:00:00Z");
        assertEquals("2026-01-01T12:00:00Z", result.get("timestamp").getAsString());
    }

    @Test
    public void toolResultTimestampOmittedWhenNull() {
        JsonObject payload = new JsonObject();
        payload.addProperty("call_id", "call-7");
        payload.addProperty("output", "ok");

        JsonObject result = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, null);
        assertNull(result.get("timestamp"));
    }

    @Test
    public void functionCallNormalizesShellCommandToolName() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", "call-shell-1");
        payload.addProperty("arguments", "{\"command\":\"ls src\"}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, null);

        assertEquals("assistant", result.get("type").getAsString());
        assertEquals("Tool: glob", result.get("content").getAsString());

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("call-shell-1", toolUse.get("id").getAsString());
        assertEquals("glob", toolUse.get("name").getAsString());
        assertEquals("ls src", toolUse.getAsJsonObject("input").get("command").getAsString());
    }


    @Test
    public void customToolCallWithStringInput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-1");
        payload.addProperty("input", "some patch content");

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        assertEquals("assistant", result.get("type").getAsString());
        assertEquals("Tool: apply_patch", result.get("content").getAsString());

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("custom-1", toolUse.get("id").getAsString());
        assertEquals("apply_patch", toolUse.get("name").getAsString());
        assertEquals("some patch content", toolUse.getAsJsonObject("input").get("patch").getAsString());
    }

    @Test
    public void customExecHistoryToolIsFiltered() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "exec");
        payload.addProperty("call_id", "custom-exec-1");
        payload.addProperty("input", "const result = await tools.shell_command({ command: 'git status' });");

        assertNull(CodexMessageConverter.convertCustomToolCallToToolUse(payload, null));
    }

    @Test
    public void functionWaitHistoryToolIsFiltered() {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "wait");
        payload.addProperty("call_id", "wait-1");
        payload.addProperty("arguments", "{\"cell_id\":5,\"terminate\":true,\"max_tokens\":10000}");

        assertNull(CodexMessageConverter.convertFunctionCallToToolUse(payload, null));
    }

    @Test
    public void customToolCallWithJsonObjectInput() {
        JsonObject structuredInput = new JsonObject();
        structuredInput.addProperty("file", "test.py");
        structuredInput.addProperty("action", "create");

        JsonObject payload = new JsonObject();
        payload.addProperty("name", "mcp_tool");
        payload.addProperty("call_id", "custom-2");
        payload.add("input", structuredInput);

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        String patchValue = toolUse.getAsJsonObject("input").get("patch").getAsString();
        assertTrue("Should contain serialized JSON", patchValue.contains("test.py"));
    }

    @Test
    public void customToolCallWithMissingInput() {
        JsonObject payload = new JsonObject();
        payload.addProperty("name", "some_tool");
        payload.addProperty("call_id", "custom-3");

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("", toolUse.getAsJsonObject("input").get("patch").getAsString());
    }

    @Test
    public void customToolCallExtractsFilePathFromApplyPatch() {
        String patchContent = "*** Update File: src/main/App.java\n--- old\n+++ new\n@@ -1 +1 @@\n-old line\n+new line";

        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-4");
        payload.addProperty("input", patchContent);

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        JsonObject input = toolUse.getAsJsonObject("input");
        assertEquals("src/main/App.java", input.get("file_path").getAsString());
    }

    @Test
    public void customToolCallExtractsFilePathFromAddFile() {
        String patchContent = "*** Add File: src/new/File.java\n+new content";

        JsonObject payload = new JsonObject();
        payload.addProperty("name", "apply_patch");
        payload.addProperty("call_id", "custom-5");
        payload.addProperty("input", patchContent);

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        JsonObject input = toolUse.getAsJsonObject("input");
        assertEquals("src/new/File.java", input.get("file_path").getAsString());
    }

    @Test
    public void customToolCallWithMissingNameAndCallId() {
        JsonObject payload = new JsonObject();
        payload.addProperty("input", "data");

        JsonObject result = CodexMessageConverter.convertCustomToolCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("unknown", toolUse.get("name").getAsString());
        assertEquals("unknown", toolUse.get("id").getAsString());
    }

    // ---- convertFunctionCallToToolUse: cmd -> command mapping for history replay ----

    @Test
    public void execCommandHistoryMapsCmdToCommand() {
        // Codex history stores exec_command arguments with `cmd` field, but
        // BashToolGroupBlock.parseBashItem reads input.command. Without mapping
        // the timeline rows render blank when replaying a Codex history session.
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "exec_command");
        payload.addProperty("call_id", "call-cmd-1");
        payload.addProperty("arguments",
                "{\"cmd\":\"sed -n '1,10p' README.md\",\"workdir\":\"/tmp/x\",\"yield_time_ms\":1000}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, "2026-05-22T08:13:18Z");

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("exec_command", toolUse.get("name").getAsString());
        JsonObject input = toolUse.getAsJsonObject("input");
        // Original cmd is preserved (downstream tooling may still rely on it)
        assertEquals("sed -n '1,10p' README.md", input.get("cmd").getAsString());
        // New command field powers BashToolGroupBlock / BashToolBlock rendering
        assertEquals("sed -n '1,10p' README.md", input.get("command").getAsString());
    }

    @Test
    public void shellCommandHistoryMapsCmdToCommandWhenNotRenamed() {
        // shell_command stays as shell_command (not renamed to glob/read) when
        // the cmd doesn't match the ls/cat/grep patterns. Still needs the mapping.
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", "call-cmd-2");
        payload.addProperty("arguments", "{\"cmd\":\"npm test\"}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, null);

        JsonObject toolUse = extractFirstBlock(result);
        assertEquals("npm test", toolUse.getAsJsonObject("input").get("command").getAsString());
    }

    @Test
    public void execCommandPreservesExistingCommandField() {
        // Defensive: if upstream already supplies command, do not overwrite it.
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "exec_command");
        payload.addProperty("call_id", "call-cmd-3");
        payload.addProperty("arguments", "{\"cmd\":\"raw\",\"command\":\"already-set\"}");

        JsonObject result = CodexMessageConverter.convertFunctionCallToToolUse(payload, null);

        JsonObject input = extractFirstBlock(result).getAsJsonObject("input");
        assertEquals("already-set", input.get("command").getAsString());
        assertEquals("raw", input.get("cmd").getAsString());
    }

    // ---- helpers ----

    private static JsonObject extractFirstToolResult(JsonObject frontendMsg) {
        return frontendMsg.getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject();
    }

    private static JsonObject extractFirstBlock(JsonObject frontendMsg) {
        return frontendMsg.getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject();
    }
}
