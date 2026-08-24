package com.github.claudecodegui.util;

import com.github.claudecodegui.model.PathCheckResult;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Path utility class.
 * Provides cross-platform path handling methods including path normalization,
 * path validation, and temporary directory detection.
 */
public class PathUtils {

    // Windows path length limit
    private static final int WINDOWS_MAX_PATH = 260;
    private static final int SAFE_PATH_LENGTH = 200; // Leave room for file names

    // ==================== Path Normalization ====================

    /**
     * Convert a path into a safe filename/identifier.
     * Consistent with Claude Code's sanitizedPath logic.
     * Replaces all non-alphanumeric characters with hyphens.
     *
     * @param path the original path
     * @return the sanitized path string (non-alphanumeric characters replaced with -)
     */
    public static String sanitizePath(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        // Consistent with Claude Code: replace all non-alphanumeric characters with -
        // e.g., D:\Projects\MyProject becomes D--Projects-MyProject
        return path.replaceAll("[^a-zA-Z0-9]", "-");
    }

    /**
     * Resolve a path to an absolute, normalized form, collapsing {@code .} and
     * {@code ..} segments without resolving symlinks.
     *
     * <p>This mirrors Node's {@code path.resolve()} (used by the ai-bridge when it
     * decides the working directory), so the {@code ~/.claude/projects/<key>}
     * directory derived on the Java side matches the one the Claude SDK writes to.
     * {@code getCanonicalPath()} is deliberately avoided: it resolves
     * symlinks/junctions and may change case, which would re-introduce divergence.
     *
     * @param path the original path
     * @return the absolute, normalized path; or the input unchanged when null/blank
     *         or when normalization fails
     */
    public static String normalizeAbsolute(String path) {
        if (path == null || path.isEmpty()) {
            return path;
        }
        // WSL UNC paths (\\wsl.localhost\..., \\wsl$\..., and the forward-slash
        // //wsl.localhost/... form IntelliJ's getBasePath() returns on Windows) must NOT be run
        // through Paths.get(...).toAbsolutePath(): the leading "//" collapses and the path resolves
        // drive-relative (C:\wsl.localhost\...), producing a different ~/.claude/projects/<key>
        // than the SDK writes to. See WslPathUtil.resolveHomeForFileOps for the same hazard.
        if (isWslUncPath(path)) {
            return normalizeWslUncLexically(path);
        }
        try {
            return java.nio.file.Paths.get(path).toAbsolutePath().normalize().toString();
        } catch (Exception e) {
            return path;
        }
    }

    /** True for the WSL UNC roots ({@code \\wsl.localhost\...}, {@code \\wsl$\...}) in either slash form. */
    private static boolean isWslUncPath(String path) {
        String p = path.replace('\\', '/');
        return p.startsWith("//wsl.localhost/") || p.startsWith("//wsl$/")
                || p.equals("//wsl.localhost") || p.equals("//wsl$");
    }

    /**
     * Collapse {@code .}/{@code ..} segments lexically while preserving the leading {@code //}
     * UNC prefix and using forward slashes (which {@link WslPathUtil} accepts on both sides).
     * Used instead of {@link java.nio.file.Path#normalize()} because Java's Windows path parser
     * corrupts the {@code //wsl...} prefix (see {@link #normalizeAbsolute}).
     */
    private static String normalizeWslUncLexically(String path) {
        String p = path.replace('\\', '/');
        String[] segments = p.substring(2).split("/");
        java.util.Deque<String> stack = new java.util.ArrayDeque<>();
        for (String seg : segments) {
            if (seg.isEmpty() || ".".equals(seg)) {
                continue;
            }
            if ("..".equals(seg)) {
                if (!stack.isEmpty()) {
                    stack.pollLast();
                }
                continue;
            }
            stack.addLast(seg);
        }
        return "//" + String.join("/", stack);
    }

    /**
     * Normalize a path to Unix style (for internal storage and comparison).
     * Converts Windows backslashes to forward slashes.
     *
     * @param path the original path
     * @return the path using forward slashes
     */
    public static String normalizeToUnix(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        return path.replace("\\", "/");
    }

    /**
     * Normalize a path to the current platform's style.
     *
     * @param path the original path
     * @return the path using the current platform's separator
     */
    public static String normalizeToPlatform(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        if (PlatformUtils.isWindows()) {
            return path.replace("/", "\\");
        } else {
            return path.replace("\\", "/");
        }
    }

    /**
     * Check whether a path is in Windows format (contains a drive letter).
     *
     * @param path the path to check
     * @return true if the path is in Windows format
     */
    public static boolean isWindowsPath(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        // Check if it starts with a drive letter (e.g., C:, D:)
        return path.matches("^[a-zA-Z]:.*");
    }

    /**
     * Check whether a path is a UNC path (network path).
     *
     * @param path the path to check
     * @return true if the path is a UNC path
     */
    public static boolean isUncPath(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        return path.startsWith("\\\\") || path.startsWith("//");
    }

    /**
     * Convert an MSYS2/Git Bash-style path to a Windows path.
     * Handles the following path mappings:
     * <ul>
     *   <li>{@code /c/Users/test} → {@code C:\Users\test} (drive letter mapping)</li>
     *   <li>{@code /home/user} or {@code ~} → {@code %USERPROFILE%} (home directory)</li>
     *   <li>{@code /tmp} → {@code %TEMP%} (temporary directory)</li>
     *   <li>{@code /dev/null} → {@code NUL} (null device)</li>
     * </ul>
     * Returns the original path if conversion is not needed.
     *
     * @param path the original path
     * @return the converted Windows path, or the original path
     */
    public static String convertMsysToWindowsPath(String path) {
        if (path == null || path.isEmpty() || !PlatformUtils.isWindows()) {
            return path;
        }

        if (isWindowsPath(path) || isUncPath(path)) {
            return path;
        }

        // Handle tilde (home directory shorthand)
        if (path.equals("~") || path.startsWith("~/")) {
            String home = PlatformUtils.getHomeDirectory();
            if (home != null && !home.isEmpty()) {
                String expanded = path.equals("~") ? home : home + path.substring(1);
                return normalizeToPlatform(expanded);
            }
        }

        // All remaining conversions require a leading slash
        if (!path.startsWith("/")) {
            return path;
        }

        // /dev/null → NUL
        if (path.equals("/dev/null")) {
            return "NUL";
        }

        // Drive letter mapping: /c/... → C:\...
        if (path.matches("^/[a-zA-Z](/.*)?$")) {
            char driveLetter = Character.toUpperCase(path.charAt(1));
            String remainder = path.length() > 2 ? path.substring(2) : "";
            String windowsPath = driveLetter + ":" + (remainder.isEmpty() ? "/" : remainder);
            return normalizeToPlatform(windowsPath);
        }

        // /home/<username>/... → %USERPROFILE%/... (Git Bash maps /home/<user> to Windows home)
        if (path.startsWith("/home/")) {
            String home = PlatformUtils.getHomeDirectory();
            if (home != null && !home.isEmpty()) {
                String afterHome = path.substring("/home/".length());
                int slashIdx = afterHome.indexOf('/');
                if (slashIdx < 0) {
                    return normalizeToPlatform(home);
                } else {
                    return normalizeToPlatform(home + afterHome.substring(slashIdx));
                }
            }
        }

        // /tmp → system temp directory
        if (path.equals("/tmp") || path.startsWith("/tmp/")) {
            String tempDir = PlatformUtils.getTempDirectory();
            if (!tempDir.isEmpty()) {
                String remainder = path.length() > "/tmp".length() ? path.substring("/tmp".length()) : "";
                return normalizeToPlatform(tempDir + remainder);
            }
        }

        return path;
    }

    // ==================== Path Length Checks ====================

    /**
     * Check whether a path length is safe (primarily for Windows).
     *
     * @param path the path to check
     * @return PathCheckResult containing the check result and recommendations
     */
    public static PathCheckResult checkPathLength(String path) {
        if (path == null || path.isEmpty()) {
            return PathCheckResult.ok();
        }

        // No check needed on non-Windows platforms
        if (!PlatformUtils.isWindows()) {
            return PathCheckResult.ok();
        }

        int pathLength = path.length();

        if (pathLength >= WINDOWS_MAX_PATH) {
            return PathCheckResult.error(
                "Project path is too long (" + pathLength + " characters)\n" +
                "Windows limits path length to 260 characters.\n" +
                "Suggestion: move the project to a shorter path, e.g. D:\\projects\\",
                path,
                pathLength
            );
        }

        if (pathLength >= SAFE_PATH_LENGTH) {
            return PathCheckResult.warning(
                "Project path is relatively long (" + pathLength + " characters)\n" +
                "It may exceed the Windows path limit when creating deeply nested files.",
                path,
                pathLength
            );
        }

        return PathCheckResult.ok(path, pathLength);
    }

    // ==================== Temporary Directory Detection ====================

    /**
     * Get all possible temporary directory paths.
     *
     * @return list of temporary directory paths
     */
    public static List<String> getTempPaths() {
        Set<String> paths = new HashSet<>();

        // Primary temp directory from PlatformUtils (handles TEMP/TMP/TMPDIR/java.io.tmpdir)
        String primaryTemp = PlatformUtils.getTempDirectory();
        if (!primaryTemp.isEmpty()) {
            paths.add(normalizeToUnix(primaryTemp).toLowerCase());
        }

        // java.io.tmpdir as additional fallback
        String javaTmpDir = System.getProperty("java.io.tmpdir");
        if (javaTmpDir != null && !javaTmpDir.isEmpty()) {
            paths.add(normalizeToUnix(javaTmpDir).toLowerCase());
        }

        if (PlatformUtils.isWindows()) {
            String localAppData = PlatformUtils.getEnvIgnoreCase("LOCALAPPDATA");
            if (localAppData != null && !localAppData.isEmpty()) {
                paths.add(normalizeToUnix(localAppData + "\\Temp").toLowerCase());
            }
        } else {
            paths.add("/tmp");
            paths.add("/var/tmp");
            paths.add("/private/tmp"); // macOS
        }

        return new ArrayList<>(paths);
    }

    /**
     * Check whether a given path is a temporary directory.
     *
     * @param path the path to check
     * @return true if the path is a temp directory or is located within one
     */
    public static boolean isTempDirectory(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }

        String normalizedPath = normalizeToUnix(path).toLowerCase();
        List<String> tempPaths = getTempPaths();

        for (String tempPath : tempPaths) {
            if (tempPath != null && normalizedPath.startsWith(tempPath)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Paths that must never be used as the agent working directory / agy
     * {@code workspaceDirs}. Observed failures used plugin install dirs, the
     * embedded ai-bridge tree, or {@code ~/.gemini} when cwd fell through.
     *
     * @param path candidate working directory
     * @return true when the path is empty or clearly not a user project root
     */
    public static boolean isUnsafeWorkingDirectory(String path) {
        return isUnsafeWorkingDirectory(path, null);
    }

    /**
     * Same as {@link #isUnsafeWorkingDirectory(String)} with the bridge install
     * tree anchor. The standalone checkout is rejected by position (inside
     * {@code bridgeDir}), not by name — a user directory legitimately named
     * {@code ai-bridge} outside the install tree must stay usable, mirroring the
     * JS-side guard in {@code ai-bridge/utils/path-utils.js}.
     *
     * @param path      candidate working directory
     * @param bridgeDir resolved bridge install directory (daemon process.cwd());
     *                  null skips the anchored check (name literals still apply)
     * @return true when the path is empty or clearly not a user project root
     */
    public static boolean isUnsafeWorkingDirectory(String path, File bridgeDir) {
        if (path == null || path.trim().isEmpty()) {
            return true;
        }
        String normalized = normalizeToUnix(path.trim()).toLowerCase();
        if (normalized.isEmpty() || "undefined".equals(normalized) || "null".equals(normalized)) {
            return true;
        }
        // JetBrains plugin install / config trees (embedded ai-bridge lives here).
        if (normalized.contains("/application support/jetbrains/")) {
            return true;
        }
        if (normalized.contains("/plugins/idea-claude-code-gui")) {
            return true;
        }
        if (normalized.contains("/.local/share/jetbrains/")) {
            return true;
        }
        // Windows JetBrains config/install roots (AppData Roaming + Local).
        if (normalized.contains("/appdata/roaming/jetbrains/")) {
            return true;
        }
        if (normalized.contains("/appdata/local/jetbrains/")) {
            return true;
        }
        // Linux JetBrains config root (~/.config/JetBrains; comparison is lowercased).
        if (normalized.contains("/.config/jetbrains/")) {
            return true;
        }
        // Standalone bridge install tree used as process.cwd() by the daemon —
        // anchored to the actual install dir, not the "ai-bridge" name.
        if (bridgeDir != null) {
            String anchor = normalizeToUnix(normalizeAbsolute(bridgeDir.getAbsolutePath())).toLowerCase();
            String anchorPrefix = anchor.endsWith("/") ? anchor : anchor + "/";
            if (!anchor.isEmpty() && (normalized.equals(anchor) || normalized.startsWith(anchorPrefix))) {
                return true;
            }
        }
        // Antigravity CLI default home — was seen as workspaceDirs=[~/.gemini].
        if (normalized.endsWith("/.gemini") || normalized.contains("/.gemini/")) {
            return true;
        }
        if (normalized.endsWith("/.gemini/antigravity-cli")
                || normalized.contains("/.gemini/antigravity-cli/")) {
            return true;
        }
        return false;
    }

    /**
     * Prefer {@code requested} when it is a safe existing directory; otherwise
     * fall back to {@code projectBasePath} when that is safe. Returns the first
     * usable path, or {@code null} when neither is acceptable: agy uses process
     * cwd as {@code workspaceDirs}, so spawning from a plugin install /
     * bridge / {@code ~/.gemini} tree must fall through, not clamp.
     *
     * <p>{@code bridgeDir} anchors the "bridge's own tree" check — the same
     * resolver result the daemon is spawned with ({@code
     * BridgePreloader.getSharedResolver().findSdkDir()}); null when the resolver
     * is unavailable, in which case only the name-based literals apply.
     */
    public static String selectSafeWorkingDirectory(String requested, String projectBasePath, File bridgeDir) {
        String primary = firstSafeExistingDirectory(requested, bridgeDir);
        if (primary != null) {
            return primary;
        }
        String fallback = firstSafeExistingDirectory(projectBasePath, bridgeDir);
        if (fallback != null) {
            return fallback;
        }
        return null;
    }

    private static String firstSafeExistingDirectory(String path, File bridgeDir) {
        if (path == null || path.trim().isEmpty() || isUnsafeWorkingDirectory(path, bridgeDir)) {
            return null;
        }
        String normalized = normalizeAbsolute(path.trim());
        if (normalized == null || normalized.isEmpty() || isUnsafeWorkingDirectory(normalized, bridgeDir)) {
            return null;
        }
        File dir = new File(normalized);
        if (!dir.isDirectory()) {
            return null;
        }
        return normalized;
    }

    // ==================== Path Validation ====================

    /**
     * Check whether a path is writable.
     *
     * @param path the path to verify
     * @return true if the path exists and is writable
     */
    public static boolean isWritable(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        File file = new File(path);
        return file.exists() && file.canWrite();
    }

    /**
     * Check whether a path exists.
     *
     * @param path the path to verify
     * @return true if the path exists
     */
    public static boolean exists(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        return new File(path).exists();
    }

    /**
     * Get the parent directory of a path.
     *
     * @param path the file or directory path
     * @return the parent directory path, or null if unavailable
     */
    public static String getParentPath(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        File file = new File(path);
        File parent = file.getParentFile();
        return parent != null ? parent.getAbsolutePath() : null;
    }

    /**
     * Join two path segments.
     *
     * @param basePath     the base path
     * @param relativePath the relative path to append
     * @return the combined path
     */
    public static String joinPath(String basePath, String relativePath) {
        if (basePath == null || basePath.isEmpty()) {
            return relativePath;
        }
        if (relativePath == null || relativePath.isEmpty()) {
            return basePath;
        }
        return new File(basePath, relativePath).getAbsolutePath();
    }
}
