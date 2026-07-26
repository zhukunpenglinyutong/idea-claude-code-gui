package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.settings.TabStateService;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class TabSessionRestorePolicyTest {

    @Test
    public void shouldLoadHistoryForPersistedSessionId() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.sessionId = "session-123";

        assertTrue(TabSessionRestorePolicy.shouldLoadHistory(savedState));
    }

    @Test
    public void shouldNotLoadHistoryWithoutPersistedSessionId() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.cwd = "/workspace";

        assertFalse(TabSessionRestorePolicy.shouldLoadHistory(savedState));
        assertFalse(TabSessionRestorePolicy.shouldLoadHistory(null));
    }

    @Test
    public void shouldLoadImmediatelyOnlyForSelectedTabsWithHistory() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.sessionId = "session-123";

        assertTrue(TabSessionRestorePolicy.shouldLoadImmediately(savedState, true));
        assertFalse(TabSessionRestorePolicy.shouldLoadImmediately(savedState, false));
    }

    @Test
    public void shouldStartHistoryLoadOnlyAfterFrontendIsReady() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.sessionId = "session-123";

        assertFalse(TabSessionRestorePolicy.shouldStartHistoryLoad(savedState, false));
        assertTrue(TabSessionRestorePolicy.shouldStartHistoryLoad(savedState, true));
    }
}
