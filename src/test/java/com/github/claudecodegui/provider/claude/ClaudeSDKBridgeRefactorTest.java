package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeSDKBridgeRefactorTest {

    @Test
    public void sanitizerRedactsCommonSecretsWithoutTouchingShortValues() {
        ClaudeLogSanitizer sanitizer = new ClaudeLogSanitizer();

        String sanitized = sanitizer.sanitizeSensitiveData(
                "{\"apiKey\":\"secret-value-123456\",\"token\":\"abcdefghi\",\"password\":\"hunter2\",\"note\":\"safe\"}"
        );

        assertTrue(sanitized.contains("apiKey: [REDACTED]"));
        assertTrue(sanitized.contains("token: [REDACTED]"));
        assertTrue(sanitized.contains("\"password\":\"hunter2\""));
        assertTrue(sanitized.contains("\"note\":\"safe\""));
    }

    @Test
    public void requestBuilderIncludesOptionalFieldsAndSkipsNullAttachments() {
        ClaudeRequestParamsBuilder builder = new ClaudeRequestParamsBuilder(new Gson());
        List<ClaudeSession.Attachment> attachments = new ArrayList<>();
        attachments.add(createAttachment("image.png", "image/png", "base64-image"));
        attachments.add(null);

        JsonObject openedFiles = new JsonObject();
        openedFiles.addProperty("/tmp/demo.txt", "demo");

        JsonObject params = builder.buildSendParams(
                "hello",
                "session-1",
                "epoch-1",
                "/workspace",
                "acceptEdits",
                "claude-sonnet-4-6",
                attachments,
                openedFiles,
                "system prompt",
                Boolean.TRUE,
                Boolean.TRUE,
                "xhigh"
        );

        assertEquals("hello", params.get("message").getAsString());
        assertEquals("session-1", params.get("sessionId").getAsString());
        assertEquals("epoch-1", params.get("runtimeSessionEpoch").getAsString());
        assertEquals("/workspace", params.get("cwd").getAsString());
        assertEquals("acceptEdits", params.get("permissionMode").getAsString());
        assertEquals("claude-sonnet-4-6", params.get("model").getAsString());
        assertEquals("system prompt", params.get("agentPrompt").getAsString());
        assertTrue(params.get("streaming").getAsBoolean());
        assertTrue(params.get("disableThinking").getAsBoolean());
        assertEquals("xhigh", params.get("reasoningEffort").getAsString());
        assertTrue(params.has("attachments"));
        assertEquals(1, params.getAsJsonArray("attachments").size());
        assertEquals("image.png", params.getAsJsonArray("attachments").get(0).getAsJsonObject().get("fileName").getAsString());
        assertTrue(params.has("openedFiles"));
    }

    @Test
    public void requestBuilderOmitsAttachmentsWhenAllEntriesAreNull() {
        ClaudeRequestParamsBuilder builder = new ClaudeRequestParamsBuilder(new Gson());
        List<ClaudeSession.Attachment> attachments = new ArrayList<>();
        attachments.add(null);

        JsonObject params = builder.buildSendParams(
                "hello",
                null,
                null,
                null,
                null,
                null,
                attachments,
                null,
                null,
                null,
                null,
                null
        );

        assertFalse(params.has("attachments"));
        assertEquals("", params.get("sessionId").getAsString());
        assertEquals("", params.get("cwd").getAsString());
    }

    @Test
    public void streamAdapterRoutesMessageAndDeltaLines() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        AtomicBoolean hadSendError = new AtomicBoolean(false);
        AtomicReference<String> lastNodeError = new AtomicReference<>(null);
        AtomicBoolean wasAborted = new AtomicBoolean(false);

        adapter.processOutputLine("[MESSAGE] {\"type\":\"assistant\",\"content\":\"ignored\"}", callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processOutputLine("[CONTENT_DELTA] \"Hello\\nWorld\"", callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processOutputLine("[THINKING_DELTA] \"reasoning\"", callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);
        adapter.processOutputLine("[SESSION_ID] session-123", callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);

        assertEquals(1, result.messages.size());
        assertEquals("assistant", callback.events.get(0).type);
        assertEquals("content_delta", callback.events.get(1).type);
        assertEquals("Hello\nWorld", callback.events.get(1).payload);
        assertEquals("thinking_delta", callback.events.get(2).type);
        assertEquals("reasoning", callback.events.get(2).payload);
        assertEquals("session_id", callback.events.get(3).type);
        assertEquals("Hello\nWorld", assistantContent.toString());
        assertFalse(hadSendError.get());
        assertEquals(null, lastNodeError.get());
    }

    @Test
    public void streamAdapterMarksSendErrorsAndPreservesParsedMessage() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        AtomicBoolean hadSendError = new AtomicBoolean(false);
        AtomicReference<String> lastNodeError = new AtomicReference<>(null);
        AtomicBoolean wasAborted = new AtomicBoolean(false);

        adapter.processOutputLine("[SEND_ERROR] {\"error\":\"boom\"}", callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);

        assertTrue(hadSendError.get());
        assertFalse(result.success);
        assertEquals("boom", result.error);
        assertEquals(1, callback.errors.size());
        assertEquals("boom", callback.errors.get(0));
    }

    @Test
    public void streamAdapterSuppressesSendErrorAfterUserAbort() {
        ClaudeStreamAdapter adapter = new ClaudeStreamAdapter(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        AtomicBoolean hadSendError = new AtomicBoolean(false);
        AtomicReference<String> lastNodeError = new AtomicReference<>(null);
        AtomicBoolean wasAborted = new AtomicBoolean(true);

        adapter.processOutputLine("[SEND_ERROR] {\"error\":\"Request aborted by user\"}", callback, result, assistantContent, hadSendError, lastNodeError, wasAborted);

        assertFalse(hadSendError.get());
        assertEquals(null, result.error);
        assertTrue(callback.errors.isEmpty());
    }

    @Test
    public void daemonExecutorCompletesGracefullyOnUserAbort() throws Exception {
        Gson gson = new Gson();
        ClaudeDaemonRequestExecutor executor = new ClaudeDaemonRequestExecutor(
                com.intellij.openapi.diagnostic.Logger.getInstance(ClaudeDaemonRequestExecutor.class),
                new ClaudeRequestParamsBuilder(gson),
                new ClaudeStreamAdapter(gson),
                new ClaudeJsonOutputExtractor()
        );
        RecordingCallback callback = new RecordingCallback();

        SDKResult result = executor.sendMessageViaDaemon(
                new AbortingDaemonBridge(),
                "channel-1",
                "hello",
                null,
                null,
                "/workspace",
                null,
                "default",
                "claude-sonnet-4-6",
                null,
                null,
                Boolean.TRUE,
                null,
                null,
                callback
        ).get();

        assertFalse(result.success);
        assertEquals("User interrupted", result.error);
        assertEquals(1, callback.completions.size());
        assertTrue(callback.errors.isEmpty());
    }

    @Test
    public void jsonOutputExtractorFindsLastJsonLineAfterLogs() {
        ClaudeJsonOutputExtractor extractor = new ClaudeJsonOutputExtractor();

        String json = extractor.extractLastJsonLine("debug line\nanother log\n{\"success\":true,\"value\":1}");

        assertEquals("{\"success\":true,\"value\":1}", json);
    }

    @Test
    public void jsonOutputExtractorPrefersNestedCauseMessage() {
        ClaudeJsonOutputExtractor extractor = new ClaudeJsonOutputExtractor();

        String message = extractor.extractErrorMessage(new RuntimeException("", new IllegalStateException("boom")));

        assertEquals("boom", message);
    }

    private ClaudeSession.Attachment createAttachment(String fileName, String mediaType, String data) {
        return new ClaudeSession.Attachment(fileName, mediaType, data);
    }

    private static class RecordingCallback implements MessageCallback {
        private final List<Event> events = new ArrayList<>();
        private final List<String> errors = new ArrayList<>();
        private final List<SDKResult> completions = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
            events.add(new Event(type, content));
        }

        @Override
        public void onError(String error) {
            errors.add(error);
        }

        @Override
        public void onComplete(SDKResult result) {
            completions.add(result);
        }
    }

    private static class AbortingDaemonBridge extends DaemonBridge {
        AbortingDaemonBridge() {
            super(null, null, null);
        }

        @Override
        public CompletableFuture<Boolean> sendCommand(
                String method,
                JsonObject params,
                DaemonOutputCallback callback
        ) {
            callback.onAbort();
            return CompletableFuture.completedFuture(false);
        }

        // Production send path routes Agent sends through sendCommandChecked
        // (Phase 2C-C.1 pre-launch abort); the fake must override it the same way.
        @Override
        public CompletableFuture<Boolean> sendCommandChecked(
                String method,
                JsonObject params,
                DaemonOutputCallback callback
        ) {
            callback.onAbort();
            return CompletableFuture.completedFuture(false);
        }

        @Override
        public boolean isAlive() {
            return true;
        }
    }

    private static class Event {
        private final String type;
        private final String payload;

        private Event(String type, String payload) {
            this.type = type;
            this.payload = payload;
        }
    }
}
