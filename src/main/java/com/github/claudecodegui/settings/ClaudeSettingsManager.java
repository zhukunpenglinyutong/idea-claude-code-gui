package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

/**
 * Claude Settings Manager.
 * Manages reading, writing, and syncing of ~/.claude/settings.json.
 */
public class ClaudeSettingsManager {
    private static final Logger LOG = Logger.getInstance(ClaudeSettingsManager.class);

    /**
     * System-protected fields - these should never be overridden by provider configs
     * and are always preserved from the existing configuration.
     */
    private static final Set<String> PROTECTED_SYSTEM_FIELDS = Set.of(
            "mcpServers",           // MCP server configuration
            "disabledMcpServers",   // Disabled MCP servers
            "plugins",              // Skills/Plugins configuration
            "trustedDirectories",   // Trusted directories
            "trustedFiles"          // Trusted files
    );

    /**
     * Provider-managed fields - only these fields will be overridden by provider configs.
     * All other user-customized fields are preserved.
     */
    private static final Set<String> PROVIDER_MANAGED_FIELDS = Set.of(
            "env",                      // Environment variables
            "model",                    // Model selection
            "alwaysThinkingEnabled",    // Thinking mode
            "codemossProviderId",       // Codemoss provider identifier
            "ccSwitchProviderId",       // CC-Switch provider identifier
            "maxContextLengthTokens",   // Maximum context length
            "temperature",              // Temperature parameter
            "topP",                     // Top-P parameter
            "topK"                      // Top-K parameter
    );

    private final Gson gson;
    private final ConfigPathManager pathManager;

    public ClaudeSettingsManager(Gson gson, ConfigPathManager pathManager) {
        this.gson = gson;
        this.pathManager = pathManager;
    }

    /**
     * Create default Claude Settings.
     */
    public JsonObject createDefaultClaudeSettings() {
        JsonObject settings = new JsonObject();
        settings.add("env", new JsonObject());
        return settings;
    }

    /**
     * Read Claude Settings.
     */
    public JsonObject readClaudeSettings() throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        File settingsFile = settingsPath.toFile();

        if (!settingsFile.exists()) {
            return createDefaultClaudeSettings();
        }

        try (FileReader reader = new FileReader(settingsFile, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[ClaudeSettingsManager] Failed to read ~/.claude/settings.json: " + e.getMessage());
            return createDefaultClaudeSettings();
        }
    }

    /**
     * Read managed settings from the platform-specific managed-settings.json.
     * Returns null if the file does not exist or cannot be parsed.
     */
    public JsonObject readManagedSettings() {
        try {
            Path managedPath = pathManager.getManagedSettingsPath();
            File managedFile = managedPath.toFile();

            if (!managedFile.exists()) {
                return null;
            }

            try (FileReader reader = new FileReader(managedFile)) {
                return JsonParser.parseReader(reader).getAsJsonObject();
            }
        } catch (Exception e) {
            LOG.debug("[ClaudeSettingsManager] Failed to read managed-settings.json: " + e.getMessage());
            return null;
        }
    }

    /**
     * Write Claude Settings.
     */
    public void writeClaudeSettings(JsonObject settings) throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        if (!Files.exists(settingsPath.getParent())) {
            Files.createDirectories(settingsPath.getParent());
        }

        // Force-write CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC setting
        // Ensure the env object exists
        if (!settings.has("env") || settings.get("env").isJsonNull()) {
            settings.add("env", new JsonObject());
        }
        JsonObject env = settings.getAsJsonObject("env");
        // Force-set to string value "1"
        env.addProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

        try (FileWriter writer = new FileWriter(settingsPath.toFile(), StandardCharsets.UTF_8)) {
            gson.toJson(settings, writer);
            LOG.info("[ClaudeSettingsManager] Synced settings to: " + settingsPath);
        }
        // Security (J): settings.json may hold ANTHROPIC_AUTH_TOKEN; restrict to 0600.
        hardenFilePermissions(settingsPath);
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). No-op on non-POSIX
     * filesystems (e.g. Windows), where the per-user home directory ACL applies. (Security J)
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            LOG.debug("[ClaudeSettingsManager] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }

    /**
     * Sync MCP server configuration to Claude settings.json.
     * The Claude CLI reads MCP config from ~/.claude/settings.json at runtime.
     */
    public void syncMcpToClaudeSettings() throws IOException {
        try {
            String homeDir = NodeDetector.resolveHomeForFileOps();

            // Read ~/.claude.json
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (!claudeJsonFile.exists()) {
                LOG.info("[ClaudeSettingsManager] ~/.claude.json not found, skipping MCP sync");
                return;
            }

            JsonObject claudeJson;
            try (FileReader reader = new FileReader(claudeJsonFile, StandardCharsets.UTF_8)) {
                claudeJson = JsonParser.parseReader(reader).getAsJsonObject();
            } catch (Exception e) {
                LOG.error("[ClaudeSettingsManager] Failed to parse ~/.claude.json: " + e.getMessage(), e);
                LOG.error("[ClaudeSettingsManager] This may indicate a corrupted JSON file. Please check ~/.claude.json");

                // Try to read the most recent backup
                File backup = new File(claudeJsonFile.getParent(), ".claude.json.backup");
                if (backup.exists()) {
                    LOG.info("[ClaudeSettingsManager] Found backup file, you may need to restore it manually");
                }
                return;
            }

            // Read ~/.claude/settings.json
            JsonObject settings = readClaudeSettings();

            // Sync mcpServers
            if (claudeJson.has("mcpServers")) {
                settings.add("mcpServers", claudeJson.get("mcpServers"));
                LOG.info("[ClaudeSettingsManager] Synced mcpServers to settings.json");
            }

            // Sync disabledMcpServers
            if (claudeJson.has("disabledMcpServers")) {
                settings.add("disabledMcpServers", claudeJson.get("disabledMcpServers"));
                JsonArray disabledServers = claudeJson.getAsJsonArray("disabledMcpServers");
                LOG.info("[ClaudeSettingsManager] Synced " + disabledServers.size()
                                 + " disabled MCP servers to settings.json");
            }

            // Write back to settings.json
            writeClaudeSettings(settings);

            LOG.info("[ClaudeSettingsManager] Successfully synced MCP configuration to ~/.claude/settings.json");
        } catch (Exception e) {
            LOG.error("[ClaudeSettingsManager] Failed to sync MCP to Claude settings: " + e.getMessage(), e);
            throw new IOException("Failed to sync MCP settings", e);
        }
    }

    /**
     * Apply CLI login mode.
     *
     * Historical behavior (REMOVED): this method used to write CCGUI_CLI_LOGIN_AUTHORIZED=1
     * AND DELETE the user's ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from
     * ~/.claude/settings.json so that the Claude SDK would fall through to its native
     * OAuth flow. That destructively wiped user-configured keys with no recovery path.
     *
     * Current behavior: this is a no-op. The single source of truth for CLI login mode
     * is the plugin-owned ~/.codemoss/config.json (claude.current === "__cli_login__").
     * The Node.js bridge reads that file via getClaudeRuntimeState() in api-config.js
     * and clears process.env.ANTHROPIC_API_KEY at runtime — without ever touching
     * the user's ~/.claude/settings.json.
     *
     * Kept as a no-op (rather than deleted) to preserve the call site in
     * ClaudeProviderOperations.handleSwitchProvider for future hooks if needed.
     */
    public void applyCliLoginToClaudeSettings() throws IOException {
        LOG.info("[ClaudeSettingsManager] Switched to CLI login mode (settings.json untouched, API keys preserved)");
    }

    /**
     * Read OAuth account info from ~/.claude.json for UI display.
     * Only extracts safe display fields (email, name), never credentials or tokens.
     * @return JsonObject with filtered account info, or null if not available
     */
    public JsonObject readCliLoginAccountInfo() {
        try {
            String homeDir = NodeDetector.resolveHomeForFileOps();
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (!claudeJsonFile.exists()) {
                return null;
            }

            try (FileReader reader = new FileReader(claudeJsonFile, StandardCharsets.UTF_8)) {
                JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();
                if (claudeJson.has("oauthAccount") && !claudeJson.get("oauthAccount").isJsonNull()) {
                    JsonObject oauthAccount = claudeJson.getAsJsonObject("oauthAccount");
                    // Only extract safe display fields - never pass the full object
                    JsonObject safeInfo = new JsonObject();
                    if (oauthAccount.has("emailAddress")) {
                        safeInfo.addProperty("emailAddress", oauthAccount.get("emailAddress").getAsString());
                    }
                    if (oauthAccount.has("name")) {
                        safeInfo.addProperty("name", oauthAccount.get("name").getAsString());
                    }
                    return safeInfo;
                }
            }
        } catch (Exception e) {
            LOG.debug("[ClaudeSettingsManager] Failed to read CLI login account info: " + e.getMessage());
        }
        return null;
    }

    /**
     * Remove the legacy CCGUI_CLI_LOGIN_AUTHORIZED flag from settings.json if present.
     *
     * This flag is no longer written by the plugin (CLI login mode is tracked in
     * ~/.codemoss/config.json), but earlier versions did write it. This method cleans
     * up that residue when users switch away from CLI login mode, so the flag does
     * not leak into other auth flows.
     */
    public void removeCliLoginFromClaudeSettings() throws IOException {
        JsonObject settings = readClaudeSettings();

        if (settings.has("env") && !settings.get("env").isJsonNull()) {
            JsonObject env = settings.getAsJsonObject("env");
            if (env.has("CCGUI_CLI_LOGIN_AUTHORIZED")) {
                env.remove("CCGUI_CLI_LOGIN_AUTHORIZED");
                writeClaudeSettings(settings);
                LOG.info("[ClaudeSettingsManager] Removed CLI login authorization flag from settings.json");
            }
        }
    }

    /**
     * Detect apiKeyHelper in user settings or managed settings.
     * @return true if apiKeyHelper is configured, false otherwise
     */
    private boolean hasApiKeyHelper(JsonObject claudeSettings) {
        if (claudeSettings.has("apiKeyHelper") && !claudeSettings.get("apiKeyHelper").isJsonNull()) {
            return true;
        }
        JsonObject managedSettings = readManagedSettings();
        return managedSettings != null && managedSettings.has("apiKeyHelper") && !managedSettings.get("apiKeyHelper").isJsonNull();
    }

    /**
     * Get the current configuration used by Claude CLI (~/.claude/settings.json).
     * Used to display the currently applied configuration on the settings page.
     */
    public JsonObject getCurrentClaudeConfig() throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        JsonObject result = new JsonObject();

        // Extract key settings from the env object
        if (claudeSettings.has("env")) {
            JsonObject env = claudeSettings.getAsJsonObject("env");

            // Support both auth methods: prefer ANTHROPIC_AUTH_TOKEN, fall back to ANTHROPIC_API_KEY
            String apiKey = "";
            String authType = "none";

            if (env.has("ANTHROPIC_AUTH_TOKEN") && !env.get("ANTHROPIC_AUTH_TOKEN").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_AUTH_TOKEN").getAsString();
                authType = "auth_token";  // Bearer authentication
            } else if (env.has("ANTHROPIC_API_KEY") && !env.get("ANTHROPIC_API_KEY").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_API_KEY").getAsString();
                authType = "api_key";  // x-api-key authentication
            }

            String baseUrl = env.has("ANTHROPIC_BASE_URL") ? env.get("ANTHROPIC_BASE_URL").getAsString() : "";

            // Check for CLI login authorization
            if (apiKey.isEmpty() && "none".equals(authType) &&
                    env.has("CCGUI_CLI_LOGIN_AUTHORIZED") &&
                    "1".equals(env.get("CCGUI_CLI_LOGIN_AUTHORIZED").getAsString())) {
                authType = "cli_login";
            }

            // If no API key found, check for apiKeyHelper in user settings or managed settings
            if (apiKey.isEmpty() && "none".equals(authType) && hasApiKeyHelper(claudeSettings)) {
                authType = "api_key_helper";
            }

            // Mask credentials – never expose full API keys to the webview.
            // Show only a safe prefix/suffix so the user can identify the key.
            result.addProperty("apiKey", maskCredential(apiKey));
            result.addProperty("authType", authType);  // Add auth type identifier
            result.addProperty("baseUrl", baseUrl);
        } else {
            // No env object — still check for apiKeyHelper
            String authType = hasApiKeyHelper(claudeSettings) ? "api_key_helper" : "none";
            result.addProperty("apiKey", "");
            result.addProperty("authType", authType);
            result.addProperty("baseUrl", "");
        }

        // If codemossProviderId exists, try to retrieve the provider name
        if (claudeSettings.has("codemossProviderId")) {
            String providerId = claudeSettings.get("codemossProviderId").getAsString();
            result.addProperty("providerId", providerId);
        }

        return result;
    }

    /**
     * Mask a credential string for safe display.
     * Shows the first 4 and last 4 characters with asterisks in between.
     * Returns empty string for null/empty input.
     */
    private static String maskCredential(String credential) {
        if (credential == null || credential.isEmpty()) {
            return "";
        }
        if (credential.length() <= 8) {
            return "****";
        }
        return credential.substring(0, 4) + "****" + credential.substring(credential.length() - 4);
    }

    /**
     * Get the alwaysThinkingEnabled setting.
     */
    public Boolean getAlwaysThinkingEnabled() throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        if (!claudeSettings.has("alwaysThinkingEnabled") || claudeSettings.get("alwaysThinkingEnabled").isJsonNull()) {
            return null;
        }
        try {
            return claudeSettings.get("alwaysThinkingEnabled").getAsBoolean();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Set the alwaysThinkingEnabled setting.
     */
    public void setAlwaysThinkingEnabled(boolean enabled) throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        claudeSettings.addProperty("alwaysThinkingEnabled", enabled);
        writeClaudeSettings(claudeSettings);
    }

    /**
     * Apply provider configuration to Claude settings.json.
     * Uses an incremental merge strategy:
     * - User-customized fields are preserved
     * - Provider-managed fields (env, model, etc.) are fully overwritten
     * - System-protected fields (mcpServers, plugins, etc.) are not affected
     */
    public void applyProviderToClaudeSettings(JsonObject provider) throws IOException {
        if (provider == null) {
            throw new IllegalArgumentException("Provider cannot be null");
        }

        if (!provider.has("settingsConfig") || provider.get("settingsConfig").isJsonNull()) {
            throw new IllegalArgumentException("Provider is missing settingsConfig");
        }

        JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
        JsonObject oldClaudeSettings = readClaudeSettings();

        // ========== Incremental merge strategy ==========
        // Start from existing config to preserve all user customizations
        JsonObject claudeSettings = oldClaudeSettings.deepCopy();

        LOG.info("[ClaudeSettingsManager] Applying provider config with incremental merge strategy");
        LOG.info("[ClaudeSettingsManager] Original settings keys: " + oldClaudeSettings.keySet());

        // 1. Only overwrite fields managed by the provider
        for (String key : settingsConfig.keySet()) {
            JsonElement value = settingsConfig.get(key);

            // Skip null values
            if (value == null || value.isJsonNull()) {
                continue;
            }

            // Skip system-protected fields (managed by the system, providers should not override)
            if (PROTECTED_SYSTEM_FIELDS.contains(key)) {
                LOG.debug("[ClaudeSettingsManager] Skipping protected system field: " + key);
                continue;
            }

            // Only process provider-managed fields
            if (PROVIDER_MANAGED_FIELDS.contains(key)) {
                // All provider fields (including env) are fully overwritten
                claudeSettings.add(key, value);
                LOG.debug("[ClaudeSettingsManager] Set provider field: " + key);
            }
            // Note: fields not in PROVIDER_MANAGED_FIELDS are ignored and won't override user config
        }

        // 2. Add provider ID identifier
        if (provider.has("id") && !provider.get("id").isJsonNull()) {
            claudeSettings.addProperty("codemossProviderId", provider.get("id").getAsString());
        }

        LOG.info("[ClaudeSettingsManager] Final settings keys: " + claudeSettings.keySet());
        writeClaudeSettings(claudeSettings);
    }

    /**
     * Sync Skills to Claude settings.json.
     */
    public void syncSkillsToClaudeSettings(JsonArray plugins) throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        claudeSettings.add("plugins", plugins);
        writeClaudeSettings(claudeSettings);
    }
}
