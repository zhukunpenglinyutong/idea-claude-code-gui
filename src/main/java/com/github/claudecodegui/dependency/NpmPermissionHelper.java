package com.github.claudecodegui.dependency;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Utility for detecting and fixing npm permission issues.
 */
public class NpmPermissionHelper {
    private static final Logger LOG = Logger.getInstance(NpmPermissionHelper.class);

    // Permission error keywords
    private static final Pattern PERMISSION_ERROR_PATTERN = Pattern.compile(
            "EACCES|EPERM|permission denied|access denied|ENOTEMPTY.*_cacache",
            Pattern.CASE_INSENSITIVE
    );

    // Cache conflict keywords
    private static final Pattern CACHE_ERROR_PATTERN = Pattern.compile(
            "File exists.*_cacache|EEXIST.*_cacache|Invalid response body",
            Pattern.CASE_INSENSITIVE
    );

    // Special characters that need escaping in the Windows shell
    private static final Pattern WINDOWS_SPECIAL_CHARS = Pattern.compile("[\\^~<>|&()\\s]");

    /**
     * Detects whether the logs contain permission errors.
     */
    public static boolean hasPermissionError(String logs) {
        if (logs == null || logs.isEmpty()) {
            return false;
        }
        return PERMISSION_ERROR_PATTERN.matcher(logs).find();
    }

    /**
     * Detects whether the logs contain cache errors.
     */
    public static boolean hasCacheError(String logs) {
        if (logs == null || logs.isEmpty()) {
            return false;
        }
        return CACHE_ERROR_PATTERN.matcher(logs).find();
    }

    /**
     * Returns the npm cache directory.
     */
    public static Path getNpmCacheDir() {
        String userHome = PlatformUtils.getHomeDirectory();
        return Paths.get(userHome, ".npm", "_cacache");
    }

    /**
     * Checks whether the npm cache directory has permission issues.
     */
    public static boolean checkCachePermission() {
        try {
            Path cacheDir = getNpmCacheDir();
            if (!Files.exists(cacheDir)) {
                return true; // Doesn't exist, so no problem
            }

            // Try to create a test file in the cache directory
            Path testFile = cacheDir.resolve(".permission-test-" + System.currentTimeMillis());
            try {
                Files.createFile(testFile);
                Files.delete(testFile);
                return true; // Write permission confirmed
            } catch (Exception e) {
                LOG.warn("[NpmPermissionHelper] Cache directory has permission issues: " + e.getMessage());
                return false; // No write permission
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to check cache permission: " + e.getMessage(), e);
            return true; // Cannot check, assume no issues
        }
    }

    /**
     * Cleans the npm cache (strategy 1).
     *
     * @param npmPath path to the npm executable
     * @return true if the cleanup succeeded
     */
    public static boolean cleanNpmCache(String npmPath) {
        try {
            LOG.info("[NpmPermissionHelper] Attempting to clean npm cache using: npm cache clean --force");

            ProcessBuilder pb = new ProcessBuilder(npmPath, "cache", "clean", "--force");
            Process process = pb.start();

            // Read output (may contain warning messages)
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            boolean finished = process.waitFor(60, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                LOG.warn("[NpmPermissionHelper] npm cache clean timed out");
                return false;
            }

            int exitCode = process.exitValue();
            if (exitCode == 0) {
                LOG.info("[NpmPermissionHelper] npm cache cleaned successfully");
                return true;
            } else {
                LOG.warn("[NpmPermissionHelper] npm cache clean failed with exit code: " + exitCode);
                LOG.debug("[NpmPermissionHelper] Output: " + output);
                return false;
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to clean npm cache: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Forcefully deletes the npm cache directory (strategy 2 - more aggressive).
     *
     * @return true if the deletion succeeded
     */
    public static boolean forceDeleteCache() {
        try {
            Path cacheDir = getNpmCacheDir();
            if (!Files.exists(cacheDir)) {
                LOG.info("[NpmPermissionHelper] Cache directory does not exist, nothing to delete");
                return true;
            }

            LOG.info("[NpmPermissionHelper] Force deleting cache directory: " + cacheDir);

            if (PlatformUtils.isWindows()) {
                // Windows: use rmdir /s /q
                ProcessBuilder pb = new ProcessBuilder("cmd", "/c", "rmdir", "/s", "/q", cacheDir.toString());
                Process process = pb.start();
                boolean finished = process.waitFor(30, TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                }
                return process.exitValue() == 0;
            } else {
                // Unix: use rm -rf
                ProcessBuilder pb = new ProcessBuilder("rm", "-rf", cacheDir.toString());
                Process process = pb.start();
                boolean finished = process.waitFor(30, TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                }
                return process.exitValue() == 0;
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to force delete cache: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Fixes cache directory ownership (Unix only).
     *
     * @return true if the fix succeeded or was not needed
     */
    public static boolean fixCacheOwnership() {
        if (PlatformUtils.isWindows()) {
            // Windows does not need ownership fixes
            return true;
        }

        try {
            Path cacheDir = getNpmCacheDir().getParent(); // ~/.npm
            if (!Files.exists(cacheDir)) {
                return true;
            }

            String currentUser = System.getProperty("user.name");
            LOG.info("[NpmPermissionHelper] Attempting to fix ownership of: " + cacheDir + " to user: " + currentUser);

            // Use sudo chown -R
            ProcessBuilder pb = new ProcessBuilder("sudo", "chown", "-R", currentUser, cacheDir.toString());
            Process process = pb.start();

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }

            if (process.exitValue() == 0) {
                LOG.info("[NpmPermissionHelper] Ownership fixed successfully");
                return true;
            } else {
                LOG.warn("[NpmPermissionHelper] Failed to fix ownership (exit code: " + process.exitValue() + ")");
                return false;
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to fix cache ownership: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Builds an npm install command with permission fix strategies.
     *
     * <p>Use the {@link #buildInstallCommandWithFallback(String, String, List, int)} overload
     * when the prefix path must be passed as a raw string (e.g. a WSL Unix path like
     * {@code /home/user/.codemoss/...}) to avoid Windows {@link java.nio.file.Path#toString()}
     * converting forward slashes to backslashes.
     */
    public static List<String> buildInstallCommandWithFallback(
            String npmPath, Path sdkDir, List<String> packages, int retryAttempt) {
        return buildInstallCommandWithFallback(npmPath, sdkDir.toString(), packages, retryAttempt);
    }

    /**
     * Builds an npm install command with permission fix strategies.
     * Accepts the {@code --prefix} value as a plain string so callers can supply a
     * WSL Unix-style path (e.g. {@code /home/user/.codemoss/dependencies/claude-sdk})
     * without it being mangled by {@link java.nio.file.Path#toString()} on Windows.
     */
    public static List<String> buildInstallCommandWithFallback(
            String npmPath, String prefixPath, List<String> packages, int retryAttempt) {

        List<String> command = new ArrayList<>();
        command.add(npmPath);
        command.add("install");
        command.add("--include=optional");
        // Security (I): never run package lifecycle scripts (pre/post/install) of the SDK or
        // any transitive dependency — the classic npm-postinstall supply-chain RCE vector.
        // Verified: the Claude/Codex SDKs and their dependency trees declare no install
        // scripts, so this changes nothing functionally while closing the vector.
        command.add("--ignore-scripts");
        command.add("--prefix");
        command.add(prefixPath);

        // Second retry: use --force to overwrite
        if (retryAttempt > 0) {
            command.add("--force");
            LOG.info("[NpmPermissionHelper] Adding --force flag for retry attempt " + retryAttempt);
        }

        // On Windows, wrap packages containing shell special characters in quotes to prevent
        // cmd.exe from interpreting them. Unix systems don't need this as ProcessBuilder
        // passes arguments directly via execve() without shell interpretation.
        boolean needsQuoting = PlatformUtils.isWindows();
        for (String pkg : packages) {
            if (needsQuoting && WINDOWS_SPECIAL_CHARS.matcher(pkg).find()) {
                // Escape any existing quotes in the package name and wrap in quotes
                command.add("\"" + pkg.replace("\"", "\\\"") + "\"");
            } else {
                command.add(pkg);
            }
        }

        return command;
    }

    /**
     * Generates a user-friendly error message with troubleshooting suggestions.
     */
    public static String generateErrorSolution(String logs) {
        StringBuilder solution = new StringBuilder();

        if (hasPermissionError(logs)) {
            solution.append("\n\n🔧 Detected npm permission error. Possible solutions:\n");
            solution.append("1. Run: npm cache clean --force\n");
            solution.append("2. Or manually delete: ~/.npm/_cacache\n");
            if (!PlatformUtils.isWindows()) {
                solution.append("3. Fix ownership: sudo chown -R $(whoami) ~/.npm\n");
            }
        } else if (hasCacheError(logs)) {
            solution.append("\n\n🔧 Detected npm cache conflict. Possible solutions:\n");
            solution.append("1. Clean cache: npm cache clean --force\n");
            solution.append("2. Or delete cache: rm -rf ~/.npm/_cacache\n");
        }

        return solution.toString();
    }
}
