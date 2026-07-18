package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PpccMessageHandlerTest {
    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        int streamStartCount;
        int streamEndCount;
        int messageUpdateCount;
        final List<String> statuses = new ArrayList<>();
        final List<String> approvals = new ArrayList<>();

        @Override public void onMessageUpdate(List<ClaudeSession.Message> messages) { messageUpdateCount++; }
        @Override public void onStateChange(boolean busy, boolean loading, String error) { }
        @Override public void onSessionIdReceived(String sessionId) { }
        @Override public void onPermissionRequested(com.github.claudecodegui.permission.PermissionRequest request) { }
        @Override public void onThinkingStatusChanged(boolean isThinking) { }
        @Override public void onSlashCommandsReceived(List<String> slashCommands) { }
        @Override public void onNodeLog(String log) { }
        @Override public void onSummaryReceived(String summary) { }
        @Override public void onStreamStart() { streamStartCount++; }
        @Override public void onStreamEnd() { streamEndCount++; }
        @Override public void onStatusMessage(String message) { statuses.add(message); }
        @Override public void onPpccApprovalRequired(String requestJson) { approvals.add(requestJson); }
    }

    @Test
    public void structuredEventsAndApprovalUseDedicatedCallbacks() {
        SessionState state = new SessionState();
        CallbackHandler callbacks = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbacks.setCallback(callback);
        PpccMessageHandler handler = new PpccMessageHandler(state, callbacks);

        handler.onMessage("stream_start", "");
        handler.onMessage("ppcc_event", "{\"type\":\"check_started\"}");
        handler.onMessage("ppcc_approval_required", "{\"runId\":\"run-1\"}");

        assertEquals(1, callback.streamStartCount);
        assertEquals(List.of("PPCC: check_started"), callback.statuses);
        assertEquals(List.of("{\"runId\":\"run-1\"}"), callback.approvals);
    }

    @Test
    public void completionClearsBusyStateAndStoresAssistantContentOnce() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);
        CallbackHandler callbacks = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbacks.setCallback(callback);
        PpccMessageHandler handler = new PpccMessageHandler(state, callbacks);

        handler.onMessage("content", "完成");
        SDKResult result = new SDKResult();
        result.success = true;
        handler.onComplete(result);

        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertEquals(1, state.getMessages().size());
        assertEquals("完成", state.getMessages().get(0).content);
        assertTrue(callback.messageUpdateCount > 0);
    }
}
