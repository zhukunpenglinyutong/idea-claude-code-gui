package com.github.claudecodegui.dependency;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SdkDefinitionGeminiTest {

    @Test
    public void fromProviderMapsGemini() {
        assertEquals(SdkDefinition.GEMINI_CLI, SdkDefinition.fromProvider("gemini"));
        assertEquals(SdkDefinition.GEMINI_CLI, SdkDefinition.fromProvider("GEMINI"));
        assertEquals(SdkDefinition.CLAUDE_SDK, SdkDefinition.fromProvider("claude"));
        assertEquals(SdkDefinition.CODEX_SDK, SdkDefinition.fromProvider("codex"));
        assertNull(SdkDefinition.fromProvider("unknown"));
    }

    @Test
    public void fromIdMapsGeminiCli() {
        assertEquals(SdkDefinition.GEMINI_CLI, SdkDefinition.fromId("gemini-cli"));
        assertNull(SdkDefinition.fromId("nope"));
    }

    @Test
    public void geminiCliIsExternalBinaryMarker() {
        assertEquals("gemini-cli", SdkDefinition.GEMINI_CLI.getId());
        assertEquals("agy-cli-binary", SdkDefinition.GEMINI_CLI.getNpmPackage());
        assertNull(SdkDefinition.GEMINI_CLI.getMinRequiredVersion());
        assertTrue(SdkDefinition.GEMINI_CLI.getDisplayName().toLowerCase().contains("antigravity")
                || SdkDefinition.GEMINI_CLI.getDisplayName().toLowerCase().contains("gemini"));
        assertNotNull(SdkDefinition.GEMINI_CLI.getDescription());
    }
}
