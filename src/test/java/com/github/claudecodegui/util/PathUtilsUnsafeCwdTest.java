package com.github.claudecodegui.util;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class PathUtilsUnsafeCwdTest {

    @Test
    public void rejectsJetBrainsPluginTree() {
        assertTrue(PathUtils.isUnsafeWorkingDirectory(
                "/Users/x/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/idea-claude-code-gui/ai-bridge"));
    }

    @Test
    public void rejectsGeminiHome() {
        assertTrue(PathUtils.isUnsafeWorkingDirectory("/Users/x/.gemini"));
        assertTrue(PathUtils.isUnsafeWorkingDirectory("/Users/x/.gemini/antigravity-cli"));
    }

    @Test
    public void rejectsWindowsAppDataJetBrainsTrees() {
        assertTrue(PathUtils.isUnsafeWorkingDirectory("C:\\Users\\u\\AppData\\Roaming\\JetBrains\\IntelliJIdea2026.2"));
        assertTrue(PathUtils.isUnsafeWorkingDirectory("C:\\Users\\u\\AppData\\Local\\JetBrains\\IntelliJIdea2026.2"));
    }

    @Test
    public void rejectsLinuxConfigJetBrainsTree() {
        assertTrue(PathUtils.isUnsafeWorkingDirectory("/home/u/.config/JetBrains/IntelliJIdea2026.2"));
        assertTrue(PathUtils.isUnsafeWorkingDirectory("/home/u/.config/jetbrains/ide"));
    }

    @Test
    public void acceptsAiBridgeNamedDirOutsideInstallTree() {
        // The name alone is not a verdict: a user checkout legitimately named
        // "ai-bridge" that is not the bridge install tree stays usable.
        assertFalse(PathUtils.isUnsafeWorkingDirectory("/path/to/plugin/ai-bridge"));
    }

    @Test
    public void rejectsDirUnderBridgeInstallTree() throws Exception {
        Path bridgeRoot = Files.createTempDirectory("ccg-bridge-root-");
        try {
            Path work = Files.createDirectories(bridgeRoot.resolve("work"));
            File anchor = bridgeRoot.toFile();
            assertTrue(PathUtils.isUnsafeWorkingDirectory(bridgeRoot.toString(), anchor));
            assertTrue(PathUtils.isUnsafeWorkingDirectory(work.toString(), anchor));
            // A sibling directory with a similar name must not be caught by prefix accident.
            Path sibling = Files.createTempDirectory("ccg-bridge-root-");
            try {
                assertFalse(PathUtils.isUnsafeWorkingDirectory(sibling.toString(), anchor));
            } finally {
                deleteRecursively(sibling);
            }
        } finally {
            deleteRecursively(bridgeRoot);
        }
    }

    @Test
    public void acceptsNormalProject() {
        assertFalse(PathUtils.isUnsafeWorkingDirectory("/path/to/normal/project"));
        assertFalse(PathUtils.isUnsafeWorkingDirectory("/Users/x/projects/my-app"));
    }

    @Test
    public void guardFallsBackToProjectBase() throws Exception {
        Path project = Files.createTempDirectory("ccg-cwd-project-");
        try {
            String unsafe = project.resolve(".gemini").toString();
            Files.createDirectories(Path.of(unsafe));
            String guarded = PathUtils.selectSafeWorkingDirectory(unsafe, project.toString(), null);
            assertEquals(project.toRealPath().toString(), Path.of(guarded).toRealPath().toString());
        } finally {
            deleteRecursively(project);
        }
    }

    @Test
    public void guardFallsBackWhenRequestedIsUnderBridgeInstallTree() throws Exception {
        Path project = Files.createTempDirectory("ccg-cwd-ok-");
        Path bridgeRoot = Files.createTempDirectory("ccg-bridge-fallback-");
        try {
            Path work = Files.createDirectories(bridgeRoot.resolve("work"));
            String guarded = PathUtils.selectSafeWorkingDirectory(
                    work.toString(), project.toString(), bridgeRoot.toFile());
            assertEquals(project.toRealPath().toString(), Path.of(guarded).toRealPath().toString());
        } finally {
            deleteRecursively(project);
            deleteRecursively(bridgeRoot);
        }
    }

    @Test
    public void guardKeepsSafeRequested() throws Exception {
        Path project = Files.createTempDirectory("ccg-cwd-ok-");
        try {
            String guarded = PathUtils.selectSafeWorkingDirectory(project.toString(), project.toString(), null);
            assertEquals(project.toRealPath().toString(), Path.of(guarded).toRealPath().toString());
        } finally {
            deleteRecursively(project);
        }
    }

    @Test
    public void guardReturnsNullWhenNothingSafe() {
        assertNull(PathUtils.selectSafeWorkingDirectory(
                "/Users/x/.gemini",
                "/Users/x/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/idea-claude-code-gui",
                null));
    }

    private static void deleteRecursively(Path root) throws Exception {
        if (root == null || !Files.exists(root)) {
            return;
        }
        try (var walk = Files.walk(root)) {
            walk.sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        }
    }
}
