package com.github.claudecodegui.session;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.Before;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * A slash command failing on an exhausted usage window (e.g. /compact) reports
 * the limit ONLY inside a {@code system/local_command} record's stderr — it is
 * neither an error result nor a synthetic assistant notice (session 0d009806,
 * line 1587). It must surface as an ERROR message so the failure renders and
 * the auto-resume-on-limit feature can arm on it.
 */
public class ClaudeMessageHandlerLocalCommandLimitTest {

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
    public void localCommandUsageLimitStderrSurfacesAsErrorMessage() {
        // Verbatim shape of the record written by a /compact that hit the limit.
        String system = "{\"type\":\"system\",\"subtype\":\"local_command\","
                + "\"content\":\"<local-command-stderr>Error during compaction: You've hit your session limit "
                + "\\u00b7 resets 12:10am (Europe/Warsaw)</local-command-stderr>\",\"level\":\"info\"}";

        handler.onMessage("system", system);

        List<ClaudeSession.Message> messages = state.getMessages();
        assertEquals(1, messages.size());
        assertEquals(ClaudeSession.Message.Type.ERROR, messages.get(0).type);
        assertEquals("Error during compaction: You've hit your session limit · resets 12:10am (Europe/Warsaw)",
                messages.get(0).content);
        assertTrue("The limit error must be pushed to the webview",
                callbackHandler.messageUpdateCount >= 1);
    }

    @Test
    public void ordinaryLocalCommandStderrIsIgnored() {
        String system = "{\"type\":\"system\",\"subtype\":\"local_command\","
                + "\"content\":\"<local-command-stderr>fatal: not a git repository</local-command-stderr>\"}";

        handler.onMessage("system", system);

        assertTrue("Non-limit local command errors keep their current (hidden) behavior",
                state.getMessages().isEmpty());
        assertEquals(0, callbackHandler.messageUpdateCount);
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
