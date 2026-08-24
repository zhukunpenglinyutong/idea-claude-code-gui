package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.util.TokenUsageUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.List;

/**
 * Gemini/agy message callback handler (Claude-template protocol surface).
 *
 * Grows toward ClaudeMessageHandler event types without reusing Claude-specific
 * Anthropic assumptions wholesale (handler strategy A).
 *
 * Protocol tags from ai-bridge agy stream-json normalizer:
 *   message_start / message_end / stream_start / stream_end / block_reset
 *   content_delta / content / thinking / thinking_delta
 *   assistant / user / result / session_id / tool_result / usage
 */
public class GeminiMessageHandler implements MessageCallback {
    private static final Logger LOG = Logger.getInstance(GeminiMessageHandler.class);

    private final SessionState state;
    private final CallbackHandler callbackHandler;
    private final Project project;
    private final Gson gson = new Gson();

    private final StringBuilder assistantContent = new StringBuilder();
    private Message currentAssistantMessage = null;
    /** Peak context tokens this stream (ignore tiny agy checkpoint regressions). */
    private int peakContextTokens = 0;
    /**
     * Assistant bubble owned by the active stream. After {@code stream_start} we only
     * attach content to this message — never to a completed previous-turn assistant
     * (which would silently glue two answers together when the send-time user message
     * is missing from state).
     */
    private Message assistantMessageForCurrentStream = null;

    private boolean isStreaming = false;
    private boolean streamEndedThisTurn = false;
    private boolean isThinking = false;

    public GeminiMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        this(state, callbackHandler, null);
    }

    public GeminiMessageHandler(SessionState state, CallbackHandler callbackHandler, Project project) {
        this.state = state;
        this.callbackHandler = callbackHandler;
        this.project = project;
    }

    @Override
    public void onMessage(String type, String content) {
        LOG.debug("GeminiMessageHandler.onMessage: type=" + type);

        switch (type) {
            case "assistant":
            case "message":
                handleAssistantMessage(content);
                break;
            case "user":
                handleUserMessage(content);
                break;
            case "result":
                handleResultMessage(content);
                break;
            case "session_id":
            case "thread_id":
                handleSessionId(content);
                break;
            case "stream_start":
                handleStreamStart();
                break;
            case "stream_end":
                handleStreamEnd();
                break;
            case "block_reset":
                handleBlockReset();
                break;
            case "content_delta":
            case "content":
                handleContentDelta(content);
                break;
            case "thinking":
                handleThinking();
                break;
            case "thinking_delta":
                handleThinkingDelta(content);
                break;
            case "tool_result":
                handleToolResult(content);
                break;
            case "usage":
                handleUsage(content);
                break;
            case "status":
                if (content != null && !content.trim().isEmpty()) {
                    callbackHandler.notifyStatusMessage(content);
                }
                break;
            case "message_start":
                // lifecycle marker; stream_start drives UI
                break;
            case "message_end":
                handleMessageEnd();
                break;
            default:
                LOG.debug("GeminiMessageHandler: Unhandled message type: " + type);
        }
    }

    @Override
    public void onError(String error) {
        boolean wasStreaming = isStreaming;
        isStreaming = false;
        streamEndedThisTurn = false;
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);

        // Always end stream so tool cards / loading state finalize
        callbackHandler.notifyStreamEnd();
        callbackHandler.notifyMessageUpdate(state.getMessages());
        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    @Override
    public void onComplete(SDKResult result) {
        boolean streamEndedBeforeComplete = streamEndedThisTurn;
        boolean wasStreaming = isStreaming;

        isStreaming = false;
        streamEndedThisTurn = false;
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();

        if (wasStreaming && !streamEndedBeforeComplete) {
            LOG.warn("Gemini onComplete called without prior stream_end; forcing stream cleanup");
            callbackHandler.notifyMessageUpdate(state.getMessages());
            callbackHandler.notifyStreamEnd();
        }

        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    // ===== Private handlers =====

    private void handleAssistantMessage(String jsonContent) {
        try {
            JsonObject msgJson = gson.fromJson(jsonContent, JsonObject.class);
            if (msgJson == null) {
                return;
            }

            // tool_use blocks: keep raw structure for UI tool cards
            boolean hasToolUse = hasToolUseBlocks(msgJson);

            Message parsed = parseAssistantMessage(msgJson);
            if (parsed == null) {
                return;
            }

            Message target = resolveAssistantMessageForStream();
            // Merge raw when possible (preserve existing tool_use blocks)
            if (target.raw != null && (hasToolUse || hasToolUseBlocks(target.raw))) {
                target.raw = mergeAssistantRaw(target.raw, msgJson);
            } else {
                target.raw = parsed.raw;
            }
            if (parsed.content != null && !parsed.content.isEmpty()) {
                if (!isStreaming || parsed.content.length() >= assistantContent.length()) {
                    target.content = parsed.content;
                    assistantContent.setLength(0);
                    assistantContent.append(parsed.content);
                }
            }
            // Structural changes (tool_use) must refresh UI even during streaming
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } catch (Exception e) {
            LOG.warn("Failed to parse Gemini assistant message: " + e.getMessage());
        }
    }

    private void handleUserMessage(String jsonContent) {
        try {
            JsonObject msgJson = gson.fromJson(jsonContent, JsonObject.class);
            if (msgJson == null) {
                return;
            }

            if (hasToolResult(msgJson)) {
                Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", msgJson);
                state.addMessage(toolResultMessage);
                callbackHandler.notifyMessageUpdate(state.getMessages());
                return;
            }

            // Live user text is owned by SessionSendService at send-time. ACP/user echoes
            // must NOT addMessage again — that re-appends the user's first message after
            // the assistant and glues turns in the UI. Mirror Claude: patch existing only.
            String userText = extractText(msgJson);
            if (userText == null || userText.isEmpty()) {
                LOG.debug("Gemini user message has no text; skipping");
                return;
            }

            List<Message> messages = state.getMessagesReference();
            for (int i = messages.size() - 1; i >= 0; i--) {
                Message msg = messages.get(i);
                if (msg.type != Message.Type.USER) {
                    continue;
                }
                if (userText.equals(msg.content)) {
                    if (msg.raw == null) {
                        msg.raw = msgJson;
                    }
                    LOG.debug("Gemini user message matched existing send-time bubble; not duplicating");
                    callbackHandler.notifyMessageUpdate(state.getMessages());
                    return;
                }
            }
            // No matching send-time bubble (edge path). Still avoid inventing a trailing
            // user after an assistant mid-conversation — the webview optimistic path
            // owns display until SessionSendService persists the message.
            LOG.debug("Gemini user message with no matching state entry; not adding to avoid duplicate bubble");
        } catch (Exception e) {
            LOG.warn("Failed to parse Gemini user message: " + e.getMessage());
        }
    }

    private void handleResultMessage(String jsonContent) {
        if (jsonContent == null || !jsonContent.startsWith("{")) {
            return;
        }
        try {
            JsonObject resultJson = gson.fromJson(jsonContent, JsonObject.class);
            if (resultJson == null) {
                return;
            }
            if (resultJson.has("usage") && resultJson.get("usage").isJsonObject()) {
                JsonObject usage = resultJson.getAsJsonObject("usage");
                if (currentAssistantMessage != null) {
                    if (currentAssistantMessage.raw == null) {
                        currentAssistantMessage.raw = new JsonObject();
                    }
                    // Per-turn display (MessageItem) reads turnUsage; status bar uses context extract.
                    currentAssistantMessage.raw.add("turnUsage", usage.deepCopy());
                    ensureAssistantRaw();
                    JsonObject message = currentAssistantMessage.raw.has("message")
                            && currentAssistantMessage.raw.get("message").isJsonObject()
                            ? currentAssistantMessage.raw.getAsJsonObject("message")
                            : new JsonObject();
                    message.add("usage", usage.deepCopy());
                    currentAssistantMessage.raw.add("message", message);
                }
                // Final result is authoritative for the turn context occupancy.
                applyContextUsage(usage, true);
                callbackHandler.notifyMessageUpdate(state.getMessages());
            }
        } catch (Exception e) {
            LOG.debug("Gemini result parse skipped: " + e.getMessage());
        }
    }

    private void handleSessionId(String id) {
        if (id != null && !id.trim().isEmpty()) {
            state.setSessionId(id.trim());
            callbackHandler.notifySessionIdReceived(id.trim());
            LOG.info("Captured Gemini session ID: " + id.trim());
        }
    }

    private void handleStreamStart() {
        isStreaming = true;
        streamEndedThisTurn = false;
        peakContextTokens = 0;
        resetStreamingAccumulator();
        callbackHandler.notifyStreamStart();
    }

    private void handleStreamEnd() {
        streamEndedThisTurn = true;
        isStreaming = false;
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStreamEnd();
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    private void handleBlockReset() {
        // New structural segment after tools — clear delta accumulator for next text block
        assistantContent.setLength(0);
        currentAssistantMessage = null;
        try {
            callbackHandler.notifyBlockReset();
        } catch (Exception e) {
            LOG.debug("notifyBlockReset not available or failed: " + e.getMessage());
        }
    }

    private void handleContentDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        assistantContent.append(content);

        Message target = resolveAssistantMessageForStream();
        target.content = assistantContent.toString();
        callbackHandler.notifyContentDelta(content);
        if (!isStreaming) {
            callbackHandler.notifyMessageUpdate(state.getMessages());
        }
    }

    private void handleThinking() {
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
        }
    }

    private void handleThinkingDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
        }
        ensureAssistantRaw();
        appendThinkingToRaw(content);
        try {
            callbackHandler.notifyThinkingDelta(content);
        } catch (Exception e) {
            LOG.debug("notifyThinkingDelta failed: " + e.getMessage());
        }
        callbackHandler.notifyMessageUpdate(state.getMessages());
    }

    private void handleToolResult(String content) {
        if (content == null || !content.startsWith("{")) {
            return;
        }
        try {
            JsonObject toolResultBlock = gson.fromJson(content, JsonObject.class);
            String toolUseId = toolResultBlock.has("tool_use_id")
                    ? toolResultBlock.get("tool_use_id").getAsString()
                    : null;
            if (toolUseId == null) {
                return;
            }

            JsonArray contentArray = new JsonArray();
            contentArray.add(toolResultBlock);
            JsonObject messageObj = new JsonObject();
            messageObj.add("content", contentArray);
            JsonObject rawUser = new JsonObject();
            rawUser.addProperty("type", "user");
            rawUser.add("message", messageObj);

            Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", rawUser);
            state.addMessage(toolResultMessage);
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } catch (Exception e) {
            LOG.warn("Failed to parse Gemini tool_result: " + e.getMessage());
        }
    }

    private void handleUsage(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        try {
            JsonObject usage = gson.fromJson(content, JsonObject.class);
            if (usage == null) {
                return;
            }
            // Intermediate step usage (agy checkpoint rows are tiny) must not replace a larger peak.
            if (!applyContextUsage(usage, false)) {
                return;
            }
            ensureAssistantRaw();
            JsonObject message = currentAssistantMessage.raw.has("message")
                    && currentAssistantMessage.raw.get("message").isJsonObject()
                    ? currentAssistantMessage.raw.getAsJsonObject("message")
                    : new JsonObject();
            message.add("usage", usage);
            currentAssistantMessage.raw.add("message", message);
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } catch (Exception e) {
            LOG.debug("Gemini usage parse skipped: " + e.getMessage());
        }
    }

    /**
     * Push context occupancy to the status bar.
     * Uses input (+ cache) only — never total_tokens (includes output).
     *
     * @param authoritative when true, always apply (final result); when false, ignore regressions
     * @return true if applied
     */
    private boolean applyContextUsage(JsonObject usage, boolean authoritative) {
        if (usage == null) {
            return false;
        }
        int used = TokenUsageUtils.extractContextTokens(usage, "gemini");
        if (used <= 0) {
            return false;
        }
        if (!authoritative && used < peakContextTokens) {
            return false;
        }
        if (used > peakContextTokens) {
            peakContextTokens = used;
        }
        int maxTokens = SettingsHandler.getModelContextLimit(state.getProvider(), state.getModel());
        int effectiveUsed = maxTokens > 0 ? Math.min(used, maxTokens) : used;
        if (project != null) {
            ClaudeNotifier.setTokenUsage(project, effectiveUsed, maxTokens);
        }
        callbackHandler.notifyUsageUpdate(effectiveUsed, maxTokens);
        return true;
    }

    private void handleMessageEnd() {
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
    }

    private Message parseAssistantMessage(JsonObject msg) {
        String text = extractText(msg);
        Message m = new Message(Message.Type.ASSISTANT, text != null ? text : "");
        m.raw = msg;
        return m;
    }

    private String extractText(JsonObject msg) {
        if (msg == null) {
            return "";
        }
        try {
            if (msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("content")) {
                    com.google.gson.JsonElement c = message.get("content");
                    if (c.isJsonArray()) {
                        StringBuilder sb = new StringBuilder();
                        for (com.google.gson.JsonElement el : c.getAsJsonArray()) {
                            if (el.isJsonObject()) {
                                JsonObject b = el.getAsJsonObject();
                                if (b.has("text")) {
                                    sb.append(b.get("text").getAsString());
                                }
                            }
                        }
                        return sb.toString();
                    } else if (c.isJsonPrimitive()) {
                        return c.getAsString();
                    }
                }
            }
            if (msg.has("content") && msg.get("content").isJsonPrimitive()) {
                return msg.get("content").getAsString();
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    private boolean hasToolUseBlocks(JsonObject msg) {
        try {
            if (msg != null && msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("content") && message.get("content").isJsonArray()) {
                    for (com.google.gson.JsonElement el : message.getAsJsonArray("content")) {
                        if (el.isJsonObject() && el.getAsJsonObject().has("type")) {
                            if ("tool_use".equals(el.getAsJsonObject().get("type").getAsString())) {
                                return true;
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private boolean hasToolResult(JsonObject msg) {
        try {
            if (msg != null && msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("content") && message.get("content").isJsonArray()) {
                    for (com.google.gson.JsonElement el : message.getAsJsonArray("content")) {
                        if (el.isJsonObject() && el.getAsJsonObject().has("type")) {
                            if ("tool_result".equals(el.getAsJsonObject().get("type").getAsString())) {
                                return true;
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private JsonObject mergeAssistantRaw(JsonObject previous, JsonObject incoming) {
        // Merge content blocks from incoming into previous without duplicating tool_use blocks
        try {
            JsonObject prevMsg = previous.has("message") && previous.get("message").isJsonObject()
                    ? previous.getAsJsonObject("message")
                    : new JsonObject();
            JsonArray prevContent = prevMsg.has("content") && prevMsg.get("content").isJsonArray()
                    ? prevMsg.getAsJsonArray("content")
                    : new JsonArray();

            if (incoming.has("message") && incoming.get("message").isJsonObject()) {
                JsonObject inMsg = incoming.getAsJsonObject("message");
                if (inMsg.has("content") && inMsg.get("content").isJsonArray()) {
                    for (com.google.gson.JsonElement el : inMsg.getAsJsonArray("content")) {
                        if (!el.isJsonObject()) {
                            continue;
                        }
                        JsonObject incomingBlock = el.getAsJsonObject();
                        String type = incomingBlock.has("type") ? incomingBlock.get("type").getAsString() : "";
                        String id = incomingBlock.has("id") ? incomingBlock.get("id").getAsString() : "";

                        if ("tool_use".equals(type)) {
                            boolean exists = false;
                            if (!id.isEmpty()) {
                                for (com.google.gson.JsonElement prevEl : prevContent) {
                                    if (prevEl.isJsonObject()) {
                                        JsonObject p = prevEl.getAsJsonObject();
                                        if ("tool_use".equals(p.has("type") ? p.get("type").getAsString() : "")
                                                && id.equals(p.has("id") ? p.get("id").getAsString() : "")) {
                                            exists = true;
                                            break;
                                        }
                                    }
                                }
                            }
                            if (!exists) {
                                prevContent.add(incomingBlock.deepCopy());
                            }
                        } else if ("text".equals(type)) {
                            boolean textBlockFound = false;
                            for (com.google.gson.JsonElement prevEl : prevContent) {
                                if (prevEl.isJsonObject() && "text".equals(prevEl.getAsJsonObject().has("type") ? prevEl.getAsJsonObject().get("type").getAsString() : "")) {
                                    if (incomingBlock.has("text")) {
                                        prevEl.getAsJsonObject().addProperty("text", incomingBlock.get("text").getAsString());
                                    }
                                    textBlockFound = true;
                                    break;
                                }
                            }
                            if (!textBlockFound) {
                                prevContent.add(incomingBlock.deepCopy());
                            }
                        } else {
                            prevContent.add(incomingBlock.deepCopy());
                        }
                    }
                }
            }
            prevMsg.add("content", prevContent);
            previous.add("message", prevMsg);
            return previous;
        } catch (Exception e) {
            return incoming;
        }
    }

    private void ensureAssistantRaw() {
        Message target = resolveAssistantMessageForStream();
        if (target.raw == null) {
            JsonObject raw = new JsonObject();
            raw.addProperty("type", "assistant");
            JsonObject messageObj = new JsonObject();
            messageObj.add("content", new JsonArray());
            raw.add("message", messageObj);
            target.raw = raw;
        }
    }

    /**
     * Resolve the assistant bubble for the current stream. Always creates a new
     * message on the first call after {@code stream_start} instead of reusing a
     * completed previous-turn assistant (see {@link #assistantMessageForCurrentStream}).
     */
    private Message resolveAssistantMessageForStream() {
        if (currentAssistantMessage != null) {
            return currentAssistantMessage;
        }
        if (assistantMessageForCurrentStream != null) {
            currentAssistantMessage = assistantMessageForCurrentStream;
            return currentAssistantMessage;
        }
        Message created = new Message(Message.Type.ASSISTANT, assistantContent.toString());
        state.addMessage(created);
        currentAssistantMessage = created;
        assistantMessageForCurrentStream = created;
        return created;
    }

    private void appendThinkingToRaw(String delta) {
        ensureAssistantRaw();
        JsonObject raw = currentAssistantMessage.raw;
        JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message")
                : new JsonObject();
        JsonArray content = message.has("content") && message.get("content").isJsonArray()
                ? message.getAsJsonArray("content")
                : new JsonArray();

        JsonObject thinkingBlock = null;
        for (int i = content.size() - 1; i >= 0; i--) {
            com.google.gson.JsonElement el = content.get(i);
            if (el.isJsonObject() && el.getAsJsonObject().has("type")
                    && "thinking".equals(el.getAsJsonObject().get("type").getAsString())) {
                thinkingBlock = el.getAsJsonObject();
                break;
            }
        }
        if (thinkingBlock == null) {
            thinkingBlock = new JsonObject();
            thinkingBlock.addProperty("type", "thinking");
            thinkingBlock.addProperty("thinking", delta);
            content.add(thinkingBlock);
        } else {
            String prev = thinkingBlock.has("thinking") ? thinkingBlock.get("thinking").getAsString() : "";
            thinkingBlock.addProperty("thinking", prev + delta);
        }
        message.add("content", content);
        raw.add("message", message);
    }

    private void resetStreamingAccumulator() {
        assistantContent.setLength(0);
        currentAssistantMessage = null;
        assistantMessageForCurrentStream = null;
    }
}
