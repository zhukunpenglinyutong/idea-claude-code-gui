package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

public class HtmlLoaderTest {

    @Test
    public void shouldInjectPerTabReasoningEffort() {
        HtmlLoader loader = new HtmlLoader(HtmlLoaderTest.class);

        String html = loader.injectInitialTabState(
                "<html><head></head><body></body></html>",
                "codex",
                "gpt-5.6-sol",
                "ultra"
        );

        assertTrue(html.contains("window.__INITIAL_TAB_PROVIDER__ = 'codex';"));
        assertTrue(html.contains("window.__INITIAL_TAB_MODEL__ = 'gpt-5.6-sol';"));
        assertTrue(html.contains("window.__INITIAL_TAB_REASONING_EFFORT__ = 'ultra';"));
    }
}
