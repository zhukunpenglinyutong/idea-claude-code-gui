package com.github.claudecodegui.session;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.Before;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Sidechain guard added after the 0d009806 session forensics: with the SDK
 * default {@code forwardSubagentText:false} a foreground Agent run streams the
 * SUBAGENT's tool_use/tool_result blocks into the parent query as
 * assistant/user messages marked with {@code parent_tool_use_id} (a progress
 * heartbeat). Merging them rendered subagent tool calls as ordinary
 * conversation cards and buried the Agent card inside one ever-growing merged
 * assistant message — three foreground agents were reported invisible in the
 * GUI. The ai-bridge turn loop now drops them; this guard covers daemons still
 * running an older bridge.
 */
public class ClaudeMessageHandlerSidechainTest {

    private RecordingCallbackHandler callbackHandler;
    private SessionState state;
    private ClaudeMessageHandler handler;

    @Before
    public void setUp() {
        callbackHandler = new RecordingCallbackHandler();
        state = new SessionState();
        MessageParser messageParser = new MessageParser();
        MessageMerger messageMerger = new MessageMerger();
        Gson gson = new GsonBuilder().create();

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
    public void sidechainAssistantMessageIsSkipped() {
        String sidechain = "{\"type\":\"assistant\",\"parent_tool_use_id\":\"toolu_parent01\","
                + "\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_sub01\",\"name\":\"Bash\","
                + "\"input\":{\"command\":\"git status\"}}]}}";

        handler.onMessage("assistant", sidechain);

        assertTrue("Sidechain assistant message must not enter the session state",
                state.getMessages().isEmpty());
        assertEquals("Sidechain assistant message must not trigger a webview push",
                0, callbackHandler.messageUpdateCount);
    }

    @Test
    public void sidechainUserToolResultIsSkipped() {
        String sidechain = "{\"type\":\"user\",\"parent_tool_use_id\":\"toolu_parent01\","
                + "\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_sub01\","
                + "\"content\":\"ok\"}]}}";

        handler.onMessage("user", sidechain);

        assertTrue("Sidechain tool_result must not enter the session state",
                state.getMessages().isEmpty());
    }

    @Test
    public void parentMessagesWithNullParentToolUseIdAreProcessed() {
        // The SDK stamps parent conversation messages with an explicit null —
        // that is NOT a sidechain marker.
        String assistant = "{\"type\":\"assistant\",\"parent_tool_use_id\":null,"
                + "\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_agent01\",\"name\":\"Agent\","
                + "\"input\":{\"subagent_type\":\"general-purpose\",\"description\":\"Review spec document\","
                + "\"prompt\":\"...\"}}]}}";
        String toolResult = "{\"type\":\"user\",\"parent_tool_use_id\":null,"
                + "\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_agent01\","
                + "\"content\":\"report\"}]}}";

        handler.onMessage("assistant", assistant);
        handler.onMessage("user", toolResult);

        List<ClaudeSession.Message> messages = state.getMessages();
        assertEquals("Parent Agent tool_use and its tool_result must both land", 2, messages.size());
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, messages.get(0).type);
        assertTrue("Agent tool_use block must survive into the assistant raw",
                messages.get(0).raw.toString().contains("toolu_agent01"));
        assertEquals(ClaudeSession.Message.Type.USER, messages.get(1).type);
        assertEquals("[tool_result]", messages.get(1).content);
    }

    /** Records webview-push notifications for assertions. */
    private static class RecordingCallbackHandler extends CallbackHandler {
        int messageUpdateCount = 0;

        @Override
        public void notifyMessageUpdate(List<ClaudeSession.Message> messages) {
            messageUpdateCount++;
        }
    }
}
