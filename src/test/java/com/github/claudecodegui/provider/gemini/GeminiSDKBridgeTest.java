package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GeminiSDKBridgeTest {

    private static final class RecordingCallback implements MessageCallback {
        final List<String> types = new ArrayList<>();
        final List<String> contents = new ArrayList<>();
        String lastError = null;

        @Override
        public void onMessage(String type, String content) {
            types.add(type);
            contents.add(content == null ? "" : content);
        }

        @Override
        public void onError(String error) {
            lastError = error;
        }

        @Override
        public void onComplete(SDKResult result) {
        }
    }

    private static void feed(GeminiSDKBridge bridge, String line, MessageCallback cb, SDKResult result,
                             StringBuilder assistant, AtomicBoolean hadErr, AtomicReference<String> nodeErr)
            throws Exception {
        Method m = GeminiSDKBridge.class.getDeclaredMethod(
                "processOutputLine",
                String.class,
                MessageCallback.class,
                SDKResult.class,
                StringBuilder.class,
                AtomicBoolean.class,
                AtomicReference.class
        );
        m.setAccessible(true);
        m.invoke(bridge, line, cb, result, assistant, hadErr, nodeErr);
    }

    @Test
    public void processOutputLineMapsProtocolTags() throws Exception {
        GeminiSDKBridge bridge = new GeminiSDKBridge();
        RecordingCallback cb = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistant = new StringBuilder();
        AtomicBoolean hadErr = new AtomicBoolean(false);
        AtomicReference<String> nodeErr = new AtomicReference<>();

        feed(bridge, "[MESSAGE_START]", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[STREAM_START]", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[SESSION_ID] conv-99", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[CONTENT_DELTA] \"Hello\"", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[THINKING_DELTA] \"think\"", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[TOOL_RESULT] {\"type\":\"tool_result\"}", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[USAGE] {\"total_tokens\":42,\"input_tokens\":10,\"output_tokens\":32}", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[MESSAGE] {\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hello\"}]}}",
                cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[STREAM_END]", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[MESSAGE_END]", cb, result, assistant, hadErr, nodeErr);

        assertTrue(cb.types.contains("message_start"));
        assertTrue(cb.types.contains("stream_start"));
        assertTrue(cb.types.contains("session_id"));
        assertEquals("conv-99", cb.contents.get(cb.types.indexOf("session_id")));
        assertTrue(cb.types.contains("content_delta"));
        assertEquals("Hello", cb.contents.get(cb.types.indexOf("content_delta")));
        assertTrue(cb.types.contains("thinking_delta"));
        assertTrue(cb.types.contains("tool_result"));
        assertTrue(cb.types.contains("usage"));
        assertTrue(cb.types.contains("assistant"));
        assertTrue(cb.types.contains("stream_end"));
        assertTrue(cb.types.contains("message_end"));
        assertEquals("Hello", assistant.toString());
        assertFalse(hadErr.get());
    }

    @Test
    public void processOutputLineSendErrorSetsFailure() throws Exception {
        GeminiSDKBridge bridge = new GeminiSDKBridge();
        RecordingCallback cb = new RecordingCallback();
        SDKResult result = new SDKResult();
        result.success = true;
        StringBuilder assistant = new StringBuilder();
        AtomicBoolean hadErr = new AtomicBoolean(false);
        AtomicReference<String> nodeErr = new AtomicReference<>();

        feed(bridge, "[SEND_ERROR] {\"error\":\"authentication required\"}", cb, result, assistant, hadErr, nodeErr);

        assertTrue(hadErr.get());
        assertFalse(result.success);
        assertEquals("authentication required", result.error);
        assertEquals("authentication required", cb.lastError);
    }

    @Test
    public void processOutputLineIgnoresDebugLines() throws Exception {
        GeminiSDKBridge bridge = new GeminiSDKBridge();
        RecordingCallback cb = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistant = new StringBuilder();
        AtomicBoolean hadErr = new AtomicBoolean(false);
        AtomicReference<String> nodeErr = new AtomicReference<>();

        feed(bridge, "[DEBUG] noise", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[AGY] spawn ...", cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[DIAG-EXEC] start", cb, result, assistant, hadErr, nodeErr);

        assertTrue(cb.types.isEmpty());
    }

    @Test
    public void getContextUsageReturnsLocalSynthesis() throws Exception {
        GeminiSDKBridge bridge = new GeminiSDKBridge();
        RecordingCallback cb = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistant = new StringBuilder();
        AtomicBoolean hadErr = new AtomicBoolean(false);
        AtomicReference<String> nodeErr = new AtomicReference<>();

        feed(bridge, "[USAGE] {\"total_tokens\":1234,\"input_tokens\":1000,\"output_tokens\":234}",
                cb, result, assistant, hadErr, nodeErr);

        JsonObject usage = bridge.getContextUsage("sid", "/cwd", "gemini-3.5-flash-medium").get();
        assertTrue(usage.get("success").getAsBoolean());
        JsonObject data = usage.getAsJsonObject("data");
        // Context occupancy is input (+ cache), not total_tokens
        assertEquals(1000, data.get("usedTokens").getAsInt());
        assertEquals(1_000_000, data.get("maxTokens").getAsInt());
        assertEquals("gemini-3.5-flash-medium", data.get("model").getAsString());
        assertEquals("gemini-bridge", data.get("source").getAsString());
    }

    @Test
    public void usagePeakIgnoresSmallerCheckpointRows() throws Exception {
        GeminiSDKBridge bridge = new GeminiSDKBridge();
        RecordingCallback cb = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistant = new StringBuilder();
        AtomicBoolean hadErr = new AtomicBoolean(false);
        AtomicReference<String> nodeErr = new AtomicReference<>();

        feed(bridge, "[USAGE] {\"input_tokens\":27000,\"output_tokens\":10,\"total_tokens\":27010}",
                cb, result, assistant, hadErr, nodeErr);
        feed(bridge, "[USAGE] {\"input_tokens\":96,\"output_tokens\":3,\"total_tokens\":99}",
                cb, result, assistant, hadErr, nodeErr);

        JsonObject usage = bridge.getContextUsage("sid", "/cwd", "claude-sonnet-4-6").get();
        JsonObject data = usage.getAsJsonObject("data");
        assertEquals(27000, data.get("usedTokens").getAsInt());
        assertEquals(200_000, data.get("maxTokens").getAsInt());
    }

    @Test
    public void getSessionMessagesReturnsEmptyList() {
        GeminiSDKBridge bridge = new GeminiSDKBridge();
        assertTrue(bridge.getSessionMessages("any", "/tmp").isEmpty());
    }

    @Test
    public void providerNameIsGemini() throws Exception {
        Method m = GeminiSDKBridge.class.getDeclaredMethod("getProviderName");
        m.setAccessible(true);
        assertEquals("gemini", m.invoke(new GeminiSDKBridge()));
    }
}
