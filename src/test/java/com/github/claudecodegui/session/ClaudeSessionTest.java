package com.github.claudecodegui.session;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;

public class ClaudeSessionTest {

    @Test
    public void setSessionInfoNotifiesSessionIdWhenRestoringHistorySession() {
        ClaudeSession session = new ClaudeSession(null, null, null);
        RecordingCallback callback = new RecordingCallback();
        session.setCallback(callback);

        session.setSessionInfo("history-session-123", "/workspace/demo");

        assertEquals("history-session-123", session.getSessionId());
        assertEquals("history-session-123", callback.lastSessionId);
        assertEquals("/workspace/demo", session.getCwd());
    }

    @Test
    public void hasNoTurnStartTimestampBeforeFirstSubmission() {
        ClaudeSession session = new ClaudeSession(null, null, null);

        assertEquals(0L, session.getLastTurnStartedAtMillis());
    }

    private static class RecordingCallback implements ClaudeSession.SessionCallback {
        private String lastSessionId;

        @Override
        public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
            this.lastSessionId = sessionId;
        }

        @Override
        public void onPermissionRequested(com.github.claudecodegui.permission.PermissionRequest request) {
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
    }
}
