package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.session.SessionState;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class ClaudeChatWindowSessionPreferencesTest {

    @Test
    public void shouldCopyProviderPreferencesWithoutConversationState() {
        SessionState source = new SessionState();
        source.setProvider("codex");
        source.setModel("gpt-5.6-sol");
        source.setPermissionMode("plan");
        source.setReasoningEffort("xhigh");
        source.setSessionId("existing-session");
        source.setCwd("C:/source-project");

        SessionState target = new SessionState();
        target.setSessionId("new-session");
        target.setCwd("C:/target-project");

        ClaudeChatWindow.copySessionPreferences(source, target);

        assertEquals("codex", target.getProvider());
        assertEquals("gpt-5.6-sol", target.getModel());
        assertEquals("plan", target.getPermissionMode());
        assertEquals("xhigh", target.getReasoningEffort());
        assertEquals("new-session", target.getSessionId());
        assertEquals("C:/target-project", target.getCwd());
    }

    @Test
    public void shouldClearOptionalPreferencesWhenSourceUsesDefaults() {
        SessionState source = new SessionState();
        source.setProvider("codex");
        source.setModel(null);
        source.setReasoningEffort(null);

        SessionState target = new SessionState();
        target.setModel("stale-model");
        target.setReasoningEffort("high");

        ClaudeChatWindow.copySessionPreferences(source, target);

        assertNull(target.getModel());
        assertNull(target.getReasoningEffort());
    }
}
