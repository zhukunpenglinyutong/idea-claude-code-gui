package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Message parser.
 * Parses server-returned messages and converts them to Message objects.
 */
public class MessageParser {
    private static final Logger LOG = Logger.getInstance(MessageParser.class);

    /**
     * Parse a server-returned message.
     */
    public ClaudeSession.Message parseServerMessage(JsonObject msg) {
        String type = msg.has("type") ? msg.get("type").getAsString() : null;
        JsonObject rawMessage = resolveRawMessage(msg);

        // Filter out isMeta messages
        if (msg.has("isMeta") && msg.get("isMeta").getAsBoolean()) {
            return null;
        }

        // Filter out command messages - only for user messages
        // Assistant messages may contain these tags in code examples.
        // Use rawMessage (not msg) so a normalized history envelope, whose "message"
        // lives under "raw", is inspected the same way as a live SDK message; for live
        // messages resolveRawMessage returns msg unchanged, so this is a no-op there.
        if (shouldFilterCommandMessage(rawMessage, type)) {
            return null;
        }

        if ("user".equals(type)) {
            String content = extractMessageContent(msg);
            // Check if it contains a tool_result
            if (content == null || content.trim().isEmpty()) {
                if (hasToolResult(rawMessage)) {
                    return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "[tool_result]", rawMessage);
                }
                if (hasImageContent(rawMessage)) {
                    return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "", rawMessage);
                }
                return null;
            }
            return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, content, rawMessage);
        } else if ("assistant".equals(type)) {
            String content = extractMessageContent(msg);
            return new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, content, rawMessage);
        } else if ("system".equals(type)) {
            // System records are display-transparent except one case: a slash
            // command failing on an exhausted usage window (e.g. /compact) reports
            // the limit ONLY in a local_command record's stderr. Forward it as an
            // ERROR message so the failure stays visible after reloads and the
            // auto-resume-on-limit feature can arm on it. The raw record keeps the
            // transcript timestamp the webview's freshness gate reads.
            String limitError = extractLocalCommandUsageLimitError(msg);
            if (limitError != null) {
                return new ClaudeSession.Message(ClaudeSession.Message.Type.ERROR, limitError, msg);
            }
            return null;
        }

        return null;
    }

    /**
     * Phrasings identifying a Claude usage-limit notice. Deliberately permissive
     * (mirrors the webview's usageLimitError.ts patterns): the webview re-parses
     * the text before arming auto-resume, so a false positive here at worst
     * renders an extra error row for a genuinely failed command.
     */
    private static final java.util.regex.Pattern USAGE_LIMIT_TEXT_PATTERN = java.util.regex.Pattern.compile(
        "usage limit reached"
            + "|\\b\\d+[\\s-]?hour limit reached"
            + "|\\b(session|daily|weekly|monthly) limit reached"
            + "|reached your (usage|\\d+[\\s-]?hour) limit"
            + "|you['’]?ve hit your (session|daily|weekly|monthly|usage|\\d+[\\s-]?hour) limit",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    private static final String LOCAL_COMMAND_STDERR_OPEN = "<local-command-stderr>";
    private static final String LOCAL_COMMAND_STDERR_CLOSE = "</local-command-stderr>";

    /**
     * If the record is a local-command output whose stderr reports a Claude
     * usage limit, return the inner stderr text; otherwise null.
     *
     * Example transcript record (a /compact that hit the session limit):
     * {@code {"type":"system","subtype":"local_command","content":
     * "<local-command-stderr>Error during compaction: You've hit your session
     * limit · resets 12:10am (Europe/Warsaw)</local-command-stderr>"}}
     */
    public static String extractLocalCommandUsageLimitError(JsonObject record) {
        if (record == null || !record.has("content") || !record.get("content").isJsonPrimitive()) {
            return null;
        }
        String content;
        try {
            content = record.get("content").getAsString();
        } catch (Exception e) {
            return null;
        }
        int start = content.indexOf(LOCAL_COMMAND_STDERR_OPEN);
        if (start < 0) {
            return null;
        }
        int innerStart = start + LOCAL_COMMAND_STDERR_OPEN.length();
        int end = content.indexOf(LOCAL_COMMAND_STDERR_CLOSE, innerStart);
        String inner = (end >= innerStart ? content.substring(innerStart, end) : content.substring(innerStart)).trim();
        if (inner.isEmpty() || !USAGE_LIMIT_TEXT_PATTERN.matcher(inner).find()) {
            return null;
        }
        return inner;
    }

    /**
     * Provider history adapters may return an already-normalized frontend envelope whose
     * structured SDK payload lives in {@code raw}. Keep only that payload in session state;
     * otherwise MessageJsonConverter sees the envelope's display-only content and drops
     * nested tool_use/tool_result blocks during auto-restore.
     */
    private JsonObject resolveRawMessage(JsonObject msg) {
        if (msg.has("raw") && msg.get("raw").isJsonObject()) {
            return msg.getAsJsonObject("raw");
        }
        return msg;
    }

    /**
     * Check whether a command message should be filtered out.
     * Only applies to user messages - assistant messages may contain
     * command tags in code examples and should not be filtered.
     */
    private boolean shouldFilterCommandMessage(JsonObject msg, String type) {
        // Only filter user messages - assistant messages may contain command tags in code examples
        if (!"user".equals(type)) {
            return false;
        }

        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return false;
        }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content")) {
            return false;
        }

        JsonElement contentElement = message.get("content");
        String contentStr = null;

        if (contentElement.isJsonPrimitive()) {
            contentStr = contentElement.getAsString();
        } else if (contentElement.isJsonArray()) {
            JsonArray contentArray = contentElement.getAsJsonArray();
            for (int i = 0; i < contentArray.size(); i++) {
                JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    JsonObject block = element.getAsJsonObject();
                    if (block.has("type") && "text".equals(block.get("type").getAsString()) &&
                        block.has("text")) {
                        contentStr = block.get("text").getAsString();
                        break;
                    }
                }
            }
        }

        // Filter content with command tags (allow user input containing <command-message>)
        if (contentStr != null) {
            boolean hasCommandMessage = contentStr.contains("<command-message>") &&
                contentStr.contains("</command-message>");
            if (!hasCommandMessage && (
                contentStr.contains("<command-name>") ||
                contentStr.contains("<local-command-stdout>") ||
                contentStr.contains("<local-command-stderr>") ||
                contentStr.contains("<command-args>")
            )) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check whether the message contains a tool_result.
     */
    public boolean hasToolResult(JsonObject msg) {
        return hasContentBlockType(msg, "tool_result");
    }

    public boolean hasImageContent(JsonObject msg) {
        return hasContentBlockType(msg, "image");
    }

    private boolean hasContentBlockType(JsonObject msg, String blockType) {
        if (msg.has("content") && containsContentBlockType(msg.get("content"), blockType)) {
            return true;
        }
        if (msg.has("message") && msg.get("message").isJsonObject()) {
            JsonObject message = msg.getAsJsonObject("message");
            if (message.has("content") && containsContentBlockType(message.get("content"), blockType)) {
                return true;
            }
        }
        return false;
    }

    private boolean containsContentBlockType(JsonElement contentElement, String blockType) {
        if (contentElement == null || !contentElement.isJsonArray()) {
            return false;
        }

        JsonArray contentArray = contentElement.getAsJsonArray();
        for (int i = 0; i < contentArray.size(); i++) {
            JsonElement element = contentArray.get(i);
            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                if (block.has("type") && blockType.equals(block.get("type").getAsString())) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Extract the message content.
     */
    public String extractMessageContent(JsonObject msg) {
        if (!msg.has("message")) {
            if (msg.has("content")) {
                return extractContentFromElement(msg.get("content"));
            }
            return "";
        }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return "";
        }

        return extractContentFromElement(message.get("content"));
    }

    /**
     * Extract content from a JsonElement.
     */
    private String extractContentFromElement(JsonElement contentElement) {
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        if (contentElement.isJsonArray()) {
            return extractFromArrayContent(contentElement.getAsJsonArray());
        }

        if (contentElement.isJsonObject()) {
            JsonObject contentObj = contentElement.getAsJsonObject();
            if (contentObj.has("text") && !contentObj.get("text").isJsonNull()) {
                return contentObj.get("text").getAsString();
            }
            LOG.warn("Content is an object but has no 'text' field: " + contentObj.toString());
        }

        return "";
    }

    /**
     * Extract text from array-format content.
     */
    private String extractFromArrayContent(JsonArray contentArray) {
        StringBuilder sb = new StringBuilder();
        boolean hasContent = false;

        for (int i = 0; i < contentArray.size(); i++) {
            JsonElement element = contentArray.get(i);
            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                String blockType = (block.has("type") && !block.get("type").isJsonNull())
                    ? block.get("type").getAsString()
                    : null;

                if ("text".equals(blockType) && block.has("text") && !block.get("text").isJsonNull()) {
                    if (sb.length() > 0) {
                        sb.append("\n");
                    }
                    sb.append(block.get("text").getAsString());
                    hasContent = true;
                } else if ("tool_use".equals(blockType)) {
                    // Skip tool_use block, don't display tool usage text
                } else if ("thinking".equals(blockType)) {
                    // Skip thinking block, don't display fixed text
                } else if ("image".equals(blockType)) {
                    // Skip image block, don't display fixed text
                }
            } else if (element.isJsonPrimitive()) {
                String text = element.getAsString();
                if (text != null && !text.trim().isEmpty()) {
                    if (sb.length() > 0) {
                        sb.append("\n");
                    }
                    sb.append(text);
                    hasContent = true;
                }
            }
        }

        return sb.toString();
    }
}
