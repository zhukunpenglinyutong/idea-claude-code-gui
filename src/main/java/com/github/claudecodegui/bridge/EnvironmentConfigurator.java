// TODO: consider extracting WSL env propagation into a dedicated helper class
package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.ShellExecutor;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Environment configurator.
 * Responsible for configuring process environment variables.
 */
public class EnvironmentConfigurator {

    private static final Logger LOG = Logger.getInstance(EnvironmentConfigurator.class);
    private static final String CLAUDE_PERMISSION_ENV = "CLAUDE_PERMISSION_DIR";
    private static final String CLAUDE_SESSION_ID_ENV = "CLAUDE_SESSION_ID";
    private static final String CLAUDE_PERMISSION_SAFETY_NET_ENV = "CLAUDE_PERMISSION_SAFETY_NET_MS";
    private static final String CODEX_HOME_ENV = "CODEX_HOME";
    private static final String HOME_ENV = "HOME";
    private static final Pattern WSL_MOUNT_PATH_PATTERN = Pattern.compile("^/mnt/([a-zA-Z])(?:/(.*))?$");

    private final CodemossSettingsService settingsService;
    private volatile String cachedPermissionDir = null;
    private volatile String sessionId = null;

    // Cache for Codex env_key values from config.toml
    private volatile Map<String, String> cachedCodexEnvVars = null;

    public EnvironmentConfigurator() {
        this(new CodemossSettingsService());
    }

    EnvironmentConfigurator(CodemossSettingsService settingsService) {
        this.settingsService = settingsService;
    }

    /**
     * Updates the process environment variables, ensuring PATH includes the Node.js directory.
     * Supports both Windows (Path) and Unix (PATH) naming conventions.
     * The configured Node.js directory is prepended to PATH with highest priority.
     */
    public void updateProcessEnvironment(ProcessBuilder pb, String nodeExecutable) {
        Map<String, String> env = pb.environment();

        // Use PlatformUtils to get the PATH variable (case-insensitive)
        String path = PlatformUtils.isWindows() ?
                              PlatformUtils.getEnvIgnoreCase("PATH") :
                              env.get("PATH");

        if (path == null) {
            path = "";
        }

        StringBuilder newPath = new StringBuilder();
        String separator = File.pathSeparator;

        // 1. Prepend the directory containing Node.js with highest priority
        //    Remove it from existing PATH first to avoid duplicates
        if (nodeExecutable != null && !nodeExecutable.equals("node")) {
            File nodeFile = new File(nodeExecutable);
            String nodeDir = nodeFile.getParent();
            if (nodeDir != null) {
                // Remove existing nodeDir from PATH to avoid duplicates
                String cleanedPath = removePathEntry(path, nodeDir);
                // Prepend nodeDir at the beginning for highest priority
                newPath.append(nodeDir);
                if (!cleanedPath.isEmpty()) {
                    newPath.append(separator).append(cleanedPath);
                }
            } else {
                newPath.append(path);
            }
        } else {
            newPath.append(path);
        }

        // 2. Add common paths based on the platform (append to the end)
        String currentPath = newPath.toString();
        if (PlatformUtils.isWindows()) {
            // Common Windows paths
            String[] windowsPaths = {
                    System.getenv("ProgramFiles") + "\\nodejs",
                    System.getenv("APPDATA") + "\\npm",
                    // OMP Windows native installer: %LOCALAPPDATA%\omp\omp.exe
                    System.getenv("LOCALAPPDATA") + "\\omp",
                    System.getenv("LOCALAPPDATA") + "\\Programs\\nodejs"
            };
            for (String p : windowsPaths) {
                if (!p.contains("null") && !pathContains(currentPath, p)) {
                    newPath.append(separator).append(p);
                }
            }
        } else {
            // Common macOS/Linux paths
            String userHome = PlatformUtils.getHomeDirectory();
            String[] unixPaths = {
                    "/usr/local/bin",
                    "/opt/homebrew/bin",
                    "/usr/bin",
                    "/bin",
                    "/usr/sbin",
                    "/sbin",
                    userHome + "/.nvm/current/bin",
                    // Python / uv / pip tool installation directory (uvx, uv, etc.)
                    userHome + "/.local/bin",
                    // Rust / cargo tool installation directory
                    userHome + "/.cargo/bin",
                    // Headless CLI providers (IDE PATH often lacks login-shell dirs)
                    userHome + "/.kimi-code/bin",
                    userHome + "/.kimi/bin",
                    userHome + "/.opencode/bin",
                    userHome + "/.grok/bin",
                    userHome + "/.pi/bin",
                    userHome + "/.omp/bin",
                    userHome + "/.mimo/bin",
                    userHome + "/.mimocode",
                    // Bun global installs (bun add -g) land here, e.g. omp CLI
                    userHome + "/.bun/bin",
                    // Yarn classic global installs
                    userHome + "/.yarn/bin",
                    // pnpm global installs (PNPM_HOME defaults per platform)
                    userHome + "/Library/pnpm",
                    userHome + "/.local/share/pnpm",
                    userHome + "/.claude/bin",
                    // DeepSeek Harness (Hermes installer keeps node + dsh together)
                    userHome + "/.hermes/node/bin",
                    userHome + "/.dsh/bin",
            };
            for (String p : unixPaths) {
                if (!pathContains(currentPath, p)) {
                    newPath.append(separator).append(p);
                }
            }
        }

        // 3. Set the PATH environment variable
        // Windows requires setting both PATH and Path (some programs only recognize one)
        String newPathStr = newPath.toString();
        if (PlatformUtils.isWindows()) {
            // Remove potentially existing old values to avoid duplicates
            env.remove("PATH");
            env.remove("Path");
            env.remove("path");
            // Set multiple case variations to ensure compatibility
            env.put("PATH", newPathStr);
            env.put("Path", newPathStr);
        } else {
            env.put("PATH", newPathStr);
        }

        // 4. Ensure HOME matches the process type. Native Windows child processes
        // must not inherit WSL mount paths such as /mnt/c/Users/me.
        boolean isWslNode = NodeDetector.isWslPath(nodeExecutable);
        String home = resolveHomeForNodeEnvironment(nodeExecutable, env.get(HOME_ENV));
        if (home != null && !home.isEmpty()) {
            env.put(HOME_ENV, home);
        }

        // 5. Ensure CODEX_HOME is stable and non-empty (Codex uses it to locate config/sessions/skills)
        // Environment variables may be missing when launched from macOS GUI; relying on implicit defaults causes unstable feature detection (e.g. skills tool appearing intermittently)
        String codexHome = env.get(CODEX_HOME_ENV);
        if (codexHome == null || codexHome.trim().isEmpty()) {
            if (home != null && !home.isEmpty()) {
                env.put(CODEX_HOME_ENV, appendChildPath(home, ".codex", isWslNode));
            }
        } else {
            env.put(CODEX_HOME_ENV, normalizePathForNodeEnvironment(codexHome, isWslNode));
        }

        configurePermissionEnv(env, nodeExecutable);
    }

    static String resolveHomeForNodeEnvironment(String nodeExecutable, String currentHome) {
        boolean isWslNode = NodeDetector.isWslPath(nodeExecutable);
        if (currentHome != null && !currentHome.isEmpty()) {
            return normalizePathForNodeEnvironment(currentHome, isWslNode);
        }

        String resolvedHome = NodeDetector.resolveHomeForFileOps(nodeExecutable);
        if (resolvedHome == null || resolvedHome.isEmpty()) {
            return resolvedHome;
        }
        return normalizePathForNodeEnvironment(resolvedHome, isWslNode);
    }

    static String normalizePathForNodeEnvironment(String path, boolean isWslNode) {
        if (path == null || path.isEmpty()) {
            return path;
        }
        if (isWslNode) {
            return NodeDetector.convertToWslPath(path);
        }
        String windowsPath = convertWslMountPathToWindowsPath(path);
        return windowsPath != null ? windowsPath : path;
    }

    static String convertWslMountPathToWindowsPath(String path) {
        if (!PlatformUtils.isWindows() || path == null || path.isEmpty()) {
            return null;
        }
        Matcher matcher = WSL_MOUNT_PATH_PATTERN.matcher(path);
        if (!matcher.matches()) {
            return null;
        }
        String drive = matcher.group(1).toUpperCase();
        String rest = matcher.group(2);
        if (rest == null || rest.isEmpty()) {
            return drive + ":\\";
        }
        return drive + ":\\" + rest.replace('/', '\\');
    }

    private static String appendChildPath(String parent, String child, boolean isWslNode) {
        if (isWslNode) {
            String normalizedParent = parent.replace('\\', '/');
            while (normalizedParent.endsWith("/")) {
                normalizedParent = normalizedParent.substring(0, normalizedParent.length() - 1);
            }
            return normalizedParent + "/" + child;
        }
        return Paths.get(parent, child).toString();
    }

    /**
     * Configures permission-related environment variables.
     *
     * <p>Equivalent to calling {@link #configurePermissionEnv(Map, String)} with a
     * {@code null} node executable, which disables WSL path translation. Prefer the
     * two-arg overload from production code paths; this one exists for callers (and
     * tests) that don't have a node path on hand.
     */
    public void configurePermissionEnv(Map<String, String> env) {
        configurePermissionEnv(env, null);
    }

    /** Like {@link #configurePermissionEnv(Map)}, but also translates the IPC dir and sets WSLENV when node is a WSL binary. */
    public void configurePermissionEnv(Map<String, String> env, String nodeExecutable) {
        if (env == null) {
            return;
        }
        boolean isWsl = NodeDetector.isWslPath(nodeExecutable);
        String permissionDir = getPermissionDirectory();
        if (permissionDir != null) {
            env.put(CLAUDE_PERMISSION_ENV, isWsl ? NodeDetector.convertToWslPath(permissionDir) : permissionDir);
        }
        String sid = getSessionId();
        if (sid != null) {
            env.put(CLAUDE_SESSION_ID_ENV, sid);
        }
        env.put(CLAUDE_PERMISSION_SAFETY_NET_ENV, String.valueOf(getPermissionSafetyNetMs()));
        propagateWslEnv(env, isWsl);
    }

    // Permission vars that must cross the Windows→WSL boundary via WSLENV.
    private static final String[] WSL_PROPAGATED_KEYS = {
            CLAUDE_PERMISSION_ENV,
            CLAUDE_SESSION_ID_ENV,
            CLAUDE_PERMISSION_SAFETY_NET_ENV
    };

    /** Appends permission-bridge keys to WSLENV so they reach the daemon inside WSL. */
    private static void propagateWslEnv(Map<String, String> env, boolean isWsl) {
        if (!isWsl) {
            return;
        }
        String existing = env.get("WSLENV");
        LinkedHashSet<String> entries = new LinkedHashSet<>();
        if (existing != null && !existing.isEmpty()) {
            for (String token : existing.split(":")) {
                if (!token.isEmpty()) {
                    entries.add(token);
                }
            }
        }
        for (String key : WSL_PROPAGATED_KEYS) {
            entries.add(key);
        }
        env.put("WSLENV", String.join(":", entries));
    }

    /**
     * Returns the permission IPC directory in a form the given node executable can
     * read. When {@code nodeExecutable} is a WSL binary on Windows (per
     * {@link NodeDetector#isWslPath}), converts the Windows-style path to its
     * {@code /mnt/<drive>/...} or stripped UNC-WSL equivalent so that both sides
     * of the bridge operate on the same physical directory. Otherwise returns the
     * input unchanged.
     */
    static String translatePermissionDirForNode(String permissionDir, String nodeExecutable) {
        if (permissionDir == null || permissionDir.isEmpty()) {
            return permissionDir;
        }
        if (NodeDetector.isWslPath(nodeExecutable)) {
            return NodeDetector.convertToWslPath(permissionDir);
        }
        return permissionDir;
    }

    long getPermissionSafetyNetMs() {
        try {
            long timeoutSeconds = settingsService.getPermissionDialogTimeoutSeconds();
            return (timeoutSeconds + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
        } catch (Exception e) {
            LOG.warn("[EnvironmentConfigurator] Failed to read permission timeout for Node safety net; errorClass="
                    + e.getClass().getSimpleName());
            return (CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                    + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
        }
    }

    /**
     * Get or generate session ID for this instance.
     *
     * @return Session ID
     */
    public String getSessionId() {
        if (this.sessionId == null) {
            synchronized (this) {
                if (this.sessionId == null) {
                    this.sessionId = java.util.UUID.randomUUID().toString();
                }
            }
        }
        return this.sessionId;
    }

    /**
     * Explicitly sets the session ID to align permission request routing
     * across multiple bridge instances.
     */
    public void setSessionId(String sessionId) {
        if (sessionId == null) {
            return;
        }
        String normalized = sessionId.trim();
        if (normalized.isEmpty()) {
            return;
        }
        this.sessionId = normalized;
    }

    /**
     * Gets the permission directory path.
     *
     * The directory is created with restrictive permissions (POSIX 0700 on Unix-like
     * filesystems) because it carries permission IPC payloads and tmpdir is shared
     * across all users on multi-user systems. On Windows / non-POSIX filesystems we
     * fall back to default permissions: tmpdir on Windows is per-user, and the file
     * names contain unguessable request IDs, so other-user access is already gated.
     */
    public String getPermissionDirectory() {
        String cached = this.cachedPermissionDir;
        if (cached != null) {
            return cached;
        }

        Path dir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
        try {
            Files.createDirectories(dir);
            hardenPermissionDirectory(dir);
        } catch (IOException e) {
            LOG.error("[EnvironmentConfigurator] Failed to prepare permission dir: " + dir + " (" + e.getMessage() + ")");
        }
        cachedPermissionDir = dir.toAbsolutePath().toString();
        return cachedPermissionDir;
    }

    /**
     * Tightens the permission-IPC directory to owner-only access on POSIX systems.
     * Silent no-op on filesystems that don't support POSIX file permissions.
     */
    private void hardenPermissionDirectory(Path dir) {
        try {
            if (!Files.getFileStore(dir).supportsFileAttributeView(java.nio.file.attribute.PosixFileAttributeView.class)) {
                return;
            }
            Files.setPosixFilePermissions(dir,
                    java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException | IOException ignored) {
            // Filesystem (e.g. Windows NTFS, FAT32) does not support POSIX perms.
            // The directory still inherits the user's tmpdir ACL, which is acceptable.
        }
    }

    /**
     * Checks whether the PATH already contains the specified path.
     * Performs case-insensitive comparison on Windows.
     */
    private boolean pathContains(String pathEnv, String targetPath) {
        if (pathEnv == null || targetPath == null) {
            return false;
        }
        if (PlatformUtils.isWindows()) {
            return pathEnv.toLowerCase().contains(targetPath.toLowerCase());
        }
        return pathEnv.contains(targetPath);
    }

    /**
     * Removes a specific path entry from the PATH environment variable.
     * Performs case-insensitive comparison on Windows.
     *
     * @param pathEnv    The PATH environment variable value
     * @param targetPath The path entry to remove
     * @return PATH with the target entry removed
     */
    private String removePathEntry(String pathEnv, String targetPath) {
        if (pathEnv == null || pathEnv.isEmpty() || targetPath == null || targetPath.isEmpty()) {
            return pathEnv != null ? pathEnv : "";
        }

        String separator = File.pathSeparator;
        String[] entries = pathEnv.split(Pattern.quote(separator));
        StringBuilder result = new StringBuilder();

        for (String entry : entries) {
            String trimmedEntry = entry.trim();
            if (trimmedEntry.isEmpty()) {
                continue;
            }
            // Case-insensitive comparison on Windows, case-sensitive on Unix
            boolean shouldSkip;
            if (PlatformUtils.isWindows()) {
                shouldSkip = trimmedEntry.equalsIgnoreCase(targetPath);
            } else {
                shouldSkip = trimmedEntry.equals(targetPath);
            }

            if (!shouldSkip) {
                if (result.length() > 0) {
                    result.append(separator);
                }
                result.append(trimmedEntry);
            }
        }

        return result.toString();
    }

    /**
     * Configures temporary directory environment variables.
     */
    public void configureTempDir(Map<String, String> env, File tempDir) {
        if (env == null || tempDir == null) {
            return;
        }
        String tmpPath = tempDir.getAbsolutePath();
        env.put("TMPDIR", tmpPath);
        env.put("TEMP", tmpPath);
        env.put("TMP", tmpPath);
    }

    /**
     * Configures project path environment variables.
     */
    public void configureProjectPath(Map<String, String> env, String cwd) {
        if (env == null || cwd == null || cwd.isEmpty() || "undefined".equals(cwd) || "null".equals(cwd)) {
            return;
        }
        env.put("IDEA_PROJECT_PATH", cwd);
        env.put("PROJECT_PATH", cwd);
    }

    /**
     * Configures attachment-related environment variables.
     */
    public void configureAttachmentEnv(Map<String, String> env, boolean hasAttachments) {
        if (env == null) {
            return;
        }
        if (hasAttachments) {
            env.put("CLAUDE_USE_STDIN", "true");
        }
    }

    /**
     * Clears all cached values.
     */
    public void clearCache() {
        this.cachedPermissionDir = null;
        this.cachedCodexEnvVars = null;
    }

    /**
     * Configure Codex-specific environment variables.
     * Reads ~/.codex/config.toml to find custom env_key settings and loads those
     * environment variables from the system shell environment.
     * <p>
     * This is necessary because IDE processes often don't inherit shell environment
     * variables set in ~/.zshrc or ~/.bash_profile when launched from Dock/launcher.
     *
     * @param env ProcessBuilder environment map to update
     */
    public void configureCodexEnv(Map<String, String> env) {
        if (env == null) {
            return;
        }

        try {
            String accessMode = new CodemossSettingsService().getCodexRuntimeAccessMode();
            if (CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE.equals(accessMode)) {
                LOG.debug("[Codex] Skipping env_key sync from ~/.codex/config.toml: local access is not authorized");
                return;
            }

            // 1. Find all env_key names from ~/.codex/config.toml
            Set<String> envKeyNames = parseCodexConfigEnvKeys();
            if (envKeyNames.isEmpty()) {
                LOG.debug("[Codex] No custom env_key found in config.toml");
                return;
            }

            LOG.info("[Codex] Found env_key names in config.toml: " + envKeyNames);

            // 2. Try to get values for each env_key from multiple sources
            for (String envKeyName : envKeyNames) {
                // Skip if already set in environment
                if (env.containsKey(envKeyName) && env.get(envKeyName) != null && !env.get(envKeyName).isEmpty()) {
                    LOG.debug("[Codex] Env var already set: " + envKeyName);
                    continue;
                }

                // Try to get value from system
                String value = resolveEnvValue(envKeyName);
                if (value != null && !value.isEmpty()) {
                    env.put(envKeyName, value);
                    LOG.info("[Codex] Set env var from shell: " + envKeyName + " (length: " + value.length() + ")");
                } else {
                    LOG.warn("[Codex] Could not resolve env var: " + envKeyName +
                                     ". Please ensure it's set in your shell environment.");
                }
            }
        } catch (Exception e) {
            LOG.warn("[Codex] Error configuring Codex env: " + e.getMessage());
        }
    }

    /**
     * Parse ~/.codex/config.toml to extract all env_key values.
     *
     * @return Set of environment variable names referenced by env_key
     */
    private Set<String> parseCodexConfigEnvKeys() {
        Set<String> envKeys = new HashSet<>();
        String home = NodeDetector.resolveHomeForFileOps();
        if (home == null || home.isEmpty()) {
            return envKeys;
        }

        Path configPath = Paths.get(home, ".codex", "config.toml");
        if (!Files.exists(configPath)) {
            LOG.debug("[Codex] config.toml not found: " + configPath);
            return envKeys;
        }

        try {
            String content = Files.readString(configPath, StandardCharsets.UTF_8);

            // Pattern to match: env_key = "VALUE" or env_key = 'VALUE'
            Pattern pattern = Pattern.compile("env_key\\s*=\\s*[\"']([^\"']+)[\"']");
            Matcher matcher = pattern.matcher(content);

            while (matcher.find()) {
                String envKeyName = matcher.group(1).trim();
                if (!envKeyName.isEmpty()) {
                    envKeys.add(envKeyName);
                }
            }
        } catch (IOException e) {
            LOG.warn("[Codex] Failed to read config.toml: " + e.getMessage());
        }

        return envKeys;
    }

    /**
     * Resolve environment variable value from multiple sources.
     * Order of precedence:
     * 1. System.getenv() - already inherited env vars
     * 2. Shell environment via subprocess (macOS/Linux)
     * 3. Parse shell config files as fallback
     *
     * @param envName Environment variable name
     * @return Value or null if not found
     */
    private String resolveEnvValue(String envName) {
        // 1. Try System.getenv first (might already be inherited)
        String value = System.getenv(envName);
        if (value != null && !value.isEmpty()) {
            LOG.debug("[Codex] Env var found via System.getenv: " + envName);
            return value;
        }

        // 2. For macOS/Linux, try to get from shell environment
        if (!PlatformUtils.isWindows()) {
            value = getEnvFromShell(envName);
            if (value != null && !value.isEmpty()) {
                return value;
            }
        } else {
            // Windows: try to get from shell environment via cmd
            value = getEnvFromWindowsShell(envName);
            if (value != null && !value.isEmpty()) {
                return value;
            }
        }

        // 3. Parse shell config files as last resort
        value = parseEnvFromShellConfigs(envName);
        if (value != null && !value.isEmpty()) {
            return value;
        }

        return null;
    }

    /**
     * Validate environment variable name format.
     * Valid names start with a letter or underscore, followed by letters, digits, or underscores.
     * This prevents command injection when the name is used in shell commands.
     *
     * @param envName Environment variable name to validate
     * @return true if valid, false otherwise
     */
    private boolean isValidEnvName(String envName) {
        if (envName == null || envName.isEmpty()) {
            return false;
        }
        return envName.matches("^[a-zA-Z_][a-zA-Z0-9_]*$");
    }

    /**
     * Allowlist of shells that may be invoked to source the user's login env.
     * `$SHELL` is read from the process environment which is technically attacker-influenced;
     * restricting to this set prevents a hostile parent from pointing us at an arbitrary binary
     * (e.g. a script in /tmp) under the guise of a login shell.
     */
    private static final Set<String> ALLOWED_LOGIN_SHELLS = Set.of(
            "/bin/zsh",
            "/bin/bash",
            "/bin/sh",
            "/usr/bin/zsh",
            "/usr/bin/bash",
            "/usr/bin/sh",
            "/usr/local/bin/zsh",
            "/usr/local/bin/bash",
            "/opt/homebrew/bin/zsh",
            "/opt/homebrew/bin/bash"
    );

    /**
     * Resolve a login shell binary to invoke, honoring `$SHELL` only when it points
     * at an allowlisted executable. Returns {@code null} when no acceptable shell exists.
     */
    String resolveLoginShell() {
        String shell = System.getenv("SHELL");
        if (shell != null && !shell.isEmpty() && ALLOWED_LOGIN_SHELLS.contains(shell)) {
            return shell;
        }
        if (shell != null && !shell.isEmpty()) {
            LOG.warn("[Codex] $SHELL=" + shell + " is not in allowlist; falling back to /bin/zsh");
        }
        // Prefer zsh (macOS default) then bash; only return a candidate that actually exists.
        for (String candidate : new String[]{"/bin/zsh", "/bin/bash", "/bin/sh"}) {
            if (new File(candidate).canExecute()) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Get environment variable by executing a login shell (macOS/Linux).
     * This captures environment variables set in .zshrc, .bash_profile, etc.
     *
     * @param envName Environment variable name
     * @return Value or null
     */
    private String getEnvFromShell(String envName) {
        // Validate env name to prevent command injection
        if (!isValidEnvName(envName)) {
            LOG.warn("[Codex] Invalid env var name, skipping: " + envName);
            return null;
        }

        // Use login + interactive shell to get full environment
        // fnm and other version managers require interactive shell to load .zshrc
        String shell = resolveLoginShell();
        if (shell == null) {
            LOG.warn("[Codex] No allowlisted login shell available; skipping env lookup for: " + envName);
            return null;
        }

        List<String> command = new ArrayList<>();
        command.add(shell);
        command.add("-l"); // Login shell
        command.add("-i"); // Interactive shell (needed for fnm, nvm etc.)
        command.add("-c");
        command.add("echo \"$" + envName + "\"");

        ShellExecutor.ExecutionResult result = ShellExecutor.executeAndGetLast(
                command,
                ShellExecutor.createShellOutputFilter(),
                "[Codex] getEnvFromShell(" + envName + ")",
                ShellExecutor.DEFAULT_TIMEOUT_SECONDS
        );

        if (result.isSuccess() && result.getOutput() != null) {
            LOG.debug("[Codex] Env var found via shell: " + envName);
            return result.getOutput();
        }

        return null;
    }

    /**
     * Get environment variable from Windows shell (cmd).
     *
     * @param envName Environment variable name
     * @return Value or null
     */
    private String getEnvFromWindowsShell(String envName) {
        // Validate env name to prevent command injection
        if (!isValidEnvName(envName)) {
            LOG.warn("[Codex] Invalid env var name, skipping: " + envName);
            return null;
        }

        try {
            List<String> command = new ArrayList<>();
            command.add("cmd");
            command.add("/c");
            command.add("echo %" + envName + "%");

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.redirectErrorStream(true);

            Process process = pb.start();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line = reader.readLine();
                process.waitFor();

                // Windows returns "%VARNAME%" if not set
                if (line != null && !line.trim().isEmpty() &&
                            !line.trim().equals("%" + envName + "%")) {
                    LOG.debug("[Codex] Env var found via Windows shell: " + envName);
                    return line.trim();
                }
            }
        } catch (Exception e) {
            LOG.debug("[Codex] Failed to get env from Windows shell: " + e.getMessage());
        }
        return null;
    }

    /**
     * Parse environment variable from shell config files.
     * Checks .zshrc, .bash_profile, .bashrc, .profile
     *
     * @param envName Environment variable name
     * @return Value or null
     */
    private String parseEnvFromShellConfigs(String envName) {
        String home = NodeDetector.resolveHomeForFileOps();
        if (home == null || home.isEmpty()) {
            return null;
        }

        // Shell config files to check (in order of preference)
        String[] configFiles;
        if (PlatformUtils.isWindows()) {
            // Windows doesn't use these, but check anyway
            configFiles = new String[]{};
        } else {
            configFiles = new String[]{
                    ".zshrc",
                    ".bash_profile",
                    ".bashrc",
                    ".profile",
                    ".zshenv",
                    ".zprofile"
            };
        }

        // Pattern to match: export VAR=value or VAR=value
        Pattern pattern = Pattern.compile(
                "(?:export\\s+)?" + Pattern.quote(envName) + "\\s*=\\s*[\"']?([^\"'\\n]+)[\"']?"
        );

        for (String configFile : configFiles) {
            Path configPath = Paths.get(home, configFile);
            if (!Files.exists(configPath)) {
                continue;
            }

            try {
                String content = Files.readString(configPath, StandardCharsets.UTF_8);
                Matcher matcher = pattern.matcher(content);

                if (matcher.find()) {
                    String value = matcher.group(1).trim();
                    if (!value.isEmpty()) {
                        LOG.debug("[Codex] Env var found in " + configFile + ": " + envName);
                        return value;
                    }
                }
            } catch (IOException e) {
                LOG.debug("[Codex] Failed to read " + configFile + ": " + e.getMessage());
            }
        }

        return null;
    }
}
