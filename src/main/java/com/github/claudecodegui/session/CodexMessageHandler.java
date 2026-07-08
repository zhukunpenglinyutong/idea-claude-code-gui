package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.util.UsageCostCalculator;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Codex message callback handler.
 * Processes messages returned by Codex AI.
 * Similar to ClaudeMessageHandler but handles Codex's simpler message format,
 * primarily dealing with streaming text output.
 */
public class CodexMessageHandler implements MessageCallback {
    /**
     * log.
     */
    private static final Logger LOG = Logger.getInstance(CodexMessageHandler.class);

    /**
     * state.
     */
    private final SessionState state;
    /**
     * callback handler.
     */
    private final CallbackHandler callbackHandler;
    /**
     * message merger.
     */
    private final MessageMerger messageMerger = new MessageMerger();

    /**
     * assistant content.
     */ // Content accumulator for the current assistant message
    private final StringBuilder assistantContent = new StringBuilder();

    /**
     * current assistant message.
     */ // Current assistant message object being processed
    private Message currentAssistantMessage = null;

    /**
     * is streaming.
     */
    private boolean isStreaming = false;
    /**
     * stream ended this turn.
     */
    private boolean streamEndedThisTurn = false;

    /**
     * Constructor.
     *
     * @param state state
     * @param callbackHandler callback handler
     * @since 1.0.0
     */
    public CodexMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        this.state = state;
        this.callbackHandler = callbackHandler;
    }

    /**
     * Handle a received message by dispatching to the appropriate handler based on type.
     *
     * @param type type
     * @param content content
     * @since 1.0.0
     */
    @Override
    public void onMessage(String type, String content) {
        // [FIX] Handle multiple message types
        // Codex message-service.js sends:
        // - type='assistant': contains thinking, tool_use, text
        // - type='user': contains tool_result
        LOG.debug("CodexMessageHandler.onMessage: type=" + type + ", content length=" + (content != null ? content.length() : 0));

        if ("assistant".equals(type)) {
            // Handle assistant message (thinking, tool_use, text)
            handleAssistantMessage(content);
        } else if ("user".equals(type)) {
            // Handle user message (tool_result)
            handleUserMessage(content);
        } else if ("result".equals(type)) {
            // Handle result message (usage stats, etc.)
            handleResultMessage(content);
        } else if ("session_id".equals(type)) {
            // Handle session_id/thread_id (for session recovery)
            handleSessionId(content);
        } else if ("event_msg".equals(type)) {
            handleEventMessage(content);
        } else if ("stream_start".equals(type)) {
            handleStreamStart();
        } else if ("stream_end".equals(type)) {
            handleStreamEnd();
        } else if ("thinking_delta".equals(type)) {
            handleThinkingDelta(content);
        } else if ("content_delta".equals(type) || "content".equals(type)) {
            // Handle streaming content delta (legacy format, kept for compatibility)
            // content_delta: streaming incremental
            // content: complete content block
            handleContentDelta(content);
        } else if ("status".equals(type)) {
            if (content != null && !content.trim().isEmpty()) {
                callbackHandler.notifyStatusMessage(content);
            }
        } else if ("message_end".equals(type)) {
            handleMessageEnd();
        } else {
            LOG.debug("CodexMessageHandler: Unhandled message type: " + type);
        }
    }

    /**
     * Handle an error from the SDK.
     *
     * @param error error
     * @since 1.0.0
     */
    @Override
    public void onError(String error) {
        boolean wasStreaming = isStreaming;
        isStreaming = false;
        streamEndedThisTurn = false;
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);

        // Signal stream-end BEFORE pushing the error snapshot (mirrors the PR #1421
        // fix in ClaudeMessageHandler.onError). The webview's onStreamEnd cancels any
        // pending updateMessages rAF; pushing the error snapshot first lets that
        // cancellation drop it, so the "API request failed" bubble never renders.
        // Ending the stream first lets the subsequent snapshot land normally.
        //
        // Kept conditional on wasStreaming — deliberately NOT unconditional like the
        // Claude handler. A non-streaming Codex turn maps to the webview's 'minimal'
        // stream-end mode (getStreamEndHandlingMode: provider === 'codex'), which only
        // cancels pending updates and does NOT run the dangling-tool cleanup the Claude
        // 'skip' mode does. So an unconditional call would buy no tool cleanup here
        // while adding a redundant minimal-mode pass. The dangling-tool-on-non-
        // streaming-error case needs a separate webview-side fix, not this ordering one.
        if (wasStreaming) {
            callbackHandler.notifyStreamEnd();
        }
        callbackHandler.notifyMessageUpdate(state.getMessages());
        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    /**
     * Handle completion of a response turn.
     *
     * @param result result
     * @since 1.0.0
     */
    @Override
    public void onComplete(SDKResult result) {
        boolean streamEndedBeforeComplete = streamEndedThisTurn;
        boolean wasStreaming = isStreaming;

        isStreaming = false;
        streamEndedThisTurn = false;
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();

        if (wasStreaming && !streamEndedBeforeComplete) {
            LOG.warn("Codex onComplete called without prior stream_end; forcing stream cleanup");
            callbackHandler.notifyMessageUpdate(state.getMessages());
            callbackHandler.notifyStreamEnd();
        }

        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    // ===== Private methods =====

    /**
     * Handle a complete assistant message in JSON format.
     * Contains thinking, tool_use, text, and other content types.
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleAssistantMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);

            // Apply v0.1.3-codex filtering logic
            Message parsed = parseServerMessage(msgJson, Message.Type.ASSISTANT);
            if (parsed == null) {
                LOG.debug("Codex assistant message filtered out");
                return;
            }

            if (currentAssistantMessage != null) {
                com.google.gson.JsonObject mergedRaw = messageMerger.mergeAssistantMessage(currentAssistantMessage.raw, parsed.raw);
                currentAssistantMessage.content = parsed.content;
                currentAssistantMessage.raw = mergedRaw;
                assistantContent.setLength(0);
                assistantContent.append(parsed.content != null ? parsed.content : "");
            } else {
                state.addMessage(parsed);
            }
            callbackHandler.notifyMessageUpdate(state.getMessages());

            LOG.debug("Codex assistant message synchronized with raw JSON");
        } catch (Exception e) {
            LOG.warn("Failed to parse assistant message: " + e.getMessage());
        }
    }

    /**
     * Handle a user message (primarily tool_result).
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleUserMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);

            // Apply v0.1.3-codex filtering logic
            Message parsed = parseServerMessage(msgJson, Message.Type.USER);
            if (parsed == null) {
                LOG.debug("Codex user message filtered out");
                return;
            }

            state.addMessage(parsed);
            callbackHandler.notifyMessageUpdate(state.getMessages());

            LOG.debug("Codex user message (tool_result) added");
        } catch (Exception e) {
            LOG.warn("Failed to parse user message: " + e.getMessage());
        }
    }

    /**
     * Handle the session_id (Codex thread ID) for session recovery.
     *
     * @param threadId thread id
     * @since 1.0.0
     */
    private void handleSessionId(String threadId) {
        if (threadId != null && !threadId.trim().isEmpty()) {
            state.setSessionId(threadId);
            callbackHandler.notifySessionIdReceived(threadId);
            LOG.info("Captured Codex thread ID: " + threadId);
        }
    }

    /**
     * Handle the result message containing usage statistics.
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleResultMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);
            if (msgJson == null || !msgJson.has("usage") || !msgJson.get("usage").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject usage = msgJson.getAsJsonObject("usage");
            // The result message carries the turn.completed usage, which covers exactly
            // one turn but counts cached tokens inside input_tokens (OpenAI convention).
            // Normalize to the Claude usage schema (input excludes cache) and stamp it
            // as turnUsage for the per-turn token display in the webview.
            com.google.gson.JsonObject turnUsage = buildTurnUsage(usage);
            boolean updated = attachUsageToLastAssistant(usage, turnUsage);
            if (updated) {
                callbackHandler.notifyMessageUpdate(state.getMessages());
                LOG.info("Codex usage applied from result message");
            } else {
                LOG.debug("Codex usage received but no assistant message to attach");
            }
        } catch (Exception e) {
            LOG.debug("Failed to parse Codex result message: " + e.getMessage());
        }
    }

    /**
     * Build a whole-turn usage object in the Claude usage schema from a Codex usage
     * object whose input_tokens include cached tokens.
     *
     * @param usage usage in ai-bridge Claude-compatible format (input includes cache)
     * @return turn usage with input_tokens excluding cache, cache fields separate
     * @since 1.0.0
     */
    private static com.google.gson.JsonObject buildTurnUsage(com.google.gson.JsonObject usage) {
        int input = readInt(usage, "input_tokens");
        int output = readInt(usage, "output_tokens");
        int cacheRead = readInt(usage, "cache_read_input_tokens", "cached_input_tokens");
        com.google.gson.JsonObject turnUsage = new com.google.gson.JsonObject();
        turnUsage.addProperty("input_tokens", Math.max(0, input - cacheRead));
        turnUsage.addProperty("cache_creation_input_tokens", 0);
        turnUsage.addProperty("cache_read_input_tokens", cacheRead);
        turnUsage.addProperty("output_tokens", output);
        return turnUsage;
    }

    private static int readInt(com.google.gson.JsonObject json, String... keys) {
        for (String key : keys) {
            if (json.has(key) && !json.get(key).isJsonNull()) {
                return Math.max(0, json.get(key).getAsInt());
            }
        }
        return 0;
    }

    /**
     * Handle event_msg containing token_count and other events.
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleEventMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);
            if (msgJson == null || !msgJson.has("payload") || !msgJson.get("payload").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject payload = msgJson.getAsJsonObject("payload");
            if (!payload.has("type") || !"token_count".equals(payload.get("type").getAsString())) {
                return;
            }

            if (!payload.has("info") || payload.get("info").isJsonNull() || !payload.get("info").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject info = payload.getAsJsonObject("info");
            if (!info.has("total_token_usage") || !info.get("total_token_usage").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject totalUsage = info.getAsJsonObject("total_token_usage");
            int inputTokens = totalUsage.has("input_tokens") ? totalUsage.get("input_tokens").getAsInt() : 0;
            int outputTokens = totalUsage.has("output_tokens") ? totalUsage.get("output_tokens").getAsInt() : 0;
            int cachedInputTokens = totalUsage.has("cached_input_tokens") ? totalUsage.get("cached_input_tokens").getAsInt() : 0;

            com.google.gson.JsonObject usage = new com.google.gson.JsonObject();
            usage.addProperty("input_tokens", inputTokens);
            usage.addProperty("output_tokens", outputTokens);
            usage.addProperty("cache_read_input_tokens", cachedInputTokens);
            usage.addProperty("cache_creation_input_tokens", 0);

            // token_count carries total_token_usage (session-cumulative), which feeds the
            // context-usage status bar via the top-level usage field. It is NOT turn-scoped,
            // so never stamp it as turnUsage — the turn aggregate comes from the result
            // message (turn.completed) in handleResultMessage.
            boolean updated = attachUsageToLastAssistant(usage, null);
            if (updated) {
                callbackHandler.notifyMessageUpdate(state.getMessages());
                LOG.debug("Codex token_count applied: input=" + inputTokens + ", output=" + outputTokens + ", cached=" + cachedInputTokens);
            } else {
                LOG.debug("Codex token_count received but no assistant message to attach");
            }
        } catch (Exception e) {
            LOG.debug("Failed to parse Codex event_msg: " + e.getMessage());
        }
    }

    /**
     * Attach usage data to the last assistant message's raw field.
     * The top-level usage field feeds the context-usage status bar; the optional
     * turnUsage field feeds the per-turn token display in the webview.
     *
     * @param usage usage for the status bar (top-level usage field)
     * @param turnUsage whole-turn usage in Claude schema, or null to skip
     * @return boolean
     * @since 1.0.0
     */
    private boolean attachUsageToLastAssistant(com.google.gson.JsonObject usage, com.google.gson.JsonObject turnUsage) {
        java.util.List<Message> messages = state.getMessagesReference();
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message msg = messages.get(i);
            if (msg.type == Message.Type.ASSISTANT && msg.raw != null) {
                msg.raw.add("usage", usage);
                if (turnUsage != null) {
                    msg.raw.add("turnUsage", turnUsage);
                    Double turnCostUsd = UsageCostCalculator.calculateTurnCostUsd("codex", turnUsage, state.getModel());
                    if (turnCostUsd != null) {
                        msg.raw.addProperty("turnCostUsd", turnCostUsd);
                    }
                }
                return true;
            }
        }
        return false;
    }

    /**
     * Parse a server message with full filtering and parsing logic (ported from v0.1.3-codex).
     *
     * @param msg msg
     * @param messageType message type
     * @return message
     * @since 1.0.0
     */
    private Message parseServerMessage(com.google.gson.JsonObject msg, Message.Type messageType) {
        if (isMetaMessage(msg)) {
            return null;
        }
        if (isFilteredCommandMessage(msg, messageType)) {
            return null;
        }

        String content = extractMessageContent(msg);
        if (messageType == Message.Type.USER) {
            return buildUserMessage(msg, content);
        }

        Message result = new Message(messageType, content != null ? content : "");
        result.raw = msg;
        return result;
    }

    private boolean isMetaMessage(com.google.gson.JsonObject msg) {
        return msg.has("isMeta") && msg.get("isMeta").getAsBoolean();
    }

    /**
     * Detect Codex internal command messages that must not be shown to the user.
     * Codex prepends instruction blocks to user input; strip them before checking command tags
     * so those hidden blocks do not mask the user's real message.
     * Only filter user messages - assistant messages may contain these tags in code examples.
     */
    private boolean isFilteredCommandMessage(com.google.gson.JsonObject msg, Message.Type messageType) {
        // Only filter user messages - assistant messages may contain command tags in code examples
        if (messageType != Message.Type.USER) {
            return false;
        }

        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return false;
        }
        com.google.gson.JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content")) {
            return false;
        }

        String contentStr = extractFirstTextContent(message.get("content"));
        if (contentStr == null) {
            return false;
        }

        String filterContent = CodexMessageConverter.stripSystemTags(contentStr);
        boolean hasCommandMessage = contentStr.contains("<command-message>")
            && contentStr.contains("</command-message>");
        if (hasCommandMessage) {
            return false;
        }
        return filterContent.contains("<command-name>")
            || filterContent.contains("<local-command-stdout>")
            || filterContent.contains("<local-command-stderr>")
            || filterContent.contains("<command-args>");
    }

    private String extractFirstTextContent(com.google.gson.JsonElement contentElement) {
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }
        if (!contentElement.isJsonArray()) {
            return null;
        }
        com.google.gson.JsonArray contentArray = contentElement.getAsJsonArray();
        for (int i = 0; i < contentArray.size(); i++) {
            com.google.gson.JsonElement element = contentArray.get(i);
            if (!element.isJsonObject()) {
                continue;
            }
            com.google.gson.JsonObject block = element.getAsJsonObject();
            if (block.has("type") && "text".equals(block.get("type").getAsString())
                && block.has("text")) {
                return block.get("text").getAsString();
            }
        }
        return null;
    }

    private Message buildUserMessage(com.google.gson.JsonObject msg, String content) {
        boolean hasToolResult = containsToolResult(msg);
        if (!hasToolResult) {
            content = CodexMessageConverter.stripSystemTags(content);
            if (content != null && !content.trim().isEmpty()) {
                rewriteUserRawContent(msg, content);
            }
        }
        if (content == null || content.trim().isEmpty()) {
            if (hasToolResult) {
                Message result = new Message(Message.Type.USER, "[tool_result]");
                result.raw = msg;
                return result;
            }
            return null;
        }

        Message result = new Message(Message.Type.USER, content);
        result.raw = msg;
        return result;
    }

    /**
     * Extract message content (ported from v0.1.3-codex).
     *
     * @param msg msg
     * @return string
     * @since 1.0.0
     */
    private String extractMessageContent(com.google.gson.JsonObject msg) {
        if (!msg.has("message")) {
            // Try to get content directly from the top level (some message formats may differ)
            if (msg.has("content")) {
                return extractContentFromElement(msg.get("content"));
            }
            return "";
        }

        com.google.gson.JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return "";
        }

        // Get the content element
        com.google.gson.JsonElement contentElement = message.get("content");
        return extractContentFromElement(contentElement);
    }

    /**
     * Extract content from a JsonElement (ported from v0.1.3-codex).
     *
     * @param contentElement content element
     * @return string
     * @since 1.0.0
     */
    private String extractContentFromElement(com.google.gson.JsonElement contentElement) {
        // String format
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        // Array format
        if (contentElement.isJsonArray()) {
            com.google.gson.JsonArray contentArray = contentElement.getAsJsonArray();
            StringBuilder sb = new StringBuilder();
            boolean hasContent = false;

            for (int i = 0; i < contentArray.size(); i++) {
                com.google.gson.JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    com.google.gson.JsonObject block = element.getAsJsonObject();
                    String blockType = (block.has("type") && !block.get("type").isJsonNull())
                        ? block.get("type").getAsString()
                        : null;

                    // Handle different content block types
                    if (("text".equals(blockType) || "input_text".equals(blockType) || "output_text".equals(blockType))
                            && block.has("text") && !block.get("text").isJsonNull()) {
                        String text = block.get("text").getAsString();
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append(text);
                        hasContent = true;
                    } else if ("tool_use".equals(blockType)) {
                        // Skip tool_use, don't display tool usage text
                    } else if ("tool_result".equals(blockType)) {
                        // Tool result - skip display as it provides no direct value to the user
                        // and is typically long and already reflected in the assistant's response
                    } else if ("thinking".equals(blockType)) {
                        // Skip thinking block, don't display fixed text
                    } else if ("image".equals(blockType)) {
                        // Skip image block, don't display fixed text
                    }
                } else if (element.isJsonPrimitive()) {
                    // In some cases, array elements may be plain strings
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

        // Object format (special cases)
        if (contentElement.isJsonObject()) {
            com.google.gson.JsonObject contentObj = contentElement.getAsJsonObject();
            // Try to extract the text field
            if (contentObj.has("text") && !contentObj.get("text").isJsonNull()) {
                return contentObj.get("text").getAsString();
            }
            LOG.warn("Content is an object but has no 'text' field: " + contentObj.toString());
        }

        return "";
    }

    /**
     * Check whether a server message contains a tool_result block.
     *
     * @param msg msg
     * @return boolean
     * @since 1.0.0
     */
    private boolean containsToolResult(com.google.gson.JsonObject msg) {
        com.google.gson.JsonElement contentElement = getMessageContentElement(msg);
        if (contentElement == null || !contentElement.isJsonArray()) {
            return false;
        }

        com.google.gson.JsonArray contentArray = contentElement.getAsJsonArray();
        for (int i = 0; i < contentArray.size(); i++) {
            com.google.gson.JsonElement element = contentArray.get(i);
            if (element.isJsonObject()) {
                com.google.gson.JsonObject block = element.getAsJsonObject();
                if (block.has("type") && "tool_result".equals(block.get("type").getAsString())) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Replace raw user content with the visible text only.
     *
     * @param msg msg
     * @param content visible content
     * @since 1.0.0
     */
    private void rewriteUserRawContent(com.google.gson.JsonObject msg, String content) {
        com.google.gson.JsonArray contentBlocks = new com.google.gson.JsonArray();
        com.google.gson.JsonObject textBlock = new com.google.gson.JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", content);
        contentBlocks.add(textBlock);

        if (msg.has("message") && msg.get("message").isJsonObject()) {
            msg.getAsJsonObject("message").add("content", contentBlocks);
        } else {
            msg.add("content", contentBlocks);
        }
    }

    /**
     * Get the content element from either nested or top-level Codex message shapes.
     *
     * @param msg msg
     * @return element
     * @since 1.0.0
     */
    private com.google.gson.JsonElement getMessageContentElement(com.google.gson.JsonObject msg) {
        if (msg.has("message") && msg.get("message").isJsonObject()) {
            com.google.gson.JsonObject message = msg.getAsJsonObject("message");
            if (message.has("content") && !message.get("content").isJsonNull()) {
                return message.get("content");
            }
        }
        if (msg.has("content") && !msg.get("content").isJsonNull()) {
            return msg.get("content");
        }
        return null;
    }

    /**
     * Handle content delta in streaming mode.
     *
     * @param content content
     * @since 1.0.0
     */
    private void handleContentDelta(String content) {
        // Empty content check (compatible with v0.1.3-codex)
        if (content == null || content.isEmpty()) {
            return;
        }

        assistantContent.append(content);

        if (currentAssistantMessage == null) {
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
            state.addMessage(currentAssistantMessage);
        } else {
            currentAssistantMessage.content = assistantContent.toString();
        }

        callbackHandler.notifyContentDelta(content);
        callbackHandler.notifyMessageUpdate(state.getMessages());
    }

    /**
     * Handle thinking delta in streaming mode.
     *
     * @param content content
     * @since 1.0.0
     */
    private void handleThinkingDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }

        ensureCurrentAssistantMessageExists();
        applyThinkingDeltaToRaw(content);
        callbackHandler.notifyThinkingDelta(content);
    }

    /**
     * Ensure an assistant message exists for streaming raw updates.
     *
     * @since 1.0.0
     */
    private void ensureCurrentAssistantMessageExists() {
        if (currentAssistantMessage == null) {
            com.google.gson.JsonObject raw = new com.google.gson.JsonObject();
            raw.addProperty("type", "assistant");
            com.google.gson.JsonObject messageObj = new com.google.gson.JsonObject();
            messageObj.add("content", new com.google.gson.JsonArray());
            raw.add("message", messageObj);
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", raw);
            state.addMessage(currentAssistantMessage);
        }
        if (currentAssistantMessage.raw == null) {
            com.google.gson.JsonObject raw = new com.google.gson.JsonObject();
            raw.addProperty("type", "assistant");
            com.google.gson.JsonObject messageObj = new com.google.gson.JsonObject();
            messageObj.add("content", new com.google.gson.JsonArray());
            raw.add("message", messageObj);
            currentAssistantMessage.raw = raw;
        }
    }

    /**
     * Append thinking delta to the current assistant raw block.
     *
     * @param delta delta
     * @since 1.0.0
     */
    private void applyThinkingDeltaToRaw(String delta) {
        com.google.gson.JsonObject raw = currentAssistantMessage.raw;
        com.google.gson.JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message")
                : new com.google.gson.JsonObject();
        com.google.gson.JsonArray content = message.has("content") && message.get("content").isJsonArray()
                ? message.getAsJsonArray("content")
                : new com.google.gson.JsonArray();

        com.google.gson.JsonObject target = null;
        if (content.size() > 0) {
            com.google.gson.JsonElement last = content.get(content.size() - 1);
            if (last.isJsonObject()) {
                com.google.gson.JsonObject block = last.getAsJsonObject();
                if (block.has("type") && "thinking".equals(block.get("type").getAsString())) {
                    target = block;
                }
            }
        }

        if (target == null) {
            target = new com.google.gson.JsonObject();
            target.addProperty("type", "thinking");
            target.addProperty("thinking", "");
            target.addProperty("text", "");
            content.add(target);
        }

        String existing = target.has("thinking") && !target.get("thinking").isJsonNull()
                ? target.get("thinking").getAsString()
                : "";
        String next = existing + delta;
        target.addProperty("thinking", next);
        target.addProperty("text", next);

        message.add("content", content);
        raw.add("message", message);
        currentAssistantMessage.raw = raw;
    }

    /**
     * Handle Stream Start
     *
     * @since 1.0.0
     */
    private void handleStreamStart() {
        isStreaming = true;
        streamEndedThisTurn = false;
        resetStreamingAccumulator();
        callbackHandler.notifyStreamStart();
        LOG.debug("Codex stream started");
    }

    /**
     * Handle Stream End
     *
     * @since 1.0.0
     */
    private void handleStreamEnd() {
        if (!isStreaming && streamEndedThisTurn) {
            return;
        }

        isStreaming = false;
        streamEndedThisTurn = true;
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStreamEnd();
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        LOG.debug("Codex stream ended");
    }

    /**
     * Handle the end of a message.
     *
     * @since 1.0.0
     */
    private void handleMessageEnd() {
        LOG.debug("Codex message_end received, deferring stream cleanup to stream_end/onComplete");
    }

    /**
     * Reset per-turn streaming accumulator state.
     *
     * @since 1.0.0
     */
    private void resetStreamingAccumulator() {
        assistantContent.setLength(0);
        currentAssistantMessage = null;
    }
}
