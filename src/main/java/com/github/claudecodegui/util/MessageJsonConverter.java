package com.github.claudecodegui.util;

import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;

import java.util.List;

/**
 * Converts session messages to JSON for webview transport.
 * Handles error content truncation and tool_result size limits.
 */
public class MessageJsonConverter {

    private static final Logger LOG = Logger.getInstance(MessageJsonConverter.class);

    private static final int MAX_ERROR_CONTENT_CHARS = 1000;
    private static final String[] ERROR_CONTENT_PREFIXES = {
        "API Error", "API error", "Error:", "Error "
    };
    private static final int MAX_TOOL_RESULT_CHARS = 20000;

    /**
     * Convert a list of session messages to JSON string for webview transport.
     */
    public static String convertMessagesToJson(List<ClaudeSession.Message> messages) {
        Gson gson = new Gson();
        JsonArray messagesArray = new JsonArray();
        for (ClaudeSession.Message msg : messages) {
            JsonObject msgObj = new JsonObject();
            msgObj.addProperty("type", msg.type.toString().toLowerCase());
            msgObj.addProperty("timestamp", msg.timestamp);
            msgObj.addProperty("content", truncateErrorContent(msg.content != null ? msg.content : ""));
            if (msg.raw != null) {
                msgObj.add("raw", truncateRawForTransport(msg.raw));
            }
            messagesArray.add(msgObj);
        }
        return gson.toJson(messagesArray);
    }

    /**
     * Truncate content only if it looks like an error message.
     * Normal assistant responses are never truncated.
     */
    public static String truncateErrorContent(String content) {
        if (content == null || content.length() <= MAX_ERROR_CONTENT_CHARS) {
            return content;
        }
        for (String prefix : ERROR_CONTENT_PREFIXES) {
            if (content.startsWith(prefix)) {
                return content.substring(0, MAX_ERROR_CONTENT_CHARS)
                    + "... [truncated, total " + content.length() + " chars]";
            }
        }
        return content;
    }

    /**
     * Check if content starts with a known error prefix.
     */
    public static boolean isErrorContent(String content) {
        if (content == null) { return false; }
        for (String prefix : ERROR_CONTENT_PREFIXES) {
            if (content.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Truncate oversized raw JSON for transport.
     * Handles tool_result and error text blocks.
     */
    public static JsonObject truncateRawForTransport(JsonObject raw) {
        JsonObject transport = buildTransportRaw(raw);
        JsonElement contentEl = findContentElement(transport);

        if (contentEl == null) {
            return transport;
        }

        // Handle string content (frontend normalizeBlocks also handles this case)
        if (contentEl.isJsonPrimitive() && contentEl.getAsJsonPrimitive().isString()) {
            String s = contentEl.getAsString();
            if (s.length() > MAX_ERROR_CONTENT_CHARS && isErrorContent(s)) {
                JsonObject copied = transport.deepCopy();
                String truncated = truncateErrorContent(s);
                if (copied.has("content")) {
                    copied.addProperty("content", truncated);
                } else if (copied.has("message") && copied.get("message").isJsonObject()) {
                    copied.getAsJsonObject("message").addProperty("content", truncated);
                }
                return copied;
            }
            return transport;
        }

        if (!contentEl.isJsonArray()) {
            return transport;
        }

        JsonArray contentArr = contentEl.getAsJsonArray();
        boolean needsCopy = false;
        for (JsonElement el : contentArr) {
            if (!el.isJsonObject()) { continue; }
            JsonObject block = el.getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull()) { continue; }
            String blockType = block.get("type").getAsString();
            // Check tool_result blocks for oversized content
            if ("tool_result".equals(blockType)) {
                if (!block.has("content") || block.get("content").isJsonNull()) { continue; }
                JsonElement c = block.get("content");
                if (c.isJsonPrimitive() && c.getAsJsonPrimitive().isString()) {
                    if (c.getAsString().length() > MAX_TOOL_RESULT_CHARS) {
                        needsCopy = true;
                        break;
                    }
                }
            }
            // Check text blocks for oversized error content
            if ("text".equals(blockType) && block.has("text") && !block.get("text").isJsonNull()) {
                JsonElement t = block.get("text");
                if (t.isJsonPrimitive() && t.getAsJsonPrimitive().isString()) {
                    String s = t.getAsString();
                    if (s.length() > MAX_ERROR_CONTENT_CHARS && isErrorContent(s)) {
                        needsCopy = true;
                        break;
                    }
                }
            }
        }

        if (!needsCopy) {
            return transport;
        }

        JsonObject copied = transport.deepCopy();
        JsonElement copiedContentEl = findContentElement(copied);

        if (copiedContentEl == null || !copiedContentEl.isJsonArray()) {
            return copied;
        }

        JsonArray copiedArr = copiedContentEl.getAsJsonArray();
        for (JsonElement el : copiedArr) {
            if (!el.isJsonObject()) { continue; }
            JsonObject block = el.getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull()) { continue; }
            String blockType = block.get("type").getAsString();
            // Truncate oversized tool_result content
            if ("tool_result".equals(blockType)) {
                if (!block.has("content") || block.get("content").isJsonNull()) { continue; }
                JsonElement c = block.get("content");
                if (c.isJsonPrimitive() && c.getAsJsonPrimitive().isString()) {
                    String s = c.getAsString();
                    if (s.length() > MAX_TOOL_RESULT_CHARS) {
                        int head = (int) Math.floor(MAX_TOOL_RESULT_CHARS * 0.65);
                        int tail = MAX_TOOL_RESULT_CHARS - head;
                        String prefix = s.substring(0, Math.min(head, s.length()));
                        String suffix = tail > 0 ? s.substring(Math.max(0, s.length() - tail)) : "";
                        String truncated = prefix + "\n...\n(truncated, original length: " + s.length() + " chars)\n...\n" + suffix;
                        block.addProperty("content", truncated);
                    }
                }
            }
            // Truncate error content in text blocks
            if ("text".equals(blockType) && block.has("text") && !block.get("text").isJsonNull()) {
                JsonElement t = block.get("text");
                if (t.isJsonPrimitive() && t.getAsJsonPrimitive().isString()) {
                    String s = t.getAsString();
                    if (s.length() > MAX_ERROR_CONTENT_CHARS && isErrorContent(s)) {
                        block.addProperty("text", truncateErrorContent(s));
                    }
                }
            }
        }

        return copied;
    }

    private static JsonObject buildTransportRaw(JsonObject raw) {
        JsonObject transport = new JsonObject();
        copyFieldIfPresent(raw, transport, "uuid");
        copyFieldIfPresent(raw, transport, "type");
        copyFieldIfPresent(raw, transport, "isMeta");
        copyFieldIfPresent(raw, transport, "text");
        // Compact-related fields for filtering compact summary messages
        copyFieldIfPresent(raw, transport, "isCompactSummary");
        copyFieldIfPresent(raw, transport, "isVisibleInTranscriptOnly");
        copyFieldIfPresent(raw, transport, "summarizeMetadata");
        // Origin field for distinguishing human input from synthetic messages
        copyFieldIfPresent(raw, transport, "origin");
        // Whole-turn aggregated usage stamped by ClaudeMessageHandler.handleResult /
        // CodexMessageHandler.handleResultMessage, for the per-turn token display.
        // Whole-turn estimated cost is calculated by the backend from the same pricing
        // configuration used by Usage Statistics; the frontend only formats it.
        // Deliberately NOT copying the top-level usage or message.usage fields:
        // those carry per-call / session-cumulative values for the status bar and
        // would be misleading if rendered per message.
        copyFieldIfPresent(raw, transport, "turnUsage");
        copyFieldIfPresent(raw, transport, "turnCostUsd");

        if (raw.has("content")) {
            transport.add("content", raw.get("content").deepCopy());
        }

        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject sourceMessage = raw.getAsJsonObject("message");
            JsonObject transportMessage = new JsonObject();
            if (sourceMessage.has("content")) {
                transportMessage.add("content", sourceMessage.get("content").deepCopy());
            }
            if (transportMessage.size() > 0) {
                transport.add("message", transportMessage);
            }
        }

        if (transport.size() > 0) {
            return transport;
        }
        LOG.warn("buildTransportRaw: no recognized fields in raw JSON, returning empty object");
        return new JsonObject();
    }

    private static JsonElement findContentElement(JsonObject raw) {
        if (raw.has("content")) {
            return raw.get("content");
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject message = raw.getAsJsonObject("message");
            if (message.has("content")) {
                return message.get("content");
            }
        }
        return null;
    }

    private static void copyFieldIfPresent(JsonObject source, JsonObject target, String fieldName) {
        if (source.has(fieldName)) {
            target.add(fieldName, source.get(fieldName).deepCopy());
        }
    }

    /**
     * Extract usage info from messages and push update to the webview.
     */
    public static void pushUsageUpdateFromMessages(
            List<ClaudeSession.Message> messages,
            HandlerContext handlerContext,
            JBCefBrowser browser,
            boolean disposed
    ) {
        try {
            LOG.debug("pushUsageUpdateFromMessages called with " + messages.size() + " messages");

            JsonObject lastUsage = TokenUsageUtils.findLastUsageFromSessionMessages(messages);
            if (lastUsage == null) {
                LOG.debug("No usage info found in messages");
                return;
            }

            String currentProvider = handlerContext.getCurrentProvider();
            int usedTokens = TokenUsageUtils.extractUsedTokens(lastUsage, currentProvider);
            int maxTokens = SettingsHandler.getModelContextLimit(handlerContext.getCurrentModel());
            int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

            LOG.debug("Pushing usage update: provider=" + currentProvider + ", usedTokens=" + usedTokens + ", max=" + maxTokens + ", percentage=" + percentage + "%");

            JsonObject usageUpdate = new JsonObject();
            usageUpdate.addProperty("percentage", percentage);
            usageUpdate.addProperty("totalTokens", usedTokens);
            usageUpdate.addProperty("limit", maxTokens);
            usageUpdate.addProperty("usedTokens", usedTokens);
            usageUpdate.addProperty("maxTokens", maxTokens);

            String usageJson = new Gson().toJson(usageUpdate);
            ApplicationManager.getApplication().invokeLater(() -> {
                if (browser != null && !disposed) {
                    // Use safe call pattern, check if function exists
                    String js = "(function() {" +
                            "  if (typeof window.onUsageUpdate === 'function') {" +
                            "    window.onUsageUpdate('" + JsUtils.escapeJs(usageJson) + "');" +
                            "    console.log('[Backend->Frontend] Usage update sent successfully');" +
                            "  } else {" +
                            "    console.warn('[Backend->Frontend] window.onUsageUpdate not found');" +
                            "  }" +
                            "})();";
                    browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
                }
            });
        } catch (Exception e) {
            LOG.warn("Failed to push usage update: " + e.getMessage(), e);
        }
    }
}
