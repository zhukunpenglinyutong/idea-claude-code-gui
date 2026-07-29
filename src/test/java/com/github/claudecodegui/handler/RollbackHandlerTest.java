package com.github.claudecodegui.handler;

import org.junit.Test;

import java.nio.file.Paths;

import static org.junit.Assert.*;

/**
 * Tests for {@link RollbackHandler} utility methods.
 *
 * Validates CWD sanitisation, JSONL path construction with security checks,
 * and path traversal prevention.
 */
public class RollbackHandlerTest {

    // ── sanitizeCwd ──────────────────────────────────────────────────────

    @Test
    public void sanitizeCwdNullReturnsEmpty() {
        assertEquals("", RollbackHandler.sanitizeCwd(null));
    }

    @Test
    public void sanitizeCwdEmptyReturnsEmpty() {
        assertEquals("", RollbackHandler.sanitizeCwd(""));
    }

    @Test
    public void sanitizeCwdNormalPath() {
        String result = RollbackHandler.sanitizeCwd("/home/user/project");
        assertFalse(result.isEmpty());
        assertFalse(result.contains("/"));
        assertFalse(result.contains("\\"));
    }

    @Test
    public void sanitizeCwdWindowsPath() {
        String result = RollbackHandler.sanitizeCwd("C:\\Users\\me\\project");
        assertFalse(result.contains("\\"));
        assertFalse(result.contains(":"));
        // Should contain parts of the path separated by hyphens
        assertTrue(result.contains("C") || result.contains("Users"));
    }

    @Test
    public void sanitizeCwdTruncatesLongPaths() {
        String longPath = "a-" + "verylongsegment".repeat(10);
        String result = RollbackHandler.sanitizeCwd(longPath);
        assertTrue(result.length() <= 64);
    }

    // ── buildJsonlPath ───────────────────────────────────────────────────

    @Test
    public void buildJsonlPathValidSessionId() {
        String path = RollbackHandler.buildJsonlPath("/home/user/proj", "abc-123-def").toString();
        assertTrue(path.endsWith("abc-123-def.jsonl"));
        // Should contain the projects directory component
        assertTrue(path.replace("\\", "/").contains(".claude/projects/"));
    }

    @Test
    public void buildJsonlPathWithNullSessionIdThrows() {
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", null));
    }

    @Test
    public void buildJsonlPathWithEmptySessionIdThrows() {
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", ""));
    }

    @Test
    public void buildJsonlPathWithInvalidSessionIdThrows() {
        // sessionId containing path traversal chars should be rejected
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", "../evil"));
    }

    @Test
    public void buildJsonlPathWithSlashInSessionIdThrows() {
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", "a/b"));
    }

    @Test
    public void buildJsonlPathWithDotDotInSessionIdThrows() {
        // Malicious sessionId attempting path escape
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", "..\\..\\etc"));
    }

    @Test
    public void buildJsonlPathResolvesWithinProjectsDir() {
        // Even if cwd contains traversal, sanitizeCwd replaces special chars
        // so the resolved path stays within the projects directory.
        String path = RollbackHandler.buildJsonlPath("../../evil", "valid-uuid").toString();
        // The sanitized cwd should not contain ".." — sanitizeCwd replaces
        // non-alphanumeric chars (including '.') with hyphens.
        assertFalse(path.contains(".."));
    }

    @Test
    public void buildJsonlPathHandlesNonExistentCwd() {
        // A non-existent directory name should still produce a valid-looking path
        String path = RollbackHandler.buildJsonlPath("/nonexistent/path", "valid-uuid-123").toString();
        assertTrue(path.replace("\\", "/").contains("/nonexistent/path".replace("/", "-")));
    }
}
