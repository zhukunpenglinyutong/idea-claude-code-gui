package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.ConflictStrategy;
import com.github.claudecodegui.model.DeleteResult;
import com.github.claudecodegui.model.PromptScope;
import com.github.claudecodegui.dependency.DependencyManager;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Codemoss configuration service (Facade pattern).
 * Delegates specific functionality to specialized managers.
 */
public class CodemossSettingsService {

    private static final Logger LOG = Logger.getInstance(CodemossSettingsService.class);
    private static final int CONFIG_VERSION = 2;
    private static final String CODEX_SANDBOX_MODE_WORKSPACE_WRITE = "workspace-write";
    private static final String CODEX_SANDBOX_MODE_DANGER_FULL_ACCESS = "danger-full-access";
    private static final String UI_FONT_CONFIG_KEY = "uiFont";
    private static final String CODE_FONT_CONFIG_KEY = "codeFont";
    // Shared by both UI font and code font: the persisted JSON keys ("mode" /
    // "customFontPath") and the set of valid modes are identical for the two font kinds,
    // so they reuse these UI_FONT_*-named constants. They are NOT UI-only despite the name.
    private static final String UI_FONT_MODE_KEY = "mode";
    private static final String UI_FONT_CUSTOM_PATH_KEY = "customFontPath";
    private static final Set<String> VALID_UI_FONT_MODES = Set.of(
            FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR,
            FontConfigService.UI_FONT_MODE_CUSTOM_FILE
    );
    public static final String CODEX_RUNTIME_ACCESS_INACTIVE = "inactive";
    public static final String CODEX_RUNTIME_ACCESS_MANAGED = "managed";
    public static final String CODEX_RUNTIME_ACCESS_CLI_LOGIN = "cli_login";
    private static final String COMMIT_AI_KEY = "commitAi";
    private static final String PROMPT_ENHANCER_KEY = "promptEnhancer";
    private static final String AI_FEATURE_PROVIDER_KEY = "provider";
    private static final String AI_FEATURE_MODELS_KEY = "models";
    private static final String AI_FEATURE_EFFECTIVE_PROVIDER_KEY = "effectiveProvider";
    private static final String AI_FEATURE_RESOLUTION_SOURCE_KEY = "resolutionSource";
    private static final String AI_FEATURE_AVAILABILITY_KEY = "availability";
    private static final String AI_FEATURE_PROVIDER_CLAUDE = "claude";
    private static final String AI_FEATURE_PROVIDER_CODEX = "codex";
    private static final String AI_FEATURE_RESOLUTION_MANUAL = "manual";
    private static final String AI_FEATURE_RESOLUTION_AUTO = "auto";
    private static final String AI_FEATURE_RESOLUTION_UNAVAILABLE = "unavailable";
    private static final String DEFAULT_PROMPT_ENHANCER_CLAUDE_MODEL = "claude-sonnet-4-6";
    private static final String DEFAULT_PROMPT_ENHANCER_CODEX_MODEL = "gpt-5.5";
    private static final String DEFAULT_COMMIT_AI_CLAUDE_MODEL = "claude-sonnet-4-6";
    private static final String DEFAULT_COMMIT_AI_CODEX_MODEL = "gpt-5.5";
    private static final String USER_LANGUAGE_CONFIG_KEY = "language";

    private final Gson gson;

    // Managers
    private final ConfigPathManager pathManager;
    private final ClaudeSettingsManager claudeSettingsManager;
    private final CodexSettingsManager codexSettingsManager;
    private final CodexMcpServerManager codexMcpServerManager;
    private final WorkingDirectoryManager workingDirectoryManager;
    private final AgentManager agentManager;
    private final SkillManager skillManager;
    private final McpServerManager mcpServerManager;
    private final ProviderManager providerManager;
    private final CodexProviderManager codexProviderManager;

    public CodemossSettingsService() {
        this.gson = new GsonBuilder().setPrettyPrinting().serializeNulls().create();

        // Initialize ConfigPathManager
        this.pathManager = new ConfigPathManager();

        // Initialize ClaudeSettingsManager
        this.claudeSettingsManager = new ClaudeSettingsManager(gson, pathManager);

        // Initialize WorkingDirectoryManager
        this.workingDirectoryManager = new WorkingDirectoryManager(
                (ignored) -> {
                    try {
                        return readConfig();
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                (config) -> {
                    try {
                        writeConfig(config);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                }
        );

        // Initialize AgentManager
        this.agentManager = new AgentManager(gson, pathManager);

        // Initialize SkillManager
        this.skillManager = new SkillManager(
                (ignored) -> {
                    try {
                        return readConfig();
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                (config) -> {
                    try {
                        writeConfig(config);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                claudeSettingsManager
        );

        // Initialize McpServerManager
        this.mcpServerManager = new McpServerManager(
                gson,
                (ignored) -> {
                    try {
                        return readConfig();
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                (config) -> {
                    try {
                        writeConfig(config);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                claudeSettingsManager
        );

        // Initialize ProviderManager
        this.providerManager = new ProviderManager(
                gson,
                (ignored) -> {
                    try {
                        return readConfig();
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                (config) -> {
                    try {
                        writeConfig(config);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                pathManager,
                claudeSettingsManager
        );

        // Initialize CodexSettingsManager
        this.codexSettingsManager = new CodexSettingsManager(gson);

        // Initialize CodexMcpServerManager
        this.codexMcpServerManager = new CodexMcpServerManager(codexSettingsManager);

        // Initialize CodexProviderManager
        this.codexProviderManager = new CodexProviderManager(
                gson,
                (ignored) -> {
                    try {
                        return readConfig();
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                (config) -> {
                    try {
                        writeConfig(config);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                },
                pathManager,
                codexSettingsManager
        );
    }

    // ==================== Basic Config Management ====================

    /**
     * Get config file path (~/.codemoss/config.json).
     */
    public String getConfigPath() {
        return pathManager.getConfigPath();
    }

    /**
     * Read the config file.
     */
    public JsonObject readConfig() throws IOException {
        String configPath = getConfigPath();
        File configFile = new File(configPath);

        if (!configFile.exists()) {
            LOG.info("[CodemossSettings] Config file not found, creating default: " + configPath);
            return createDefaultConfig();
        }

        try (FileReader reader = new FileReader(configFile, StandardCharsets.UTF_8)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            LOG.info("[CodemossSettings] Successfully read config from: " + configPath);
            return config;
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to read config: " + e.getMessage());
            return createDefaultConfig();
        }
    }

    /**
     * Write the config file.
     */
    public void writeConfig(JsonObject config) throws IOException {
        pathManager.ensureConfigDirectory();

        // Back up existing config
        backupConfig();

        String configPath = getConfigPath();
        try (FileWriter writer = new FileWriter(configPath, StandardCharsets.UTF_8)) {
            gson.toJson(config, writer);
            LOG.info("[CodemossSettings] Successfully wrote config to: " + configPath);
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to write config: " + e.getMessage());
            throw e;
        }
        // Security (J): config.json holds provider API keys/tokens; restrict to 0600.
        hardenFilePermissions(Paths.get(configPath));
    }

    private void backupConfig() {
        try {
            Path configPath = pathManager.getConfigFilePath();
            if (Files.exists(configPath)) {
                Path backupPath = Paths.get(pathManager.getBackupPath());
                Files.copy(configPath, backupPath, StandardCopyOption.REPLACE_EXISTING);
                // Security (J): the .bak copy also contains secrets; restrict to 0600.
                hardenFilePermissions(backupPath);
            }
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to backup config: " + e.getMessage());
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
            LOG.debug("[CodemossSettings] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }

    /**
     * Create default config.
     */
    private JsonObject createDefaultConfig() {
        JsonObject config = new JsonObject();
        config.addProperty("version", CONFIG_VERSION);

        // Claude config - empty provider list
        JsonObject claude = new JsonObject();
        JsonObject providers = new JsonObject();

        claude.addProperty("current", "");
        claude.add("providers", providers);
        config.add("claude", claude);

        JsonObject codex = new JsonObject();
        codex.addProperty("current", "");
        codex.add("providers", new JsonObject());
        codex.addProperty("localConfigAuthorized", false);
        config.add("codex", codex);

        return config;
    }

    // ==================== Language Config Management ====================

    /**
     * Get the manually configured UI language.
     *
     * @return configured language code, or null when the UI should follow the IDE language
     */
    public String getUserLanguage() throws IOException {
        JsonObject config = readConfig();
        if (!config.has(USER_LANGUAGE_CONFIG_KEY) || config.get(USER_LANGUAGE_CONFIG_KEY).isJsonNull()) {
            return null;
        }
        String language = config.get(USER_LANGUAGE_CONFIG_KEY).getAsString();
        return language == null || language.trim().isEmpty() ? null : language.trim();
    }

    /**
     * Persist the manually configured UI language.
     *
     * @param language supported UI language code
     */
    public void setUserLanguage(String language) throws IOException {
        JsonObject config = readConfig();
        config.addProperty(USER_LANGUAGE_CONFIG_KEY, language);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set user language: " + language);
    }

    /**
     * Clear the manual UI language override so the webview follows the IDE language.
     */
    public void clearUserLanguage() throws IOException {
        JsonObject config = readConfig();
        config.remove(USER_LANGUAGE_CONFIG_KEY);
        writeConfig(config);
        LOG.info("[CodemossSettings] Cleared user language override");
    }

    // ==================== Claude Settings Management ====================

    public JsonObject getCurrentClaudeConfig() throws IOException {
        JsonObject currentConfig = claudeSettingsManager.getCurrentClaudeConfig();

        // If codemossProviderId exists, try to get provider name from codemoss config
        if (currentConfig.has("providerId")) {
            String providerId = currentConfig.get("providerId").getAsString();
            try {
                JsonObject config = readConfig();
                if (config.has("claude")) {
                    JsonObject claude = config.getAsJsonObject("claude");
                    if (claude.has("providers")) {
                        JsonObject providers = claude.getAsJsonObject("providers");
                        if (providers.has(providerId)) {
                            JsonObject provider = providers.getAsJsonObject(providerId);
                            if (provider.has("name")) {
                                currentConfig.addProperty("providerName", provider.get("name").getAsString());
                            }
                        }
                    }
                }
            } catch (Exception e) {
                // Ignore error - provider name is optional
            }
        }

        return currentConfig;
    }

    public JsonObject readClaudeSettings() throws IOException {
        return claudeSettingsManager.readClaudeSettings();
    }

    public Boolean getAlwaysThinkingEnabledFromClaudeSettings() throws IOException {
        return claudeSettingsManager.getAlwaysThinkingEnabled();
    }

    public void setAlwaysThinkingEnabledInClaudeSettings(boolean enabled) throws IOException {
        claudeSettingsManager.setAlwaysThinkingEnabled(enabled);
    }

    public boolean setAlwaysThinkingEnabledInActiveProvider(boolean enabled) throws IOException {
        return providerManager.setAlwaysThinkingEnabledInActiveProvider(enabled);
    }

    public void applyProviderToClaudeSettings(JsonObject provider) throws IOException {
        claudeSettingsManager.applyProviderToClaudeSettings(provider);
    }

    public void applyCliLoginToClaudeSettings() throws IOException {
        claudeSettingsManager.applyCliLoginToClaudeSettings();
    }

    public void removeCliLoginFromClaudeSettings() throws IOException {
        claudeSettingsManager.removeCliLoginFromClaudeSettings();
    }

    public JsonObject readCliLoginAccountInfo() {
        return claudeSettingsManager.readCliLoginAccountInfo();
    }

    public void applyActiveProviderToClaudeSettings() throws IOException {
        providerManager.applyActiveProviderToClaudeSettings();
    }

    // ==================== Working Directory Management ====================

    public String getCustomWorkingDirectory(String projectPath) throws IOException {
        return workingDirectoryManager.getCustomWorkingDirectory(projectPath);
    }

    public void setCustomWorkingDirectory(String projectPath, String customWorkingDir) throws IOException {
        workingDirectoryManager.setCustomWorkingDirectory(projectPath, customWorkingDir);
    }

    /**
     * Resolve the normalized effective working directory for a project (custom
     * directory if configured and valid, otherwise the normalized project path).
     * This is the directory Claude runs in and the key history is stored under.
     */
    public String getEffectiveWorkingDirectory(String projectPath) {
        return workingDirectoryManager.resolveEffectiveWorkingDirectory(projectPath);
    }

    public Map<String, String> getAllWorkingDirectories() throws IOException {
        return workingDirectoryManager.getAllWorkingDirectories();
    }

    // ==================== Commit Prompt Config Management ====================

    /**
     * Get the commit AI prompt.
     *
     * @return commit prompt
     */
    public String getCommitPrompt() throws IOException {
        JsonObject config = readConfig();

        // Check for commitPrompt config
        if (config.has("commitPrompt")) {
            return config.get("commitPrompt").getAsString();
        }

        // Return default value (from i18n resource bundle)
        return ClaudeCodeGuiBundle.message("commit.defaultPrompt");
    }

    /**
     * Set the commit AI prompt.
     *
     * @param prompt commit prompt
     */
    public void setCommitPrompt(String prompt) throws IOException {
        JsonObject config = readConfig();

        // Save config
        config.addProperty("commitPrompt", prompt);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set commit prompt: " + prompt);
    }

    /**
     * Get project-level commit AI prompt.
     *
     * @param projectPath project path
     * @return project commit prompt, empty string if not configured
     */
    public String getProjectCommitPrompt(String projectPath) throws IOException {
        if (projectPath == null) {
            return "";
        }
        JsonObject config = readConfig();
        if (config.has("projectCommitPrompt")) {
            JsonObject projectPrompts = config.getAsJsonObject("projectCommitPrompt");
            if (projectPrompts.has(projectPath)) {
                return projectPrompts.get(projectPath).getAsString();
            }
        }
        return "";
    }

    /**
     * Set project-level commit AI prompt.
     *
     * @param projectPath project path
     * @param prompt commit prompt
     */
    public void setProjectCommitPrompt(String projectPath, String prompt) throws IOException {
        if (projectPath == null) {
            return;
        }
        JsonObject config = readConfig();
        JsonObject projectPrompts;
        if (config.has("projectCommitPrompt")) {
            projectPrompts = config.getAsJsonObject("projectCommitPrompt");
        } else {
            projectPrompts = new JsonObject();
            config.add("projectCommitPrompt", projectPrompts);
        }
        projectPrompts.addProperty(projectPath, prompt);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set project commit prompt for project: " + projectPath);
    }

    // ==================== UI Font Config Management ====================

    /**
     * Get persisted UI font configuration.
     *
     * @return normalized UI font configuration
     */
    public JsonObject getUiFontConfig() throws IOException {
        JsonObject config = readConfig();
        if (!config.has(UI_FONT_CONFIG_KEY) || !config.get(UI_FONT_CONFIG_KEY).isJsonObject()) {
            return createDefaultUiFontConfig();
        }
        return normalizeUiFontConfig(config.getAsJsonObject(UI_FONT_CONFIG_KEY));
    }

    /**
     * Persist UI font configuration.
     *
     * @param mode requested mode
     * @param customFontPath custom font path for custom file mode
     */
    public void setUiFontConfig(String mode, String customFontPath) throws IOException {
        JsonObject config = readConfig();
        config.add(UI_FONT_CONFIG_KEY, createUiFontConfig(mode, customFontPath));
        writeConfig(config);
        LOG.debug("[CodemossSettings] Set UI font config: mode=" + mode
                + ", customFontPath=" + customFontPath);
    }

    /**
     * Get persisted code font configuration.
     *
     * @return normalized code font configuration
     */
    public JsonObject getCodeFontConfig() throws IOException {
        JsonObject config = readConfig();
        if (!config.has(CODE_FONT_CONFIG_KEY) || !config.get(CODE_FONT_CONFIG_KEY).isJsonObject()) {
            return createDefaultCodeFontConfig();
        }
        return normalizeCodeFontConfig(config.getAsJsonObject(CODE_FONT_CONFIG_KEY));
    }

    /**
     * Persist code font configuration.
     *
     * @param mode requested mode
     * @param customFontPath custom font path for custom file mode
     */
    public void setCodeFontConfig(String mode, String customFontPath) throws IOException {
        JsonObject config = readConfig();
        config.add(CODE_FONT_CONFIG_KEY, createCodeFontConfig(mode, customFontPath));
        writeConfig(config);
        LOG.debug("[CodemossSettings] Set code font config: mode=" + mode
                + ", customFontPath=" + customFontPath);
    }

    // ==================== Permission Dialog Timeout Config Management ====================

    public static final int DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS =
            PermissionDialogTimeoutSettings.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
    public static final int MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS =
            PermissionDialogTimeoutSettings.MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS;
    public static final int MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS =
            PermissionDialogTimeoutSettings.MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS;
    public static final long PERMISSION_SAFETY_NET_BUFFER_SECONDS =
            PermissionDialogTimeoutSettings.PERMISSION_SAFETY_NET_BUFFER_SECONDS;

    public static int clampPermissionDialogTimeoutSeconds(int seconds) {
        return PermissionDialogTimeoutSettings.clampPermissionDialogTimeoutSeconds(seconds);
    }

    public int getPermissionDialogTimeoutSeconds() throws IOException {
        return PermissionDialogTimeoutSettings.getPermissionDialogTimeoutSeconds(this);
    }

    public void setPermissionDialogTimeoutSeconds(int seconds) throws IOException {
        PermissionDialogTimeoutSettings.setPermissionDialogTimeoutSeconds(this, seconds);
    }

    // ==================== Streaming Config Management ====================

    /**
     * Get streaming configuration.
     *
     * @param projectPath project path
     * @return whether streaming is enabled
     */
    public boolean getStreamingEnabled(String projectPath) throws IOException {
        JsonObject config = readConfig();

        // Check for streaming config
        if (!config.has("streaming")) {
            return true;
        }

        JsonObject streaming = config.getAsJsonObject("streaming");

        // Check project-specific config first
        if (projectPath != null && streaming.has(projectPath)) {
            return streaming.get(projectPath).getAsBoolean();
        }

        // Fall back to global default if no project-specific config
        if (streaming.has("default")) {
            return streaming.get("default").getAsBoolean();
        }

        return true;
    }

    private JsonObject createDefaultUiFontConfig() {
        JsonObject uiFont = new JsonObject();
        uiFont.addProperty(UI_FONT_MODE_KEY, FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR);
        return uiFont;
    }

    private JsonObject createDefaultCodeFontConfig() {
        JsonObject codeFont = new JsonObject();
        codeFont.addProperty(UI_FONT_MODE_KEY, FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR);
        return codeFont;
    }

    private JsonObject normalizeUiFontConfig(JsonObject rawConfig) {
        if (rawConfig == null) {
            return createDefaultUiFontConfig();
        }
        String requestedMode = rawConfig.has(UI_FONT_MODE_KEY) && !rawConfig.get(UI_FONT_MODE_KEY).isJsonNull()
                ? rawConfig.get(UI_FONT_MODE_KEY).getAsString()
                : FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR;
        String customFontPath = rawConfig.has(UI_FONT_CUSTOM_PATH_KEY) && !rawConfig.get(UI_FONT_CUSTOM_PATH_KEY).isJsonNull()
                ? rawConfig.get(UI_FONT_CUSTOM_PATH_KEY).getAsString()
                : null;
        return createUiFontConfig(requestedMode, customFontPath);
    }

    private JsonObject createUiFontConfig(String mode, String customFontPath) {
        String normalizedMode = VALID_UI_FONT_MODES.contains(mode)
                ? mode
                : FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR;
        JsonObject uiFont = new JsonObject();
        uiFont.addProperty(UI_FONT_MODE_KEY, normalizedMode);

        if (FontConfigService.UI_FONT_MODE_CUSTOM_FILE.equals(normalizedMode)
                && customFontPath != null
                && !customFontPath.trim().isEmpty()) {
            uiFont.addProperty(UI_FONT_CUSTOM_PATH_KEY, customFontPath.trim());
        }

        return uiFont;
    }

    private JsonObject normalizeCodeFontConfig(JsonObject rawConfig) {
        if (rawConfig == null) {
            return createDefaultCodeFontConfig();
        }
        String requestedMode = rawConfig.has(UI_FONT_MODE_KEY) && !rawConfig.get(UI_FONT_MODE_KEY).isJsonNull()
                ? rawConfig.get(UI_FONT_MODE_KEY).getAsString()
                : FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR;
        String customFontPath = rawConfig.has(UI_FONT_CUSTOM_PATH_KEY) && !rawConfig.get(UI_FONT_CUSTOM_PATH_KEY).isJsonNull()
                ? rawConfig.get(UI_FONT_CUSTOM_PATH_KEY).getAsString()
                : null;
        return createCodeFontConfig(requestedMode, customFontPath);
    }

    private JsonObject createCodeFontConfig(String mode, String customFontPath) {
        // UI font and code font share the same valid-mode set (see VALID_UI_FONT_MODES).
        String normalizedMode = VALID_UI_FONT_MODES.contains(mode)
                ? mode
                : FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR;
        JsonObject codeFont = new JsonObject();
        codeFont.addProperty(UI_FONT_MODE_KEY, normalizedMode);

        if (FontConfigService.UI_FONT_MODE_CUSTOM_FILE.equals(normalizedMode)
                && customFontPath != null
                && !customFontPath.trim().isEmpty()) {
            codeFont.addProperty(UI_FONT_CUSTOM_PATH_KEY, customFontPath.trim());
        }

        return codeFont;
    }

    /**
     * Set streaming configuration.
     *
     * @param projectPath project path
     * @param enabled     whether to enable
     */
    public void setStreamingEnabled(String projectPath, boolean enabled) throws IOException {
        JsonObject config = readConfig();

        // Ensure streaming object exists
        JsonObject streaming;
        if (config.has("streaming")) {
            streaming = config.getAsJsonObject("streaming");
        } else {
            streaming = new JsonObject();
            config.add("streaming", streaming);
        }

        // Save project-specific config (also serves as default)
        if (projectPath != null) {
            streaming.addProperty(projectPath, enabled);
        }
        streaming.addProperty("default", enabled);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set streaming enabled to " + enabled + " for project: " + projectPath);
    }

    // ==================== Auto Open File Config Management ====================

    /**
     * Get auto-open file configuration.
     *
     * @param projectPath project path
     * @return whether auto-open file is enabled
     */
    public boolean getAutoOpenFileEnabled(String projectPath) throws IOException {
        JsonObject config = readConfig();

        // Check for autoOpenFile config
        if (!config.has("autoOpenFile")) {
            return false;
        }

        JsonObject autoOpenFile = config.getAsJsonObject("autoOpenFile");

        // Check project-specific config first
        if (projectPath != null && autoOpenFile.has(projectPath)) {
            return autoOpenFile.get(projectPath).getAsBoolean();
        }

        // Fall back to global default if no project-specific config
        if (autoOpenFile.has("default")) {
            return autoOpenFile.get("default").getAsBoolean();
        }

        return false;
    }

    /**
     * Set auto-open file configuration.
     *
     * @param projectPath project path
     * @param enabled     whether to enable
     */
    public void setAutoOpenFileEnabled(String projectPath, boolean enabled) throws IOException {
        JsonObject config = readConfig();

        // Ensure autoOpenFile object exists
        JsonObject autoOpenFile;
        if (config.has("autoOpenFile")) {
            autoOpenFile = config.getAsJsonObject("autoOpenFile");
        } else {
            autoOpenFile = new JsonObject();
            config.add("autoOpenFile", autoOpenFile);
        }

        // Save project-specific config (also serves as default)
        if (projectPath != null) {
            autoOpenFile.addProperty(projectPath, enabled);
        }
        autoOpenFile.addProperty("default", enabled);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set auto open file enabled to " + enabled + " for project: " + projectPath);
    }

    // ==================== Codex Sandbox Mode Config Management ====================

    /**
     * Get Codex sandbox mode configuration.
     *
     * @param projectPath project path
     * @return sandbox mode (workspace-write or danger-full-access)
     */
    public String getCodexSandboxMode(String projectPath) throws IOException {
        JsonObject config = readConfig();
        String defaultMode = getDefaultCodexSandboxMode();

        if (!config.has("codexSandboxMode")) {
            return defaultMode;
        }

        JsonObject sandboxConfig = config.getAsJsonObject("codexSandboxMode");

        if (projectPath != null && sandboxConfig.has(projectPath)) {
            String mode = sandboxConfig.get(projectPath).getAsString();
            return isValidCodexSandboxMode(mode) ? mode : defaultMode;
        }

        if (sandboxConfig.has("default")) {
            String mode = sandboxConfig.get("default").getAsString();
            return isValidCodexSandboxMode(mode) ? mode : defaultMode;
        }

        return defaultMode;
    }

    /**
     * Set Codex sandbox mode configuration.
     *
     * @param projectPath project path
     * @param sandboxMode sandbox mode (workspace-write or danger-full-access)
     */
    public void setCodexSandboxMode(String projectPath, String sandboxMode) throws IOException {
        if (!isValidCodexSandboxMode(sandboxMode)) {
            throw new IllegalArgumentException("Invalid Codex sandbox mode: " + sandboxMode);
        }

        JsonObject config = readConfig();

        JsonObject sandboxConfig;
        if (config.has("codexSandboxMode")) {
            sandboxConfig = config.getAsJsonObject("codexSandboxMode");
        } else {
            sandboxConfig = new JsonObject();
            config.add("codexSandboxMode", sandboxConfig);
        }

        if (projectPath != null) {
            sandboxConfig.addProperty(projectPath, sandboxMode);
        }
        sandboxConfig.addProperty("default", sandboxMode);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set Codex sandbox mode to " + sandboxMode + " for project: " + projectPath);
    }

    private boolean isValidCodexSandboxMode(String mode) {
        return CODEX_SANDBOX_MODE_WORKSPACE_WRITE.equals(mode)
                || CODEX_SANDBOX_MODE_DANGER_FULL_ACCESS.equals(mode);
    }

    private String getDefaultCodexSandboxMode() {
        // Security (F): default to workspace-write (sandboxed to the project) instead of
        // danger-full-access (no sandbox), so a prompt-injected Codex command is contained
        // to the project by default; full access must be an explicit opt-in. Windows keeps
        // danger-full-access as a platform fallback because the Codex sandbox is experimental
        // there (mirrors CodexSDKBridge.resolveCodexSandboxMode).
        return com.github.claudecodegui.util.PlatformUtils.isWindows()
                ? CODEX_SANDBOX_MODE_DANGER_FULL_ACCESS
                : CODEX_SANDBOX_MODE_WORKSPACE_WRITE;
    }

    // ==================== Provider Management ====================

    public List<JsonObject> getClaudeProviders() throws IOException {
        return providerManager.getClaudeProviders();
    }

    public JsonObject getActiveClaudeProvider() throws IOException {
        return providerManager.getActiveClaudeProvider();
    }

    public void addClaudeProvider(JsonObject provider) throws IOException {
        providerManager.addClaudeProvider(provider);
    }

    public void saveClaudeProvider(JsonObject provider) throws IOException {
        providerManager.saveClaudeProvider(provider);
    }

    public void updateClaudeProvider(String id, JsonObject updates) throws IOException {
        providerManager.updateClaudeProvider(id, updates);
    }

    public DeleteResult deleteClaudeProvider(String id) {
        return providerManager.deleteClaudeProvider(id);
    }

    @Deprecated
    public void deleteClaudeProviderWithException(String id) throws IOException {
        DeleteResult result = deleteClaudeProvider(id);
        if (!result.isSuccess()) {
            throw new IOException(result.getUserFriendlyMessage());
        }
    }

    public void switchClaudeProvider(String id) throws IOException {
        providerManager.switchClaudeProvider(id);
    }

    public void deactivateClaudeProvider() throws IOException {
        providerManager.deactivateClaudeProvider();
    }

    public List<JsonObject> parseProvidersFromCcSwitchDb(String dbPath) throws IOException {
        return providerManager.parseProvidersFromCcSwitchDb(dbPath);
    }

    public int saveProviders(List<JsonObject> providers) throws IOException {
        return providerManager.saveProviders(providers);
    }

    public void saveProviderOrder(List<String> orderedIds) throws IOException {
        providerManager.saveProviderOrder(orderedIds);
    }

    public boolean isLocalProviderActive() {
        return providerManager.isLocalProviderActive();
    }

    // ==================== MCP Server Management ====================

    public List<JsonObject> getMcpServers() throws IOException {
        return mcpServerManager.getMcpServers();
    }

    public List<JsonObject> getMcpServersWithProjectPath(String projectPath) throws IOException {
        return mcpServerManager.getMcpServersWithProjectPath(projectPath);
    }

    public void upsertMcpServer(JsonObject server) throws IOException {
        mcpServerManager.upsertMcpServer(server);
    }

    public void upsertMcpServer(JsonObject server, String projectPath) throws IOException {
        mcpServerManager.upsertMcpServer(server, projectPath);
    }

    public boolean deleteMcpServer(String serverId) throws IOException {
        return mcpServerManager.deleteMcpServer(serverId);
    }

    public Map<String, Object> validateMcpServer(JsonObject server) {
        return mcpServerManager.validateMcpServer(server);
    }

    // ==================== Codex MCP Server Management ====================

    public CodexMcpServerManager getCodexMcpServerManager() {
        return codexMcpServerManager;
    }

    public List<JsonObject> getCodexMcpServers() throws IOException {
        return codexMcpServerManager.getMcpServers();
    }

    public void upsertCodexMcpServer(JsonObject server) throws IOException {
        codexMcpServerManager.upsertMcpServer(server);
    }

    public boolean deleteCodexMcpServer(String serverId) throws IOException {
        return codexMcpServerManager.deleteMcpServer(serverId);
    }

    public Map<String, Object> validateCodexMcpServer(JsonObject server) {
        return codexMcpServerManager.validateMcpServer(server);
    }

    // ==================== Skills Management ====================

    public List<JsonObject> getSkills() throws IOException {
        return skillManager.getSkills();
    }

    public void upsertSkill(JsonObject skill) throws IOException {
        skillManager.upsertSkill(skill);
    }

    public boolean deleteSkill(String id) throws IOException {
        return skillManager.deleteSkill(id);
    }

    public Map<String, Object> validateSkill(JsonObject skill) {
        return skillManager.validateSkill(skill);
    }

    public void syncSkillsToClaudeSettings() throws IOException {
        skillManager.syncSkillsToClaudeSettings();
    }

    // ==================== Agents Management ====================

    public List<JsonObject> getAgents() throws IOException {
        return agentManager.getAgents();
    }

    public void addAgent(JsonObject agent) throws IOException {
        agentManager.addAgent(agent);
    }

    public void updateAgent(String id, JsonObject updates) throws IOException {
        agentManager.updateAgent(id, updates);
    }

    public boolean deleteAgent(String id) throws IOException {
        return agentManager.deleteAgent(id);
    }

    public JsonObject getAgent(String id) throws IOException {
        return agentManager.getAgent(id);
    }

    public String getSelectedAgentId() throws IOException {
        return agentManager.getSelectedAgentId();
    }

    public void setSelectedAgentId(String agentId) throws IOException {
        agentManager.setSelectedAgentId(agentId);
    }

    public AgentManager getAgentManager() {
        return agentManager;
    }

    // ==================== Prompts Management ====================

    /**
     * Get a PromptManager for the specified scope.
     * Creates managers on-demand using PromptManagerFactory.
     *
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return An AbstractPromptManager instance for the specified scope
     */
    public AbstractPromptManager getPromptManager(PromptScope scope, Project project) {
        return PromptManagerFactory.create(scope, gson, pathManager, project);
    }

    /**
     * Get prompts from the specified scope.
     *
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return List of prompts
     * @throws IOException if reading fails
     */
    public List<JsonObject> getPrompts(PromptScope scope, Project project) throws IOException {
        return getPrompts(scope, project, "claude");
    }

    public List<JsonObject> getPrompts(PromptScope scope, Project project, String provider) throws IOException {
        String normalizedProvider = normalizePromptProvider(provider);
        List<JsonObject> result = new ArrayList<>();
        for (JsonObject prompt : getPromptManager(scope, project).getPrompts()) {
            if (promptBelongsToProvider(prompt, normalizedProvider)) {
                JsonObject copy = prompt.deepCopy();
                copy.addProperty("provider", normalizedProvider);
                result.add(copy);
            }
        }
        return result;
    }

    /**
     * Add a prompt to the specified scope.
     *
     * @param prompt  The prompt to add
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @throws IOException if writing fails
     */
    public void addPrompt(JsonObject prompt, PromptScope scope, Project project) throws IOException {
        addPrompt(prompt, scope, project, "claude");
    }

    public void addPrompt(JsonObject prompt, PromptScope scope, Project project, String provider) throws IOException {
        AbstractPromptManager manager = getPromptManager(scope, project);
        JsonObject copy = prompt.deepCopy();
        String normalizedProvider = normalizePromptProvider(provider);
        copy.addProperty("provider", normalizedProvider);
        if (copy.has("id") && copy.get("id").isJsonPrimitive()) {
            String id = copy.get("id").getAsString();
            JsonObject existing = manager.getPrompt(id);
            if (existing != null && !promptBelongsToProvider(existing, normalizedProvider)) {
                JsonObject config = manager.readPromptConfig();
                copy.addProperty("id", manager.generateUniqueId(id, config.getAsJsonObject("prompts")));
            }
        }
        manager.addPrompt(copy);
    }

    /**
     * Update a prompt in the specified scope.
     *
     * @param id      The prompt ID
     * @param updates The updates to apply
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @throws IOException if writing fails
     */
    public void updatePrompt(String id, JsonObject updates, PromptScope scope, Project project) throws IOException {
        updatePrompt(id, updates, scope, project, "claude");
    }

    public void updatePrompt(String id, JsonObject updates, PromptScope scope, Project project, String provider) throws IOException {
        AbstractPromptManager manager = getPromptManager(scope, project);
        String normalizedProvider = normalizePromptProvider(provider);
        JsonObject existing = manager.getPrompt(id);
        if (!promptBelongsToProvider(existing, normalizedProvider)) {
            throw new IllegalArgumentException("Prompt with id '" + id + "' not found for provider " + normalizedProvider);
        }
        JsonObject copy = updates.deepCopy();
        copy.addProperty("provider", normalizedProvider);
        manager.updatePrompt(id, copy);
    }

    /**
     * Delete a prompt from the specified scope.
     *
     * @param id      The prompt ID
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return true if deleted, false if not found
     * @throws IOException if writing fails
     */
    public boolean deletePrompt(String id, PromptScope scope, Project project) throws IOException {
        return deletePrompt(id, scope, project, "claude");
    }

    public boolean deletePrompt(String id, PromptScope scope, Project project, String provider) throws IOException {
        AbstractPromptManager manager = getPromptManager(scope, project);
        String normalizedProvider = normalizePromptProvider(provider);
        JsonObject existing = manager.getPrompt(id);
        if (!promptBelongsToProvider(existing, normalizedProvider)) {
            return false;
        }
        return manager.deletePrompt(id);
    }

    /**
     * Get a prompt by ID from the specified scope.
     *
     * @param id      The prompt ID
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return The prompt JsonObject, or null if not found
     * @throws IOException if reading fails
     */
    public JsonObject getPrompt(String id, PromptScope scope, Project project) throws IOException {
        return getPrompt(id, scope, project, "claude");
    }

    public JsonObject getPrompt(String id, PromptScope scope, Project project, String provider) throws IOException {
        String normalizedProvider = normalizePromptProvider(provider);
        JsonObject prompt = getPromptManager(scope, project).getPrompt(id);
        if (!promptBelongsToProvider(prompt, normalizedProvider)) {
            return null;
        }
        JsonObject copy = prompt.deepCopy();
        copy.addProperty("provider", normalizedProvider);
        return copy;
    }

    /**
     * Batch import prompts to the specified scope.
     *
     * @param promptsToImport The prompts to import
     * @param strategy        The conflict resolution strategy
     * @param scope           The prompt scope (GLOBAL or PROJECT)
     * @param project         The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return A map containing the results of the import operation
     * @throws IOException if writing fails
     */
    public Map<String, Object> batchImportPrompts(List<JsonObject> promptsToImport, ConflictStrategy strategy, PromptScope scope, Project project) throws IOException {
        return batchImportPrompts(promptsToImport, strategy, scope, project, "claude");
    }

    public Map<String, Object> batchImportPrompts(List<JsonObject> promptsToImport, ConflictStrategy strategy,
                                                  PromptScope scope, Project project, String provider) throws IOException {
        AbstractPromptManager manager = getPromptManager(scope, project);
        String normalizedProvider = normalizePromptProvider(provider);
        List<JsonObject> scopedPrompts = new ArrayList<>();
        for (JsonObject prompt : promptsToImport) {
            JsonObject copy = prompt.deepCopy();
            copy.addProperty("provider", normalizedProvider);
            scopedPrompts.add(copy);
        }
        return batchImportProviderPrompts(manager, scopedPrompts, strategy, normalizedProvider);
    }

    public Set<String> detectPromptConflicts(List<JsonObject> promptsToImport, PromptScope scope,
                                             Project project, String provider) throws IOException {
        AbstractPromptManager manager = getPromptManager(scope, project);
        String normalizedProvider = normalizePromptProvider(provider);
        Set<String> conflicts = new HashSet<>();
        JsonObject existingPrompts = manager.readPromptConfig().getAsJsonObject("prompts");
        for (JsonObject prompt : promptsToImport) {
            if (!prompt.has("id") || !prompt.get("id").isJsonPrimitive()) {
                continue;
            }
            String id = prompt.get("id").getAsString();
            if (existingPrompts.has(id)
                    && promptBelongsToProvider(existingPrompts.getAsJsonObject(id), normalizedProvider)) {
                conflicts.add(id);
            }
        }
        return conflicts;
    }

    private Map<String, Object> batchImportProviderPrompts(AbstractPromptManager manager,
                                                           List<JsonObject> promptsToImport,
                                                           ConflictStrategy strategy,
                                                           String provider) throws IOException {
        Map<String, Object> result = new HashMap<>();
        int imported = 0;
        int skipped = 0;
        int updated = 0;
        List<String> errors = new ArrayList<>();

        JsonObject config = manager.readPromptConfig();
        JsonObject prompts = config.getAsJsonObject("prompts");
        Set<String> conflicts = new HashSet<>();
        for (JsonObject prompt : promptsToImport) {
            if (!prompt.has("id") || !prompt.get("id").isJsonPrimitive()) {
                continue;
            }
            String id = prompt.get("id").getAsString();
            if (prompts.has(id) && promptBelongsToProvider(prompts.getAsJsonObject(id), provider)) {
                conflicts.add(id);
            }
        }

        for (JsonObject prompt : promptsToImport) {
            try {
                String validationError = manager.validatePrompt(prompt);
                if (validationError != null) {
                    errors.add("Validation failed: " + validationError);
                    skipped++;
                    continue;
                }

                String id = prompt.get("id").getAsString();
                boolean hasSameProviderConflict = conflicts.contains(id);

                if (hasSameProviderConflict) {
                    switch (strategy) {
                        case SKIP:
                            skipped++;
                            continue;
                        case OVERWRITE:
                            JsonObject overwritePrompt = prompt.deepCopy();
                            overwritePrompt.addProperty("provider", provider);
                            overwritePrompt.addProperty("updatedAt", System.currentTimeMillis());
                            prompts.add(id, overwritePrompt);
                            updated++;
                            break;
                        case DUPLICATE:
                            String duplicateId = manager.generateUniqueId(id, prompts);
                            JsonObject duplicatePrompt = prompt.deepCopy();
                            duplicatePrompt.addProperty("id", duplicateId);
                            duplicatePrompt.addProperty("provider", provider);
                            if (!duplicatePrompt.has("createdAt")) {
                                duplicatePrompt.addProperty("createdAt", System.currentTimeMillis());
                            }
                            duplicatePrompt.addProperty("updatedAt", System.currentTimeMillis());
                            prompts.add(duplicateId, duplicatePrompt);
                            imported++;
                            break;
                    }
                } else {
                    String targetId = prompts.has(id) ? manager.generateUniqueId(id, prompts) : id;
                    JsonObject newPrompt = prompt.deepCopy();
                    newPrompt.addProperty("id", targetId);
                    newPrompt.addProperty("provider", provider);
                    if (!newPrompt.has("createdAt")) {
                        newPrompt.addProperty("createdAt", System.currentTimeMillis());
                    }
                    if (!newPrompt.has("updatedAt")) {
                        newPrompt.addProperty("updatedAt", System.currentTimeMillis());
                    }
                    prompts.add(targetId, newPrompt);
                    imported++;
                }
            } catch (Exception e) {
                errors.add("Failed to import prompt: " + e.getMessage());
                skipped++;
            }
        }

        manager.writePromptConfig(config);
        result.put("imported", imported);
        result.put("updated", updated);
        result.put("skipped", skipped);
        result.put("errors", errors);
        result.put("success", errors.isEmpty());
        return result;
    }

    public static String normalizePromptProvider(String provider) {
        return "codex".equalsIgnoreCase(provider) ? "codex" : "claude";
    }

    private static boolean promptBelongsToProvider(JsonObject prompt, String provider) {
        if (prompt == null) {
            return false;
        }
        String promptProvider = prompt.has("provider")
                && prompt.get("provider").isJsonPrimitive()
                && prompt.get("provider").getAsJsonPrimitive().isString()
                ? prompt.get("provider").getAsString()
                : "claude";
        return normalizePromptProvider(promptProvider).equals(provider);
    }

    // ==================== Deprecated Backward-Compatible Methods ====================

    /**
     * Get a PromptManager (defaults to GLOBAL scope).
     *
     * @deprecated Use {@link #getPromptManager(PromptScope, Project)} instead
     */
    @Deprecated
    public AbstractPromptManager getPromptManager() {
        return getPromptManager(PromptScope.GLOBAL, null);
    }

    /**
     * Get prompts (defaults to GLOBAL scope).
     *
     * @deprecated Use {@link #getPrompts(PromptScope, Project)} instead
     */
    @Deprecated
    public List<JsonObject> getPrompts() throws IOException {
        return getPrompts(PromptScope.GLOBAL, null);
    }

    /**
     * Add a prompt (defaults to GLOBAL scope).
     *
     * @deprecated Use {@link #addPrompt(JsonObject, PromptScope, Project)} instead
     */
    @Deprecated
    public void addPrompt(JsonObject prompt) throws IOException {
        addPrompt(prompt, PromptScope.GLOBAL, null);
    }

    /**
     * Update a prompt (defaults to GLOBAL scope).
     *
     * @deprecated Use {@link #updatePrompt(String, JsonObject, PromptScope, Project)} instead
     */
    @Deprecated
    public void updatePrompt(String id, JsonObject updates) throws IOException {
        updatePrompt(id, updates, PromptScope.GLOBAL, null);
    }

    /**
     * Delete a prompt (defaults to GLOBAL scope).
     *
     * @deprecated Use {@link #deletePrompt(String, PromptScope, Project)} instead
     */
    @Deprecated
    public boolean deletePrompt(String id) throws IOException {
        return deletePrompt(id, PromptScope.GLOBAL, null);
    }

    /**
     * Get a prompt by ID (defaults to GLOBAL scope).
     *
     * @deprecated Use {@link #getPrompt(String, PromptScope, Project)} instead
     */
    @Deprecated
    public JsonObject getPrompt(String id) throws IOException {
        return getPrompt(id, PromptScope.GLOBAL, null);
    }

    // ==================== Sound Notification Management ====================

    /**
     * Get whether sound notification is enabled.
     *
     * @return whether sound notification is enabled, default is false
     */
    public boolean getSoundNotificationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (!config.has("soundNotification")) {
            return false;
        }

        JsonObject soundConfig = config.getAsJsonObject("soundNotification");
        if (soundConfig.has("enabled")) {
            return soundConfig.get("enabled").getAsBoolean();
        }

        return false;
    }

    /**
     * Set whether sound notification is enabled.
     *
     * @param enabled whether to enable
     */
    public void setSoundNotificationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();

        JsonObject soundConfig;
        if (config.has("soundNotification")) {
            soundConfig = config.getAsJsonObject("soundNotification");
        } else {
            soundConfig = new JsonObject();
            config.add("soundNotification", soundConfig);
        }

        soundConfig.addProperty("enabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set sound notification enabled: " + enabled);
    }

    /**
     * Get custom sound file path.
     *
     * @return custom sound path, null means use default sound
     */
    public String getCustomSoundPath() throws IOException {
        JsonObject config = readConfig();

        if (!config.has("soundNotification")) {
            return null;
        }

        JsonObject soundConfig = config.getAsJsonObject("soundNotification");
        if (soundConfig.has("customSoundPath") && !soundConfig.get("customSoundPath").isJsonNull()) {
            return soundConfig.get("customSoundPath").getAsString();
        }

        return null;
    }

    /**
     * Set custom sound file path.
     *
     * @param path file path, null means use default sound
     */
    public void setCustomSoundPath(String path) throws IOException {
        JsonObject config = readConfig();

        JsonObject soundConfig;
        if (config.has("soundNotification")) {
            soundConfig = config.getAsJsonObject("soundNotification");
        } else {
            soundConfig = new JsonObject();
            config.add("soundNotification", soundConfig);
        }

        if (path == null || path.isEmpty()) {
            soundConfig.remove("customSoundPath");
        } else {
            soundConfig.addProperty("customSoundPath", path);
        }

        writeConfig(config);
        LOG.info("[CodemossSettings] Set custom sound path: " + path);
    }

    /**
     * Get whether sound should only play when IDE window is not focused.
     *
     * @return whether only-when-unfocused is enabled, default is false
     */
    public boolean getSoundOnlyWhenUnfocused() throws IOException {
        JsonObject config = readConfig();

        if (!config.has("soundNotification")) {
            return false;
        }

        JsonObject soundConfig = config.getAsJsonObject("soundNotification");
        if (soundConfig.has("onlyWhenUnfocused")) {
            return soundConfig.get("onlyWhenUnfocused").getAsBoolean();
        }

        return false;
    }

    /**
     * Set whether sound should only play when IDE window is not focused.
     *
     * @param enabled whether to enable
     */
    public void setSoundOnlyWhenUnfocused(boolean enabled) throws IOException {
        JsonObject config = readConfig();

        JsonObject soundConfig;
        if (config.has("soundNotification")) {
            soundConfig = config.getAsJsonObject("soundNotification");
        } else {
            soundConfig = new JsonObject();
            config.add("soundNotification", soundConfig);
        }

        soundConfig.addProperty("onlyWhenUnfocused", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set sound only when unfocused: " + enabled);
    }

    /**
     * Get selected sound ID.
     *
     * @return sound ID (e.g. "default", "chime", "bell", "ding", "success", "custom"), defaults to "default"
     */
    public String getSelectedSound() throws IOException {
        JsonObject config = readConfig();

        if (!config.has("soundNotification")) {
            return "default";
        }

        JsonObject soundConfig = config.getAsJsonObject("soundNotification");
        if (soundConfig.has("selectedSound") && !soundConfig.get("selectedSound").isJsonNull()) {
            return soundConfig.get("selectedSound").getAsString();
        }

        return "default";
    }

    /**
     * Set selected sound ID.
     *
     * @param soundId sound ID, null or empty means "default"
     */
    public void setSelectedSound(String soundId) throws IOException {
        JsonObject config = readConfig();

        JsonObject soundConfig;
        if (config.has("soundNotification")) {
            soundConfig = config.getAsJsonObject("soundNotification");
        } else {
            soundConfig = new JsonObject();
            config.add("soundNotification", soundConfig);
        }

        soundConfig.addProperty("selectedSound", (soundId == null || soundId.isEmpty()) ? "default" : soundId);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set selected sound: " + soundId);
    }

    // ==================== Task Completion Notification Management ====================

    /**
     * Get whether task completion balloon notification is enabled.
     *
     * @return whether task completion notification is enabled, default is false (opt-in)
     */
    public boolean getTaskCompletionNotificationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("taskCompletionNotificationEnabled") && !config.get("taskCompletionNotificationEnabled").isJsonNull()) {
            return config.get("taskCompletionNotificationEnabled").getAsBoolean();
        }

        return false;
    }

    /**
     * Set whether task completion balloon notification is enabled.
     *
     * @param enabled whether to enable
     */
    public void setTaskCompletionNotificationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("taskCompletionNotificationEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set task completion notification enabled: " + enabled);
    }

    // ==================== Ask User Question Notification Management ====================

    /**
     * Get whether the AskUserQuestion reminder notification is enabled.
     *
     * @return whether the reminder notification is enabled, default is false (opt-in)
     */
    public boolean getAskUserQuestionNotificationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("askUserQuestionNotificationEnabled") && !config.get("askUserQuestionNotificationEnabled").isJsonNull()) {
            return config.get("askUserQuestionNotificationEnabled").getAsBoolean();
        }

        return false;
    }

    /**
     * Set whether the AskUserQuestion reminder notification is enabled.
     *
     * @param enabled whether to enable
     */
    public void setAskUserQuestionNotificationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("askUserQuestionNotificationEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set ask user question notification enabled: " + enabled);
    }

    // ==================== AI Feature Toggle Management ====================

    /**
     * Get whether AI commit message generation is enabled.
     *
     * @return whether commit generation is enabled, default is true
     */
    public boolean getCommitGenerationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("commitGenerationEnabled") && !config.get("commitGenerationEnabled").isJsonNull()) {
            return config.get("commitGenerationEnabled").getAsBoolean();
        }

        return true;
    }

    /**
     * Set whether AI commit message generation is enabled.
     *
     * @param enabled whether to enable
     */
    public void setCommitGenerationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("commitGenerationEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set commit generation enabled: " + enabled);
    }

    /**
     * Get whether status bar widget is enabled.
     *
     * @return whether status bar widget is enabled, default is true
     */
    public boolean getStatusBarWidgetEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("statusBarWidgetEnabled") && !config.get("statusBarWidgetEnabled").isJsonNull()) {
            return config.get("statusBarWidgetEnabled").getAsBoolean();
        }

        return true;
    }

    /**
     * Set whether status bar widget is enabled.
     *
     * @param enabled whether to enable
     */
    public void setStatusBarWidgetEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("statusBarWidgetEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set status bar widget enabled: " + enabled);
    }

    /**
     * Get whether AI session title generation is enabled.
     *
     * @return whether AI title generation is enabled, default is true
     */
    public boolean getAiTitleGenerationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("aiTitleGenerationEnabled") && !config.get("aiTitleGenerationEnabled").isJsonNull()) {
            return config.get("aiTitleGenerationEnabled").getAsBoolean();
        }

        return true;
    }

    /**
     * Set whether AI session title generation is enabled.
     *
     * @param enabled whether to enable
     */
    public void setAiTitleGenerationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("aiTitleGenerationEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set AI title generation enabled: " + enabled);
    }

    // ==================== Prompt Enhancer Config Management ====================

    /**
     * Get prompt enhancer configuration with resolved provider availability.
     *
     * <p>The returned object always includes:
     * <ul>
     *     <li>provider: manual override or null</li>
     *     <li>models: per-provider remembered models</li>
     *     <li>effectiveProvider: resolved runtime provider or null</li>
     *     <li>resolutionSource: manual/auto/unavailable</li>
     *     <li>availability: per-provider availability flags</li>
     * </ul>
     */
    public JsonObject getPromptEnhancerConfig() throws IOException {
        return getAiFeatureConfig(
                PROMPT_ENHANCER_KEY,
                DEFAULT_PROMPT_ENHANCER_CLAUDE_MODEL,
                DEFAULT_PROMPT_ENHANCER_CODEX_MODEL
        );
    }

    /**
     * Persist prompt enhancer provider override and per-provider models.
     *
     * @param provider manual provider override, null/blank to restore auto mode
     * @param claudeModel remembered Claude enhancer model
     * @param codexModel remembered Codex enhancer model
     */
    public void setPromptEnhancerConfig(String provider, String claudeModel, String codexModel) throws IOException {
        setAiFeatureConfig(
                PROMPT_ENHANCER_KEY,
                provider,
                claudeModel,
                codexModel,
                DEFAULT_PROMPT_ENHANCER_CLAUDE_MODEL,
                DEFAULT_PROMPT_ENHANCER_CODEX_MODEL,
                "prompt enhancer"
        );
    }

    public JsonObject getCommitAiConfig() throws IOException {
        return getAiFeatureConfig(
                COMMIT_AI_KEY,
                DEFAULT_COMMIT_AI_CLAUDE_MODEL,
                DEFAULT_COMMIT_AI_CODEX_MODEL
        );
    }

    public void setCommitAiConfig(String provider, String claudeModel, String codexModel) throws IOException {
        setAiFeatureConfig(
                COMMIT_AI_KEY,
                provider,
                claudeModel,
                codexModel,
                DEFAULT_COMMIT_AI_CLAUDE_MODEL,
                DEFAULT_COMMIT_AI_CODEX_MODEL,
                "commit AI"
        );
    }

    private JsonObject getAiFeatureConfig(
            String featureKey,
            String defaultClaudeModel,
            String defaultCodexModel
    ) throws IOException {
        JsonObject rootConfig = readConfig();
        JsonObject featureConfig = getAiFeatureRootObject(rootConfig, featureKey);
        String manualProvider = normalizeAiFeatureProvider(
                featureConfig.has(AI_FEATURE_PROVIDER_KEY) && !featureConfig.get(AI_FEATURE_PROVIDER_KEY).isJsonNull()
                        ? featureConfig.get(AI_FEATURE_PROVIDER_KEY).getAsString()
                        : null
        );
        JsonObject models = getNormalizedAiFeatureModels(featureConfig, defaultClaudeModel, defaultCodexModel);
        JsonObject availability = buildAiFeatureAvailability();
        boolean claudeAvailable = availability.get(AI_FEATURE_PROVIDER_CLAUDE).getAsBoolean();
        boolean codexAvailable = availability.get(AI_FEATURE_PROVIDER_CODEX).getAsBoolean();
        ResolvedAiFeatureProvider resolvedProvider = resolveAiFeatureProvider(
                manualProvider,
                claudeAvailable,
                codexAvailable
        );

        JsonObject response = new JsonObject();
        if (manualProvider == null) {
            response.add(AI_FEATURE_PROVIDER_KEY, JsonNull.INSTANCE);
        } else {
            response.addProperty(AI_FEATURE_PROVIDER_KEY, manualProvider);
        }
        response.add(AI_FEATURE_MODELS_KEY, models);
        if (resolvedProvider.effectiveProvider == null) {
            response.add(AI_FEATURE_EFFECTIVE_PROVIDER_KEY, JsonNull.INSTANCE);
        } else {
            response.addProperty(AI_FEATURE_EFFECTIVE_PROVIDER_KEY, resolvedProvider.effectiveProvider);
        }
        response.addProperty(AI_FEATURE_RESOLUTION_SOURCE_KEY, resolvedProvider.resolutionSource);
        response.add(AI_FEATURE_AVAILABILITY_KEY, availability);
        return response;
    }

    private void setAiFeatureConfig(
            String featureKey,
            String provider,
            String claudeModel,
            String codexModel,
            String defaultClaudeModel,
            String defaultCodexModel,
            String featureLabel
    ) throws IOException {
        JsonObject config = readConfig();
        JsonObject featureConfig = getAiFeatureRootObject(config, featureKey);
        String normalizedProvider = normalizeAiFeatureProvider(provider);
        if (normalizedProvider == null) {
            featureConfig.add(AI_FEATURE_PROVIDER_KEY, JsonNull.INSTANCE);
        } else {
            featureConfig.addProperty(AI_FEATURE_PROVIDER_KEY, normalizedProvider);
        }
        featureConfig.add(
                AI_FEATURE_MODELS_KEY,
                createAiFeatureModels(claudeModel, codexModel, defaultClaudeModel, defaultCodexModel)
        );

        config.add(featureKey, featureConfig);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set " + featureLabel + " config: provider=" + normalizedProvider);
    }

    private JsonObject getAiFeatureRootObject(JsonObject rootConfig, String featureKey) {
        if (rootConfig.has(featureKey) && rootConfig.get(featureKey).isJsonObject()) {
            return rootConfig.getAsJsonObject(featureKey);
        }
        return new JsonObject();
    }

    private JsonObject buildAiFeatureAvailability() {
        JsonObject availability = new JsonObject();
        availability.addProperty(AI_FEATURE_PROVIDER_CLAUDE, isAiFeatureProviderAvailable(AI_FEATURE_PROVIDER_CLAUDE));
        availability.addProperty(AI_FEATURE_PROVIDER_CODEX, isAiFeatureProviderAvailable(AI_FEATURE_PROVIDER_CODEX));
        return availability;
    }

    private boolean isAiFeatureProviderAvailable(String provider) {
        try {
            DependencyManager dependencyManager = new DependencyManager();
            if (AI_FEATURE_PROVIDER_CODEX.equals(provider)) {
                return getActiveCodexProvider() != null && dependencyManager.isInstalled("codex-sdk");
            }
            return getActiveClaudeProvider() != null && dependencyManager.isInstalled("claude-sdk");
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to resolve AI feature availability for " + provider + ": " + e.getMessage());
            return false;
        }
    }

    private JsonObject getNormalizedAiFeatureModels(
            JsonObject featureConfig,
            String defaultClaudeModel,
            String defaultCodexModel
    ) {
        if (featureConfig != null
                && featureConfig.has(AI_FEATURE_MODELS_KEY)
                && featureConfig.get(AI_FEATURE_MODELS_KEY).isJsonObject()) {
            JsonObject rawModels = featureConfig.getAsJsonObject(AI_FEATURE_MODELS_KEY);
            String claudeModel = rawModels.has(AI_FEATURE_PROVIDER_CLAUDE) && !rawModels.get(AI_FEATURE_PROVIDER_CLAUDE).isJsonNull()
                    ? rawModels.get(AI_FEATURE_PROVIDER_CLAUDE).getAsString()
                    : null;
            String codexModel = rawModels.has(AI_FEATURE_PROVIDER_CODEX) && !rawModels.get(AI_FEATURE_PROVIDER_CODEX).isJsonNull()
                    ? rawModels.get(AI_FEATURE_PROVIDER_CODEX).getAsString()
                    : null;
            return createAiFeatureModels(claudeModel, codexModel, defaultClaudeModel, defaultCodexModel);
        }
        return createAiFeatureModels(null, null, defaultClaudeModel, defaultCodexModel);
    }

    private JsonObject createAiFeatureModels(
            String claudeModel,
            String codexModel,
            String defaultClaudeModel,
            String defaultCodexModel
    ) {
        JsonObject models = new JsonObject();
        models.addProperty(
                AI_FEATURE_PROVIDER_CLAUDE,
                normalizeAiFeatureModel(claudeModel, defaultClaudeModel)
        );
        models.addProperty(
                AI_FEATURE_PROVIDER_CODEX,
                normalizeAiFeatureModel(codexModel, defaultCodexModel)
        );
        return models;
    }

    private ResolvedAiFeatureProvider resolveAiFeatureProvider(
            String manualProvider,
            boolean claudeAvailable,
            boolean codexAvailable
    ) {
        if (manualProvider != null) {
            boolean manualProviderAvailable = AI_FEATURE_PROVIDER_CODEX.equals(manualProvider)
                    ? codexAvailable
                    : claudeAvailable;
            if (manualProviderAvailable) {
                return new ResolvedAiFeatureProvider(manualProvider, AI_FEATURE_RESOLUTION_MANUAL);
            }
            return new ResolvedAiFeatureProvider(null, AI_FEATURE_RESOLUTION_UNAVAILABLE);
        }
        if (codexAvailable) {
            return new ResolvedAiFeatureProvider(AI_FEATURE_PROVIDER_CODEX, AI_FEATURE_RESOLUTION_AUTO);
        }
        if (claudeAvailable) {
            return new ResolvedAiFeatureProvider(AI_FEATURE_PROVIDER_CLAUDE, AI_FEATURE_RESOLUTION_AUTO);
        }
        return new ResolvedAiFeatureProvider(null, AI_FEATURE_RESOLUTION_UNAVAILABLE);
    }

    private String normalizeAiFeatureProvider(String provider) {
        if (provider == null) {
            return null;
        }
        String normalized = provider.trim().toLowerCase();
        if (normalized.isEmpty()) {
            return null;
        }
        if (AI_FEATURE_PROVIDER_CLAUDE.equals(normalized) || AI_FEATURE_PROVIDER_CODEX.equals(normalized)) {
            return normalized;
        }
        return null;
    }

    private String normalizeAiFeatureModel(String model, String defaultValue) {
        if (model == null) {
            return defaultValue;
        }
        String normalized = model.trim();
        return normalized.isEmpty() ? defaultValue : normalized;
    }

    private static class ResolvedAiFeatureProvider {
        private final String effectiveProvider;
        private final String resolutionSource;

        private ResolvedAiFeatureProvider(String effectiveProvider, String resolutionSource) {
            this.effectiveProvider = effectiveProvider;
            this.resolutionSource = resolutionSource;
        }
    }

    // ==================== Codex Provider Management ====================

    public List<JsonObject> getCodexProviders() throws IOException {
        return codexProviderManager.getCodexProviders();
    }

    public JsonObject getActiveCodexProvider() throws IOException {
        return codexProviderManager.getActiveCodexProvider();
    }

    public void addCodexProvider(JsonObject provider) throws IOException {
        codexProviderManager.addCodexProvider(provider);
    }

    public void saveCodexProvider(JsonObject provider) throws IOException {
        codexProviderManager.saveCodexProvider(provider);
    }

    public void updateCodexProvider(String id, JsonObject updates) throws IOException {
        codexProviderManager.updateCodexProvider(id, updates);
    }

    public DeleteResult deleteCodexProvider(String id) {
        return codexProviderManager.deleteCodexProvider(id);
    }

    public void switchCodexProvider(String id) throws IOException {
        codexProviderManager.switchCodexProvider(id);
    }

    public void applyActiveProviderToCodexSettings() throws IOException {
        codexProviderManager.applyActiveProviderToCodexSettings();
    }

    public JsonObject getCurrentCodexConfig() throws IOException {
        if (!isCodexLocalConfigAuthorized()) {
            return new JsonObject();
        }
        return codexProviderManager.getCurrentCodexConfig();
    }

    public boolean isCodexCliLoginAvailable() {
        try {
            if (!isCodexLocalConfigAuthorized()) {
                return false;
            }
            return codexSettingsManager.isCodexCliLoginAvailable();
        } catch (IOException e) {
            LOG.warn("[CodemossSettings] Failed to check Codex local authorization: " + e.getMessage());
            return false;
        }
    }

    public void applyCodexCliLoginToSettings() throws IOException {
        codexSettingsManager.applyCodexCliLoginToSettings();
    }

    public void removeCodexCliLoginFromSettings() throws IOException {
        codexSettingsManager.removeCodexCliLoginFromSettings();
    }

    public JsonObject readCodexCliLoginAccountInfo() {
        try {
            if (!isCodexLocalConfigAuthorized()) {
                return null;
            }
            return codexSettingsManager.readCodexCliLoginAccountInfo();
        } catch (IOException e) {
            LOG.warn("[CodemossSettings] Failed to read Codex local authorization state: " + e.getMessage());
            return null;
        }
    }

    public boolean isCodexLocalConfigAuthorized() throws IOException {
        JsonObject config = readConfig();
        if (!config.has("codex") || !config.get("codex").isJsonObject()) {
            return false;
        }
        JsonObject codex = config.getAsJsonObject("codex");
        return codex.has("localConfigAuthorized")
                && !codex.get("localConfigAuthorized").isJsonNull()
                && codex.get("localConfigAuthorized").getAsBoolean();
    }

    public void setCodexLocalConfigAuthorized(boolean authorized) throws IOException {
        JsonObject config = readConfig();
        JsonObject codex;
        if (config.has("codex") && config.get("codex").isJsonObject()) {
            codex = config.getAsJsonObject("codex");
        } else {
            codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        codex.addProperty("localConfigAuthorized", authorized);
        writeConfig(config);
    }

    public String getCodexRuntimeAccessMode() throws IOException {
        JsonObject config = readConfig();
        if (!config.has("codex") || !config.get("codex").isJsonObject()) {
            return CODEX_RUNTIME_ACCESS_INACTIVE;
        }

        JsonObject codex = config.getAsJsonObject("codex");
        String currentId = codex.has("current") && !codex.get("current").isJsonNull()
                ? codex.get("current").getAsString().trim()
                : "";

        if (CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId)) {
            return isCodexLocalConfigAuthorized()
                    ? CODEX_RUNTIME_ACCESS_CLI_LOGIN
                    : CODEX_RUNTIME_ACCESS_INACTIVE;
        }

        if (!currentId.isEmpty()
                && codex.has("providers")
                && codex.get("providers").isJsonObject()
                && codex.getAsJsonObject("providers").has(currentId)) {
            return CODEX_RUNTIME_ACCESS_MANAGED;
        }

        return CODEX_RUNTIME_ACCESS_INACTIVE;
    }

    public int saveCodexProviders(List<JsonObject> providers) throws IOException {
        return codexProviderManager.saveProviders(providers);
    }

    public void saveCodexProviderOrder(List<String> orderedIds) throws IOException {
        codexProviderManager.saveProviderOrder(orderedIds);
    }

    // ==================== User Model Pricing Management ====================

    /**
     * Persist user-configured model pricing for a provider family, replacing the whole map.
     *
     * @param provider {@code "claude"} or {@code "codex"}
     * @param pricing  map of model ID → pricing; empty or null clears the provider entry
     */
    public void setCustomModelPricing(String provider, Map<String, ModelPricing> pricing) throws IOException {
        JsonObject config = readConfig();

        JsonObject root;
        if (config.has("customModelPricing") && config.get("customModelPricing").isJsonObject()) {
            root = config.getAsJsonObject("customModelPricing");
        } else {
            root = new JsonObject();
            config.add("customModelPricing", root);
        }

        if (pricing == null || pricing.isEmpty()) {
            root.remove(provider);
        } else {
            JsonObject providerNode = new JsonObject();
            for (Map.Entry<String, ModelPricing> entry : pricing.entrySet()) {
                providerNode.add(entry.getKey(), serializeModelPricing(entry.getValue()));
            }
            root.add(provider, providerNode);
        }

        writeConfig(config);
        LOG.info("[CodemossSettings] Set user model pricing for " + provider
                + ": " + (pricing == null ? 0 : pricing.size()) + " models");
    }

    private JsonObject serializeModelPricing(ModelPricing pricing) {
        JsonObject node = new JsonObject();
        if (isValidPrice(pricing.inputCostPer1M())) {
            node.addProperty("inputCostPer1M", pricing.inputCostPer1M());
        }
        if (isValidPrice(pricing.outputCostPer1M())) {
            node.addProperty("outputCostPer1M", pricing.outputCostPer1M());
        }
        if (isValidPrice(pricing.cacheWriteCostPer1M())) {
            node.addProperty("cacheWriteCostPer1M", pricing.cacheWriteCostPer1M());
        }
        if (isValidPrice(pricing.cacheReadCostPer1M())) {
            node.addProperty("cacheReadCostPer1M", pricing.cacheReadCostPer1M());
        }
        return node;
    }

    private static boolean isValidPrice(Double value) {
        return value != null && Double.isFinite(value) && value >= 0;
    }
}
