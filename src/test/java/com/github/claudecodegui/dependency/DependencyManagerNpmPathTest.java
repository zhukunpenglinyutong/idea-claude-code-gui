package com.github.claudecodegui.dependency;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Tests for {@link DependencyManager#findNpmFile}, which resolves the npm
 * executable across Node.js installers on Windows (standard npm.cmd vs
 * mise/Volta npm.exe). Regression coverage for issue #1503.
 */
public class DependencyManagerNpmPathTest {

    @Test
    public void windows_prefersNpmCmdWhenBothPresent() throws IOException {
        Path dir = newTempDir();
        touch(dir.resolve("npm.exe"));
        touch(dir.resolve("npm.cmd"));

        File found = DependencyManager.findNpmFile(dir.toFile(), true);

        assertEquals("npm.cmd must be preferred over npm.exe on Windows",
                dir.resolve("npm.cmd").toFile(), found);
    }

    @Test
    public void windows_fallsBackToNpmExeForMiseInstalls() throws IOException {
        // Reproduces issue #1503: mise shims only npm.exe (no npm.cmd), so the
        // previous hard-coded "npm.cmd" lookup failed with CreateProcess error=2.
        Path dir = newTempDir();
        touch(dir.resolve("npm.exe"));

        File found = DependencyManager.findNpmFile(dir.toFile(), true);

        assertEquals("npm.exe must be used when npm.cmd is absent (mise/Volta)",
                dir.resolve("npm.exe").toFile(), found);
    }

    @Test
    public void unix_returnsNpmWhenPresent() throws IOException {
        Path dir = newTempDir();
        touch(dir.resolve("npm"));

        File found = DependencyManager.findNpmFile(dir.toFile(), false);

        assertEquals(dir.resolve("npm").toFile(), found);
    }

    @Test
    public void returnsNullWhenNoCandidateExists() throws IOException {
        Path dir = newTempDir();

        assertNull(DependencyManager.findNpmFile(dir.toFile(), true));
        assertNull(DependencyManager.findNpmFile(dir.toFile(), false));
    }

    @Test
    public void returnsNullForNullDirectory() {
        assertNull(DependencyManager.findNpmFile(null, true));
        assertNull(DependencyManager.findNpmFile(null, false));
    }

    private static Path newTempDir() throws IOException {
        Path dir = Files.createTempDirectory("npm-resolve-test");
        dir.toFile().deleteOnExit();
        return dir;
    }

    private static void touch(Path file) throws IOException {
        Files.createFile(file);
        file.toFile().deleteOnExit();
    }
}