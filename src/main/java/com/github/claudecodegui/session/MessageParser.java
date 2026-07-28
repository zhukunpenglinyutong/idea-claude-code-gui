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

        // Filter out sidechain messages (subagent transcripts) so they never
        // enter the main session list. This mirrors the isSidechain filter
        // ClaudeSessionLiteReader applies on history reload, keeping reloaded
        // history consistent with the live stream (whose subagent messages are
        // already filtered upstream by ai-bridge's parent_tool_use_id check).
        // parseServerMessage runs on the history-reload path, so this is a
        // defense-in-depth guard against any isSidechain-tagged entry slipping
        // through into the rendered chat.
        if (msg.has("isSidechain") && !msg.get("isSidechain").isJsonNull()
                && msg.get("isSidechain").getAsBoolean()) {
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
                    return applyTranscriptTimestamp(
                        new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "[tool_result]", rawMessage), msg);
                }
                if (hasImageContent(rawMessage)) {
                    return applyTranscriptTimestamp(
                        new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "", rawMessage), msg);
                }
                return null;
            }
            return applyTranscriptTimestamp(
                new ClaudeSession.Message(ClaudeSession.Message.Type.USER, content, rawMessage), msg);
        } else if ("assistant".equals(type)) {
            String content = extractMessageContent(msg);
            return applyTranscriptTimestamp(
                new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, content, rawMessage), msg);
        } else if ("queue-operation".equals(type) || "attachment".equals(type)) {
            // A task-notification delivered while a turn is running is recorded only
            // as queue-operation enqueue/remove lines plus an attachment line — it
            // never becomes a plain user message (and compaction can drop even a
            // queued one). Forward these records so the frontend's finished-task
            // store learns the terminal status (and usage stats) of background
            // agents/workflows; the frontend recognizes raw.type and never renders
            // them, and duplicate records for the same task are idempotent there.
            String notification = extractTaskNotificationRecord(msg);
            if (notification != null) {
                return applyTranscriptTimestamp(
                    new ClaudeSession.Message(ClaudeSession.Message.Type.USER, notification, msg), msg);
            }
            return null;
        }

        return null;
    }

    /**
     * Stamp the message with the transcript record's own timestamp when present.
     *
     * The Message constructor stamps {@code System.currentTimeMillis()}, so every
     * session reload used to produce a fresh timestamp for every message. The
     * webview's smart merge reuses a previous message object only when its
     * timestamp matches — with parse-time stamps nothing ever matched, every
     * reload replaced every row, and the throttled background-turn refreshes
     * (~5s) read as a visible full-transcript blink. A transcript-derived stamp
     * is deterministic across reloads (and shows the real message time instead
     * of the reload time). Live SDK messages carry no timestamp field and keep
     * the parse-time stamp.
     */
    private ClaudeSession.Message applyTranscriptTimestamp(ClaudeSession.Message message, JsonObject msg) {
        if (message == null || msg == null || !msg.has("timestamp") || msg.get("timestamp").isJsonNull()) {
            return message;
        }
        try {
            JsonElement ts = msg.get("timestamp");
            if (ts.isJsonPrimitive() && ts.getAsJsonPrimitive().isNumber()) {
                message.timestamp = ts.getAsLong();
            } else if (ts.isJsonPrimitive() && ts.getAsJsonPrimitive().isString()) {
                message.timestamp = java.time.Instant.parse(ts.getAsString()).toEpochMilli();
            }
        } catch (Exception e) {
            LOG.debug("Unparseable transcript timestamp, keeping parse-time stamp: " + e.getMessage());
        }
        return message;
    }

    /**
     * Extract the task-notification text carried by a queue-operation line
     * (top-level string {@code content}) or an attachment line
     * ({@code attachment.prompt}). Returns null for unrelated records.
     */
    private String extractTaskNotificationRecord(JsonObject msg) {
        String text = null;
        if (msg.has("content") && msg.get("content").isJsonPrimitive()) {
            text = msg.get("content").getAsString();
        } else if (msg.has("attachment") && msg.get("attachment").isJsonObject()) {
            JsonObject attachment = msg.getAsJsonObject("attachment");
            if (attachment.has("prompt") && attachment.get("prompt").isJsonPrimitive()) {
                text = attachment.get("prompt").getAsString();
            }
        }
        return text != null && text.contains("<task-notification>") ? text : null;
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
