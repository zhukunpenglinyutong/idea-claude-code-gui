package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.permission.PermissionRequest;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for translating Codex bridge events into provider-neutral session state.
 */
public class CodexMessageHandlerTest {

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        int streamStartCount = 0;
        int streamEndCount = 0;
        int stateChangeCount = 0;
        int messageUpdateCount = 0;
        boolean lastLoading = false;
        boolean lastBusy = false;
        final List<String> contentDeltas = new ArrayList<>();
        final List<String> thinkingDeltas = new ArrayList<>();
        final List<Message> lastMessages = new ArrayList<>();
        // Records the relative order of stream-end vs message-update callbacks so a
        // test can assert stream-end fires BEFORE the error snapshot is pushed.
        final List<String> callOrder = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageUpdateCount++;
            callOrder.add("messageUpdate");
            lastMessages.clear();
            lastMessages.addAll(messages);
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            stateChangeCount++;
            lastBusy = busy;
            lastLoading = loading;
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
        }

        @Override
        public void onPermissionRequested(PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
        }

        @Override
        public void onNodeLog(String log) {
        }

        @Override
        public void onSummaryReceived(String summary) {
        }

        @Override
        public void onStreamStart() {
            streamStartCount++;
        }

        @Override
        public void onStreamEnd() {
            streamEndCount++;
            callOrder.add("streamEnd");
        }

        @Override
        public void onContentDelta(String delta) {
            contentDeltas.add(delta);
        }

        @Override
        public void onThinkingDelta(String delta) {
            thinkingDeltas.add(delta);
        }
    }

    @Test
    public void streamMarkersDriveStandardStreamingLifecycle() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "done");
        handler.onMessage("stream_end", "");

        assertEquals(1, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertTrue(callback.messageUpdateCount >= 2);
        assertEquals("done", callback.lastMessages.get(callback.lastMessages.size() - 1).content);
    }

    @Test
    public void contentDeltaIsForwardedToFrontendStreamingCallback() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "hello");
        handler.onMessage("content_delta", " world");

        assertEquals(List.of("hello", " world"), callback.contentDeltas);
        assertEquals("hello world", state.getMessages().get(0).content);
    }

    @Test
    public void finalAssistantMessageReusesStreamingPlaceholderInsteadOfAppendingDuplicate() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "收到，测试正常。");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"收到，测试正常。\"}]}}");

        assertEquals(1, state.getMessages().size());
        assertEquals("收到，测试正常。", state.getMessages().get(0).content);
        assertTrue(state.getMessages().get(0).raw != null);
    }

    @Test
    public void thinkingDeltaIsForwardedAndPreservedWhenFinalTextSnapshotArrives() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking_delta", "先分析");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"先分析\",\"text\":\"先分析\"}]}}");
        handler.onMessage("content_delta", "结论");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"结论\"}]}}");

        assertEquals(List.of("先分析"), callback.thinkingDeltas);
        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals("结论", message.content);
        var blocks = message.raw.getAsJsonObject("message").getAsJsonArray("content");
        assertEquals("thinking", blocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("先分析", blocks.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("text", blocks.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("结论", blocks.get(1).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void userMessageStripsCodexInjectedInstructionsFromContentAndRawBlocks() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\","
                + "\"text\":\"<agents-instructions>\\n# AGENTS.md instructions\\n"
                + "<INSTRUCTIONS>中文回复</INSTRUCTIONS>\\n</agents-instructions>\\n\\n测试通讯\"}]}}");

        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals("测试通讯", message.content);
        assertEquals("测试通讯", message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject()
                .get("text")
                .getAsString());
    }

    @Test
    public void userMessageWithOnlyCodexInjectedInstructionsIsFiltered() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<agents-instructions>\\n# AGENTS.md instructions\\n</agents-instructions>\"}]}}");

        assertEquals(0, state.getMessages().size());
        assertEquals(0, callback.messageUpdateCount);
    }

    @Test
    public void userMessageWithOnlySkillMetadataIsFiltered() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\","
                + "\"text\":\"<skill>\\n<name>autopilot</name>\\n<path>/tmp/SKILL.md</path>\\n</skill>\"}]}}");

        assertEquals(0, state.getMessages().size());
        assertEquals(0, callback.messageUpdateCount);
    }

    @Test
    public void userMessageStripsCodexImagePlaceholderFromContentAndRawBlocks() throws Exception {
        Path imagePath = Files.createTempFile("codex-live-image", ".png");
        Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));
        SessionState state = new SessionState();

        try {
            CallbackHandler callbackHandler = new CallbackHandler();
            RecordingCallback callback = new RecordingCallback();
            callbackHandler.setCallback(callback);

            CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", "<image name=[Image #1] path=\"" + imagePath
                    + "\">\n</image>\n\n测试通讯");
            JsonArray inputBlocks = new JsonArray();
            inputBlocks.add(textBlock);
            JsonObject inputMessage = new JsonObject();
            inputMessage.addProperty("role", "user");
            inputMessage.add("content", inputBlocks);
            JsonObject payload = new JsonObject();
            payload.add("message", inputMessage);
            handler.onMessage("user", payload.toString());

            assertEquals(1, state.getMessages().size());
            Message message = state.getMessages().get(0);
            assertEquals("测试通讯", message.content);
            JsonArray contentBlocks = message.raw
                    .getAsJsonObject("message")
                    .getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
            assertEquals("测试通讯", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void onCompleteFinalizesStreamingTurnWhenStreamEndIsMissing() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial");
        handler.onComplete(new SDKResult());

        assertEquals(1, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertFalse(callback.lastBusy);
        assertFalse(callback.lastLoading);
    }

    @Test
    public void streamEndFinalizesTurnEvenWhenStreamStartIsMissing() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("stream_end", "");

        assertEquals(0, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertFalse(callback.lastBusy);
        assertFalse(callback.lastLoading);
    }

    @Test
    public void onCompleteWithoutStreamingOnlyClearsState() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onComplete(new SDKResult());

        assertEquals(0, callback.streamStartCount);
        assertEquals(0, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertFalse(callback.lastBusy);
        assertFalse(callback.lastLoading);
    }

    /**
     * Verifies that result usage remains available for per-turn accounting without
     * being promoted to an untrusted current-context snapshot.
     */
    @Test
    public void resultMessageStampsNormalizedTurnUsageOnLastAssistant() {
        SessionState state = new SessionState();
        state.setModel("gpt-5.1");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        // ai-bridge Claude-compatible usage: input_tokens INCLUDE cached tokens (OpenAI convention)
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":37000,\"output_tokens\":353,"
                + "\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":36310}}");

        Message message = state.getMessages().get(0);
        assertFalse(message.raw.has("usage"));
        // turnUsage is normalized to the Claude schema: input excludes cache
        var turnUsage = message.raw.getAsJsonObject("turnUsage");
        assertEquals(690, turnUsage.get("input_tokens").getAsInt());
        assertEquals(36310, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(0, turnUsage.get("cache_creation_input_tokens").getAsInt());
        assertEquals(353, turnUsage.get("output_tokens").getAsInt());
        assertEquals(0.00893125, message.raw.get("turnCostUsd").getAsDouble(), 0.0000001);
    }

    @Test
    public void resultMessageAcceptsCodexCachedInputTokenAlias() {
        SessionState state = new SessionState();
        state.setModel("gpt-5.1");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":37000,\"output_tokens\":353,\"cached_input_tokens\":36310}}");

        Message message = state.getMessages().get(0);
        var turnUsage = message.raw.getAsJsonObject("turnUsage");
        assertEquals(690, turnUsage.get("input_tokens").getAsInt());
        assertEquals(36310, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(0.00893125, message.raw.get("turnCostUsd").getAsDouble(), 0.0000001);
    }

    @Test
    public void resultMessageDoesNotStampTurnCostWhenModelHasNoPricing() {
        SessionState state = new SessionState();
        state.setModel("custom-codex-without-pricing");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":1200,\"output_tokens\":456}}");

        Message message = state.getMessages().get(0);
        assertTrue(message.raw.has("turnUsage"));
        assertFalse(message.raw.has("turnCostUsd"));
    }

    /**
     * Verifies that token_count uses the current-context last_token_usage snapshot,
     * preserves the provider-reported context window, and remains excluded from
     * per-turn usage accounting.
     */
    @Test
    public void tokenCountEventAttachesStatusBarUsageButNeverTurnUsage() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"total_token_usage\":{\"input_tokens\":500000,\"output_tokens\":9000,\"cached_input_tokens\":480000},"
                + "\"last_token_usage\":{\"input_tokens\":18000,\"output_tokens\":400,\"cached_input_tokens\":16000},"
                + "\"model_context_window\":258400}}}");

        Message message = state.getMessages().get(0);
        assertEquals(18000, message.raw.getAsJsonObject("usage").get("input_tokens").getAsInt());
        assertEquals(258400, message.raw.getAsJsonObject("usage").get("model_context_window").getAsInt());
        assertFalse(message.raw.has("turnUsage"));
    }

    /**
     * Verifies that older token_count payloads without last_token_usage continue
     * to use total_token_usage as a best-effort context-display fallback.
     */
    @Test
    public void tokenCountEventFallsBackToTotalUsageForOlderPayloads() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"total_token_usage\":{\"input_tokens\":500000,\"output_tokens\":9000,\"cached_input_tokens\":480000}}}}");

        Message message = state.getMessages().get(0);
        assertEquals(500000, message.raw.getAsJsonObject("usage").get("input_tokens").getAsInt());
        assertEquals(9000, message.raw.getAsJsonObject("usage").get("output_tokens").getAsInt());
        assertFalse(message.raw.has("turnUsage"));
    }

    /**
     * Verifies that a later turn.completed result retains per-turn accounting without
     * overwriting the precise current-context snapshot received from token_count.
     */
    @Test
    public void resultMessageDoesNotOverwriteTokenCountContextSnapshot() {
        SessionState state = new SessionState();
        state.setModel("gpt-5.1");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"last_token_usage\":{\"input_tokens\":18000,\"output_tokens\":400,\"cached_input_tokens\":16000},"
                + "\"model_context_window\":258400}}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":37000,\"output_tokens\":353,\"cached_input_tokens\":36310}}");

        Message message = state.getMessages().get(0);
        JsonObject contextUsage = message.raw.getAsJsonObject("usage");
        assertEquals(18000, contextUsage.get("input_tokens").getAsInt());
        assertEquals(258400, contextUsage.get("model_context_window").getAsInt());
        JsonObject turnUsage = message.raw.getAsJsonObject("turnUsage");
        assertEquals(690, turnUsage.get("input_tokens").getAsInt());
        assertEquals(36310, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(353, turnUsage.get("output_tokens").getAsInt());
        assertTrue(message.raw.has("turnCostUsd"));
    }

    /**
     * Verifies that a token_count arriving before the assistant message is retained
     * and applied when turn.completed later provides the per-turn usage.
     */
    @Test
    public void tokenCountBeforeAssistantIsAppliedWhenResultArrives() {
        SessionState state = new SessionState();
        state.setModel("gpt-5.1");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"last_token_usage\":{\"input_tokens\":49060,\"output_tokens\":231,\"cached_input_tokens\":46848},"
                + "\"model_context_window\":258400}}}");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":120000,\"output_tokens\":2000,\"cached_input_tokens\":100000}}");

        Message message = state.getMessages().get(0);
        JsonObject contextUsage = message.raw.getAsJsonObject("usage");
        assertEquals(49060, contextUsage.get("input_tokens").getAsInt());
        assertEquals(231, contextUsage.get("output_tokens").getAsInt());
        assertEquals(258400, contextUsage.get("model_context_window").getAsInt());
        assertEquals(20000, message.raw.getAsJsonObject("turnUsage").get("input_tokens").getAsInt());
    }

    @Test
    public void messageEndDoesNotDuplicateStreamEndAfterNormalCompletion() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "answer");
        handler.onMessage("stream_end", "");
        handler.onMessage("message_end", "");

        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }

    @Test
    public void onErrorSignalsStreamEndBeforeErrorSnapshotWhileStreaming() {
        // Regression (PR #1421 symmetric fix): the webview's onStreamEnd cancels any
        // pending updateMessages rAF. If onError pushes the error snapshot BEFORE
        // stream-end, that cancellation drops it and the "API request failed" bubble
        // never renders. On a streaming turn, stream-end must fire first.
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial");

        handler.onError("API request failed");

        assertEquals(1, callback.streamEndCount);
        int streamEndIdx = callback.callOrder.indexOf("streamEnd");
        int lastUpdateIdx = callback.callOrder.lastIndexOf("messageUpdate");
        assertTrue("stream-end must precede the error-snapshot message update",
                streamEndIdx >= 0 && streamEndIdx < lastUpdateIdx);
        assertEquals(Message.Type.ERROR,
                callback.lastMessages.get(callback.lastMessages.size() - 1).type);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }

    @Test
    public void onErrorWithoutActiveStreamPushesErrorWithoutStreamEnd() {
        // A non-streaming Codex turn maps to the webview's 'minimal' stream-end mode,
        // which would only cancel pending updates without buying any dangling-tool
        // cleanup — so onError intentionally does NOT emit stream-end here. The error
        // snapshot is pushed directly and renders on its own.
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onError("API request failed");

        assertEquals(0, callback.streamEndCount);
        assertEquals(Message.Type.ERROR,
                callback.lastMessages.get(callback.lastMessages.size() - 1).type);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }
}
