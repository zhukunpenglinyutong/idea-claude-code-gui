package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for loading provider history and restoring session-side derived state.
 */
public class SessionMessageOrchestratorTest {

    @Test
    public void updateUserMessageUuidsBackfillsMatchingLatestClaudeUserMessage() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-1");
        state.setCwd("/workspace");

        JsonObject localRaw = new JsonObject();
        ClaudeSession.Message localUserMessage = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "Explain this diff", localRaw);
        state.addMessage(localUserMessage);

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.latestClaudeUserMessage = createHistoryUserMessage("uuid-123", "Explain this diff");

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.updateUserMessageUuids();

        assertEquals(1, historyAccess.latestClaudeUserMessageRequests.get());
        assertTrue(localUserMessage.raw.has("uuid"));
        assertEquals("uuid-123", localUserMessage.raw.get("uuid").getAsString());
        assertEquals(0, callback.messageUpdates.size());
        assertEquals(List.of("Explain this diff|uuid-123"), callback.messageUuidPatches);
    }

    @Test
    public void updateUserMessageUuidsSkipsLookupWhenAllUserMessagesAlreadyHaveUuid() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setSessionId("session-1");
        state.setCwd("/workspace");

        JsonObject localRaw = new JsonObject();
        localRaw.addProperty("uuid", "existing-uuid");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "Explain this diff", localRaw));

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.updateUserMessageUuids();

        assertEquals(0, historyAccess.latestClaudeUserMessageRequests.get());
    }

    @Test
    public void loadFromServerParsesHistoryAndClearsLoadingState() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setModel("claude-sonnet-4-6");
        state.setSessionId("session-2");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(
                createProviderMessage("user", "Show me the latest error"),
                createProviderMessage("assistant", "The stack trace points to SessionSendService.")
        );

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(1, historyAccess.providerHistoryRequests.get());
        assertFalse(state.isLoading());
        assertEquals(2, state.getMessages().size());
        assertEquals(ClaudeSession.Message.Type.USER, state.getMessages().get(0).type);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, state.getMessages().get(1).type);
        assertEquals("The stack trace points to SessionSendService.", state.getMessages().get(1).content);
        assertEquals(1, callback.messageUpdates.size());
        assertTrue(callback.stateChanges.contains("false:false:null"));
    }

    /**
     * Verifies that history recovery prefers the context window retained in provider
     * usage metadata and forwards the restored usage through the session callback.
     */
    @Test
    public void loadFromServerRestoresProviderReportedContextWindow() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setModel("gpt-5.6-sol");
        state.setSessionId("session-codex-usage");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        JsonObject assistant = createProviderMessage("assistant", "Recovered answer");
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 12000);
        usage.addProperty("output_tokens", 345);
        usage.addProperty("model_context_window", 258400);
        assistant.getAsJsonObject("message").add("usage", usage);
        historyAccess.providerHistory = List.of(assistant);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                null,
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess
        );

        orchestrator.loadFromServer().join();

        assertEquals(List.of("12345:258400"), callback.usageUpdates);
    }

    /**
     * Verifies that providers without a session-specific context window retain the
     * existing static model-limit behavior instead of dropping the usage update.
     */
    @Test
    public void loadFromServerFallsBackToStaticModelContextWindow() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setModel("claude-sonnet-4-6");
        state.setSessionId("session-claude-usage");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        JsonObject assistant = createProviderMessage("assistant", "Recovered answer");
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 12000);
        usage.addProperty("output_tokens", 345);
        assistant.getAsJsonObject("message").add("usage", usage);
        historyAccess.providerHistory = List.of(assistant);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                null,
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess
        );

        orchestrator.loadFromServer().join();

        assertEquals(List.of("12345:200000"), callback.usageUpdates);
    }

    /**
     * Verifies that loading history without usage metadata does not publish a
     * synthetic zero value before a provider snapshot becomes available.
     */
    @Test
    public void loadFromServerDoesNotPublishSyntheticUsageWithoutProviderSnapshot() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setModel("gpt-5.6-sol");
        state.setSessionId("session-without-usage");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(
                createProviderMessage("assistant", "Recovered answer without usage")
        );

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                null,
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess
        );

        orchestrator.loadFromServer().join();

        assertTrue(callback.usageUpdates.isEmpty());
    }

    @Test
    public void loadFromServerPreservesNormalizedCodexToolBlocks() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setSessionId("session-codex-tools");
        state.setCwd("/workspace");

        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", "call-1");
        toolUse.addProperty("name", "glob");
        JsonObject input = new JsonObject();
        input.addProperty("command", "rg TODO");
        toolUse.add("input", input);

        JsonArray rawContent = new JsonArray();
        rawContent.add(toolUse);
        JsonObject normalizedRaw = new JsonObject();
        normalizedRaw.add("content", rawContent);
        normalizedRaw.addProperty("role", "assistant");

        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        envelope.addProperty("content", "Tool: glob");
        envelope.add("raw", normalizedRaw);

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        historyAccess.providerHistory = List.of(envelope);
        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                new SessionCallbackFacade(null),
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(1, state.getMessages().size());
        ClaudeSession.Message restored = state.getMessages().get(0);
        assertEquals("Tool: glob", restored.content);
        assertFalse(restored.raw.has("raw"));
        assertEquals("tool_use", restored.raw.getAsJsonArray("content")
                .get(0).getAsJsonObject().get("type").getAsString());
    }

    @Test
    public void syncUserMessageUuidsShortCircuitsForCodexProvider() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setSessionId("session-3");

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.syncUserMessageUuidsAfterSend().join();

        assertEquals(0, historyAccess.latestClaudeUserMessageRequests.get());
    }

    @Test
    public void loadFromServerSetsErrorWhenHistoryAccessThrows() {
        SessionState state = new SessionState();
        state.setProvider("claude");
        state.setModel("claude-sonnet-4-6");
        state.setSessionId("session-4");
        state.setCwd("/workspace");

        RecordingCallback callback = new RecordingCallback();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        callbackFacade.setCallback(callback);

        SessionMessageOrchestrator.SessionHistoryAccess failingAccess =
                new SessionMessageOrchestrator.SessionHistoryAccess() {
                    @Override
                    public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
                        throw new RuntimeException("connection refused");
                    }

                    @Override
                    public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
                        return null;
                    }
                };

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                failingAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        // LOG.error() in IntelliJ test framework throws AssertionError,
        // which causes the CompletableFuture to complete exceptionally.
        try {
            orchestrator.loadFromServer().join();
        } catch (Exception ignored) {
            // Expected: LOG.error inside catch block triggers AssertionError in test logger
        }

        assertFalse(state.isLoading());
        assertEquals("connection refused", state.getError());
        assertTrue(callback.stateChanges.contains("false:false:connection refused"));
    }

    @Test
    public void loadFromServerReturnsImmediatelyWhenNoSessionId() {
        SessionState state = new SessionState();
        // sessionId is null by default

        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        orchestrator.loadFromServer().join();

        assertEquals(0, historyAccess.providerHistoryRequests.get());
        assertFalse(state.isLoading());
        assertNull(state.getError());
    }

    @Test
    public void extractMessageContentForMatchingHandlesStringContent() {
        SessionState state = new SessionState();
        SessionCallbackFacade callbackFacade = new SessionCallbackFacade(null);
        RecordingHistoryAccess historyAccess = new RecordingHistoryAccess();

        SessionMessageOrchestrator orchestrator = new SessionMessageOrchestrator(
                state,
                new MessageParser(),
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                },
                0,
                0
        );

        // String content format
        JsonObject message = new JsonObject();
        message.addProperty("content", "hello world");
        JsonObject msg = new JsonObject();
        msg.add("message", message);

        assertEquals("hello world", orchestrator.extractMessageContentForMatching(msg));

        // Missing message field
        assertNull(orchestrator.extractMessageContentForMatching(new JsonObject()));

        // Missing content field
        JsonObject emptyMessage = new JsonObject();
        JsonObject msgWithEmptyMessage = new JsonObject();
        msgWithEmptyMessage.add("message", emptyMessage);
        assertNull(orchestrator.extractMessageContentForMatching(msgWithEmptyMessage));
    }

    private JsonObject createHistoryUserMessage(String uuid, String text) {
        JsonObject contentBlock = new JsonObject();
        contentBlock.addProperty("type", "text");
        contentBlock.addProperty("text", text);

        JsonArray content = new JsonArray();
        content.add(contentBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject historyMessage = new JsonObject();
        historyMessage.addProperty("type", "user");
        historyMessage.addProperty("uuid", uuid);
        historyMessage.add("message", message);
        return historyMessage;
    }

    private JsonObject createProviderMessage(String type, String text) {
        JsonObject contentBlock = new JsonObject();
        contentBlock.addProperty("type", "text");
        contentBlock.addProperty("text", text);

        JsonArray content = new JsonArray();
        content.add(contentBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject serverMessage = new JsonObject();
        serverMessage.addProperty("type", type);
        serverMessage.add("message", message);
        return serverMessage;
    }

    private static final class RecordingHistoryAccess implements SessionMessageOrchestrator.SessionHistoryAccess {
        private final AtomicInteger providerHistoryRequests = new AtomicInteger();
        private final AtomicInteger latestClaudeUserMessageRequests = new AtomicInteger();
        private List<JsonObject> providerHistory = List.of();
        private JsonObject latestClaudeUserMessage;

        @Override
        public List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd) {
            providerHistoryRequests.incrementAndGet();
            return providerHistory;
        }

        @Override
        public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
            latestClaudeUserMessageRequests.incrementAndGet();
            return latestClaudeUserMessage;
        }
    }

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        private final List<List<ClaudeSession.Message>> messageUpdates = new ArrayList<>();
        private final List<String> stateChanges = new ArrayList<>();
        private final List<String> messageUuidPatches = new ArrayList<>();
        private final List<String> usageUpdates = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<ClaudeSession.Message> messages) {
            messageUpdates.add(messages);
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            stateChanges.add(busy + ":" + loading + ":" + error);
        }

        @Override
        public void onUsageUpdate(int usedTokens, int maxTokens) {
            usageUpdates.add(usedTokens + ":" + maxTokens);
        }

        @Override
        public void onUserMessageUuidPatched(String content, String uuid) {
            messageUuidPatches.add(content + "|" + uuid);
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
    }
}
