package com.github.claudecodegui.dependency;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SDK dependency manager.
 * Manages SDK installations under the ~/.codemoss/dependencies/ directory.
 */
public class DependencyManager {

    private static final Logger LOG = Logger.getInstance(DependencyManager.class);
    private static final String DEPS_DIR_NAME = "dependencies";
    private static final String MANIFEST_FILE = "manifest.json";
    private static final String INSTALLED_MARKER = ".installed";

    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final EnvironmentConfigurator envConfigurator;
    /** Caches resolved WSL npm paths keyed by node path. Populated lazily on first lookup. */
    private final Map<String, String> wslNpmPathCache = new ConcurrentHashMap<>();

    public DependencyManager() {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        // Use shared NodeDetector instance (singleton pattern)
        this.nodeDetector = NodeDetector.getInstance();
        this.envConfigurator = new EnvironmentConfigurator();
    }

    public DependencyManager(NodeDetector nodeDetector) {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        this.nodeDetector = nodeDetector;
        this.envConfigurator = new EnvironmentConfigurator();
    }

    /**
     * Returns the root dependencies directory path (~/.codemoss/dependencies/).
     *
     * <p>When the active Node.js executable is a WSL path (Unix-style on Windows), the
     * directory is rooted inside the WSL filesystem so that both the Windows JVM and the
     * WSL node process (which resolves {@code os.homedir()} to the Linux home) refer to the
     * same physical location.  The WSL home is obtained as a Windows UNC path via
     * {@link NodeDetector#resolveWslHomeUncPath()} so that {@link java.nio.file.Files}
     * operations work from the Windows side.  Falls back to the Windows home directory if
     * the UNC lookup fails.
     */
    public Path getDependenciesDir() {
        String nodePath = nodeDetector.findNodeExecutable();
        if (NodeDetector.isWslPath(nodePath)) {
            String wslHomeUnc = NodeDetector.resolveWslHomeUncPath();
            if (wslHomeUnc != null && !wslHomeUnc.isEmpty()) {
                return Paths.get(wslHomeUnc, ".codemoss", DEPS_DIR_NAME);
            }
            LOG.warn("[DependencyManager] WSL node detected but could not resolve WSL home UNC path; "
                    + "falling back to Windows home. SDK may not be found by the WSL node process.");
        }
        return Paths.get(PlatformUtils.getHomeDirectory(), ".codemoss", DEPS_DIR_NAME);
    }

    /**
     * Returns the installation directory for a given SDK.
     */
    public Path getSdkDir(String sdkId) {
        return getDependenciesDir().resolve(sdkId);
    }

    /**
     * Returns the node_modules directory for a given SDK.
     */
    public Path getSdkNodeModulesDir(String sdkId) {
        return getSdkDir(sdkId).resolve("node_modules");
    }

    /**
     * Checks whether an SDK is installed.
     */
    public boolean isInstalled(String sdkId) {
        if ("gemini-cli".equals(sdkId)) {
            return com.github.claudecodegui.cli.CliStatusDetector.detect(com.github.claudecodegui.cli.CliToolId.AGY).isInstalled();
        }

        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return false;
        }

        // Check if the main package exists in node_modules
        Path packageDir = getPackageDir(sdkId, sdk.getNpmPackage());
        if (!Files.exists(packageDir)) {
            return false;
        }

        // If the package exists but the .installed marker file is missing, create it automatically.
        // This handles the case where the user ran npm install manually.
        Path sdkDir = getSdkDir(sdkId);
        Path markerFile = sdkDir.resolve(INSTALLED_MARKER);
        if (!Files.exists(markerFile)) {
            try {
                String version = getInstalledVersionFromPackage(sdkId, sdk.getNpmPackage());
                Files.writeString(markerFile, version != null ? version : "unknown");
                LOG.info("[DependencyManager] Created missing marker file for manually installed SDK: " + sdkId);
            } catch (Exception e) {
                LOG.warn("[DependencyManager] Failed to create marker file: " + e.getMessage());
            }
        }

        return true;
    }

    /**
     * Reads the version from package.json (internal use, does not depend on isInstalled).
     */
    private String getInstalledVersionFromPackage(String sdkId, String npmPackage) {
        Path packageJson = getPackageDir(sdkId, npmPackage).resolve("package.json");
        if (!Files.exists(packageJson)) {
            return null;
        }

        try (Reader reader = Files.newBufferedReader(packageJson, StandardCharsets.UTF_8)) {
            JsonObject json = JsonParser.parseReader(reader).getAsJsonObject();
            if (json.has("version")) {
                return json.get("version").getAsString();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to read version from package.json: " + e.getMessage());
        }

        return null;
    }

    /**
     * Returns the path of a package within node_modules.
     */
    private Path getPackageDir(String sdkId, String npmPackage) {
        // @scope/package -> node_modules/@scope/package
        String[] parts = npmPackage.split("/");
        Path nodeModules = getSdkNodeModulesDir(sdkId);
        Path packagePath = nodeModules;
        for (String part : parts) {
            packagePath = packagePath.resolve(part);
        }
        return packagePath;
    }

    /**
     * Returns the installed version.
     */
    public String getInstalledVersion(String sdkId) {
        if ("gemini-cli".equals(sdkId)) {
            com.github.claudecodegui.cli.CliToolStatus status = com.github.claudecodegui.cli.CliStatusDetector.detect(com.github.claudecodegui.cli.CliToolId.AGY);
            return status.getVersion() != null ? status.getVersion() : (status.isInstalled() ? "installed" : null);
        }

        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null || !isInstalled(sdkId)) {
            return null;
        }

        return getInstalledVersionFromPackage(sdkId, sdk.getNpmPackage());
    }

    /**
     * Fetches the latest version from the NPM Registry.
     */
    public String getLatestVersion(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return null;
        }

        try {
            String nodePath = nodeDetector.findNodeExecutable();
            String npmPath = getNpmPath(nodePath);

            ProcessBuilder pb = new ProcessBuilder(buildNpmCommand(
                    nodePath, npmPath, "view", sdk.getNpmPackage(), "version"));
            configureProcessEnvironment(pb);

            Process process = pb.start();
            StringBuilder output = new StringBuilder();

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line.trim());
                }
            }

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return null;
            }

            if (process.exitValue() == 0) {
                return output.toString().trim();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to get latest version: " + e.getMessage());
        }

        List<String> fallbackVersions = sdk.getFallbackVersions();
        if (!fallbackVersions.isEmpty()) {
            return fallbackVersions.get(0);
        }

        return null;
    }

    public List<String> getAvailableVersions(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return Collections.emptyList();
        }

        try {
            String nodePath = nodeDetector.findNodeExecutable();
            String npmPath = getNpmPath(nodePath);

            ProcessBuilder pb = new ProcessBuilder(buildNpmCommand(
                    nodePath, npmPath, "view", sdk.getNpmPackage(), "versions", "--json"));
            configureProcessEnvironment(pb);

            Process process = pb.start();
            StringBuilder output = new StringBuilder();

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line);
                }
            }

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return Collections.emptyList();
            }

            if (process.exitValue() != 0) {
                return Collections.emptyList();
            }

            return parseVersionList(output.toString());
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to get available versions: " + e.getMessage());
            return Collections.emptyList();
        }
    }

    public List<String> getFallbackVersions(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return Collections.emptyList();
        }
        return sdk.getFallbackVersions();
    }

    /**
     * Checks whether an update is available.
     */
    public UpdateInfo checkForUpdates(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return UpdateInfo.error(sdkId, "Unknown SDK", "Unknown SDK: " + sdkId);
        }

        if (!isInstalled(sdkId)) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "SDK not installed");
        }

        String currentVersion = getInstalledVersion(sdkId);
        if (currentVersion == null) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "Cannot read installed version");
        }

        String latestVersion = getLatestVersion(sdkId);
        if (latestVersion == null) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "Cannot fetch latest version");
        }

        if (compareVersions(currentVersion, latestVersion) < 0) {
            return UpdateInfo.updateAvailable(sdkId, sdk.getDisplayName(), currentVersion, latestVersion);
        }

        return UpdateInfo.noUpdate(sdkId, sdk.getDisplayName(), currentVersion);
    }

    /**
     * Installs an SDK (asynchronous).
     */
    public CompletableFuture<InstallResult> installSdk(String sdkId, Consumer<String> logCallback) {
        return CompletableFuture.supplyAsync(() -> installSdkSync(sdkId, logCallback));
    }

    /**
     * Installs an SDK (synchronous).
     */
    public InstallResult installSdkSync(String sdkId, Consumer<String> logCallback) {
        return installSdkSync(sdkId, null, logCallback);
    }

    /**
     * Installs an SDK at a requested version (synchronous).
     */
    public InstallResult installSdkSync(String sdkId, String requestedVersion, Consumer<String> logCallback) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return InstallResult.failure(sdkId, "Unknown SDK: " + sdkId, "");
        }

        StringBuilder logs = new StringBuilder();
        Consumer<String> log = (msg) -> {
            logs.append(msg).append("\n");
            if (logCallback != null) {
                logCallback.accept(msg);
            }
        };

        try {
            log.accept("Starting installation of " + sdk.getDisplayName() + "...");

            // 1. Check the Node.js environment
            String nodePath = nodeDetector.findNodeExecutable();
            if (nodePath == null || "node".equals(nodePath)) {
                String version = nodeDetector.verifyNodePath("node");
                if (version == null) {
                    return InstallResult.failure(sdkId,
                            "Node.js not found. Please configure Node.js path in Settings > Basic.",
                            logs.toString());
                }
            }
            log.accept("Using Node.js: " + nodePath);

            String npmPath = getNpmPath(nodePath);
            log.accept("Using npm: " + npmPath);

            // 2. Create the SDK directory
            Path sdkDir = getSdkDir(sdkId);

            // Path safety check: ensure sdkDir is within the expected dependencies directory to prevent path traversal attacks
            Path normalizedSdkDir = sdkDir.normalize().toAbsolutePath();
            Path normalizedDepsDir = getDependenciesDir().normalize().toAbsolutePath();
            if (!normalizedSdkDir.startsWith(normalizedDepsDir)) {
                return InstallResult.failure(sdkId,
                        "Security error: SDK directory path is outside dependencies directory",
                        logs.toString());
            }

            Files.createDirectories(sdkDir);
            log.accept("Created directory: " + sdkDir);

            // 3. Create package.json
            createPackageJson(sdkDir, sdk);
            log.accept("Created package.json");

            // 4. Pre-check npm cache permissions
            log.accept("Checking npm cache permissions...");
            if (!NpmPermissionHelper.checkCachePermission()) {
                log.accept("⚠️ Warning: npm cache may have permission issues, attempting to fix...");

                // Try to clean the cache
                if (NpmPermissionHelper.cleanNpmCache(npmPath)) {
                    log.accept("✓ npm cache cleaned successfully");
                } else if (NpmPermissionHelper.forceDeleteCache()) {
                    log.accept("✓ npm cache directory deleted successfully");
                } else {
                    log.accept("⚠️ Warning: Could not clean cache automatically, will try installation anyway");
                }
            }

            // 5. Run npm install (with retry mechanism)
            String normalizedRequestedVersion = normalizeRequestedVersion(requestedVersion);
            List<String> packages = buildPackageSpecs(sdk, normalizedRequestedVersion);
            int maxRetries = 2;
            InstallResult lastResult = null;

            for (int attempt = 0; attempt <= maxRetries; attempt++) {
                if (attempt > 0) {
                    log.accept("\n🔄 Retry attempt " + attempt + "/" + maxRetries + "...");
                }

                log.accept("Running npm install...");
                boolean isWsl = NodeDetector.isWslPath(nodePath);
                List<String> command;
                if (isWsl) {
                    // Pass the WSL Unix path as a raw String — wrapping it in Paths.get() on
                    // Windows would convert forward slashes to backslashes (e.g. /home/foo →
                    // \home\foo), which WSL npm cannot resolve as a Linux absolute path.
                    String wslPrefix = NodeDetector.convertToWslPath(normalizedSdkDir.toString());
                    command = NpmPermissionHelper.buildInstallCommandWithFallback(
                            npmPath, wslPrefix, packages, attempt);
                    command.add(0, "wsl");
                } else {
                    command = NpmPermissionHelper.buildInstallCommandWithFallback(
                            npmPath, normalizedSdkDir, packages, attempt);
                }
                log.accept("Command: " + String.join(" ", command));

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(sdkDir.toFile());
                pb.redirectErrorStream(true);
                configureProcessEnvironment(pb);

                Process process = pb.start();

                // Read output in real time and collect logs
                StringBuilder installLogs = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        log.accept(line);
                        installLogs.append(line).append("\n");
                    }
                }

                boolean finished = process.waitFor(3, TimeUnit.MINUTES);
                if (!finished) {
                    process.destroyForcibly();
                    lastResult = InstallResult.failure(sdkId,
                            "Installation timed out (3 minutes)", logs.toString());
                    continue; // Retry
                }

                int exitCode = process.exitValue();
                if (exitCode == 0) {
                    // Installation succeeded, proceed to next steps
                    break;
                }

                // Installation failed, record the result
                String logsStr = logs.toString();
                lastResult = InstallResult.failure(sdkId,
                        "npm install failed with exit code: " + exitCode, logsStr);

                // If this is the last attempt, do not retry
                if (attempt == maxRetries) {
                    // Append troubleshooting suggestions
                    String solution = NpmPermissionHelper.generateErrorSolution(logsStr);
                    return InstallResult.failure(sdkId,
                            lastResult.getErrorMessage() + solution,
                            lastResult.getLogs());
                }

                // Detect error type and attempt to fix
                boolean fixed = false;
                if (NpmPermissionHelper.hasPermissionError(logsStr) ||
                            NpmPermissionHelper.hasCacheError(logsStr)) {

                    log.accept("⚠️ Detected npm cache/permission error, attempting to fix...");

                    // Strategy 1: Clean the cache
                    if (NpmPermissionHelper.cleanNpmCache(npmPath)) {
                        log.accept("✓ Cache cleaned, will retry");
                        fixed = true;
                    } else if (NpmPermissionHelper.forceDeleteCache()) {
                        log.accept("✓ Cache deleted, will retry");
                        fixed = true;
                    }

                    // Strategy 2: Fix permissions (Unix only)
                    if (!fixed && !PlatformUtils.isWindows()) {
                        log.accept("Attempting to fix cache ownership (may require password)...");
                        if (NpmPermissionHelper.fixCacheOwnership()) {
                            log.accept("✓ Ownership fixed, will retry");
                            fixed = true;
                        }
                    }
                }

                if (!fixed) {
                    log.accept("⚠️ Could not auto-fix the issue, will retry with --force flag");
                }

                // Brief delay before retrying
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return InstallResult.failure(sdkId, "Installation interrupted", logs.toString());
                }
            }

            // 6. Create the installation marker file
            String installedVersion = getInstalledVersion(sdkId);
            Path markerFile = sdkDir.resolve(INSTALLED_MARKER);
            Files.writeString(markerFile, installedVersion != null ? installedVersion : "unknown");

            // 7. Update the manifest
            updateManifest(sdkId, installedVersion);

            log.accept("Installation completed successfully!");
            log.accept("Installed version: " + installedVersion);

            return InstallResult.success(sdkId, installedVersion, logs.toString());

        } catch (Exception e) {
            LOG.error("[DependencyManager] Installation failed: " + e.getMessage(), e);
            log.accept("ERROR: " + e.getMessage());
            return InstallResult.failure(sdkId, e.getMessage(), logs.toString());
        }
    }

    /**
     * Uninstalls an SDK.
     *
     * @return true if the uninstallation completed fully, false if some files failed to delete
     */
    public boolean uninstallSdk(String sdkId) {
        try {
            Path sdkDir = getSdkDir(sdkId);
            if (!Files.exists(sdkDir)) {
                return true;
            }

            // Recursively delete the directory and collect paths that failed to delete
            List<Path> failedPaths = deleteDirectory(sdkDir);

            // Update the manifest
            removeFromManifest(sdkId);

            if (failedPaths.isEmpty()) {
                LOG.info("[DependencyManager] Uninstalled SDK completely: " + sdkId);
                return true;
            } else {
                // Some files failed to delete; log a warning but still return success (manifest is already updated)
                LOG.warn("[DependencyManager] Uninstalled SDK with " + failedPaths.size() +
                                 " files failed to delete: " + sdkId);
                return true; // Still return true because the SDK is functionally uninstalled
            }
        } catch (Exception e) {
            LOG.error("[DependencyManager] Failed to uninstall SDK: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Returns the status of all SDKs.
     */
    public JsonObject getAllSdkStatus() {
        JsonObject result = new JsonObject();

        for (SdkDefinition sdk : SdkDefinition.values()) {
            JsonObject status = new JsonObject();
            boolean installed = isInstalled(sdk.getId());

            status.addProperty("id", sdk.getId());
            status.addProperty("name", sdk.getDisplayName());
            status.addProperty("description", sdk.getDescription());
            status.addProperty("npmPackage", sdk.getNpmPackage());
            status.addProperty("installed", installed);
            // Add the status field for frontend consumption
            status.addProperty("status", installed ? "installed" : "not_installed");

            if (installed) {
                String version = getInstalledVersion(sdk.getId());
                status.addProperty("installedVersion", version);
                status.addProperty("version", version); // Also add the version field

                // Surface whether the installed version meets the SDK's minimum required
                // version (e.g. Claude SDK >= 0.3.182 for the Fable tier). The frontend uses
                // this to warn users before they hit a "model fable" 401 on old CLIs that
                // don't recognize the alias.
                String minRequired = sdk.getMinRequiredVersion();
                if (minRequired != null && version != null && !version.isEmpty()) {
                    status.addProperty("minimumVersion", minRequired);
                    status.addProperty("meetsMinimumVersion", compareVersions(version, minRequired) >= 0);
                }
            }

            result.add(sdk.getId(), status);
        }

        return result;
    }

    /**
     * Checks whether the Node.js environment is available.
     */
    public boolean checkNodeEnvironment() {
        try {
            String cachedPath = this.nodeDetector.getCachedNodePath();
            String cachedVersion = this.nodeDetector.getCachedNodeVersion();
            if (cachedPath != null && cachedVersion != null) {
                return true;
            }

            String nodePath = this.nodeDetector.findNodeExecutable();
            if (nodePath == null) {
                return false;
            }

            // findNodeExecutable() already verifies and caches on successful detection.
            // Only re-verify for the "node" fallback case where detection failed.
            NodeDetectionResult cached = this.nodeDetector.getCachedDetectionResult();
            if (cached != null && cached.isFound()) {
                return true;
            }

            // Fallback case: verify and cache in a single call (avoids double process spawn).
            NodeDetectionResult fallbackResult = this.nodeDetector.verifyAndCacheNodePath(nodePath);
            return fallbackResult.isFound();
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Node.js environment check failed: " + e.getMessage());
            return false;
        }
    }

    // ==================== Private methods ====================

    /**
     * Resolves the npm path based on the node path.
     */
    private String getNpmPath(String nodePath) {
        if (NodeDetector.isWslPath(nodePath)) {
            return resolveWslNpmPath(nodePath);
        }

        boolean windows = PlatformUtils.isWindows();

        // 1. Try to find npm in the same directory as Node.js
        if (nodePath != null && !"node".equals(nodePath)) {
            File nodeFile = new File(nodePath);
            String dir = nodeFile.getParent();
            if (dir != null) {
                File npmFile = findNpmFile(new File(dir), windows);
                if (npmFile != null) {
                    return npmFile.getAbsolutePath();
                }
            }
        }

        // 2. Windows: try to find the full path to npm from the PATH environment variable
        if (windows) {
            String pathEnv = System.getenv("PATH");
            if (pathEnv != null) {
                for (String pathDir : pathEnv.split(File.pathSeparator)) {
                    File npmFile = findNpmFile(new File(pathDir), windows);
                    if (npmFile != null) {
                        LOG.info("[DependencyManager] Found npm in PATH: " + npmFile.getAbsolutePath());
                        return npmFile.getAbsolutePath();
                    }
                }
            }
        }

        // 3. Fall back to the bare command name (usually works on Unix)
        return windows ? "npm.cmd" : "npm";
    }

    /**
     * 在指定目录中查找 npm 可执行文件。
     * <p>Windows 上 npm 可能以 {@code npm.cmd}（标准 Node.js 安装）或
     * {@code npm.exe}（mise、Volta 等版本管理器）形式存在，需按优先级依次查找；
     * 其他平台查找 {@code npm}。
     *
     * @param dir     待查找的目录，为 {@code null} 时返回 {@code null}
     * @param windows 是否在 Windows 平台查找，决定候选文件名集合
     * @return 找到的 npm 文件，未找到返回 {@code null}
     */
    static File findNpmFile(File dir, boolean windows) {
        if (dir == null) {
            return null;
        }
        String[] candidates = windows ? new String[]{"npm.cmd", "npm.exe"} : new String[]{"npm"};
        for (String name : candidates) {
            File candidate = new File(dir, name);
            if (candidate.exists()) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Resolves the npm path for a WSL node executable.
     * <p>Resolution order (with the first success being cached for the session):
     * <ol>
     *   <li>{@code wsl which npm} — authoritative; works with nvm, Volta, and any
     *       version manager that puts npm on the WSL user's {@code PATH}.</li>
     *   <li>Co-located heuristic — assume {@code <nodeDir>/npm} (correct for official
     *       installs and most nvm setups).</li>
     *   <li>Bare {@code "npm"} — last resort; depends on WSL's {@code PATH}.</li>
     * </ol>
     */
    private String resolveWslNpmPath(String nodePath) {
        String cached = wslNpmPathCache.get(nodePath);
        if (cached != null) {
            return cached;
        }
        String resolved = queryWslWhichNpm();
        if (resolved == null) {
            int lastSlash = nodePath.lastIndexOf('/');
            resolved = (lastSlash > 0) ? nodePath.substring(0, lastSlash) + "/npm" : "npm";
            LOG.info("[DependencyManager] `wsl which npm` did not resolve npm; "
                    + "falling back to co-located heuristic: " + resolved
                    + " (Volta or non-standard layouts may need a custom node path)");
        } else {
            LOG.info("[DependencyManager] Resolved WSL npm via `wsl which npm`: " + resolved);
        }
        wslNpmPathCache.put(nodePath, resolved);
        return resolved;
    }

    /**
     * Executes {@code wsl which npm} once and returns the trimmed first stdout line, or null on failure.
     */
    private static String queryWslWhichNpm() {
        try {
            ProcessBuilder pb = new ProcessBuilder("wsl", "which", "npm");
            pb.redirectErrorStream(true);
            Process process = pb.start();
            String line;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                line = reader.readLine();
            }
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return null;
            }
            if (process.exitValue() == 0 && line != null && !line.trim().isEmpty()) {
                return line.trim();
            }
        } catch (Exception e) {
            LOG.debug("[DependencyManager] `wsl which npm` failed: " + e.getMessage());
        }
        return null;
    }

    /**
     * Builds an npm command list, prepending {@code "wsl"} when {@code nodePath} is a WSL path.
     */
    private static List<String> buildNpmCommand(String nodePath, String npmPath, String... args) {
        List<String> command = new ArrayList<>();
        if (NodeDetector.isWslPath(nodePath)) {
            command.add("wsl");
        }
        command.add(npmPath);
        Collections.addAll(command, args);
        return command;
    }

    /**
     * Configures the process environment variables.
     */
    private void configureProcessEnvironment(ProcessBuilder pb) {
        String nodePath = nodeDetector.findNodeExecutable();
        envConfigurator.updateProcessEnvironment(pb, nodePath);
    }

    /**
     * Creates the package.json file.
     */
    private void createPackageJson(Path sdkDir, SdkDefinition sdk) throws IOException {
        JsonObject packageJson = new JsonObject();
        packageJson.addProperty("name", sdk.getId() + "-container");
        packageJson.addProperty("version", "1.0.0");
        packageJson.addProperty("private", true);

        Path packageJsonPath = sdkDir.resolve("package.json");
        try (Writer writer = Files.newBufferedWriter(packageJsonPath, StandardCharsets.UTF_8)) {
            gson.toJson(packageJson, writer);
        }
    }

    /**
     * Updates the manifest.json file.
     */
    private void updateManifest(String sdkId, String version) {
        try {
            Path manifestPath = getDependenciesDir().resolve(MANIFEST_FILE);
            JsonObject manifest;

            if (Files.exists(manifestPath)) {
                try (Reader reader = Files.newBufferedReader(manifestPath, StandardCharsets.UTF_8)) {
                    manifest = JsonParser.parseReader(reader).getAsJsonObject();
                }
            } else {
                manifest = new JsonObject();
            }

            JsonObject sdkInfo = new JsonObject();
            sdkInfo.addProperty("version", version);
            sdkInfo.addProperty("installedAt", System.currentTimeMillis());
            manifest.add(sdkId, sdkInfo);

            try (Writer writer = Files.newBufferedWriter(manifestPath, StandardCharsets.UTF_8)) {
                gson.toJson(manifest, writer);
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to update manifest: " + e.getMessage());
        }
    }

    /**
     * Removes an SDK from manifest.json.
     */
    private void removeFromManifest(String sdkId) {
        try {
            Path manifestPath = getDependenciesDir().resolve(MANIFEST_FILE);
            if (!Files.exists(manifestPath)) {
                return;
            }

            JsonObject manifest;
            try (Reader reader = Files.newBufferedReader(manifestPath, StandardCharsets.UTF_8)) {
                manifest = JsonParser.parseReader(reader).getAsJsonObject();
            }

            manifest.remove(sdkId);

            try (Writer writer = Files.newBufferedWriter(manifestPath, StandardCharsets.UTF_8)) {
                gson.toJson(manifest, writer);
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to remove from manifest: " + e.getMessage());
        }
    }

    /**
     * Recursively deletes a directory.
     *
     * @return a list of paths that failed to delete (empty list means complete success)
     */
    private List<Path> deleteDirectory(Path dir) throws IOException {
        List<Path> failedPaths = new ArrayList<>();

        if (!Files.exists(dir)) {
            return failedPaths;
        }

        // Collect all paths that failed to delete instead of silently ignoring them
        Files.walk(dir)
                .sorted((a, b) -> b.compareTo(a)) // Reverse sort to delete children first
                .forEach(path -> {
                    try {
                        Files.delete(path);
                    } catch (IOException e) {
                        LOG.warn("[DependencyManager] Failed to delete: " + path + " - " + e.getMessage());
                        failedPaths.add(path);
                    }
                });

        if (!failedPaths.isEmpty()) {
            LOG.warn("[DependencyManager] " + failedPaths.size() + " files/directories failed to delete");
        }

        return failedPaths;
    }

    /**
     * Compares two version strings.
     *
     * @return negative if v1 < v2, 0 if equal, positive if v1 > v2
     */
    static int compareVersions(String v1, String v2) {
        if (v1 == null || v2 == null) {
            return 0;
        }

        // Strip the leading 'v' prefix
        v1 = v1.startsWith("v") ? v1.substring(1) : v1;
        v2 = v2.startsWith("v") ? v2.substring(1) : v2;

        String[] parts1 = v1.split("\\.");
        String[] parts2 = v2.split("\\.");

        int maxLen = Math.max(parts1.length, parts2.length);
        for (int i = 0; i < maxLen; i++) {
            int num1 = i < parts1.length ? parseVersionPart(parts1[i]) : 0;
            int num2 = i < parts2.length ? parseVersionPart(parts2[i]) : 0;

            if (num1 != num2) {
                return num1 - num2;
            }
        }

        return 0;
    }

    /**
     * Semver-like pattern: major.minor.patch with optional pre-release suffix.
     * Only allows digits, dots, hyphens, and alphanumeric pre-release tags.
     * Rejects anything that could be used for npm install argument injection.
     */
    private static final java.util.regex.Pattern SEMVER_PATTERN =
            java.util.regex.Pattern.compile("^\\d+\\.\\d+\\.\\d+([-.][a-zA-Z0-9.]+)*$");

    static String normalizeRequestedVersion(String version) {
        if (version == null) {
            return null;
        }

        String trimmed = version.trim();
        if (trimmed.isEmpty()) {
            return null;
        }

        if (trimmed.startsWith("v") || trimmed.startsWith("V")) {
            trimmed = trimmed.substring(1);
        }

        if (!SEMVER_PATTERN.matcher(trimmed).matches()) {
            LOG.warn("[DependencyManager] Rejected invalid version format: " + version);
            return null;
        }

        return trimmed;
    }

    static List<String> buildPackageSpecs(SdkDefinition sdk, String requestedVersion) {
        if (sdk == null) {
            return Collections.emptyList();
        }

        List<String> packages = new ArrayList<>();
        String normalizedRequestedVersion = normalizeRequestedVersion(requestedVersion);
        String targetVersion = normalizedRequestedVersion != null ? normalizedRequestedVersion : sdk.getVersion();
        packages.add(sdk.getNpmPackage() + "@" + targetVersion);
        packages.addAll(sdk.getDependencies());
        return packages;
    }

    static List<String> parseVersionList(String rawJson) {
        List<String> versions = new ArrayList<>();

        try {
            com.google.gson.JsonElement element = JsonParser.parseString(rawJson);
            if (!element.isJsonArray()) {
                return versions;
            }

            // npm >= 9 wraps the version list in an extra array layer
            // (`[["0.0.4", ..., "0.3.221"]]`), while older npm emits a flat array
            // (`["0.0.4", ..., "0.3.221"]`). Unwrap leading array-of-array layers so
            // both shapes reach the same primitive-version leaves; otherwise every
            // element is itself an array, `isJsonPrimitive()` is false, and the whole
            // list is silently dropped (causing the misleading "remote versions
            // unavailable" fallback).
            com.google.gson.JsonArray array = element.getAsJsonArray();
            while (!array.isEmpty()
                    && array.get(0).isJsonArray()
                    && array.size() == 1) {
                array = array.get(0).getAsJsonArray();
            }

            for (com.google.gson.JsonElement item : array) {
                if (!item.isJsonPrimitive()) {
                    continue;
                }

                String version = normalizeRequestedVersion(item.getAsString());
                if (version == null || version.contains("-")) {
                    continue;
                }
                versions.add(version);
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to parse version list: " + e.getMessage());
        }

        versions.sort((left, right) -> compareVersions(right, left));
        return versions;
    }

    /**
     * Parses a single segment of a version string.
     */
    private static int parseVersionPart(String part) {
        // Strip non-numeric suffixes (e.g. -beta, -alpha)
        Pattern pattern = Pattern.compile("^(\\d+)");
        Matcher matcher = pattern.matcher(part);
        if (matcher.find()) {
            return Integer.parseInt(matcher.group(1));
        }
        return 0;
    }
}
