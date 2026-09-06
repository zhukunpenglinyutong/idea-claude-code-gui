package com.github.claudecodegui.cli;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Detects whether headless CLI tools are installed and probes their versions.
 *
 * <p>Path resolution mirrors {@code ai-bridge/utils/cli-path.js}: env overrides,
 * common home install dirs, then bare binary names on PATH.
 */
public final class CliStatusDetector {

    private static final Logger LOG = Logger.getInstance(CliStatusDetector.class);
    private static final int PROBE_TIMEOUT_SECONDS = 5;
    private static final long CACHE_TTL_MILLIS = 30_000L;
    private static final Pattern VERSION_TOKEN = Pattern.compile(
            "(\\d+\\.\\d+(?:\\.\\d+)?(?:[-+][A-Za-z0-9.]+)?)"
    );

    /** Immutable holder for a cached detectAll() result. */
    private static final class CachedDetection {
        final Map<String, CliToolStatus> result;
        final long timestampMillis;

        CachedDetection(Map<String, CliToolStatus> result, long timestampMillis) {
            this.result = result;
            this.timestampMillis = timestampMillis;
        }
    }

    private static volatile CachedDetection detectAllCache;
    private static final AtomicBoolean detectAllRefreshRunning = new AtomicBoolean(false);

    private CliStatusDetector() {
    }

    /**
     * Non-blocking variant of {@link #detectAll()}: returns the last cached
     * result immediately — even when expired — and refreshes the cache on a
     * pooled thread. Probing spawns child processes with multi-second
     * timeouts, so re-probing on the calling (possibly UI) thread after TTL
     * expiry can freeze the UI; staleness for one TTL window is acceptable.
     *
     * <p>Falls back to a synchronous {@link #detectAll()} when nothing has
     * ever been cached (first probe of the session).
     */
    public static Map<String, CliToolStatus> detectAllStaleWhileRevalidate() {
        long now = System.currentTimeMillis();
        CachedDetection cached = detectAllCache;
        if (cached == null) {
            return detectAll();
        }
        if (now - cached.timestampMillis >= CACHE_TTL_MILLIS) {
            refreshDetectAllAsync();
        }
        return cached.result;
    }

    private static void refreshDetectAllAsync() {
        if (!detectAllRefreshRunning.compareAndSet(false, true)) {
            return;
        }
        if (ApplicationManager.getApplication() == null) {
            // Headless unit tests: no pooled threads, keep stale result.
            detectAllRefreshRunning.set(false);
            return;
        }
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                detectAll();
            } finally {
                detectAllRefreshRunning.set(false);
            }
        });
    }

    /**
     * Probe all known CLI tools.
     *
     * <p>Results are cached for {@value #CACHE_TTL_MILLIS} ms: probing spawns
     * several child processes per tool, so back-to-back {@code get_cli_status}
     * requests reuse the last detection.
     *
     * @return map keyed by tool id (grok / kimi / opencode / pi)
     */
    public static Map<String, CliToolStatus> detectAll() {
        long now = System.currentTimeMillis();
        CachedDetection cached = detectAllCache;
        if (cached != null && now - cached.timestampMillis < CACHE_TTL_MILLIS) {
            return cached.result;
        }
        synchronized (CliStatusDetector.class) {
            cached = detectAllCache;
            if (cached != null && now - cached.timestampMillis < CACHE_TTL_MILLIS) {
                return cached.result;
            }
            Map<String, CliToolStatus> result = new LinkedHashMap<>();
            for (CliToolId tool : CliToolId.values()) {
                result.put(tool.getId(), detect(tool));
            }
            Map<String, CliToolStatus> immutable = Collections.unmodifiableMap(result);
            detectAllCache = new CachedDetection(immutable, System.currentTimeMillis());
            return immutable;
        }
    }

    public static CliToolStatus detect(CliToolId tool) {
        try {
            for (String candidate : candidatesFor(tool)) {
                ProbeResult probe = probe(candidate);
                if (probe.ok) {
                    return CliToolStatus.installed(tool, probe.version, probe.resolvedPath);
                }
            }
            // Last resort: ask the user's login shell. GUI-launched IDEs inherit a
            // minimal launchd/service PATH, so CLIs installed via nvm/fnm/mise/asdf
            // or custom prefixes only exist once .zshrc/.bashrc/config.fish is sourced.
            String viaShell = resolveViaLoginShell(tool.getBinaryName());
            if (viaShell != null) {
                ProbeResult probe = probe(viaShell);
                if (probe.ok) {
                    return CliToolStatus.installed(tool, probe.version, probe.resolvedPath);
                }
            }
            return CliToolStatus.notInstalled(tool);
        } catch (Exception e) {
            LOG.warn("[CliStatusDetector] Failed to detect " + tool.getId() + ": " + e.getMessage());
            return CliToolStatus.error(tool, e.getMessage());
        }
    }

    private static List<String> candidatesFor(CliToolId tool) {
        Set<String> candidates = new LinkedHashSet<>();
        // Primary name first, then the alt name (e.g. minimax → mcode): tools
        // installed under either name must be detected.
        String[] binaries = tool.getAltBinaryName() != null
                ? new String[]{tool.getBinaryName(), tool.getAltBinaryName()}
                : new String[]{tool.getBinaryName()};
        String[] extensions = PlatformUtils.isWindows()
                ? new String[]{".cmd", ".exe", ""}
                : new String[]{""};

        // 1. Explicit env overrides
        for (String envKey : envKeysFor(tool)) {
            String value = firstNonBlank(System.getenv(envKey));
            if (value != null) {
                candidates.add(value);
            }
        }

        // 2. Common home / system install locations
        String home = PlatformUtils.getHomeDirectory();
        List<String> homeDirs = homeBinDirs(tool, home);
        for (String binary : binaries) {
            for (String dir : homeDirs) {
                for (String ext : extensions) {
                    File file = new File(dir, binary + ext);
                    if (file.isFile()) {
                        candidates.add(file.getAbsolutePath());
                    }
                }
            }
        }

        // 3. Bare binary names (resolved via process PATH)
        for (String binary : binaries) {
            for (String ext : extensions) {
                candidates.add(binary + ext);
            }
        }

        return new ArrayList<>(candidates);
    }

    private static List<String> homeBinDirs(CliToolId tool, String home) {
        List<String> dirs = new ArrayList<>();
        if (home == null || home.isBlank()) {
            return dirs;
        }
        switch (tool) {
            case GROK:
                dirs.add(join(home, ".grok", "bin"));
                dirs.add(join(home, ".local", "bin"));
                break;
            case KIMI:
                dirs.add(join(home, ".kimi-code", "bin"));
                dirs.add(join(home, ".kimi", "bin"));
                dirs.add(join(home, ".moonshot", "bin"));
                dirs.add(join(home, ".local", "bin"));
                break;
            case OPENCODE:
                dirs.add(join(home, ".opencode", "bin"));
                dirs.add(join(home, ".local", "share", "opencode", "bin"));
                dirs.add(join(home, ".local", "bin"));
                break;
            case PI:
                dirs.add(join(home, ".pi", "bin"));
                dirs.add(join(home, ".local", "bin"));
                break;
            case OMP:
                dirs.add(join(home, ".omp", "bin"));
                dirs.add(join(home, ".local", "bin"));
                // Windows native installer: %LOCALAPPDATA%\omp\omp.exe
                if (PlatformUtils.isWindows()) {
                    String localAppData = System.getenv("LOCALAPPDATA");
                    if (localAppData != null && !localAppData.isBlank()) {
                        dirs.add(join(localAppData, "omp"));
                    }
                }
                break;
            case DSH:
                // Hermes (the DSH-native installer) keeps node + dsh together.
                dirs.add(join(home, ".hermes", "node", "bin"));
                dirs.add(join(home, ".dsh", "bin"));
                dirs.add(join(home, ".local", "bin"));
                break;
            case MINIMAX:
                dirs.add(join(home, ".minimax", "bin"));
                dirs.add(join(home, ".minimax-code"));
                dirs.add(join(home, ".local", "bin"));
                break;
            default:
                break;
        }
        // Shared npm / package-manager locations
        if (PlatformUtils.isWindows()) {
            String appData = System.getenv("APPDATA");
            if (appData != null && !appData.isBlank()) {
                dirs.add(join(appData, "npm"));
            }
            String programFiles = System.getenv("ProgramFiles");
            if (programFiles != null && !programFiles.isBlank()) {
                dirs.add(join(programFiles, "nodejs"));
            }
            String programFilesX86 = System.getenv("ProgramFiles(x86)");
            if (programFilesX86 != null && !programFilesX86.isBlank()) {
                dirs.add(join(programFilesX86, "nodejs"));
            }
        } else {
            dirs.add("/usr/local/bin");
            dirs.add("/opt/homebrew/bin");
            dirs.add("/usr/bin");
            dirs.add(join(home, ".npm-global", "bin"));
            dirs.add(join(home, ".volta", "bin"));
            dirs.add(join(home, ".cargo", "bin"));
            // Package-manager global bins that an IDE-launched process PATH misses.
            dirs.add(join(home, ".bun", "bin"));
            dirs.add(join(home, ".yarn", "bin"));
            // pnpm: macOS default PNPM_HOME is ~/Library/pnpm, Linux ~/.local/share/pnpm
            dirs.add(join(home, "Library", "pnpm"));
            dirs.add(join(home, ".local", "share", "pnpm"));
            // Version managers (nvm/fnm/mise/asdf/...): npm -g shims land next to
            // the managed node, invisible without sourcing the login shell.
            dirs.addAll(versionManagerBinDirs(home));
        }
        return dirs;
    }

    /**
     * Node version-manager global bin dirs (non-Windows). GUI-launched IDEs get
     * a sparse launchd PATH, so CLIs installed via {@code npm -g} under nvm /
     * fnm / mise / asdf version dirs only appear after the login shell is
     * sourced — and that fallback is fragile (slow or stdin-blocking rc files).
     * Scan the well-known roots directly; newest versions first. Mirrors
     * {@code versionManagerBinDirs} in {@code ai-bridge/utils/cli-path.js}.
     */
    static List<String> versionManagerBinDirs(String home) {
        List<String> dirs = new ArrayList<>();
        if (home == null || home.isBlank()) {
            return dirs;
        }
        // Static single-node managers (bin dir sits next to the managed node).
        dirs.add(join(home, ".hermes", "node", "bin"));
        dirs.add(join(home, ".volta", "bin"));
        dirs.add(join(home, ".fnm", "aliases", "default", "bin"));
        dirs.add(join(home, ".nvmd", "bin"));
        // Per-version managers: one global bin dir per installed node version.
        collectVersionBinDirs(dirs, join(home, ".nvm", "versions", "node"), "bin");
        collectVersionBinDirs(dirs, join(home, ".local", "share", "fnm", "node-versions"),
                "installation" + File.separator + "bin");
        collectVersionBinDirs(dirs, join(home, ".local", "share", "mise", "installs", "node"), "bin");
        collectVersionBinDirs(dirs, join(home, ".asdf", "installs", "nodejs"), "bin");
        return dirs;
    }

    /** Append {@code <root>/<version>/<binSub>} for every version-looking child, newest first. */
    private static void collectVersionBinDirs(List<String> out, String root, String binSub) {
        File[] children = new File(root).listFiles();
        if (children == null) {
            return;
        }
        List<File> versions = new ArrayList<>();
        for (File child : children) {
            if (child.isDirectory() && child.getName().matches(".*\\d.*")) {
                versions.add(child);
            }
        }
        versions.sort((a, b) -> compareVersionNamesDesc(a.getName(), b.getName()));
        for (File version : versions) {
            File bin = new File(version, binSub);
            if (bin.isDirectory()) {
                out.add(bin.getAbsolutePath());
            }
        }
    }

    /** Numeric-descending compare for names like {@code v22.22.3} / {@code 24.11.1}. */
    static int compareVersionNamesDesc(String a, String b) {
        String[] pa = a.split("\\D+");
        String[] pb = b.split("\\D+");
        for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
            long va = i < pa.length && !pa[i].isEmpty() ? Long.parseLong(pa[i]) : 0;
            long vb = i < pb.length && !pb[i].isEmpty() ? Long.parseLong(pb[i]) : 0;
            if (va != vb) {
                return Long.compare(vb, va);
            }
        }
        return b.compareTo(a);
    }

    private static String[] envKeysFor(CliToolId tool) {
        return switch (tool) {
            case GROK -> new String[]{"GROK_BIN", "GROK_PATH", "GROK_CLI_PATH"};
            case KIMI -> new String[]{"KIMI_BIN", "KIMI_PATH", "KIMI_CLI_PATH", "KIMI_CODE_BIN"};
            case OPENCODE -> new String[]{"OPENCODE_BIN", "OPENCODE_PATH", "OPENCODE_CLI_PATH"};
            case PI -> new String[]{"PI_BIN", "PI_PATH", "PI_CLI_PATH"};
            case OMP -> new String[]{"OMP_BIN", "OMP_PATH", "OMP_CLI_PATH"};
            case DSH -> new String[]{"DSH_BIN", "DSH_PATH", "DSH_CLI_PATH"};
            case MINIMAX -> new String[]{"MINIMAX_BIN", "MINIMAX_PATH", "MINIMAX_CLI_PATH", "MCODE_BIN"};
        };
    }

    private static ProbeResult probe(String candidate) {
        // npm -g shims use a `#!/usr/bin/env node` shebang; their sibling `node`
        // (same version-manager bin dir) is not on the IDE's sparse PATH, so the
        // probe would die with exit 127 ("env: node: No such file or directory").
        String siblingBinDir = parentDirOf(candidate);
        // Prefer --version; fall back to -v for tools that only support short flag.
        for (String flag : new String[]{"--version", "-v"}) {
            ProcessResult result = run(List.of(candidate, flag), siblingBinDir);
            if (result.exitCode == 0 && result.stdout != null && !result.stdout.isBlank()) {
                String version = extractVersion(result.stdout);
                String path = resolveWhichLike(candidate);
                return new ProbeResult(true, version, path != null ? path : candidate);
            }
            // Some CLIs print version on stderr with exit 0 or non-zero for -v alone.
            if (result.combined != null && !result.combined.isBlank()) {
                String version = extractVersion(result.combined);
                if (version != null && !version.equals("unknown") && result.exitCode == 0) {
                    String path = resolveWhichLike(candidate);
                    return new ProbeResult(true, version, path != null ? path : candidate);
                }
            }
        }
        // File exists and is executable but version probe failed — still count as installed.
        File file = new File(candidate);
        if (file.isFile() && file.canExecute()) {
            return new ProbeResult(true, "unknown", file.getAbsolutePath());
        }
        return ProbeResult.fail();
    }

    private static String extractVersion(String output) {
        if (output == null || output.isBlank()) {
            return "unknown";
        }
        String firstLine = output.lines()
                .map(String::trim)
                .filter(line -> !line.isEmpty())
                .findFirst()
                .orElse("");
        if (firstLine.isEmpty()) {
            return "unknown";
        }
        Matcher matcher = VERSION_TOKEN.matcher(firstLine);
        if (matcher.find()) {
            return matcher.group(1);
        }
        // Fall back to the whole first line (trimmed / shortened).
        String cleaned = firstLine.replaceAll("(?i)^(version|v)\\s*[: ]*", "").trim();
        return cleaned.isEmpty() ? "unknown" : cleaned;
    }

    /**
     * When the candidate is a bare name, try to resolve an absolute path via which/where.
     *
     * <p>On Windows, {@code where} often lists the extensionless npm bash shim first
     * (e.g. {@code ...\npm\pi}) before the spawnable {@code .cmd}/{@code .exe}. Prefer
     * spawnable extensions so the displayed path matches what the Node bridge can run.
     */
    private static String resolveWhichLike(String candidate) {
        if (candidate == null || candidate.isBlank()) {
            return null;
        }
        File asFile = new File(candidate);
        if (asFile.isAbsolute() && asFile.isFile()) {
            return preferWindowsSpawnable(asFile.getAbsolutePath());
        }
        try {
            List<String> command = PlatformUtils.isWindows()
                    ? List.of("cmd.exe", "/c", "where", candidate)
                    : List.of("which", candidate);
            ProcessResult result = run(command);
            if (result.exitCode == 0 && result.stdout != null) {
                List<String> lines = result.stdout.lines()
                        .map(String::trim)
                        .filter(line -> !line.isEmpty())
                        .toList();
                String best = selectWindowsWhereMatch(lines);
                if (best != null) {
                    return preferWindowsSpawnable(best);
                }
            }
        } catch (Exception e) {
            LOG.debug("[CliStatusDetector] which/where failed for " + candidate + ": " + e.getMessage());
        }
        return preferWindowsSpawnable(candidate);
    }

    /**
     * Prefer {@code .exe}/{@code .cmd}/{@code .bat} entries from {@code where} output.
     * Non-Windows: first line.
     */
    static String selectWindowsWhereMatch(List<String> lines) {
        if (lines == null || lines.isEmpty()) {
            return null;
        }
        if (PlatformUtils.isWindows()) {
            for (String ext : new String[]{".exe", ".cmd", ".bat"}) {
                for (String line : lines) {
                    if (line != null && line.length() > ext.length()
                            && line.regionMatches(true, line.length() - ext.length(), ext, 0, ext.length())) {
                        return line;
                    }
                }
            }
        }
        return lines.get(0);
    }

    /**
     * If path has no spawnable Windows extension but a sibling {@code .exe}/{@code .cmd}/{@code .bat}
     * exists, return that sibling. Bare names and non-Windows are unchanged.
     */
    static String preferWindowsSpawnable(String path) {
        if (!PlatformUtils.isWindows() || path == null || path.isBlank()) {
            return path;
        }
        String trimmed = path.trim();
        String lower = trimmed.toLowerCase();
        if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
            return trimmed;
        }
        // Bare names rely on PATH+PATHEXT at probe time.
        File file = new File(trimmed);
        boolean looksLikePath = file.isAbsolute()
                || trimmed.indexOf('/') >= 0
                || trimmed.indexOf('\\') >= 0
                || (trimmed.length() >= 2 && trimmed.charAt(1) == ':');
        if (!looksLikePath) {
            return trimmed;
        }
        for (String ext : new String[]{".exe", ".cmd", ".bat"}) {
            File sibling = new File(trimmed + ext);
            if (sibling.isFile()) {
                return sibling.getAbsolutePath();
            }
        }
        return trimmed;
    }

    private static ProcessResult run(List<String> command) {
        return run(command, null);
    }

    private static ProcessResult run(List<String> command, String extraBinDir) {
        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.redirectErrorStream(true);
            Map<String, String> env = pb.environment();
            // Ensure common user bin dirs are on PATH for IDE-launched processes.
            enrichPath(env, extraBinDir);
            process = pb.start();
            // Bound the wait first so a hung child cannot block the probe:
            // expected output is a tiny version string that will not fill the
            // OS pipe buffer before exit, so draining after waitFor is safe.
            boolean finished = process.waitFor(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return ProcessResult.timeout();
            }
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (output.length() > 0) {
                        output.append('\n');
                    }
                    output.append(line);
                    // Cap capture — version probes are short.
                    if (output.length() > 4000) {
                        break;
                    }
                }
            }
            String text = output.toString().trim();
            return new ProcessResult(process.exitValue(), text, text);
        } catch (Exception e) {
            LOG.debug("[CliStatusDetector] Command failed " + command + ": " + e.getMessage());
            return ProcessResult.fail();
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    /** Absolute parent dir of a candidate path, or null for bare binary names. */
    private static String parentDirOf(String candidate) {
        if (candidate == null || candidate.isBlank()) {
            return null;
        }
        File file = new File(candidate);
        if (!file.isAbsolute()) {
            return null;
        }
        File parent = file.getParentFile();
        return parent != null ? parent.getAbsolutePath() : null;
    }

    private static void enrichPath(Map<String, String> env, String extraBinDir) {
        String home = PlatformUtils.getHomeDirectory();
        if (home == null || home.isBlank()) {
            return;
        }
        String pathKey = PlatformUtils.isWindows() ? "Path" : "PATH";
        String current = env.getOrDefault(pathKey, env.getOrDefault("PATH", ""));
        String sep = PlatformUtils.isWindows() ? ";" : ":";
        List<String> extras = new ArrayList<>();
        if (extraBinDir != null && !extraBinDir.isBlank()) {
            extras.add(extraBinDir);
        }
        extras.addAll(versionManagerBinDirs(home));
        extras.addAll(List.of(
                join(home, ".kimi-code", "bin"),
                join(home, ".kimi", "bin"),
                join(home, ".opencode", "bin"),
                join(home, ".grok", "bin"),
                join(home, ".pi", "bin"),
                join(home, ".omp", "bin"),
                join(home, ".minimax", "bin"),
                join(home, ".local", "bin"),
                join(home, ".cargo", "bin"),
                "/opt/homebrew/bin",
                "/usr/local/bin"
        ));
        if (PlatformUtils.isWindows()) {
            String appData = System.getenv("APPDATA");
            if (appData != null && !appData.isBlank()) {
                extras.add(join(appData, "npm"));
            }
            // Windows native installer dir (omp.exe) — see homeBinDirs.
            String localAppData = System.getenv("LOCALAPPDATA");
            if (localAppData != null && !localAppData.isBlank()) {
                extras.add(join(localAppData, "omp"));
            }
            String programFiles = System.getenv("ProgramFiles");
            if (programFiles != null && !programFiles.isBlank()) {
                extras.add(join(programFiles, "nodejs"));
            }
        }
        StringBuilder next = new StringBuilder();
        for (String dir : extras) {
            if (dir != null && !dir.isBlank() && !current.contains(dir)) {
                if (next.length() > 0) {
                    next.append(sep);
                }
                next.append(dir);
            }
        }
        if (next.length() == 0) {
            return;
        }
        String merged = next + (current.isEmpty() ? "" : sep + current);
        env.put(pathKey, merged);
        if (!"PATH".equals(pathKey)) {
            env.put("PATH", merged);
        }
    }

    // --- Login-shell fallback -----------------------------------------------

    /**
     * Shells allowed for login-env probing (mirrors the allowlist in
     * {@code EnvironmentConfigurator}): {@code $SHELL} is attacker-influenced,
     * so only standard system/Homebrew shell binaries may be invoked.
     */
    private static final Set<String> ALLOWED_LOGIN_SHELLS = Set.of(
            "/bin/zsh", "/bin/bash", "/bin/sh",
            "/usr/bin/zsh", "/usr/bin/bash", "/usr/bin/sh",
            "/usr/local/bin/zsh", "/usr/local/bin/bash",
            "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/bash",
            "/usr/local/bin/fish", "/opt/homebrew/bin/fish"
    );
    private static final int LOGIN_SHELL_TIMEOUT_SECONDS = 10;

    private static final Object LOGIN_SHELL_LOCK = new Object();
    /** binary name → absolute path, resolved in one batched shell invocation. */
    private static volatile Map<String, String> loginShellPaths;
    private static volatile long loginShellResolvedAt;

    /**
     * Resolve {@code binary} through the user's login shell (non-Windows only).
     * One shell invocation resolves every known CLI binary; the result is cached
     * for {@value #CACHE_TTL_MILLIS} ms alongside the regular detection cache.
     */
    private static String resolveViaLoginShell(String binary) {
        if (PlatformUtils.isWindows()) {
            return null;
        }
        Map<String, String> cached = loginShellPaths;
        if (cached != null && System.currentTimeMillis() - loginShellResolvedAt < CACHE_TTL_MILLIS) {
            return cached.get(binary);
        }
        synchronized (LOGIN_SHELL_LOCK) {
            cached = loginShellPaths;
            if (cached != null && System.currentTimeMillis() - loginShellResolvedAt < CACHE_TTL_MILLIS) {
                return cached.get(binary);
            }
            Map<String, String> resolved = queryLoginShell();
            loginShellPaths = resolved;
            loginShellResolvedAt = System.currentTimeMillis();
            return resolved.get(binary);
        }
    }

    private static Map<String, String> queryLoginShell() {
        String shell = loginShellBinary();
        if (shell == null) {
            return Map.of();
        }
        boolean fish = shell.endsWith("fish");
        List<String> command = new ArrayList<>();
        command.add(shell);
        if (!fish) {
            // -l -i: nvm/fnm/mise only export PATH from interactive login rc files.
            command.add("-l");
            command.add("-i");
        }
        command.add("-c");
        command.add(buildLookupScript(fish));

        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            // Keep stderr separate: interactive shells print prompts / job-control
            // noise there; merging would corrupt the key=value parse.
            pb.redirectErrorStream(false);
            process = pb.start();
            boolean finished = process.waitFor(LOGIN_SHELL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                LOG.warn("[CliStatusDetector] Login-shell lookup timed out after "
                        + LOGIN_SHELL_TIMEOUT_SECONDS + "s");
                return Map.of();
            }
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append('\n');
                    if (output.length() > 4000) {
                        break;
                    }
                }
            }
            return parseLoginShellLookup(output.toString());
        } catch (Exception e) {
            LOG.debug("[CliStatusDetector] Login-shell lookup failed: " + e.getMessage());
            return Map.of();
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    /**
     * Per-tool {@code name=path} lines. Binary names are internal constants, and
     * the value is validated against the filesystem before use.
     */
    static String buildLookupScript(boolean fish) {
        StringBuilder script = new StringBuilder();
        for (CliToolId tool : CliToolId.values()) {
            String binary = tool.getBinaryName();
            if (fish) {
                script.append("echo \"").append(binary).append("=\"(command -v ").append(binary)
                        .append(" 2>/dev/null); ");
            } else {
                script.append("echo \"").append(binary).append("=$(command -v ").append(binary)
                        .append(" 2>/dev/null)\"; ");
            }
        }
        return script.toString();
    }

    /** Parse {@code name=path} lines; keep only absolute paths of existing files. */
    static Map<String, String> parseLoginShellLookup(String output) {
        if (output == null || output.isBlank()) {
            return Map.of();
        }
        Map<String, String> resolved = new LinkedHashMap<>();
        for (String line : output.split("\n")) {
            int eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String name = line.substring(0, eq).trim();
            String path = line.substring(eq + 1).trim();
            if (name.isEmpty() || path.isEmpty()) {
                continue;
            }
            File file = new File(path);
            if (file.isAbsolute() && file.isFile()) {
                resolved.put(name, file.getAbsolutePath());
            }
        }
        return resolved;
    }

    private static String loginShellBinary() {
        String shell = System.getenv("SHELL");
        if (shell != null && ALLOWED_LOGIN_SHELLS.contains(shell)) {
            return shell;
        }
        for (String candidate : new String[]{"/bin/zsh", "/bin/bash", "/bin/sh"}) {
            if (new File(candidate).canExecute()) {
                return candidate;
            }
        }
        return null;
    }

    private static String join(String first, String... parts) {
        File file = new File(first);
        for (String part : parts) {
            file = new File(file, part);
        }
        return file.getAbsolutePath();
    }

    private static String firstNonBlank(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static final class ProbeResult {
        final boolean ok;
        final String version;
        final String resolvedPath;

        private ProbeResult(boolean ok, String version, String resolvedPath) {
            this.ok = ok;
            this.version = version;
            this.resolvedPath = resolvedPath;
        }

        static ProbeResult fail() {
            return new ProbeResult(false, null, null);
        }
    }

    private static final class ProcessResult {
        final int exitCode;
        final String stdout;
        final String combined;

        private ProcessResult(int exitCode, String stdout, String combined) {
            this.exitCode = exitCode;
            this.stdout = stdout;
            this.combined = combined;
        }

        static ProcessResult fail() {
            return new ProcessResult(-1, null, null);
        }

        static ProcessResult timeout() {
            return new ProcessResult(-1, null, null);
        }
    }
}
