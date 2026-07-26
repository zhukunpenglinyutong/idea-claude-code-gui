package com.github.claudecodegui.dependency;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Test;

import java.nio.file.Paths;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link NpmPermissionHelper#buildInstallCommandWithFallback}.
 */
public class NpmPermissionHelperTest {

    private static final List<String> PACKAGES = List.of("@anthropic-ai/claude-agent-sdk@0.3.150");

    // =========================================================================
    // String overload — WSL path must not be mangled
    // =========================================================================

    @Test
    public void stringOverload_prefixIsPassedVerbatim() {
        String wslPath = "/home/testuser/.codemoss/dependencies/claude-sdk";

        List<String> cmd = NpmPermissionHelper.buildInstallCommandWithFallback(
                "/usr/bin/npm", wslPath, PACKAGES, 0);

        int prefixIdx = cmd.indexOf("--prefix");
        assertTrue("--prefix flag must be present", prefixIdx >= 0);
        assertEquals("prefix value must be the exact string passed",
                wslPath, cmd.get(prefixIdx + 1));
    }

    @Test
    public void stringOverload_forwardSlashesArePreserved() {
        String wslPath = "/home/testuser/.codemoss/dependencies/claude-sdk";

        List<String> cmd = NpmPermissionHelper.buildInstallCommandWithFallback(
                "npm", wslPath, PACKAGES, 0);

        String prefix = cmd.get(cmd.indexOf("--prefix") + 1);
        assertTrue("forward slashes must not be converted to backslashes",
                !prefix.contains("\\"));
    }

    @Test
    public void stringOverload_noForceOnFirstAttempt() {
        List<String> cmd = NpmPermissionHelper.buildInstallCommandWithFallback(
                "npm", "/home/user/.codemoss/deps/sdk", PACKAGES, 0);

        assertTrue("--force must not appear on attempt 0", !cmd.contains("--force"));
    }

    @Test
    public void stringOverload_forceAddedOnRetry() {
        List<String> cmd = NpmPermissionHelper.buildInstallCommandWithFallback(
                "npm", "/home/user/.codemoss/deps/sdk", PACKAGES, 1);

        assertTrue("--force must be present on retry attempt", cmd.contains("--force"));
    }

    // =========================================================================
    // Path overload — backward-compatibility
    // =========================================================================

    @Test
    public void pathOverload_delegatesToStringOverload() {
        List<String> fromPath = NpmPermissionHelper.buildInstallCommandWithFallback(
                "npm", Paths.get("/some/dir"), PACKAGES, 0);
        List<String> fromString = NpmPermissionHelper.buildInstallCommandWithFallback(
                "npm", Paths.get("/some/dir").toString(), PACKAGES, 0);

        assertEquals("Path and String overloads must produce identical commands",
                fromPath, fromString);
    }

    // =========================================================================
    // General shape
    // =========================================================================

    @Test
    public void command_startsWithNpmPath() {
        List<String> cmd = NpmPermissionHelper.buildInstallCommandWithFallback(
                "/usr/bin/npm", "/some/prefix", PACKAGES, 0);

        assertEquals("/usr/bin/npm", cmd.get(0));
        assertEquals("install", cmd.get(1));
        assertEquals("--include=optional", cmd.get(2));
    }

    @Test
    public void command_includesPackages() {
        List<String> pkgs = List.of("pkg-a@1.0.0", "pkg-b");
        List<String> cmd = NpmPermissionHelper.buildInstallCommandWithFallback(
                "npm", "/prefix", pkgs, 0);

        assertTrue(cmd.contains("pkg-a@1.0.0"));
        assertTrue(cmd.contains("pkg-b"));
    }

    @Test
    public void permissionSolutionMatchesCurrentPlatform() {
        String solution = NpmPermissionHelper.generateErrorSolution("EACCES permission denied");

        if (PlatformUtils.isWindows()) {
            assertTrue(solution.contains("npm config set cache"));
            assertTrue(!solution.contains("sudo chown"));
        } else {
            assertTrue(solution.contains("sudo chown"));
        }
    }
}
