package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

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
    public void interruptDoesNotResetAReplacementChannel() throws Exception {
        BlockingCodexBridge bridge = new BlockingCodexBridge(false);
        ClaudeSession session = new ClaudeSession(null, null, bridge);
        session.setProvider("codex");
        session.getState().setChannelId("old-channel");
        session.getState().setBusy(true);
        session.getState().setLoading(true);

        java.util.concurrent.CompletableFuture<Void> interrupt = session.interrupt();
        assertTrue(bridge.awaitInterrupt());
        session.getState().setChannelId("new-channel");
        session.getState().setError("new-channel-state");
        bridge.releaseInterrupt();
        interrupt.join();

        assertEquals("new-channel", session.getChannelId());
        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertEquals("new-channel-state", session.getError());
    }

    @Test(expected = CompletionException.class)
    public void interruptCompletesExceptionallyWhenProviderInterruptFails() {
        BlockingCodexBridge bridge = new BlockingCodexBridge(true);
        ClaudeSession session = new ClaudeSession(null, null, bridge);
        session.setProvider("codex");
        session.getState().setChannelId("failing-channel");

        session.interrupt().join();
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

    private static class BlockingCodexBridge extends CodexSDKBridge {
        private final CountDownLatch interruptStarted = new CountDownLatch(1);
        private final CountDownLatch interruptRelease = new CountDownLatch(1);
        private final boolean fail;

        private BlockingCodexBridge(boolean fail) {
            this.fail = fail;
        }

        @Override
        public void interruptChannel(String channelId) {
            interruptStarted.countDown();
            if (fail) {
                throw new IllegalStateException("interrupt failed");
            }
            try {
                if (!interruptRelease.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("interrupt test timed out");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupt test interrupted", e);
            }
        }

        private boolean awaitInterrupt() throws InterruptedException {
            return interruptStarted.await(5, TimeUnit.SECONDS);
        }

        private void releaseInterrupt() {
            interruptRelease.countDown();
        }
    }
}
