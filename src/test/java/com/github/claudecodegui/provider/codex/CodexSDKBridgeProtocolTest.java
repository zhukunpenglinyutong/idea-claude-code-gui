package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for Codex bridge stdout protocol routing and result bookkeeping.
 */
public class CodexSDKBridgeProtocolTest {

    /**
     * Verifies that token_count metadata reaches the live callback without being
     * counted as a conversation message in the completed SDK result.
     */
    @Test
    public void tokenCountEventIsRoutedButExcludedFromResultMessages() {
        TestableCodexSDKBridge bridge = new TestableCodexSDKBridge();
        SDKResult result = new SDKResult();
        RecordingCallback callback = new RecordingCallback();

        bridge.process(
                "[MESSAGE] {\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{"
                        + "\"last_token_usage\":{\"input_tokens\":49060,\"output_tokens\":231},"
                        + "\"model_context_window\":258400}}}",
                callback,
                result
        );

        assertEquals("event_msg", callback.lastType);
        assertTrue(callback.lastContent.contains("last_token_usage"));
        assertTrue(result.messages.isEmpty());
    }

    private static final class TestableCodexSDKBridge extends CodexSDKBridge {
        private void process(String line, MessageCallback callback, SDKResult result) {
            processOutputLine(
                    line,
                    callback,
                    result,
                    new StringBuilder(),
                    new AtomicBoolean(false),
                    new AtomicReference<>()
            );
        }
    }

    private static final class RecordingCallback implements MessageCallback {
        private String lastType;
        private String lastContent;

        @Override
        public void onMessage(String type, String content) {
            lastType = type;
            lastContent = content;
        }

        @Override
        public void onError(String error) {
        }

        @Override
        public void onComplete(SDKResult result) {
        }
    }
}
