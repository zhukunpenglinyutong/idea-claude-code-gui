package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import org.tomlj.Toml;
import org.tomlj.TomlArray;
import org.tomlj.TomlParseResult;
import org.tomlj.TomlTable;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Codex Settings Manager
 * Manages ~/.codex/config.toml and ~/.codex/auth.json files
 */
public class CodexSettingsManager {
    private static final Logger LOG = Logger.getInstance(CodexSettingsManager.class);
    private static final String MODEL_ALIASES_KEY = "model_aliases";
    private static final String MODEL_PROVIDERS_KEY = "model_providers";
    private static final String CLI_AUTH_BACKUP_FILE_NAME = "auth.json.cli_backup";
    private static final String PROVIDER_CONFIG_BASELINE_FILE_NAME = "config.toml.provider_backup";
    private static final Set<String> GLOBAL_CONFIG_KEYS = Set.of("mcp_servers", "skills");
    private static final Object CONFIG_FILE_LOCK = new Object();
    private static final String MODEL_CONTEXT_WINDOW_KEY = "model_context_window";
    private static final String MODEL_AUTO_COMPACT_TOKEN_LIMIT_KEY = "model_auto_compact_token_limit";
    private static final int DEFAULT_CONTEXT_WINDOW = 272_000;
    private static final int DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 244_800;
    private static final int MEDIUM_CONTEXT_WINDOW = 500_000;
    private static final int MEDIUM_AUTO_COMPACT_TOKEN_LIMIT = 450_000;
    private static final int LARGE_CONTEXT_WINDOW = 1_000_000;
    private static final int LARGE_AUTO_COMPACT_TOKEN_LIMIT = 900_000;

    // Pattern to validate TOML bare keys (letters, digits, hyphens, underscores)
    private static final Pattern TOML_KEY_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]+$");

    private final Gson gson;
    private final Path codexDir;

    public CodexSettingsManager(Gson gson) {
        this.gson = gson;
        String userHome = NodeDetector.resolveHomeForFileOps();
        this.codexDir = Paths.get(userHome, ".codex");
    }

    CodexSettingsManager(Gson gson, Path codexDir) {
        this.gson = gson;
        this.codexDir = codexDir;
    }

    /**
     * Ensure ~/.codex directory exists
     */
    public void ensureCodexDirectory() throws IOException {
        if (!Files.exists(codexDir)) {
            Files.createDirectories(codexDir);
            LOG.info("[CodexSettingsManager] Created ~/.codex directory");
        }
    }

    /**
     * Get path to config.toml
     */
    public Path getConfigTomlPath() {
        return codexDir.resolve("config.toml");
    }

    /**
     * Get path to auth.json
     */
    public Path getAuthJsonPath() {
        return codexDir.resolve("auth.json");
    }

    /**
     * Read config.toml as a map structure
     * Returns null if file doesn't exist
     */
    public Map<String, Object> readConfigToml() throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            return readConfigTomlUnlocked();
        }
    }

    private Map<String, Object> readConfigTomlUnlocked() throws IOException {
        Path configPath = getConfigTomlPath();
        if (!Files.exists(configPath)) {
            LOG.info("[CodexSettingsManager] config.toml not found at: " + configPath);
            return null;
        }

        try {
            String content = Files.readString(configPath, StandardCharsets.UTF_8);
            return parseToml(content);
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to read config.toml: " + e.getMessage());
            throw new IOException("Failed to read config.toml: " + e.getMessage(), e);
        }
    }

    /**
     * Write config.toml from a map structure
     */
    public void writeConfigToml(Map<String, Object> config) throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            writeConfigTomlUnlocked(config);
        }
    }

    private void writeConfigTomlUnlocked(Map<String, Object> config) throws IOException {
        Path configPath = getConfigTomlPath();
        writeStringAtomically(configPath, generateToml(config));
        LOG.info("[CodexSettingsManager] Wrote config.toml to: " + configPath);
    }

    @FunctionalInterface
    public interface ConfigEditor {
        boolean edit(Map<String, Object> config) throws IOException;
    }

    @FunctionalInterface
    public interface IoAction {
        void run() throws IOException;
    }

    @FunctionalInterface
    public interface ConfigAccessGuard {
        boolean isAllowed() throws IOException;
    }

    /**
     * Runs one config.toml read-modify-write operation under the shared Codex config lock.
     */
    public void updateConfigToml(ConfigEditor editor) throws IOException {
        updateConfigToml(() -> true, editor);
    }

    /**
     * Runs a guarded config.toml update. The guard is rechecked while holding the
     * same lock used by provider transitions, preventing access-mode changes
     * between authorization and the write.
     */
    public void updateConfigToml(ConfigAccessGuard guard, ConfigEditor editor) throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            if (!guard.isAllowed()) {
                throw new IOException("Codex config management is not authorized");
            }
            Map<String, Object> config = readConfigTomlUnlocked();
            if (config == null) {
                config = new LinkedHashMap<>();
            }
            if (editor.edit(config)) {
                writeConfigTomlUnlocked(config);
            }
        }
    }

    /** Runs a guarded file operation under the provider/config transition lock. */
    public void runWithConfigAccess(ConfigAccessGuard guard, IoAction action) throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            if (!guard.isAllowed()) {
                throw new IOException("Codex config management is not authorized");
            }
            action.run();
        }
    }

    boolean isConfigLockHeldByCurrentThread() {
        return Thread.holdsLock(CONFIG_FILE_LOCK);
    }

    /**
     * 读取 Codex 顶层上下文窗口配置，并映射为 CC GUI 支持的预设。
     *
     * <p>这里只读取第一个 TOML section 之前的顶层标量，避免把同名的 Provider
     * 子项误判为全局配置。与预设不完全匹配的已有配置会作为 custom 返回，供前端
     * 如实展示而不会在读取时改写用户文件。</p>
     *
     * @return 当前权威配置快照
     * @throws IOException 读取配置文件失败时抛出
     */
    public CodexContextWindowConfig readContextWindowConfig() throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            return readContextWindowConfigUnlocked();
        }
    }

    private CodexContextWindowConfig readContextWindowConfigUnlocked() throws IOException {
        Path configPath = getConfigTomlPath();
        if (!Files.exists(configPath)) {
            return CodexContextWindowConfig.defaultConfig();
        }

        String content = Files.readString(configPath, StandardCharsets.UTF_8);
        Integer contextWindow = readTopLevelInteger(content, MODEL_CONTEXT_WINDOW_KEY);
        Integer autoCompactTokenLimit = readTopLevelInteger(content, MODEL_AUTO_COMPACT_TOKEN_LIMIT_KEY);

        if (contextWindow == null && autoCompactTokenLimit == null) {
            return CodexContextWindowConfig.defaultConfig();
        }
        if (Integer.valueOf(DEFAULT_CONTEXT_WINDOW).equals(contextWindow)
                && (autoCompactTokenLimit == null
                    || Integer.valueOf(DEFAULT_AUTO_COMPACT_TOKEN_LIMIT).equals(autoCompactTokenLimit))) {
            return CodexContextWindowConfig.defaultConfig();
        }
        if (Integer.valueOf(MEDIUM_CONTEXT_WINDOW).equals(contextWindow)
                && (autoCompactTokenLimit == null
                    || Integer.valueOf(MEDIUM_AUTO_COMPACT_TOKEN_LIMIT).equals(autoCompactTokenLimit))) {
            return new CodexContextWindowConfig(
                    CodexContextWindowConfig.PRESET_500K,
                    MEDIUM_CONTEXT_WINDOW,
                    autoCompactTokenLimit != null ? autoCompactTokenLimit : MEDIUM_AUTO_COMPACT_TOKEN_LIMIT,
                    false
            );
        }
        if (Integer.valueOf(LARGE_CONTEXT_WINDOW).equals(contextWindow)
                && (autoCompactTokenLimit == null
                    || Integer.valueOf(LARGE_AUTO_COMPACT_TOKEN_LIMIT).equals(autoCompactTokenLimit))) {
            return new CodexContextWindowConfig(
                    CodexContextWindowConfig.PRESET_1M,
                    LARGE_CONTEXT_WINDOW,
                    autoCompactTokenLimit != null ? autoCompactTokenLimit : LARGE_AUTO_COMPACT_TOKEN_LIMIT,
                    false
            );
        }

        return new CodexContextWindowConfig(
                CodexContextWindowConfig.PRESET_CUSTOM,
                contextWindow,
                autoCompactTokenLimit,
                true
        );
    }

    /**
     * 原子更新 Codex 顶层上下文窗口配置，保留其余 TOML 文本、注释和 section。
     *
     * <p>default 会移除两个覆盖项；500k 和 1m 会写入窗口值以及 90% 自动压缩线。
     * 此方法不会修改 model、Provider 或压缩 scope。</p>
     *
     * @param preset default、500k 或 1m
     * @return 写入后重新读取的权威配置
     * @throws IOException 读取或写入失败时抛出
     * @throws IllegalArgumentException 预设非法时抛出
     */
    public CodexContextWindowConfig updateContextWindowPreset(String preset) throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            return updateContextWindowPresetUnlocked(preset);
        }
    }

    private CodexContextWindowConfig updateContextWindowPresetUnlocked(String preset) throws IOException {
        int contextWindow;
        int autoCompactTokenLimit;
        boolean restoreDefault;
        switch (preset) {
            case CodexContextWindowConfig.PRESET_DEFAULT:
                contextWindow = DEFAULT_CONTEXT_WINDOW;
                autoCompactTokenLimit = DEFAULT_AUTO_COMPACT_TOKEN_LIMIT;
                restoreDefault = true;
                break;
            case CodexContextWindowConfig.PRESET_500K:
                contextWindow = MEDIUM_CONTEXT_WINDOW;
                autoCompactTokenLimit = MEDIUM_AUTO_COMPACT_TOKEN_LIMIT;
                restoreDefault = false;
                break;
            case CodexContextWindowConfig.PRESET_1M:
                contextWindow = LARGE_CONTEXT_WINDOW;
                autoCompactTokenLimit = LARGE_AUTO_COMPACT_TOKEN_LIMIT;
                restoreDefault = false;
                break;
            default:
                throw new IllegalArgumentException("Unsupported Codex context window preset: " + preset);
        }

        Path configPath = getConfigTomlPath();
        if (restoreDefault && !Files.exists(configPath)) {
            return CodexContextWindowConfig.defaultConfig();
        }

        String original = Files.exists(configPath)
                ? Files.readString(configPath, StandardCharsets.UTF_8)
                : "";
        String patched = patchTopLevelContextWindow(
                original,
                restoreDefault ? null : contextWindow,
                restoreDefault ? null : autoCompactTokenLimit
        );

        if (!patched.equals(original)) {
            writeStringAtomically(configPath, patched);
            LOG.info("[CodexSettingsManager] Updated Codex context window preset to: " + preset);
        }
        return readContextWindowConfigUnlocked();
    }

    private Integer readTopLevelInteger(String content, String key) {
        String normalized = stripBom(content);
        String[] lines = normalized.split("\\r?\\n", -1);
        Pattern assignmentPattern = Pattern.compile(
                "^\\s*" + exactTomlKeyPattern(key)
                        + "\\s*=\\s*([0-9][0-9_]*)\\s*(?:#.*)?$"
        );
        for (String line : lines) {
            if (isTomlSectionHeader(line)) {
                break;
            }
            java.util.regex.Matcher matcher = assignmentPattern.matcher(line);
            if (!matcher.matches()) {
                continue;
            }
            try {
                long parsed = Long.parseLong(matcher.group(1).replace("_", ""));
                if (parsed > 0 && parsed <= Integer.MAX_VALUE) {
                    return (int) parsed;
                }
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private String patchTopLevelContextWindow(
            String original,
            Integer contextWindow,
            Integer autoCompactTokenLimit
    ) throws IOException {
        boolean hasBom = original.startsWith("\uFEFF");
        String body = stripBom(original);
        String newline = body.contains("\r\n") ? "\r\n" : "\n";
        boolean endedWithNewline = body.endsWith("\n") || body.endsWith("\r");
        String[] sourceLines = body.split("\\r?\\n", -1);
        List<String> topLevel = new ArrayList<>();
        List<String> sections = new ArrayList<>();
        boolean inSection = false;
        boolean contextWritten = false;
        boolean autoCompactWritten = false;

        Pattern contextPattern = topLevelAssignmentPattern(MODEL_CONTEXT_WINDOW_KEY);
        Pattern autoCompactPattern = topLevelAssignmentPattern(MODEL_AUTO_COMPACT_TOKEN_LIMIT_KEY);

        for (String line : sourceLines) {
            if (!inSection && isTomlSectionHeader(line)) {
                inSection = true;
            }
            if (inSection) {
                sections.add(line);
                continue;
            }

            if (contextPattern.matcher(line).matches()) {
                if (contextWindow != null && !contextWritten) {
                    topLevel.add(MODEL_CONTEXT_WINDOW_KEY + " = " + contextWindow);
                    contextWritten = true;
                }
                continue;
            }
            if (autoCompactPattern.matcher(line).matches()) {
                if (autoCompactTokenLimit != null && !autoCompactWritten) {
                    topLevel.add(MODEL_AUTO_COMPACT_TOKEN_LIMIT_KEY + " = " + autoCompactTokenLimit);
                    autoCompactWritten = true;
                }
                continue;
            }
            topLevel.add(line);
        }

        if (contextWindow != null && !contextWritten) {
            insertBeforeTrailingBlankLines(topLevel, MODEL_CONTEXT_WINDOW_KEY + " = " + contextWindow);
        }
        if (autoCompactTokenLimit != null && !autoCompactWritten) {
            int insertionIndex = indexBeforeTrailingBlankLines(topLevel);
            topLevel.add(insertionIndex, MODEL_AUTO_COMPACT_TOKEN_LIMIT_KEY + " = " + autoCompactTokenLimit);
        }

        if (!sections.isEmpty() && !topLevel.isEmpty()
                && !topLevel.get(topLevel.size() - 1).isEmpty()) {
            topLevel.add("");
        }

        List<String> resultLines = new ArrayList<>(topLevel.size() + sections.size());
        resultLines.addAll(topLevel);
        resultLines.addAll(sections);

        // split(..., -1) already represents a trailing newline as an empty last line.
        // New files should also end with a newline, matching standard config.toml formatting.
        if (body.isEmpty() && contextWindow != null) {
            endedWithNewline = true;
        }
        while (resultLines.size() > 1
                && resultLines.get(resultLines.size() - 1).isEmpty()
                && resultLines.get(resultLines.size() - 2).isEmpty()
                && !endedWithNewline) {
            resultLines.remove(resultLines.size() - 1);
        }

        String patched = String.join(newline, resultLines);
        if (endedWithNewline && !patched.endsWith(newline)) {
            patched += newline;
        }
        if (hasBom) {
            patched = "\uFEFF" + patched;
        }

        validatePatchedContextWindow(patched, contextWindow, autoCompactTokenLimit);
        return patched;
    }

    private void validatePatchedContextWindow(
            String patched,
            Integer expectedContextWindow,
            Integer expectedAutoCompactTokenLimit
    ) throws IOException {
        Integer actualContextWindow = readTopLevelInteger(patched, MODEL_CONTEXT_WINDOW_KEY);
        Integer actualAutoCompactTokenLimit = readTopLevelInteger(
                patched,
                MODEL_AUTO_COMPACT_TOKEN_LIMIT_KEY
        );
        if (!java.util.Objects.equals(expectedContextWindow, actualContextWindow)
                || !java.util.Objects.equals(expectedAutoCompactTokenLimit, actualAutoCompactTokenLimit)) {
            throw new IOException("Failed to validate patched Codex context window configuration");
        }
    }

    private Pattern topLevelAssignmentPattern(String key) {
        return Pattern.compile("^\\s*" + exactTomlKeyPattern(key) + "\\s*=.*$");
    }

    private String exactTomlKeyPattern(String key) {
        String quoted = Pattern.quote(key);
        return "(?:" + quoted + "|\\\"" + quoted + "\\\"|'" + quoted + "')";
    }

    private boolean isTomlSectionHeader(String line) {
        String trimmed = line == null ? "" : line.trim();
        return trimmed.startsWith("[");
    }

    private String stripBom(String content) {
        return content != null && content.startsWith("\uFEFF") ? content.substring(1) : content;
    }

    private void insertBeforeTrailingBlankLines(List<String> lines, String value) {
        lines.add(indexBeforeTrailingBlankLines(lines), value);
    }

    private int indexBeforeTrailingBlankLines(List<String> lines) {
        int index = lines.size();
        while (index > 0 && lines.get(index - 1).trim().isEmpty()) {
            index--;
        }
        return index;
    }

    /**
     * Codex 上下文窗口的权威配置快照。
     */
    public static final class CodexContextWindowConfig {
        public static final String PRESET_DEFAULT = "default";
        public static final String PRESET_500K = "500k";
        public static final String PRESET_1M = "1m";
        public static final String PRESET_CUSTOM = "custom";

        private final String preset;
        private final Integer contextWindow;
        private final Integer autoCompactTokenLimit;
        private final boolean custom;

        CodexContextWindowConfig(
                String preset,
                Integer contextWindow,
                Integer autoCompactTokenLimit,
                boolean custom
        ) {
            this.preset = preset;
            this.contextWindow = contextWindow;
            this.autoCompactTokenLimit = autoCompactTokenLimit;
            this.custom = custom;
        }

        static CodexContextWindowConfig defaultConfig() {
            return new CodexContextWindowConfig(
                    PRESET_DEFAULT,
                    DEFAULT_CONTEXT_WINDOW,
                    DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
                    false
            );
        }

        public String getPreset() {
            return preset;
        }

        public Integer getContextWindow() {
            return contextWindow;
        }

        public Integer getAutoCompactTokenLimit() {
            return autoCompactTokenLimit;
        }

        public boolean isCustom() {
            return custom;
        }
    }


    /**
     * Read auth.json
     */
    public JsonObject readAuthJson() throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            return readAuthJsonUnlocked();
        }
    }

    private JsonObject readAuthJsonUnlocked() throws IOException {
        Path authPath = getAuthJsonPath();
        if (!Files.exists(authPath)) {
            LOG.info("[CodexSettingsManager] auth.json not found at: " + authPath);
            return null;
        }

        try (Reader reader = Files.newBufferedReader(authPath, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to read auth.json: " + e.getMessage());
            throw new IOException("Failed to read auth.json: " + e.getMessage(), e);
        }
    }

    /**
     * Write auth.json
     */
    public void writeAuthJson(JsonObject auth) throws IOException {
        synchronized (CONFIG_FILE_LOCK) {
            writeAuthJsonUnlocked(auth);
        }
    }

    private void writeAuthJsonUnlocked(JsonObject auth) throws IOException {
        Path authPath = getAuthJsonPath();
        writeStringAtomically(authPath, gson.toJson(auth));
        LOG.info("[CodexSettingsManager] Wrote auth.json to: " + authPath);
    }

    /**
     * Atomically transitions the provider-owned config/auth values and commits provider state last.
     * Global MCP and Skill configuration is never owned by a provider fragment.
     */
    public void transitionProvider(
            JsonObject previousProvider,
            JsonObject nextProvider,
            boolean useCliLogin,
            IoAction commitProviderState) throws IOException {
        Map<String, Object> previousFragment = parseProviderFragment(previousProvider, false);
        Map<String, Object> nextFragment = parseProviderFragment(nextProvider, true);
        JsonObject nextAuth = parseProviderAuth(nextProvider);

        synchronized (CONFIG_FILE_LOCK) {
            Map<String, Object> nextConfig = readConfigTomlUnlocked();
            if (nextConfig == null) {
                nextConfig = new LinkedHashMap<>();
            }

            Path configPath = getConfigTomlPath();
            Path authPath = getAuthJsonPath();
            Path cliAuthBackupPath = codexDir.resolve(CLI_AUTH_BACKUP_FILE_NAME);
            Path configBaselinePath = codexDir.resolve(PROVIDER_CONFIG_BASELINE_FILE_NAME);
            Map<String, Object> configBaseline = prepareProviderConfigBaseline(
                    previousProvider != null,
                    configBaselinePath);

            if (previousProvider != null) {
                restoreProviderOwnedValues(nextConfig, configBaseline, previousFragment, true);
            }
            if (nextProvider != null) {
                configBaseline = new LinkedHashMap<>();
                captureMissingProviderBaselines(configBaseline, nextConfig, nextFragment, true);
                mergeProviderValues(nextConfig, nextFragment, true);
            }

            FileSnapshot configSnapshot = FileSnapshot.capture(configPath);
            FileSnapshot authSnapshot = FileSnapshot.capture(authPath);
            FileSnapshot cliAuthBackupSnapshot = FileSnapshot.capture(cliAuthBackupPath);
            FileSnapshot configBaselineSnapshot = FileSnapshot.capture(configBaselinePath);

            try {
                if (nextProvider != null) {
                    writeStringAtomically(configBaselinePath, generateToml(configBaseline));
                }
                writeConfigTomlUnlocked(nextConfig);
                if (nextProvider != null) {
                    if (previousProvider == null) {
                        backupLocalAuthUnlocked(cliAuthBackupPath);
                    }
                    if (nextAuth != null) {
                        writeAuthJsonUnlocked(nextAuth);
                    } else {
                        Files.deleteIfExists(authPath);
                    }
                } else if (previousProvider != null) {
                    restoreLocalAuthUnlocked(cliAuthBackupPath);
                }
                if (nextProvider == null) {
                    Files.deleteIfExists(configBaselinePath);
                }
                commitProviderState.run();
            } catch (Exception e) {
                IOException failure = toIOException("Failed to activate Codex provider", e);
                restoreSnapshot(configPath, configSnapshot, failure);
                restoreSnapshot(authPath, authSnapshot, failure);
                restoreSnapshot(cliAuthBackupPath, cliAuthBackupSnapshot, failure);
                restoreSnapshot(configBaselinePath, configBaselineSnapshot, failure);
                throw failure;
            }
        }

        String providerId = nextProvider != null && nextProvider.has("id")
                ? nextProvider.get("id").getAsString()
                : useCliLogin ? "cli-login" : "none";
        LOG.info("[CodexSettingsManager] Activated Codex provider: " + providerId);
    }

    /**
     * Verifies legacy managed-provider state before granting config management access.
     */
    public boolean isProviderApplied(JsonObject provider) throws IOException {
        if (provider == null) {
            return false;
        }
        Map<String, Object> fragment = parseProviderFragment(provider, true);
        JsonObject providerAuth = parseProviderAuth(provider);
        synchronized (CONFIG_FILE_LOCK) {
            Map<String, Object> currentConfig = readConfigTomlUnlocked();
            if (currentConfig == null || !containsProviderValues(currentConfig, fragment, true)) {
                return false;
            }
            if (providerAuth == null) {
                return readAuthJsonUnlocked() == null;
            }
            JsonObject currentAuth = readAuthJsonUnlocked();
            return providerAuth.equals(currentAuth);
        }
    }

    private Map<String, Object> parseProviderFragment(JsonObject provider, boolean rejectGlobalKeys) throws IOException {
        if (provider == null || !provider.has("configToml") || !provider.get("configToml").isJsonPrimitive()) {
            return new LinkedHashMap<>();
        }
        Map<String, Object> fragment = parseToml(provider.get("configToml").getAsString());
        if (rejectGlobalKeys) {
            for (String globalKey : GLOBAL_CONFIG_KEYS) {
                if (fragment.containsKey(globalKey)) {
                    throw new IOException("Provider config.toml must not declare global '" + globalKey + "' configuration");
                }
            }
        }
        return fragment;
    }

    private JsonObject parseProviderAuth(JsonObject provider) throws IOException {
        if (provider == null || !provider.has("authJson") || !provider.get("authJson").isJsonPrimitive()) {
            return null;
        }
        String authJson = provider.get("authJson").getAsString();
        if (authJson == null || authJson.trim().isEmpty()) {
            return null;
        }
        try {
            return JsonParser.parseString(authJson).getAsJsonObject();
        } catch (Exception e) {
            throw new IOException("Provider authJson must be a valid JSON object", e);
        }
    }

    private Map<String, Object> prepareProviderConfigBaseline(
            boolean hasPreviousProvider,
            Path baselinePath) throws IOException {
        if (hasPreviousProvider && Files.exists(baselinePath)) {
            return parseToml(Files.readString(baselinePath, StandardCharsets.UTF_8));
        }
        return new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    private void restoreProviderOwnedValues(
            Map<String, Object> target,
            Map<String, Object> baseline,
            Map<String, Object> owned,
            boolean topLevel) {
        for (Map.Entry<String, Object> entry : owned.entrySet()) {
            String key = entry.getKey();
            if (topLevel && GLOBAL_CONFIG_KEYS.contains(key)) {
                continue;
            }

            Object ownedValue = entry.getValue();
            Object baselineValue = baseline.get(key);
            boolean baselineContainsKey = baseline.containsKey(key);
            if (topLevel && MODEL_PROVIDERS_KEY.equals(key) && ownedValue instanceof Map) {
                if (baselineContainsKey && !(baselineValue instanceof Map)) {
                    target.put(key, deepCopyValue(baselineValue));
                } else {
                    restoreModelProviderEntries(
                            target,
                            baselineValue instanceof Map ? (Map<String, Object>) baselineValue : Map.of(),
                            (Map<String, Object>) ownedValue,
                            key);
                }
            } else if (ownedValue instanceof Map) {
                if (baselineContainsKey && !(baselineValue instanceof Map)) {
                    target.put(key, deepCopyValue(baselineValue));
                    continue;
                }
                Map<String, Object> targetMap = target.get(key) instanceof Map
                        ? (Map<String, Object>) target.get(key)
                        : new LinkedHashMap<>();
                restoreProviderOwnedValues(
                        targetMap,
                        baselineValue instanceof Map ? (Map<String, Object>) baselineValue : Map.of(),
                        (Map<String, Object>) ownedValue,
                        false);
                if (targetMap.isEmpty() && !baselineContainsKey) {
                    target.remove(key);
                } else {
                    target.put(key, targetMap);
                }
            } else if (baselineContainsKey) {
                target.put(key, deepCopyValue(baselineValue));
            } else {
                target.remove(key);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void restoreModelProviderEntries(
            Map<String, Object> target,
            Map<String, Object> baselineProviders,
            Map<String, Object> ownedProviders,
            String key) {
        Map<String, Object> targetProviders = target.get(key) instanceof Map
                ? (Map<String, Object>) target.get(key)
                : new LinkedHashMap<>();
        for (String providerId : ownedProviders.keySet()) {
            if (baselineProviders.containsKey(providerId)) {
                targetProviders.put(providerId, deepCopyValue(baselineProviders.get(providerId)));
            } else {
                targetProviders.remove(providerId);
            }
        }
        if (targetProviders.isEmpty() && baselineProviders.isEmpty()) {
            target.remove(key);
        } else {
            target.put(key, targetProviders);
        }
    }

    @SuppressWarnings("unchecked")
    private void captureMissingProviderBaselines(
            Map<String, Object> baseline,
            Map<String, Object> current,
            Map<String, Object> owned,
            boolean topLevel) {
        for (Map.Entry<String, Object> entry : owned.entrySet()) {
            String key = entry.getKey();
            if (topLevel && GLOBAL_CONFIG_KEYS.contains(key)) {
                continue;
            }

            Object ownedValue = entry.getValue();
            Object currentValue = current.get(key);
            if (topLevel && MODEL_PROVIDERS_KEY.equals(key) && ownedValue instanceof Map) {
                if (baseline.containsKey(key) && !(baseline.get(key) instanceof Map)) {
                    continue;
                }
                Map<String, Object> baselineProviders = baseline.get(key) instanceof Map
                        ? (Map<String, Object>) baseline.get(key)
                        : new LinkedHashMap<>();
                Map<String, Object> currentProviders = currentValue instanceof Map
                        ? (Map<String, Object>) currentValue
                        : Map.of();
                for (String providerId : ((Map<String, Object>) ownedValue).keySet()) {
                    if (!baselineProviders.containsKey(providerId) && currentProviders.containsKey(providerId)) {
                        baselineProviders.put(providerId, deepCopyValue(currentProviders.get(providerId)));
                    }
                }
                if (!baselineProviders.isEmpty()) {
                    baseline.put(key, baselineProviders);
                }
            } else if (ownedValue instanceof Map && baseline.get(key) instanceof Map) {
                captureMissingProviderBaselines(
                        (Map<String, Object>) baseline.get(key),
                        currentValue instanceof Map ? (Map<String, Object>) currentValue : Map.of(),
                        (Map<String, Object>) ownedValue,
                        false);
            } else if (ownedValue instanceof Map && !baseline.containsKey(key) && currentValue instanceof Map) {
                Map<String, Object> nestedBaseline = new LinkedHashMap<>();
                captureMissingProviderBaselines(
                        nestedBaseline,
                        (Map<String, Object>) currentValue,
                        (Map<String, Object>) ownedValue,
                        false);
                if (!nestedBaseline.isEmpty()) {
                    baseline.put(key, nestedBaseline);
                }
            } else if (!baseline.containsKey(key) && current.containsKey(key)) {
                baseline.put(key, deepCopyValue(currentValue));
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void mergeProviderValues(
            Map<String, Object> target,
            Map<String, Object> fragment,
            boolean topLevel) {
        for (Map.Entry<String, Object> entry : fragment.entrySet()) {
            String key = entry.getKey();
            Object value = entry.getValue();
            if (value instanceof Map && !(topLevel && MODEL_PROVIDERS_KEY.equals(key))) {
                Object currentValue = target.get(key);
                Map<String, Object> targetMap;
                if (currentValue instanceof Map) {
                    targetMap = (Map<String, Object>) currentValue;
                } else {
                    targetMap = new LinkedHashMap<>();
                    target.put(key, targetMap);
                }
                mergeProviderValues(targetMap, (Map<String, Object>) value, false);
            } else if (value instanceof Map) {
                Map<String, Object> providers = target.get(key) instanceof Map
                        ? (Map<String, Object>) target.get(key)
                        : new LinkedHashMap<>();
                for (Map.Entry<String, Object> providerEntry : ((Map<String, Object>) value).entrySet()) {
                    providers.put(providerEntry.getKey(), deepCopyValue(providerEntry.getValue()));
                }
                target.put(key, providers);
            } else {
                target.put(key, deepCopyValue(value));
            }
        }
    }

    @SuppressWarnings("unchecked")
    private boolean containsProviderValues(
            Map<String, Object> current,
            Map<String, Object> expected,
            boolean topLevel) {
        for (Map.Entry<String, Object> entry : expected.entrySet()) {
            boolean globalConfig = topLevel && GLOBAL_CONFIG_KEYS.contains(entry.getKey());
            if (globalConfig || !current.containsKey(entry.getKey())) {
                if (!globalConfig) {
                    return false;
                }
                continue;
            }
            Object currentValue = current.get(entry.getKey());
            Object expectedValue = entry.getValue();
            if (topLevel && MODEL_PROVIDERS_KEY.equals(entry.getKey())
                    && currentValue instanceof Map && expectedValue instanceof Map) {
                Map<String, Object> currentProviders = (Map<String, Object>) currentValue;
                for (Map.Entry<String, Object> providerEntry
                        : ((Map<String, Object>) expectedValue).entrySet()) {
                    if (!providerEntry.getValue().equals(currentProviders.get(providerEntry.getKey()))) {
                        return false;
                    }
                }
            } else if (currentValue instanceof Map && expectedValue instanceof Map) {
                if (!containsProviderValues(
                        (Map<String, Object>) currentValue,
                        (Map<String, Object>) expectedValue,
                        false)) {
                    return false;
                }
            } else if (!expectedValue.equals(currentValue)) {
                return false;
            }
        }
        return true;
    }

    @SuppressWarnings("unchecked")
    private Object deepCopyValue(Object value) {
        if (value instanceof Map) {
            Map<String, Object> copy = new LinkedHashMap<>();
            ((Map<String, Object>) value).forEach((key, nestedValue) -> copy.put(key, deepCopyValue(nestedValue)));
            return copy;
        }
        if (value instanceof List) {
            List<Object> copy = new ArrayList<>();
            for (Object item : (List<Object>) value) {
                copy.add(deepCopyValue(item));
            }
            return copy;
        }
        return value;
    }

    private void backupLocalAuthUnlocked(Path backupPath) throws IOException {
        Path authPath = getAuthJsonPath();
        if (Files.exists(authPath)) {
            writeStringAtomically(backupPath, Files.readString(authPath, StandardCharsets.UTF_8));
            LOG.info("[CodexSettingsManager] Backed up local Codex credentials");
        } else {
            Files.deleteIfExists(backupPath);
        }
    }

    private void restoreLocalAuthUnlocked(Path backupPath) throws IOException {
        if (Files.exists(backupPath)) {
            writeStringAtomically(getAuthJsonPath(), Files.readString(backupPath, StandardCharsets.UTF_8));
            Files.deleteIfExists(backupPath);
            return;
        }
        Files.deleteIfExists(getAuthJsonPath());
    }

    private void restoreSnapshot(Path path, FileSnapshot snapshot, IOException failure) {
        try {
            if (snapshot.exists()) {
                writeStringAtomically(path, new String(snapshot.content(), StandardCharsets.UTF_8));
            } else {
                Files.deleteIfExists(path);
            }
        } catch (Exception restoreError) {
            failure.addSuppressed(restoreError);
        }
    }

    private IOException toIOException(String message, Exception cause) {
        if (cause instanceof IOException) {
            return (IOException) cause;
        }
        return new IOException(message + ": " + cause.getMessage(), cause);
    }

    private record FileSnapshot(boolean exists, byte[] content) {
        private static FileSnapshot capture(Path path) throws IOException {
            return Files.exists(path)
                    ? new FileSnapshot(true, Files.readAllBytes(path))
                    : new FileSnapshot(false, new byte[0]);
        }
    }

    /**
     * Atomic write helper: write to a temp file in the same directory, then replace the target.
     * Prevents consumers (e.g., Codex SDK/CLI) from observing a partially written file.
     */
    private void writeStringAtomically(Path target, String content) throws IOException {
        ensureCodexDirectory();

        Path parent = target.getParent();
        if (parent == null) {
            // Should never happen for ~/.codex/{config.toml,auth.json}
            Files.writeString(target, content, StandardCharsets.UTF_8);
            return;
        }

        String prefix = target.getFileName() != null ? target.getFileName() + "-" : "codex-";
        Path tmp = Files.createTempFile(parent, prefix, ".tmp");
        try {
            // Security (J): restrict to owner read/write (0600) before writing secrets
            // (auth.json holds OAuth tokens; config.toml may hold API keys). The atomic
            // move below preserves these permissions on the target file.
            hardenFilePermissions(tmp);
            Files.writeString(tmp, content, StandardCharsets.UTF_8);
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            try {
                Files.deleteIfExists(tmp);
            } catch (Exception e) {
                LOG.debug("[CodexSettingsManager] Failed to cleanup temp file: " + tmp + " (" + e.getMessage() + ")");
            }
        }
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). No-op on non-POSIX
     * filesystems (e.g. Windows), where the per-user home directory ACL applies. (Security J)
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[CodexSettingsManager] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }

    /**
     * Check if Codex CLI login credentials are available in ~/.codex/auth.json.
     * Looks for "auth_mode": "chatgpt" and valid tokens.
     */
    public boolean isCodexCliLoginAvailable() {
        try {
            JsonObject auth = readAuthJson();
            if (auth == null) {
                return false;
            }
            if (auth.has("OPENAI_API_KEY") && auth.get("OPENAI_API_KEY").isJsonPrimitive()
                    && !auth.get("OPENAI_API_KEY").getAsString().isBlank()) {
                return true;
            }
            // Check for chatgpt auth mode with tokens
            if (auth.has("auth_mode") && "chatgpt".equals(auth.get("auth_mode").getAsString())) {
                if (auth.has("tokens") && auth.get("tokens").isJsonObject()) {
                    JsonObject tokens = auth.getAsJsonObject("tokens");
                    return tokens.has("access_token") && !tokens.get("access_token").isJsonNull();
                }
            }
            return false;
        } catch (Exception e) {
            LOG.debug("[CodexSettingsManager] Failed to check CLI login availability: " + e.getMessage());
            return false;
        }
    }

    /**
     * Read Codex CLI login account info (email, name) from the JWT id_token in auth.json.
     * Only extracts safe display fields, never credentials or tokens.
     *
     * <p><b>Security note:</b> The JWT payload is decoded without signature verification.
     * The returned data is intended <b>only for UI display</b> (email, name, plan type)
     * and MUST NOT be used for authorization or access-control decisions.</p>
     *
     * @return JsonObject with email/name, or null if not available
     */
    public JsonObject readCodexCliLoginAccountInfo() {
        try {
            JsonObject auth = readAuthJson();
            if (auth == null || !auth.has("tokens") || !auth.get("tokens").isJsonObject()) {
                return null;
            }

            JsonObject tokens = auth.getAsJsonObject("tokens");
            if (!tokens.has("id_token") || tokens.get("id_token").isJsonNull()) {
                return null;
            }

            String idToken = tokens.get("id_token").getAsString();
            // JWT format: header.payload.signature — decode the payload section
            String[] parts = idToken.split("\\.");
            if (parts.length < 2) {
                return null;
            }

            // Base64url decode the payload
            String payload = parts[1];
            // Pad to multiple of 4
            while (payload.length() % 4 != 0) {
                payload += "=";
            }
            byte[] decoded = java.util.Base64.getUrlDecoder().decode(payload);
            String jsonStr = new String(decoded, StandardCharsets.UTF_8);

            JsonObject claims = JsonParser.parseString(jsonStr).getAsJsonObject();
            JsonObject safeInfo = new JsonObject();

            if (claims.has("email")) {
                safeInfo.addProperty("emailAddress", claims.get("email").getAsString());
            }
            if (claims.has("name")) {
                safeInfo.addProperty("name", claims.get("name").getAsString());
            }

            // Also extract plan info if available (from https://api.openai.com/auth claim)
            if (claims.has("https://api.openai.com/auth") && claims.get("https://api.openai.com/auth").isJsonObject()) {
                JsonObject authClaim = claims.getAsJsonObject("https://api.openai.com/auth");
                if (authClaim.has("chatgpt_plan_type")) {
                    safeInfo.addProperty("planType", authClaim.get("chatgpt_plan_type").getAsString());
                }
            }

            return safeInfo;
        } catch (Exception e) {
            LOG.debug("[CodexSettingsManager] Failed to read CLI login account info: " + e.getMessage());
            return null;
        }
    }

    /**
     * Get current Codex configuration (combined from config.toml and auth.json)
     */
    public JsonObject getCurrentCodexConfig() throws IOException {
        JsonObject result = new JsonObject();

        // Read config.toml
        Map<String, Object> configToml = readConfigToml();
        if (configToml != null) {
            result.add("config", mapToJsonObject(configToml));
        }

        // Read auth.json
        JsonObject authJson = readAuthJson();
        if (authJson != null) {
            result.add("auth", authJson);
        }

        return result;
    }

    /** Resolve a UI model id using the optional [model_aliases] table. */
    public String resolveModelAlias(String selectedModel) {
        if (selectedModel == null || selectedModel.trim().isEmpty()) {
            return selectedModel;
        }
        try {
            return resolveModelAlias(selectedModel, readConfigToml());
        } catch (IOException e) {
            LOG.warn("[CodexSettingsManager] Failed to read model aliases: " + e.getMessage());
            return selectedModel;
        }
    }

    static String resolveModelAlias(String selectedModel, Map<String, Object> configToml) {
        if (selectedModel == null || selectedModel.trim().isEmpty() || configToml == null) {
            return selectedModel;
        }
        Object aliasesObject = configToml.get(MODEL_ALIASES_KEY);
        if (!(aliasesObject instanceof Map)) {
            return selectedModel;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> aliases = (Map<String, Object>) aliasesObject;
        Object alias = aliases.get(selectedModel.trim());
        return alias instanceof String && !((String) alias).trim().isEmpty()
                ? ((String) alias).trim() : selectedModel;
    }

    // ==================== TOML Parsing Utilities ====================

    /**
     * Parses TOML 1.0 into mutable maps/lists used by the existing settings managers.
     */
    private Map<String, Object> parseToml(String content) throws IOException {
        TomlParseResult parsed = Toml.parse(content == null ? "" : content);
        if (parsed.hasErrors()) {
            StringBuilder errors = new StringBuilder();
            parsed.errors().forEach(error -> {
                if (errors.length() > 0) {
                    errors.append("; ");
                }
                errors.append(error);
            });
            throw new IOException("Invalid TOML: " + errors);
        }
        return convertTomlTable(parsed);
    }

    private Map<String, Object> convertTomlTable(TomlTable table) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : table.entrySet()) {
            result.put(entry.getKey(), convertTomlValue(entry.getValue()));
        }
        return result;
    }

    private Object convertTomlValue(Object value) {
        if (value instanceof TomlTable) {
            return convertTomlTable((TomlTable) value);
        }
        if (value instanceof TomlArray) {
            TomlArray array = (TomlArray) value;
            List<Object> result = new ArrayList<>();
            for (int i = 0; i < array.size(); i++) {
                result.add(convertTomlValue(array.get(i)));
            }
            return result;
        }
        return value;
    }

    /**
     * Generate TOML string from map
     */
    private String generateToml(Map<String, Object> config) {
        StringBuilder sb = new StringBuilder();

        // First, write top-level key=value pairs (exclude Map sections and array of tables)
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            Object val = entry.getValue();
            if (!(val instanceof Map) && !isArrayOfTables(val)) {
                sb.append(toTomlKey(entry.getKey())).append(" = ").append(toTomlValue(val)).append("\n");
            }
        }

        // Then write Map sections
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            if (entry.getValue() instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> section = (Map<String, Object>) entry.getValue();
                writeTomlSection(sb, toTomlKey(entry.getKey()), section);
            }
        }

        // Finally, write top-level array of tables ([[key]])
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            if (isArrayOfTables(entry.getValue())) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> tableList = (List<Map<String, Object>>) entry.getValue();
                for (Map<String, Object> tableEntry : tableList) {
                    sb.append("\n[[").append(toTomlKey(entry.getKey())).append("]]\n");
                    for (Map.Entry<String, Object> kv : tableEntry.entrySet()) {
                        sb.append(toTomlKey(kv.getKey())).append(" = ")
                                .append(toTomlValue(kv.getValue())).append("\n");
                    }
                }
            }
        }

        return sb.toString();
    }

    /**
     * Write a TOML section recursively.
     * Handles nested Map sections and List&lt;Map&gt; array of tables.
     */
    private void writeTomlSection(StringBuilder sb, String sectionPath, Map<String, Object> section) {
        // A simple value is anything that is not a nested table or array of tables.
        boolean hasSimpleValues = section.values().stream()
                                          .anyMatch(v -> !(v instanceof Map) && !isArrayOfTables(v));

        // Write section header and simple values
        if (hasSimpleValues) {
            sb.append("[").append(sectionPath).append("]\n");
            for (Map.Entry<String, Object> entry : section.entrySet()) {
                Object val = entry.getValue();
                if (val instanceof Map || isArrayOfTables(val)) {
                    continue;
                }
                sb.append(toTomlKey(entry.getKey())).append(" = ").append(toTomlValue(val)).append("\n");
            }
        }

        // Write nested sections (Map values)
        for (Map.Entry<String, Object> entry : section.entrySet()) {
            if (entry.getValue() instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedSection = (Map<String, Object>) entry.getValue();
                writeTomlSection(sb, sectionPath + "." + toTomlKey(entry.getKey()), nestedSection);
            }
        }

        // Write array of tables (List<Map> values) as [[section.key]]
        for (Map.Entry<String, Object> entry : section.entrySet()) {
            Object entryVal = entry.getValue();
            if (isArrayOfTables(entryVal)) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> tableList = (List<Map<String, Object>>) entry.getValue();
                String arrayPath = sectionPath + "." + toTomlKey(entry.getKey());
                for (Map<String, Object> tableEntry : tableList) {
                    sb.append("\n[[").append(arrayPath).append("]]\n");
                    for (Map.Entry<String, Object> kv : tableEntry.entrySet()) {
                        sb.append(toTomlKey(kv.getKey())).append(" = ")
                                .append(toTomlValue(kv.getValue())).append("\n");
                    }
                }
            }
        }
    }

    /**
     * Validates that a key is a valid TOML bare key.
     */
    private boolean isValidTomlKey(String key) {
        return key != null && !key.isEmpty() && TOML_KEY_PATTERN.matcher(key).matches();
    }

    private String toTomlKey(String key) {
        if (isValidTomlKey(key)) {
            return key;
        }
        return "\"" + escapeTomlString(key == null ? "" : key) + "\"";
    }

    /**
     * Checks if a value is an array of tables (List where elements are Maps).
     */
    private boolean isArrayOfTables(Object value) {
        if (!(value instanceof List<?> list)) {
            return false;
        }
        if (list.isEmpty()) {
            return false;
        }
        for (Object item : list) {
            if (!(item instanceof Map)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Convert Java object to TOML value string
     */
    private String toTomlValue(Object value) {
        if (value == null) {
            return "\"\"";
        }
        if (value instanceof Boolean) {
            return value.toString();
        }
        if (value instanceof Double) {
            double number = (Double) value;
            if (Double.isNaN(number)) {
                return "nan";
            }
            if (Double.isInfinite(number)) {
                return number > 0 ? "inf" : "-inf";
            }
        }
        if (value instanceof Number) {
            return value.toString();
        }
        if (value instanceof OffsetDateTime || value instanceof LocalDateTime
                || value instanceof LocalDate || value instanceof LocalTime) {
            return value.toString();
        }
        // List -> TOML array
        if (value instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) value;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) { sb.append(", "); }
                sb.append(toTomlValue(list.get(i)));
            }
            sb.append("]");
            return sb.toString();
        }
        // Map -> TOML inline table
        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) value;
            StringBuilder sb = new StringBuilder("{ ");
            boolean first = true;
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                if (!first) { sb.append(", "); }
                first = false;
                sb.append(toTomlKey(entry.getKey())).append(" = ");
                sb.append(toTomlValue(entry.getValue()));
            }
            sb.append(" }");
            return sb.toString();
        }
        // String: quote it
        String str = value.toString();
        return "\"" + escapeTomlString(str) + "\"";
    }

    /**
     * Escape special characters in TOML string
     */
    private String escapeTomlString(String str) {
        StringBuilder escaped = new StringBuilder(str.length());
        for (int i = 0; i < str.length(); i++) {
            char value = str.charAt(i);
            switch (value) {
                case '\b':
                    escaped.append("\\b");
                    break;
                case '\t':
                    escaped.append("\\t");
                    break;
                case '\n':
                    escaped.append("\\n");
                    break;
                case '\f':
                    escaped.append("\\f");
                    break;
                case '\r':
                    escaped.append("\\r");
                    break;
                case '"':
                    escaped.append("\\\"");
                    break;
                case '\\':
                    escaped.append("\\\\");
                    break;
                default:
                    if (value <= 0x1F || value == 0x7F) {
                        escaped.append("\\u");
                        appendHex4(escaped, value);
                    } else {
                        escaped.append(value);
                    }
                    break;
            }
        }
        return escaped.toString();
    }

    private void appendHex4(StringBuilder target, char value) {
        String hexDigits = "0123456789ABCDEF";
        target.append(hexDigits.charAt((value >> 12) & 0xF));
        target.append(hexDigits.charAt((value >> 8) & 0xF));
        target.append(hexDigits.charAt((value >> 4) & 0xF));
        target.append(hexDigits.charAt(value & 0xF));
    }


    /**
     * Convert Map to JsonObject
     */
    private JsonObject mapToJsonObject(Map<String, Object> map) {
        JsonObject result = new JsonObject();
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            Object value = entry.getValue();
            if (value == null) {
                result.add(entry.getKey(), com.google.gson.JsonNull.INSTANCE);
            } else if (value instanceof Boolean) {
                result.addProperty(entry.getKey(), (Boolean) value);
            } else if (value instanceof Number) {
                result.addProperty(entry.getKey(), (Number) value);
            } else if (value instanceof String) {
                result.addProperty(entry.getKey(), (String) value);
            } else if (value instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> list = (List<Object>) value;
                result.add(entry.getKey(), listToJsonArray(list));
            } else if (value instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedMap = (Map<String, Object>) value;
                result.add(entry.getKey(), mapToJsonObject(nestedMap));
            } else {
                result.addProperty(entry.getKey(), value.toString());
            }
        }
        return result;
    }

    /**
     * Convert List to JsonArray
     */
    private JsonArray listToJsonArray(List<Object> list) {
        JsonArray result = new JsonArray();
        for (Object item : list) {
            if (item == null) {
                result.add(com.google.gson.JsonNull.INSTANCE);
            } else if (item instanceof Boolean) {
                result.add((Boolean) item);
            } else if (item instanceof Number) {
                result.add((Number) item);
            } else if (item instanceof String) {
                result.add((String) item);
            } else if (item instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> nestedList = (List<Object>) item;
                result.add(listToJsonArray(nestedList));
            } else if (item instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedMap = (Map<String, Object>) item;
                result.add(mapToJsonObject(nestedMap));
            } else {
                result.add(item.toString());
            }
        }
        return result;
    }
}
