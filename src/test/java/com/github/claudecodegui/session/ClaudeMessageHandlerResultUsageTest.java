package com.github.claudecodegui.session;

import com.github.claudecodegui.session.ClaudeSession.Message;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link ClaudeMessageHandler}'s handleResult turnUsage stamping.
 *
 * <p>The result message's usage aggregates every API call of the turn
 * (SDKResultMessage.usage). handleResult must stamp it as the top-level
 * turnUsage field on the final assistant message for the per-turn token
 * display, without touching message.usage (the status-bar channel).</p>
 *
 * <p>handleResult is private and its fallback branch calls platform statics
 * (ClaudeNotifier), so these tests use reflection to seed
 * {@code currentAssistantMessage} and invoke the method directly — the same
 * pattern as {@link ClaudeMessageHandlerRawConsistencyTest}.</p>
 */
public class ClaudeMessageHandlerResultUsageTest {

    private ClaudeMessageHandler handler;
    private SessionState state;
    private RecordingCallback callback;

    @Before
    public void setUp() {
        state = new SessionState();
        MessageParser messageParser = new MessageParser();
        MessageMerger messageMerger = new MessageMerger();
        Gson gson = new GsonBuilder().create();
        CallbackHandler callbackHandler = new CallbackHandler();
        callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        handler = new ClaudeMessageHandler(
                null,
                state,
                callbackHandler,
                messageParser,
                messageMerger,
                gson
        );
    }

    @Test
    public void resultStampsTurnUsageOnAssistantMessage() throws Exception {
        Message msg = newAssistantMessageWithUsage(37, 353);
        setCurrentAssistantMessage(msg);

        // Whole-turn aggregate from the result message: much larger than the
        // final call's usage because it sums every API call of the turn.
        invokeHandleResult("{\"type\":\"result\",\"subtype\":\"success\",\"usage\":{"
                + "\"input_tokens\":1200,\"cache_creation_input_tokens\":4096,"
                + "\"cache_read_input_tokens\":363100,\"output_tokens\":4560}}");

        assertTrue(msg.raw.has("turnUsage"));
        JsonObject turnUsage = msg.raw.getAsJsonObject("turnUsage");
        assertEquals(1200, turnUsage.get("input_tokens").getAsInt());
        assertEquals(4096, turnUsage.get("cache_creation_input_tokens").getAsInt());
        assertEquals(363100, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(4560, turnUsage.get("output_tokens").getAsInt());
        assertEquals(0.19629, msg.raw.get("turnCostUsd").getAsDouble(), 0.000001);

        // The status-bar channel (message.usage = per-call context occupancy)
        // must keep the assistant message's own value, NOT the turn aggregate.
        JsonObject messageUsage = msg.raw.getAsJsonObject("message").getAsJsonObject("usage");
        assertEquals(37, messageUsage.get("input_tokens").getAsInt());
        assertEquals(353, messageUsage.get("output_tokens").getAsInt());
    }

    @Test
    public void resultPushesMessageUpdateAfterStampingTurnUsage() throws Exception {
        Message msg = newAssistantMessageWithUsage(37, 353);
        setCurrentAssistantMessage(msg);
        addMessageToState(msg);

        invokeHandleResult("{\"type\":\"result\",\"subtype\":\"success\",\"usage\":{"
                + "\"input_tokens\":1200,\"cache_creation_input_tokens\":4096,"
                + "\"cache_read_input_tokens\":363100,\"output_tokens\":4560}}");

        assertEquals(1, callback.messageUpdateCount);
        assertEquals(1, callback.lastMessages.size());
        assertTrue(callback.lastMessages.get(0).raw.has("turnUsage"));
        assertTrue(callback.lastMessages.get(0).raw.has("turnCostUsd"));
    }

    @Test
    public void resultWithoutUsageDoesNotStampTurnUsage() throws Exception {
        Message msg = newAssistantMessageWithUsage(37, 353);
        setCurrentAssistantMessage(msg);

        invokeHandleResult("{\"type\":\"result\",\"subtype\":\"success\"}");

        assertFalse(msg.raw.has("turnUsage"));
    }

    @Test
    public void resultWithoutAssistantMessageIsIgnored() throws Exception {
        setCurrentAssistantMessage(null);

        // Must not throw even though there is no message to stamp.
        invokeHandleResult("{\"type\":\"result\",\"subtype\":\"success\",\"usage\":{"
                + "\"input_tokens\":1200,\"output_tokens\":456}}");
    }

    @Test
    public void resultDoesNotStampTurnCostWhenModelHasNoPricing() throws Exception {
        state.setModel("custom-claude-without-pricing");
        Message msg = newAssistantMessageWithUsage(37, 353);
        setCurrentAssistantMessage(msg);

        invokeHandleResult("{\"type\":\"result\",\"subtype\":\"success\",\"usage\":{"
                + "\"input_tokens\":1200,\"output_tokens\":456}}");

        assertTrue(msg.raw.has("turnUsage"));
        assertFalse(msg.raw.has("turnCostUsd"));
    }

    // --- helpers -----------------------------------------------------------

    private Message newAssistantMessageWithUsage(int inputTokens, int outputTokens) {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", "Hello");

        JsonArray content = new JsonArray();
        content.add(textBlock);

        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", inputTokens);
        usage.addProperty("output_tokens", outputTokens);

        JsonObject messageObj = new JsonObject();
        messageObj.add("content", content);
        messageObj.add("usage", usage);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", messageObj);
        return new Message(Message.Type.ASSISTANT, "Hello", raw);
    }

    private void invokeHandleResult(String json) throws Exception {
        Method method = ClaudeMessageHandler.class.getDeclaredMethod("handleResult", String.class);
        method.setAccessible(true);
        method.invoke(handler, json);
    }

    private void setCurrentAssistantMessage(Message message) throws Exception {
        Field field = ClaudeMessageHandler.class.getDeclaredField("currentAssistantMessage");
        field.setAccessible(true);
        field.set(handler, message);
    }

    private void addMessageToState(Message message) throws Exception {
        Field field = ClaudeMessageHandler.class.getDeclaredField("state");
        field.setAccessible(true);
        SessionState state = (SessionState) field.get(handler);
        state.addMessage(message);
    }

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        int messageUpdateCount = 0;
        List<Message> lastMessages = List.of();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageUpdateCount++;
            lastMessages = List.copyOf(messages);
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
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
