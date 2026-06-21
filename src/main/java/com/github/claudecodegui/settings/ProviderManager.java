package com.github.claudecodegui.settings;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * Provider Manager.
 * Manages Claude provider configurations.
 */
public class ProviderManager {
    private static final Logger LOG = Logger.getInstance(ProviderManager.class);
    private static final String BACKUP_FILE_NAME = "config.json.bak";
    public static final String DISABLED_PROVIDER_ID = "__disabled__";
    public static final String LOCAL_SETTINGS_PROVIDER_ID = "__local_settings_json__";
    public static final String CLI_LOGIN_PROVIDER_ID = "__cli_login__";

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;
    private final ConfigPathManager pathManager;
    private final ClaudeSettingsManager claudeSettingsManager;
    private final ClaudeOAuthAccountManager oauthAccountManager;

    public ProviderManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter,
            ConfigPathManager pathManager,
            ClaudeSettingsManager claudeSettingsManager) {
        this(gson, configReader, configWriter, pathManager, claudeSettingsManager, null);
    }

    public ProviderManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter,
            ConfigPathManager pathManager,
            ClaudeSettingsManager claudeSettingsManager,
            ClaudeOAuthAccountManager oauthAccountManager) {
        this.gson = gson;
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.pathManager = pathManager;
        this.claudeSettingsManager = claudeSettingsManager;
        this.oauthAccountManager = oauthAccountManager;
    }

    /**
     * Get all Claude providers.
     */
    public List<JsonObject> getClaudeProviders() {
        JsonObject config = configReader.apply(null);
        List<JsonObject> result = new ArrayList<>();
        String currentId = normalizeCurrentClaudeProviderId(config);
        JsonObject claude = config.getAsJsonObject("claude");

        // Add local provider using the extracted method
        result.add(createLocalProviderObject(LOCAL_SETTINGS_PROVIDER_ID.equals(currentId)));

        // Add CLI login provider
        result.add(createCliLoginProviderObject(CLI_LOGIN_PROVIDER_ID.equals(currentId)));
        if (oauthAccountManager != null) {
            result.addAll(oauthAccountManager.getAccounts(currentId));
        }

        if (!claude.has("providers")) {
            return result;
        }

        JsonObject providers = claude.getAsJsonObject("providers");

        // Get provider order from config, or use default order (by key)
        List<String> orderedIds = ProviderOrderHelper.getProviderOrder(claude, providers.keySet());

        // Add providers in order
        for (String id : orderedIds) {
            if (providers.has(id)) {
                JsonObject provider = providers.getAsJsonObject(id).deepCopy();
                if (!provider.has("id")) {
                    provider.addProperty("id", id);
                }
                provider.addProperty("isActive", id.equals(currentId));
                result.add(provider);
            }
        }

        return result;
    }

    /**
     * Save provider order.
     */
    public void saveProviderOrder(List<String> orderedIds) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("claude")) {
            JsonObject claude = new JsonObject();
            claude.add("providers", new JsonObject());
            claude.addProperty("current", LOCAL_SETTINGS_PROVIDER_ID);
            config.add("claude", claude);
        }

        JsonObject claude = config.getAsJsonObject("claude");
        ProviderOrderHelper.setProviderOrder(claude, orderedIds);

        configWriter.accept(config);
        LOG.info("[ProviderManager] Saved provider order: " + orderedIds);
    }

    /**
     * Get the currently active provider.
     */
    public JsonObject getActiveClaudeProvider() {
        JsonObject config = configReader.apply(null);
        String currentId = normalizeCurrentClaudeProviderId(config);
        JsonObject claude = config.getAsJsonObject("claude");

        // Return local provider using the extracted method
        if (LOCAL_SETTINGS_PROVIDER_ID.equals(currentId)) {
            return createLocalProviderObject(true);
        }

        // Return CLI login provider
        if (CLI_LOGIN_PROVIDER_ID.equals(currentId)) {
            return createCliLoginProviderObject(true);
        }
        if (oauthAccountManager != null && oauthAccountManager.isAccountId(currentId)) {
            return oauthAccountManager.getAccount(currentId, true);
        }

        if (!claude.has("providers")) {
            return null;
        }

        JsonObject providers = claude.getAsJsonObject("providers");

        if (providers.has(currentId)) {
            JsonObject provider = providers.getAsJsonObject(currentId);
            if (!provider.has("id")) {
                provider.addProperty("id", currentId);
            }
            provider.addProperty("isActive", true);
            return provider;
        }

        return null;
    }

    /**
     * Add a provider.
     */
    public void addClaudeProvider(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }

        JsonObject config = configReader.apply(null);

        // Ensure claude config exists
        if (!config.has("claude")) {
            JsonObject claude = new JsonObject();
            claude.add("providers", new JsonObject());
            claude.addProperty("current", LOCAL_SETTINGS_PROVIDER_ID);
            config.add("claude", claude);
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        String id = provider.get("id").getAsString();

        // Check if the ID already exists
        if (providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' already exists");
        }

        // Add creation timestamp
        if (!provider.has("createdAt")) {
            provider.addProperty("createdAt", System.currentTimeMillis());
        }

        // Add the provider (not auto-activated; user must manually click "Enable" to activate)
        providers.add(id, provider);

        configWriter.accept(config);
        LOG.info("[ProviderManager] Added provider: " + id + " (not activated, user needs to manually switch)");
    }

    /**
     * Save a provider (update if it exists, add if it doesn't).
     */
    public void saveClaudeProvider(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }

        JsonObject config = configReader.apply(null);

        // Ensure claude config exists
        if (!config.has("claude")) {
            JsonObject claude = new JsonObject();
            claude.add("providers", new JsonObject());
            claude.addProperty("current", LOCAL_SETTINGS_PROVIDER_ID);
            config.add("claude", claude);
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        String id = provider.get("id").getAsString();

        // If it already exists, preserve the original createdAt
        if (providers.has(id)) {
            JsonObject existing = providers.getAsJsonObject(id);
            if (existing.has("createdAt") && !provider.has("createdAt")) {
                provider.addProperty("createdAt", existing.get("createdAt").getAsLong());
            }
        } else {
            if (!provider.has("createdAt")) {
                provider.addProperty("createdAt", System.currentTimeMillis());
            }
        }

        // Overwrite and save
        providers.add(id, provider);
        configWriter.accept(config);
    }

    /**
     * Update a provider.
     */
    public void updateClaudeProvider(String id, JsonObject updates) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("claude")) {
            throw new IllegalArgumentException("No claude configuration found");
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        if (!providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' not found");
        }

        JsonObject provider = providers.getAsJsonObject(id);

        // Merge updates
        for (String key : updates.keySet()) {
            // ID modification is not allowed
            if (key.equals("id")) {
                continue;
            }

            // If the value is null (JsonNull), remove the field
            if (updates.get(key).isJsonNull()) {
                provider.remove(key);
            } else {
                provider.add(key, updates.get(key));
            }
        }

        configWriter.accept(config);
        LOG.info("[ProviderManager] Updated provider: " + id);
    }

    /**
     * Delete a provider (returns DeleteResult with detailed error information).
     *
     * @param id the provider ID
     * @return DeleteResult containing the operation result and error details
     */
    public DeleteResult deleteClaudeProvider(String id) {
        Path configFilePath = null;
        Path backupFilePath = null;

        try {
            JsonObject config = configReader.apply(null);
            configFilePath = pathManager.getConfigFilePath();
            backupFilePath = pathManager.getConfigDir().resolve(BACKUP_FILE_NAME);

            if (!config.has("claude")) {
                return DeleteResult.failure(
                        DeleteResult.ErrorType.FILE_NOT_FOUND,
                        "No claude configuration found",
                        configFilePath.toString(),
                        "Please add at least one provider configuration first"
                );
            }

            JsonObject claude = config.getAsJsonObject("claude");
            JsonObject providers = claude.getAsJsonObject("providers");

            if (!providers.has(id)) {
                return DeleteResult.failure(
                        DeleteResult.ErrorType.FILE_NOT_FOUND,
                        "Provider with id '" + id + "' not found",
                        null,
                        "Please verify that the provider ID is correct"
                );
            }

            // Create a config backup (for rollback)
            try {
                Files.copy(configFilePath, backupFilePath, StandardCopyOption.REPLACE_EXISTING);
                LOG.info("[ProviderManager] Created backup: " + backupFilePath);
            } catch (IOException e) {
                LOG.warn("[ProviderManager] Warning: Failed to create backup: " + e.getMessage());
                // Backup failure doesn't block the delete operation, but log a warning
            }

            // Delete the provider
            providers.remove(id);

            // If the deleted provider was the active one, switch to the first available provider
            String currentId = claude.has("current") ? claude.get("current").getAsString() : null;
            if (id.equals(currentId)) {
                if (providers.size() > 0) {
                    String firstKey = providers.keySet().iterator().next();
                    claude.addProperty("current", firstKey);
                    LOG.info("[ProviderManager] Switched to provider: " + firstKey);
                } else {
                    claude.addProperty("current", "");
                    LOG.info("[ProviderManager] No remaining providers, leaving Claude provider inactive");
                }
            }

            // Remove deleted provider from providerOrder to avoid stale IDs
            ProviderOrderHelper.removeFromOrder(claude, id);

            // Write config
            configWriter.accept(config);
            LOG.info("[ProviderManager] Deleted provider: " + id);

            // Remove backup after successful deletion
            try {
                Files.deleteIfExists(backupFilePath);
            } catch (IOException e) {
                // Ignore backup file deletion failure
            }

            return DeleteResult.success(id);

        } catch (Exception e) {
            // Attempt to restore from backup
            if (backupFilePath != null && configFilePath != null) {
                try {
                    if (Files.exists(backupFilePath)) {
                        Files.copy(backupFilePath, configFilePath, StandardCopyOption.REPLACE_EXISTING);
                        LOG.info("[ProviderManager] Restored from backup after failure");
                    }
                } catch (IOException restoreEx) {
                    LOG.warn("[ProviderManager] Failed to restore backup: " + restoreEx.getMessage());
                }
            }

            return DeleteResult.fromException(e, configFilePath != null ? configFilePath.toString() : null);
        }
    }

    /**
     * Switch to a different provider.
     */
    public void switchClaudeProvider(String id) throws IOException {
        if (oauthAccountManager != null) {
            oauthAccountManager.refreshActiveAccountIfNeeded();
        }
        if (oauthAccountManager != null && oauthAccountManager.isAccountId(id)) {
            oauthAccountManager.switchToAccount(id);
            return;
        }
        JsonObject config = configReader.apply(null);

        if (!config.has("claude")) {
            throw new IllegalArgumentException("No claude configuration found");
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        if (!providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' not found");
        }

        claude.addProperty("current", id);
        configWriter.accept(config);
        LOG.info("[ProviderManager] Switched to provider: " + id);
    }

    /**
     * Leave Claude with no active provider.
     */
    public void deactivateClaudeProvider() throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("claude")) {
            JsonObject claude = new JsonObject();
            claude.add("providers", new JsonObject());
            claude.addProperty("current", "");
            config.add("claude", claude);
        } else {
            config.getAsJsonObject("claude").addProperty("current", "");
        }

        configWriter.accept(config);
        LOG.info("[ProviderManager] Claude provider deactivated");
    }

    /**
     * Batch-save provider configurations.
     *
     * @param providers the list of providers
     * @return the number of providers saved successfully
     */
    public int saveProviders(List<JsonObject> providers) throws IOException {
        int count = 0;
        for (JsonObject provider : providers) {
            try {
                saveClaudeProvider(provider);
                count++;
            } catch (Exception e) {
                LOG.warn("Failed to save provider " + provider.get("id") + ": " + e.getMessage());
            }
        }
        return count;
    }

    /**
     * Set alwaysThinkingEnabled in the currently active provider.
     */
    public boolean setAlwaysThinkingEnabledInActiveProvider(boolean enabled) throws IOException {
        JsonObject config = configReader.apply(null);
        if (!config.has("claude") || config.get("claude").isJsonNull()) {
            return false;
        }

        JsonObject claude = config.getAsJsonObject("claude");
        if (!claude.has("current") || claude.get("current").isJsonNull()) {
            return false;
        }

        String currentId = claude.get("current").getAsString();
        if (currentId == null || currentId.trim().isEmpty()) {
            return false;
        }

        if (!claude.has("providers") || claude.get("providers").isJsonNull()) {
            return false;
        }

        JsonObject providers = claude.getAsJsonObject("providers");
        if (!providers.has(currentId) || providers.get(currentId).isJsonNull()) {
            return false;
        }

        JsonObject provider = providers.getAsJsonObject(currentId);
        JsonObject settingsConfig;
        if (provider.has("settingsConfig") && provider.get("settingsConfig").isJsonObject()) {
            settingsConfig = provider.getAsJsonObject("settingsConfig");
        } else {
            settingsConfig = new JsonObject();
            provider.add("settingsConfig", settingsConfig);
        }

        settingsConfig.addProperty("alwaysThinkingEnabled", enabled);
        configWriter.accept(config);
        return true;
    }

    /**
     * Apply the active provider to Claude settings.json.
     */
    public void applyActiveProviderToClaudeSettings() throws IOException {
        JsonObject config = configReader.apply(null);

        if (config.has("claude") &&
                config.getAsJsonObject("claude").has("current")) {
            String currentId = config.getAsJsonObject("claude").get("current").getAsString();
            if (LOCAL_SETTINGS_PROVIDER_ID.equals(currentId) || CLI_LOGIN_PROVIDER_ID.equals(currentId)
                    || (oauthAccountManager != null && oauthAccountManager.isAccountId(currentId))) {
                LOG.info("[ProviderManager] " + currentId + " provider active, skipping sync to settings.json");
                return;
            }
        }

        JsonObject activeProvider = getActiveClaudeProvider();
        if (activeProvider == null) {
            LOG.info("[ProviderManager] No active provider to sync to .claude/settings.json");
            return;
        }
        claudeSettingsManager.applyProviderToClaudeSettings(activeProvider);
    }

    /**
     * Parse provider configurations from cc-switch.db.
     * Uses a Node.js script to read the database (cross-platform compatible, avoids JDBC classloader issues).
     *
     * @param dbPath the database file path
     * @return the list of parsed providers
     */
    public List<JsonObject> parseProvidersFromCcSwitchDb(String dbPath) throws IOException {
        List<JsonObject> result = new ArrayList<>();

        LOG.info("[ProviderManager] Reading cc-switch database via Node.js: " + dbPath);

        // Get the ai-bridge directory path (handles extraction automatically)
        String aiBridgePath = getAiBridgePath();
        String scriptPath = new File(aiBridgePath, "read-cc-switch-db.js").getAbsolutePath();

        LOG.info("[ProviderManager] Script path: " + scriptPath);

        // Check if the script exists
        if (!new File(scriptPath).exists()) {
            throw new IOException("Reader script not found: " + scriptPath);
        }

        try {
            // Prefer the Node.js path configured by the user on the settings page
            String nodePath = null;
            try {
                com.intellij.ide.util.PropertiesComponent props = com.intellij.ide.util.PropertiesComponent.getInstance();
                String savedNodePath = props.getValue("claude.code.node.path");
                if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                    String trimmed = savedNodePath.trim();
                    // WSL paths (Unix-style) cannot be checked with File.exists() on the Windows JVM.
                    // Validate via NodeDetector.isWslPath() first, then fall back to File checks.
                    if (NodeDetector.isWslPath(trimmed)) {
                        nodePath = trimmed;
                        LOG.info("[ProviderManager] Using user-configured WSL Node.js path: " + nodePath);
                    } else {
                        File nodeFile = new File(trimmed);
                        if (nodeFile.exists() && nodeFile.canExecute()) {
                            nodePath = trimmed;
                            LOG.info("[ProviderManager] Using user-configured Node.js path: " + nodePath);
                        } else {
                            LOG.info("[ProviderManager] User-configured Node.js path is invalid, will auto-detect: " + savedNodePath);
                        }
                    }
                }
            } catch (Exception e) {
                LOG.info("[ProviderManager] Failed to read user-configured Node.js path: " + e.getMessage());
            }

            // If the user hasn't configured a path or the config is invalid, auto-detect via shared NodeDetector
            if (nodePath == null) {
                NodeDetector nodeDetector = NodeDetector.getInstance();
                nodePath = nodeDetector.findNodeExecutable();
                LOG.info("[ProviderManager] Auto-detected Node.js path: " + nodePath);
            }

            // Build the Node.js command (WSL-aware: prepend 'wsl' and convert paths when needed)
            List<String> command = NodeDetector.buildNodeScriptCommand(nodePath, scriptPath);
            command.add(NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(dbPath) : dbPath);
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(new File(aiBridgePath));
            pb.redirectErrorStream(true); // Merge stderr into stdout

            LOG.info("[ProviderManager] Executing command: " + nodePath + " " + scriptPath + " " + dbPath);

            // Start the process
            Process process = pb.start();

            // Read output
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line);
                }
            }

            // Wait for process to finish
            int exitCode = process.waitFor();

            String jsonOutput = output.toString();
            LOG.info("[ProviderManager] Node.js output: " + jsonOutput);

            if (exitCode != 0) {
                throw new IOException("Node.js script failed (exit code: " + exitCode + "): " + jsonOutput);
            }

            // Parse JSON output
            JsonObject response = gson.fromJson(jsonOutput, JsonObject.class);

            if (response == null || !response.has("success")) {
                throw new IOException("Invalid Node.js script response: " + jsonOutput);
            }

            if (!response.get("success").getAsBoolean()) {
                String errorMsg = response.has("error") ? response.get("error").getAsString() : "Unknown error";
                throw new IOException("Node.js script execution failed: " + errorMsg);
            }

            // Extract the provider list
            if (response.has("providers")) {
                JsonArray providersArray = response.getAsJsonArray("providers");
                for (JsonElement element : providersArray) {
                    if (element.isJsonObject()) {
                        result.add(element.getAsJsonObject());
                    }
                }
            }

            int count = response.has("count") ? response.get("count").getAsInt() : result.size();
            LOG.info("[ProviderManager] Successfully read " + count + " Claude provider configs from database");

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Node.js script execution was interrupted", e);
        } catch (Exception e) {
            String errorMsg = "Failed to read database via Node.js: " + e.getMessage();
            LOG.warn("[ProviderManager] " + errorMsg);
            LOG.error("Error occurred", e);
            throw new IOException(errorMsg, e);
        }

        return result;
    }

    /**
     * Get the ai-bridge directory path (uses BridgeDirectoryResolver with automatic extraction handling).
     */
    private String getAiBridgePath() throws IOException {
        // Use the shared BridgeDirectoryResolver instance for proper extraction state detection
        com.github.claudecodegui.bridge.BridgeDirectoryResolver resolver =
                com.github.claudecodegui.startup.BridgePreloader.getSharedResolver();

        File aiBridgeDir = resolver.findSdkDir();

        // If null is returned, extraction may be in progress in the background; wait for completion
        if (aiBridgeDir == null) {
            if (resolver.isExtractionInProgress()) {
                LOG.info("[ProviderManager] ai-bridge extraction in progress, waiting for completion...");
                try {
                    // Wait for extraction to complete (up to 60 seconds)
                    Boolean ready = resolver.getExtractionFuture().get(60, java.util.concurrent.TimeUnit.SECONDS);
                    if (ready != null && ready) {
                        aiBridgeDir = resolver.getSdkDir();
                    }
                } catch (java.util.concurrent.TimeoutException e) {
                    throw new IOException("ai-bridge extraction timed out, please try again later", e);
                } catch (Exception e) {
                    throw new IOException("Error while waiting for ai-bridge extraction: " + e.getMessage(), e);
                }
            }
        }

        if (aiBridgeDir == null || !aiBridgeDir.exists()) {
            throw new IOException("Cannot find ai-bridge directory, please check the plugin installation");
        }

        LOG.info("[ProviderManager] ai-bridge directory: " + aiBridgeDir.getAbsolutePath());
        return aiBridgeDir.getAbsolutePath();
    }

    /**
     * Extract environment configuration.
     */
    private JsonObject extractEnvConfig(JsonObject provider) {
        if (provider == null ||
                !provider.has("settingsConfig") ||
                provider.get("settingsConfig").isJsonNull()) {
            return null;
        }
        JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
        if (!settingsConfig.has("env") || settingsConfig.get("env").isJsonNull()) {
            return null;
        }
        return settingsConfig.getAsJsonObject("env");
    }

    /**
     * Create local provider object with internationalized name and description.
     * When active, includes settingsConfig from ~/.claude/settings.json so the
     * webview can sync model mapping (env vars) without an extra round-trip.
     *
     * @param isActive whether this provider is currently active
     * @return JsonObject representing the local provider
     */
    private JsonObject createLocalProviderObject(boolean isActive) {
        JsonObject localProvider = new JsonObject();
        localProvider.addProperty("id", LOCAL_SETTINGS_PROVIDER_ID);
        localProvider.addProperty("name", ClaudeCodeGuiBundle.message("provider.local.name"));
        localProvider.addProperty("isActive", isActive);
        localProvider.addProperty("isLocalProvider", true);

        // Include ONLY model-mapping env vars from ~/.claude/settings.json so the
        // webview can display mapped model names. Credentials (ANTHROPIC_AUTH_TOKEN)
        // are intentionally excluded to comply with Marketplace credential policies.
        if (isActive) {
            try {
                JsonObject claudeSettings = claudeSettingsManager.readClaudeSettings();
                if (claudeSettings != null && claudeSettings.has("env")) {
                    JsonObject fullEnv = claudeSettings.getAsJsonObject("env");
                    JsonObject safeEnv = new JsonObject();
                    // Only copy model-mapping keys — never credentials
                    String[] modelMappingKeys = {
                        "ANTHROPIC_MODEL",
                        "ANTHROPIC_DEFAULT_SONNET_MODEL",
                        "ANTHROPIC_DEFAULT_OPUS_MODEL",
                        "ANTHROPIC_DEFAULT_HAIKU_MODEL"
                    };
                    for (String key : modelMappingKeys) {
                        if (fullEnv.has(key) && !fullEnv.get(key).isJsonNull()) {
                            safeEnv.add(key, fullEnv.get(key));
                        }
                    }
                    if (safeEnv.size() > 0) {
                        JsonObject settingsConfig = new JsonObject();
                        settingsConfig.add("env", safeEnv);
                        localProvider.add("settingsConfig", settingsConfig);
                    }
                }
            } catch (Exception e) {
                LOG.warn("[ProviderManager] Failed to read settings.json for local provider: " + e.getMessage());
            }
        }

        return localProvider;
    }

    /**
     * Create CLI login provider object with internationalized name and description
     *
     * @param isActive whether this provider is currently active
     * @return JsonObject representing the CLI login provider
     */
    private JsonObject createCliLoginProviderObject(boolean isActive) {
        JsonObject cliLoginProvider = new JsonObject();
        cliLoginProvider.addProperty("id", CLI_LOGIN_PROVIDER_ID);
        cliLoginProvider.addProperty("name", ClaudeCodeGuiBundle.message("provider.cliLogin.name"));
        cliLoginProvider.addProperty("isActive", isActive);
        cliLoginProvider.addProperty("isCliLoginProvider", true);
        return cliLoginProvider;
    }

    /**
     * Normalize the current Claude provider.
     * Preserve an explicit empty current value so Claude can remain intentionally inactive.
     *
     * @param config current plugin configuration
     * @return available current provider id
     */
    private String normalizeCurrentClaudeProviderId(JsonObject config) {
        boolean changed = false;
        JsonObject claude;

        if (!config.has("claude") || config.get("claude").isJsonNull()) {
            claude = new JsonObject();
            config.add("claude", claude);
            changed = true;
        } else {
            claude = config.getAsJsonObject("claude");
        }

        if (!claude.has("providers") || claude.get("providers").isJsonNull()) {
            claude.add("providers", new JsonObject());
            changed = true;
        }

        JsonObject providers = claude.getAsJsonObject("providers");
        boolean hasExplicitCurrent = claude.has("current") && !claude.get("current").isJsonNull();
        String currentId = null;
        if (hasExplicitCurrent) {
            currentId = claude.get("current").getAsString();
        }

        boolean invalidCurrent = currentId == null
                || (!LOCAL_SETTINGS_PROVIDER_ID.equals(currentId)
                    && !CLI_LOGIN_PROVIDER_ID.equals(currentId)
                    && !(oauthAccountManager != null && oauthAccountManager.isAccountId(currentId)
                        && oauthAccountManager.getAccount(currentId, false) != null)
                    && !providers.has(currentId));

        // Marketplace-safe default:
        // - Preserve an explicit local settings provider selection.
        // - If current is missing entirely and there are saved providers, select the first one.
        // - If current is explicitly blank, leave Claude inactive until the user explicitly chooses a mode.
        if (invalidCurrent) {
            currentId = !hasExplicitCurrent && providers.size() > 0
                    ? providers.keySet().iterator().next()
                    : "";
            claude.addProperty("current", currentId);
            changed = true;
        }

        if (changed) {
            configWriter.accept(config);
        }
        return currentId;
    }

    public boolean isLocalSettingsProvider(String providerId) {
        return LOCAL_SETTINGS_PROVIDER_ID.equals(providerId);
    }

    public boolean isLocalProviderActive() {
        JsonObject config = configReader.apply(null);
        if (!config.has("claude")) {
            return false;
        }
        JsonObject claude = config.getAsJsonObject("claude");
        if (!claude.has("current")) {
            return false;
        }
        return LOCAL_SETTINGS_PROVIDER_ID.equals(claude.get("current").getAsString());
    }

    public boolean isCliLoginProviderActive() {
        JsonObject config = configReader.apply(null);
        if (!config.has("claude")) {
            return false;
        }
        JsonObject claude = config.getAsJsonObject("claude");
        if (!claude.has("current")) {
            return false;
        }
        String currentId = claude.get("current").getAsString();
        return CLI_LOGIN_PROVIDER_ID.equals(currentId)
                || (oauthAccountManager != null && oauthAccountManager.isAccountId(currentId));
    }
}
