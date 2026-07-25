package com.github.claudecodegui.handler;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class CodexMcpServerHandlerCallbackTest {

    @Test
    public void codexToolsUseProviderSpecificCallbackContract() {
        assertEquals(
                "window.updateCodexMcpServerTools",
                CodexMcpServerHandler.CODEX_MCP_TOOLS_CALLBACK);
    }
}
