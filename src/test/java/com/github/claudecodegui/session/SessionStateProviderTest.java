package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class SessionStateProviderTest {
    @Test
    public void acceptsPpccAndRejectsUnknownProvider() {
        SessionState state = new SessionState();
        state.setProvider("ppcc");
        assertEquals("ppcc", state.getProvider());
        state.setProvider("unknown");
        assertEquals("ppcc", state.getProvider());
    }
}
