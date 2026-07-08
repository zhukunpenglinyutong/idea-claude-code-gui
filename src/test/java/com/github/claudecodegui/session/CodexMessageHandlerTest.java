package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.permission.PermissionRequest;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

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
        // Status-bar channel keeps the cache-inclusive usage untouched
        assertEquals(37000, message.raw.getAsJsonObject("usage").get("input_tokens").getAsInt());
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

    @Test
    public void tokenCountEventAttachesStatusBarUsageButNeverTurnUsage() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        // token_count carries session-cumulative totals, not turn totals
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"total_token_usage\":{\"input_tokens\":500000,\"output_tokens\":9000,\"cached_input_tokens\":480000}}}}");

        Message message = state.getMessages().get(0);
        assertEquals(500000, message.raw.getAsJsonObject("usage").get("input_tokens").getAsInt());
        assertFalse(message.raw.has("turnUsage"));
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
