package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class RemoteProjectIdTest {

    @Test
    public void deterministicForSamePath() {
        String a = RemoteProjectId.of("D:\\dev\\ccgui-test");
        String b = RemoteProjectId.of("D:\\dev\\ccgui-test");
        assertNotNull(a);
        assertEquals(a, b);
    }

    @Test
    public void stableAcrossRuns() {
        // Pin a known path to a fixed expected hash so a future refactor can't
        // silently change the id derivation. SHA-256 of normalized
        // "/home/user/project", truncated to 32 hex chars (128 bits).
        assertEquals("9dad1e4e08b0b11cbcd860257e8bdfa6", RemoteProjectId.of("/home/user/project"));
    }

    @Test
    public void isLowercaseHexOfFixedLength() {
        String id = RemoteProjectId.of("/home/user/project");
        assertNotNull(id);
        assertEquals(32, id.length());
        assertTrue(id.matches("[0-9a-f]{32}"));
        assertFalse(id.matches(".*[A-Z].*"));
    }

    @Test
    public void differentPathsYieldDifferentIds() {
        String a = RemoteProjectId.of("/home/user/project-a");
        String b = RemoteProjectId.of("/home/user/project-b");
        assertFalse(a.equals(b));
    }

    @Test
    public void driveLetterCaseInsensitiveOnWindows() {
        String upper = RemoteProjectId.of("C:\\Projects\\X");
        String lower = RemoteProjectId.of("c:\\Projects\\X");
        assertEquals(upper, lower);
    }

    @Test
    public void trailingSeparatorsCollapsed() {
        String withSlash = RemoteProjectId.of("/home/user/project/");
        String without = RemoteProjectId.of("/home/user/project");
        assertEquals(withSlash, without);
    }

    @Test
    public void returnsNullForNullOrBlank() {
        assertNull(RemoteProjectId.of(null));
        assertNull(RemoteProjectId.of(""));
        assertNull(RemoteProjectId.of("   "));
        assertNull(RemoteProjectId.of("/"));
    }
}
