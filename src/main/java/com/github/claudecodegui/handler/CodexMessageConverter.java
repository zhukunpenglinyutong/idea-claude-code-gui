package com.github.claudecodegui.handler;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.github.claudecodegui.util.UserMessageSanitizer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Codex message format conversion utilities.
 * <p>
 * Contains static methods for converting Codex message formats to Claude-compatible
 * frontend formats. Extracted from HistoryHandler to improve separation of concerns.
 * <p>
 * Note: {@link #SESSION_FILE_MAP} maintains minimal state to track file-writing sessions
 * across related exec_command / write_stdin pairs. Call {@link #clearSessionState()} when
 * a new conversation starts to avoid stale entries.
 */
public class CodexMessageConverter {

    /** Maximum number of tracked file-writing sessions to prevent unbounded growth. */
    private static final int MAX_SESSION_ENTRIES = 256;

    // Tracks file-writing sessions so later write_stdin events can display the target file.
    // Uses a bounded LRU map to prevent memory leaks over long IDE sessions.
    private static final Map<Integer, String> SESSION_FILE_MAP =
        Collections.synchronizedMap(new LinkedHashMap<Integer, String>(64, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, String> eldest) {
                return size() > MAX_SESSION_ENTRIES;
            }
        });

    // Extracts a destination path from common shell write patterns.
    // Note: The echo/printf alternative uses [^>]* instead of .* to prevent greedy matching across redirections.
    private static final Pattern WRITE_CMD_PATTERN = Pattern.compile(
        "cat\\s*>\\s*([^\\s;|&]+)|tee\\s+(?:-[a-zA-Z]+\\s+)*([^\\s;|&]+)|(?:echo|printf)\\s+[^>]*>\\s*([^\\s;|&]+)"
    );

    private CodexMessageConverter() {
        // Utility class, no instantiation.
    }

    /**
     * Safely extract a string from a JsonElement, handling null, primitives, and structured types.
     * Returns the primitive string value when possible, falls back to {@code toString()} for
     * arrays/objects, and returns the given default for null or missing elements.
     */
    private static String safeGetAsString(JsonElement elem, String defaultValue) {
        if (elem == null || elem.isJsonNull()) {
            return defaultValue;
        }
        if (elem.isJsonPrimitive()) {
            return elem.getAsString();
        }
        return elem.toString();
    }

    /**
     * Clear session tracking state. Should be called when a new conversation starts
     * to avoid stale session-to-file mappings.
     */
    public static void clearSessionState() {
        SESSION_FILE_MAP.clear();
    }

    /**
     * Convert Codex content to Claude-format content blocks.
     * Codex: [{type: "input_text", text: "..."}, {type: "text", text: "..."}]
     * Claude: [{type: "text", text: "..."}]
     */
    public static JsonArray convertToClaudeContentBlocks(JsonElement contentElem) {
        JsonArray claudeBlocks = new JsonArray();

        if (contentElem == null) {
            return claudeBlocks;
        }

        // Handle string type - convert to a single text block
        if (contentElem.isJsonPrimitive()) {
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", contentElem.getAsString());
            claudeBlocks.add(textBlock);
            return claudeBlocks;
        }

        // Handle array type
        if (contentElem.isJsonArray()) {
            JsonArray contentArray = contentElem.getAsJsonArray();

            for (JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    JsonObject itemObj = item.getAsJsonObject();
                    String type = itemObj.has("type") ? itemObj.get("type").getAsString() : null;

                    if (type != null) {
                        JsonObject claudeBlock = new JsonObject();

                        // Convert Codex "input_text" and "output_text" to Claude "text"
                        if ("input_text".equals(type) || "output_text".equals(type) || "text".equals(type)) {
                            claudeBlock.addProperty("type", "text");
                            if (itemObj.has("text")) {
                                claudeBlock.addProperty("text", itemObj.get("text").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle tool use (if present in Codex)
                        else if ("tool_use".equals(type)) {
                            claudeBlock.addProperty("type", "tool_use");
                            if (itemObj.has("id")) {
                                claudeBlock.addProperty("id", itemObj.get("id").getAsString());
                            }
                            if (itemObj.has("name")) {
                                claudeBlock.addProperty("name", itemObj.get("name").getAsString());
                            }
                            if (itemObj.has("input")) {
                                claudeBlock.add("input", itemObj.get("input"));
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle tool result
                        else if ("tool_result".equals(type)) {
                            claudeBlock.addProperty("type", "tool_result");
                            if (itemObj.has("tool_use_id")) {
                                claudeBlock.addProperty("tool_use_id", itemObj.get("tool_use_id").getAsString());
                            }
                            if (itemObj.has("content")) {
                                claudeBlock.add("content", itemObj.get("content"));
                            }
                            if (itemObj.has("is_error")) {
                                claudeBlock.addProperty("is_error", itemObj.get("is_error").getAsBoolean());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle thinking block
                        else if ("thinking".equals(type)) {
                            claudeBlock.addProperty("type", "thinking");
                            if (itemObj.has("thinking")) {
                                claudeBlock.addProperty("thinking", itemObj.get("thinking").getAsString());
                            }
                            if (itemObj.has("text")) {
                                claudeBlock.addProperty("text", itemObj.get("text").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle image
                        else if ("image".equals(type)) {
                            claudeBlock.addProperty("type", "image");
                            if (itemObj.has("src")) {
                                claudeBlock.addProperty("src", itemObj.get("src").getAsString());
                            }
                            if (itemObj.has("mediaType")) {
                                claudeBlock.addProperty("mediaType", itemObj.get("mediaType").getAsString());
                            }
                            if (itemObj.has("alt")) {
                                claudeBlock.addProperty("alt", itemObj.get("alt").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Other unknown types, try to keep as-is
                        else {
                            claudeBlocks.add(itemObj);
                        }
                    }
                }
            }

            return claudeBlocks;
        }

        // Handle object type - treat as a single block
        if (contentElem.isJsonObject()) {
            claudeBlocks.add(contentElem.getAsJsonObject());
            return claudeBlocks;
        }

        return claudeBlocks;
    }

    /**
     * Extract text content from a Codex content field.
     * Codex content can be in string, object, or array format.
     */
    public static String extractContentAsString(JsonElement contentElem) {
        if (contentElem == null) {
            return null;
        }

        // Handle string type
        if (contentElem.isJsonPrimitive()) {
            return contentElem.getAsString();
        }

        // Handle array type
        if (contentElem.isJsonArray()) {
            JsonArray contentArray = contentElem.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    JsonObject itemObj = item.getAsJsonObject();

                    // Flatten supported text-like blocks into a single preview string for the frontend.
                    if (itemObj.has("type") && "text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // Extract input_text type (Codex user messages)
                    else if (itemObj.has("type") && "input_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // Extract output_text type (Codex AI assistant messages)
                    else if (itemObj.has("type") && "output_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                }
            }

            return sb.toString();
        }

        // Handle object type
        if (contentElem.isJsonObject()) {
            JsonObject contentObj = contentElem.getAsJsonObject();
            if (contentObj.has("text")) {
                return contentObj.get("text").getAsString();
            }
        }

        return null;
    }

    /**
     * Convert Codex regular message to frontend format.
     */
    public static JsonObject convertCodexMessageToFrontend(JsonObject payload, String timestamp) {
        String contentStr = extractContentAsString(payload.get("content"));
        String role = payload.has("role") ? payload.get("role").getAsString() : "user";
        if (!"user".equals(role) && !"assistant".equals(role)) {
            return null;
        }
        boolean userMessage = "user".equals(role);
        boolean strippedSystemTags = false;

        if (userMessage) {
            String originalContent = contentStr;
            contentStr = stripSystemTags(originalContent);
            strippedSystemTags = originalContent != null && !originalContent.equals(contentStr);
            if (contentStr == null || contentStr.isBlank()) {
                return null;
            }
        }

        // Filter out system messages
        if (contentStr != null && isSystemMessage(contentStr)) {
            return null;
        }

        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", role);

        if (payload.has("content")) {
            if (contentStr != null && !contentStr.isEmpty()) {
                frontendMsg.addProperty("content", contentStr);
            }

            JsonArray claudeContentBlocks = strippedSystemTags
                    ? textContentBlocks(contentStr)
                    : convertToClaudeContentBlocks(payload.get("content"));
            JsonObject rawObj = new JsonObject();
            rawObj.add("content", claudeContentBlocks);
            rawObj.addProperty("role", role);
            frontendMsg.add("raw", rawObj);
        }

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Check if this is a system message (should be filtered).
     */
    public static boolean isSystemMessage(String contentStr) {
        return contentStr.startsWith("Warning:") ||
               contentStr.startsWith("Tool result:") ||
               contentStr.startsWith("Exit code:") ||
               contentStr.startsWith("# AGENTS.md instructions") ||
               contentStr.startsWith("<agents-instructions>") ||
               contentStr.startsWith("<INSTRUCTIONS>") ||
               contentStr.startsWith("<environment_context>");
    }

    /**
     * Strip internal instruction blocks that are prepended before sending to Codex.
     * These blocks are useful model context, but should not be rendered as user history.
     */
    public static String stripSystemTags(String text) {
        return UserMessageSanitizer.sanitizeUserFacingText(text);
    }

    private static JsonArray textContentBlocks(String text) {
        JsonArray content = new JsonArray();
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        content.add(textBlock);
        return content;
    }

    /**
     * Convert Codex function_call to Claude tool_use format.
     */
    public static JsonObject convertFunctionCallToToolUse(JsonObject payload, String timestamp) {
        String toolName = payload.has("name") ? payload.get("name").getAsString() : "unknown";
        JsonElement toolInput = parseToolArguments(payload);

        // Normalize tool identities first so downstream input conversion can target the displayed tool name.
        toolName = convertToolName(toolName, toolInput);

        // Filter out ignored tools (e.g., write_stdin)
        if (toolName == null) {
            return null;
        }

        toolInput = convertToolInput(toolName, toolInput);

        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "assistant");

        // Build tool_use format
        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", payload.has("call_id") ? payload.get("call_id").getAsString() : "unknown");
        toolUse.addProperty("name", toolName);

        if (toolInput != null) {
            toolUse.add("input", toolInput);
        }

        JsonArray content = new JsonArray();
        content.add(toolUse);

        frontendMsg.addProperty("content", "Tool: " + toolName);

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "assistant");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Parse tool call arguments.
     */
    public static JsonElement parseToolArguments(JsonObject payload) {
        if (!payload.has("arguments")) {
            return null;
        }
        try {
            return JsonParser.parseString(payload.get("arguments").getAsString());
        } catch (Exception e) {
            return new JsonObject();
        }
    }

    /**
     * Smart tool name conversion (shell_command -> read/glob, update_plan -> todowrite).
     *
     * @return converted tool name, or null if the tool should be filtered out (e.g. write_stdin).
     */
    public static String convertToolName(String toolName, JsonElement toolInput) {
        if ("shell_command".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("command")) {
                String command = inputObj.get("command").getAsString().trim();
                // List/find commands -> glob (consistent with ai-bridge smartToolName)
                if (command.matches("^(ls|find|tree)\\b.*")) {
                    return "glob";
                }
                // File viewing commands -> read
                if (command.matches("^(pwd|cat|head|tail|file|stat)\\b.*")) {
                    return "read";
                }
                // Search commands -> glob
                if (command.matches("^(grep|rg|ack|ag)\\b.*")) {
                    return "glob";
                }
            }
        }
        if ("update_plan".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("plan") && inputObj.get("plan").isJsonArray()) {
                return "todowrite";
            }
        }
        // Ignore write_stdin - it's waiting for previous command result
        if ("write_stdin".equals(toolName)) {
            return null;
        }
        return toolName;
    }

    /**
     * Convert tool input (update_plan -> todowrite format conversion).
     * Also tracks exec_command sessions and enriches write_stdin with file paths.
     */
    public static JsonElement convertToolInput(String toolName, JsonElement toolInput) {
        // Capture the write target when a terminal session starts writing to a file.
        if ("exec_command".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("cmd") && inputObj.has("session_id")) {
                String cmd = inputObj.get("cmd").getAsString();
                int sessionId = inputObj.get("session_id").getAsInt();

                // The regex covers redirection and tee-based writes used by the coding agents.
                Matcher matcher = WRITE_CMD_PATTERN.matcher(cmd);
                if (matcher.find()) {
                    String filePath = matcher.group(1) != null ? matcher.group(1) :
                                    (matcher.group(2) != null ? matcher.group(2) : matcher.group(3));
                    if (filePath != null) {
                        SESSION_FILE_MAP.put(sessionId, filePath.trim());
                    }
                }
            }
        }

        // Map Codex protocol field `cmd` to frontend-expected `command` for shell-like tools.
        // The live path emits {command, description} via handleCommandExecution, so this
        // branch only fires when replaying Codex history (function_call payload retains `cmd`).
        // Without this mapping BashToolGroupBlock renders blank timeline rows because
        // parseBashItem only reads input.command.
        if (("exec_command".equals(toolName) || "shell_command".equals(toolName))
                && toolInput != null && toolInput.isJsonObject()) {
            JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("cmd") && !inputObj.has("command")) {
                JsonObject enriched = inputObj.deepCopy();
                enriched.add("command", inputObj.get("cmd"));
                toolInput = enriched;
            }
        }

        // Enrich incremental writes with the previously discovered destination path.
        if ("write".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("session_id")) {
                int sessionId = inputObj.get("session_id").getAsInt();
                String filePath = SESSION_FILE_MAP.get(sessionId);
                if (filePath != null) {
                    JsonObject enriched = new JsonObject();
                    for (String key : inputObj.keySet()) {
                        enriched.add(key, inputObj.get(key));
                    }
                    enriched.addProperty("file_path", filePath);
                    return enriched;
                }
            }
        }

        // Translate plan updates into the todo structure expected by the Claude-style frontend.
        if (!"todowrite".equals(toolName) || toolInput == null || !toolInput.isJsonObject()) {
            return toolInput;
        }

        JsonObject inputObj = toolInput.getAsJsonObject();
        if (!inputObj.has("plan") || !inputObj.get("plan").isJsonArray()) {
            return toolInput;
        }

        JsonArray planArray = inputObj.getAsJsonArray("plan");
        JsonArray todosArray = new JsonArray();

        for (int j = 0; j < planArray.size(); j++) {
            if (planArray.get(j).isJsonObject()) {
                JsonObject planItem = planArray.get(j).getAsJsonObject();
                JsonObject todoItem = new JsonObject();

                if (planItem.has("step")) {
                    todoItem.addProperty("content", planItem.get("step").getAsString());
                    todoItem.addProperty("activeForm", planItem.get("step").getAsString());
                }
                todoItem.addProperty("status", planItem.has("status") ? planItem.get("status").getAsString() : "pending");
                todoItem.addProperty("id", String.valueOf(j));

                todosArray.add(todoItem);
            }
        }

        JsonObject newInput = new JsonObject();
        newInput.add("todos", todosArray);
        return newInput;
    }

    /**
     * Convert Codex function_call_output to Claude tool_result format.
     */
    public static JsonObject convertFunctionCallOutputToToolResult(JsonObject payload, String timestamp) {
        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "user");

        JsonObject toolResult = new JsonObject();
        toolResult.addProperty("type", "tool_result");
        toolResult.addProperty("tool_use_id", payload.has("call_id") ? payload.get("call_id").getAsString() : "unknown");

        JsonElement outputElement = payload.get("output");
        String output = extractContentAsString(outputElement);
        if (output == null || (output.isEmpty() && outputElement != null && outputElement.isJsonArray())) {
            output = safeGetAsString(outputElement, "");
        }
        toolResult.addProperty("content", output);

        JsonArray content = new JsonArray();
        content.add(toolResult);

        frontendMsg.addProperty("content", "[tool_result]");

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Convert Codex custom_tool_call_output to the same tool_result protocol used by function calls.
     */
    public static JsonObject convertCustomToolCallOutputToToolResult(JsonObject payload, String timestamp) {
        return convertFunctionCallOutputToToolResult(payload, timestamp);
    }

    /**
     * Convert Codex custom_tool_call to Claude tool_use format.
     * Handles apply_patch and other custom tools.
     */
    public static JsonObject convertCustomToolCallToToolUse(JsonObject payload, String timestamp) {
        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "assistant");

        String toolName = payload.has("name") ? payload.get("name").getAsString() : "unknown";

        String toolInput = safeGetAsString(payload.get("input"), "");

        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", payload.has("call_id") ? payload.get("call_id").getAsString() : "unknown");
        toolUse.addProperty("name", toolName);

        JsonObject input = new JsonObject();
        input.addProperty("patch", toolInput);

        // Surface the first touched file so the frontend can show a concrete target for patch-based edits.
        if ("apply_patch".equals(toolName)
                && (toolInput.contains("*** Add File:") || toolInput.contains("*** Update File:"))) {
            String[] lines = toolInput.split("\n");
            for (String line : lines) {
                if (line.startsWith("*** Add File:") || line.startsWith("*** Update File:")) {
                    String filePath = line.substring(line.indexOf(":") + 1).trim();
                    input.addProperty("file_path", filePath);
                    break;
                }
            }
        }

        toolUse.add("input", input);

        JsonArray content = new JsonArray();
        content.add(toolUse);

        frontendMsg.addProperty("content", "Tool: " + toolName);

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "assistant");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }
}
