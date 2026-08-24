package com.github.claudecodegui.cli;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class CliToolIdTest {

    @Test
    public void fromId_acceptsKnownTools() {
        assertEquals(CliToolId.AGY, CliToolId.fromId("agy"));
        assertEquals(CliToolId.AGY, CliToolId.fromId("gemini"));
        assertEquals(CliToolId.GROK, CliToolId.fromId("grok"));
        assertEquals(CliToolId.KIMI, CliToolId.fromId("KIMI"));
        assertEquals(CliToolId.OPENCODE, CliToolId.fromId(" opencode "));
        assertEquals(CliToolId.PI, CliToolId.fromId("pi"));
        assertEquals(CliToolId.OMP, CliToolId.fromId("omp"));
        assertEquals(CliToolId.OMP, CliToolId.fromId(" OMP "));
    }

    @Test
    public void fromId_rejectsUnknown() {
        assertNull(CliToolId.fromId(null));
        assertNull(CliToolId.fromId(""));
        assertNull(CliToolId.fromId("claude"));
    }

    @Test
    public void binaryNames_matchExpected() {
        assertEquals("agy", CliToolId.AGY.getBinaryName());
        assertEquals("grok", CliToolId.GROK.getBinaryName());
        assertEquals("kimi", CliToolId.KIMI.getBinaryName());
        assertEquals("opencode", CliToolId.OPENCODE.getBinaryName());
        assertEquals("pi", CliToolId.PI.getBinaryName());
        assertEquals("omp", CliToolId.OMP.getBinaryName());
        assertEquals("OMP CLI", CliToolId.OMP.getDisplayName());
        for (CliToolId tool : CliToolId.values()) {
            assertNotNull(tool.getDisplayName());
        }
    }
}
