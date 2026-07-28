package com.github.claudecodegui.settings;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Codex Provider Manager
 * Manages Codex provider configurations stored in ~/.codemoss/config.json
 * and applies active provider to ~/.codex/ files
 */
public class CodexProviderManager {
    private static final Logger LOG = Logger.getInstance(CodexProviderManager.class);
    private static final String BACKUP_FILE_NAME = "config.json.bak";
    public static final String CODEX_CLI_LOGIN_PROVIDER_ID = "__codex_cli_login__";

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final Consumer<JsonObject> configWriter;
    private final ConfigPathManager pathManager;
    private final CodexSettingsManager codexSettingsManager;

    public CodexProviderManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            Consumer<JsonObject> configWriter,
            ConfigPathManager pathManager,
            CodexSettingsManager codexSettingsManager) {
        this.gson = gson;
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.pathManager = pathManager;
        this.codexSettingsManager = codexSettingsManager;
    }

    /**
     * Get all Codex providers
     */
    public List<JsonObject> getCodexProviders() {
        JsonObject config = configReader.apply(null);
        List<JsonObject> result = new ArrayList<>();

        String currentId = null;
        if (config.has("codex") && config.get("codex").isJsonObject()) {
            JsonObject codex = config.getAsJsonObject("codex");
            if (codex.has("current") && !codex.get("current").isJsonNull()) {
                currentId = codex.get("current").getAsString();
            }
        }
        boolean cliLoginAuthorized = isCodexCliLoginAuthorized(config);

        // Add CLI Login virtual provider at the top
        result.add(createCodexCliLoginProviderObject(
                CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId) && cliLoginAuthorized,
                cliLoginAuthorized));

        if (!config.has("codex")) {
            return result;
        }

        JsonObject codex = config.getAsJsonObject("codex");
        if (!codex.has("providers")) {
            return result;
        }

        JsonObject providers = codex.getAsJsonObject("providers");

        // Get provider order from config, or use default order (by key)
        List<String> orderedIds = ProviderOrderHelper.getProviderOrder(codex, providers.keySet());

        // Add providers in order
        for (String id : orderedIds) {
            if (providers.has(id)) {
                JsonObject provider = providers.getAsJsonObject(id).deepCopy();
                // Ensure id field exists
                if (!provider.has("id")) {
                    provider.addProperty("id", id);
                }
                // Add isActive flag
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

        if (!config.has("codex")) {
            JsonObject codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        JsonObject codex = config.getAsJsonObject("codex");
        ProviderOrderHelper.setProviderOrder(codex, orderedIds);

        configWriter.accept(config);
        LOG.info("[CodexProviderManager] Saved provider order: " + orderedIds);
    }

    /**
     * Get currently active Codex provider
     */
    public JsonObject getActiveCodexProvider() {
        JsonObject config = configReader.apply(null);

        if (!config.has("codex")) {
            return null;
        }

        JsonObject codex = config.getAsJsonObject("codex");
        if (!codex.has("current")) {
            return null;
        }

        String currentId = codex.get("current").getAsString();
        if (currentId == null || currentId.isEmpty()) {
            return null;
        }

        // Handle CLI Login virtual provider
        if (CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId)) {
            if (!isCodexCliLoginAuthorized(config)) {
                return null;
            }
            return createCodexCliLoginProviderObject(true, true);
        }

        if (!codex.has("providers")) {
            return null;
        }

        JsonObject providers = codex.getAsJsonObject("providers");

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
     * Add a new Codex provider
     */
    public void addCodexProvider(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }

        JsonObject config = configReader.apply(null);

        // Ensure codex configuration exists
        if (!config.has("codex")) {
            JsonObject codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        JsonObject codex = config.getAsJsonObject("codex");
        JsonObject providers = codex.getAsJsonObject("providers");

        String id = provider.get("id").getAsString();

        // Check if ID already exists
        if (providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' already exists");
        }

        // Add creation timestamp
        if (!provider.has("createdAt")) {
            provider.addProperty("createdAt", System.currentTimeMillis());
        }

        // Add provider (not auto-activated)
        providers.add(id, provider);

        configWriter.accept(config);
        LOG.info("[CodexProviderManager] Added provider: " + id);
    }

    /**
     * Save provider (update if exists, add if not)
     */
    public void saveCodexProvider(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }

        JsonObject config = configReader.apply(null);

        // Ensure codex configuration exists
        if (!config.has("codex")) {
            JsonObject codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        JsonObject codex = config.getAsJsonObject("codex");
        JsonObject providers = codex.getAsJsonObject("providers");

        String id = provider.get("id").getAsString();

        // Preserve createdAt if updating existing provider
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

        providers.add(id, provider);
        configWriter.accept(config);
    }

    /**
     * Update an existing Codex provider
     */
    public void updateCodexProvider(String id, JsonObject updates) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("codex")) {
            throw new IllegalArgumentException("No codex configuration found");
        }

        JsonObject codex = config.getAsJsonObject("codex");
        JsonObject providers = codex.getAsJsonObject("providers");

        if (!providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' not found");
        }

        JsonObject provider = providers.getAsJsonObject(id);

        // Merge updates
        for (String key : updates.keySet()) {
            // Don't allow modifying id
            if (key.equals("id")) {
                continue;
            }

            // If value is null (JsonNull), remove the field
            if (updates.get(key).isJsonNull()) {
                provider.remove(key);
            } else {
                provider.add(key, updates.get(key));
            }
        }

        configWriter.accept(config);
        LOG.info("[CodexProviderManager] Updated provider: " + id);
    }

    /**
     * Delete a Codex provider
     * @param id Provider ID
     * @return DeleteResult with operation status and error details
     */
    public DeleteResult deleteCodexProvider(String id) {
        Path configFilePath = null;
        Path backupFilePath = null;

        try {
            JsonObject config = configReader.apply(null);
            configFilePath = pathManager.getConfigFilePath();
            backupFilePath = pathManager.getConfigDir().resolve(BACKUP_FILE_NAME);

            if (!config.has("codex")) {
                return DeleteResult.failure(
                    DeleteResult.ErrorType.FILE_NOT_FOUND,
                    "No codex configuration found",
                    configFilePath.toString(),
                    "Please add at least one Codex provider first"
                );
            }

            JsonObject codex = config.getAsJsonObject("codex");
            JsonObject providers = codex.getAsJsonObject("providers");

            if (!providers.has(id)) {
                return DeleteResult.failure(
                    DeleteResult.ErrorType.FILE_NOT_FOUND,
                    "Provider with id '" + id + "' not found",
                    null,
                    "Please check if the provider ID is correct"
                );
            }

            // Create backup before deletion
            try {
                Files.copy(configFilePath, backupFilePath, StandardCopyOption.REPLACE_EXISTING);
                LOG.info("[CodexProviderManager] Created backup: " + backupFilePath);
            } catch (IOException e) {
                LOG.warn("[CodexProviderManager] Warning: Failed to create backup: " + e.getMessage());
            }

            // Delete provider
            providers.remove(id);

            // If deleting the active provider, switch to first available
            String currentId = codex.has("current") ? codex.get("current").getAsString() : null;
            if (id.equals(currentId)) {
                if (providers.size() > 0) {
                    String firstKey = providers.keySet().iterator().next();
                    codex.addProperty("current", firstKey);
                    LOG.info("[CodexProviderManager] Switched to provider: " + firstKey);
                } else {
                    codex.addProperty("current", "");
                    LOG.info("[CodexProviderManager] No remaining providers");
                }
            }

            // Remove deleted provider from providerOrder to avoid stale IDs
            ProviderOrderHelper.removeFromOrder(codex, id);

            // Write config
            configWriter.accept(config);
            LOG.info("[CodexProviderManager] Deleted provider: " + id);

            // Remove backup on success
            try {
                Files.deleteIfExists(backupFilePath);
            } catch (IOException e) {
                // Ignore backup deletion failure
            }

            return DeleteResult.success(id);

        } catch (Exception e) {
            // Try to restore from backup
            if (backupFilePath != null && configFilePath != null) {
                try {
                    if (Files.exists(backupFilePath)) {
                        Files.copy(backupFilePath, configFilePath, StandardCopyOption.REPLACE_EXISTING);
                        LOG.info("[CodexProviderManager] Restored from backup after failure");
                    }
                } catch (IOException restoreEx) {
                    LOG.warn("[CodexProviderManager] Failed to restore backup: " + restoreEx.getMessage());
                }
            }

            return DeleteResult.fromException(e, configFilePath != null ? configFilePath.toString() : null);
        }
    }

    /**
     * Switch to a different Codex provider
     */
    public void switchCodexProvider(String id) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("codex")) {
            JsonObject codexSection = new JsonObject();
            codexSection.add("providers", new JsonObject());
            codexSection.addProperty("current", "");
            config.add("codex", codexSection);
        }

        JsonObject codex = config.getAsJsonObject("codex");

        if (id == null || id.trim().isEmpty()) {
            codex.addProperty("current", "");
            configWriter.accept(config);
            LOG.info("[CodexProviderManager] Cleared active provider");
            return;
        }

        // CLI Login is a virtual provider — no need to check providers map
        if (!CODEX_CLI_LOGIN_PROVIDER_ID.equals(id)) {
            JsonObject providers = codex.getAsJsonObject("providers");
            if (providers == null || !providers.has(id)) {
                throw new IllegalArgumentException("Provider with id '" + id + "' not found");
            }
        }

        codex.addProperty("current", id);
        configWriter.accept(config);
        LOG.info("[CodexProviderManager] Switched to provider: " + id);
    }

    /**
     * Batch save providers
     * @param providers List of providers to save
     * @return Number of successfully saved providers
     */
    public int saveProviders(List<JsonObject> providers) throws IOException {
        int count = 0;
        for (JsonObject provider : providers) {
            try {
                saveCodexProvider(provider);
                count++;
            } catch (Exception e) {
                LOG.warn("Failed to save provider " + provider.get("id") + ": " + e.getMessage());
            }
        }
        return count;
    }

    /**
     * Apply active provider to ~/.codex/ settings files
     */
    public void applyActiveProviderToCodexSettings() throws IOException {
        JsonObject activeProvider = getActiveCodexProvider();
        if (activeProvider == null) {
            LOG.info("[CodexProviderManager] No active provider to sync to ~/.codex/");
            return;
        }
        codexSettingsManager.applyProviderToCodexSettings(activeProvider);
    }

    /**
     * Get current Codex CLI configuration (from ~/.codex/)
     */
    public JsonObject getCurrentCodexConfig() throws IOException {
        return codexSettingsManager.getCurrentCodexConfig();
    }

    /**
     * Create virtual CLI Login provider object.
     * Unlike regular providers, this is not stored in config but generated dynamically.
     */
    private JsonObject createCodexCliLoginProviderObject(boolean isActive, boolean localConfigAuthorized) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", CODEX_CLI_LOGIN_PROVIDER_ID);
        provider.addProperty("name", ClaudeCodeGuiBundle.message("provider.codexCliLogin.name"));
        provider.addProperty("isActive", isActive);
        provider.addProperty("localConfigAuthorized", localConfigAuthorized);
        provider.addProperty("isCodexCliLoginProvider", true);
        return provider;
    }

    /**
     * Check if the current active provider is Codex CLI Login.
     */
    public boolean isCodexCliLoginProviderActive() {
        try {
            JsonObject config = configReader.apply(null);
            if (!config.has("codex")) { return false; }
            JsonObject codex = config.getAsJsonObject("codex");
            if (!codex.has("current")) { return false; }
            return CODEX_CLI_LOGIN_PROVIDER_ID.equals(codex.get("current").getAsString())
                    && isCodexCliLoginAuthorized(config);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isCodexCliLoginAuthorized(JsonObject config) {
        if (config == null || !config.has("codex") || !config.get("codex").isJsonObject()) {
            return false;
        }
        JsonObject codex = config.getAsJsonObject("codex");
        return codex.has("localConfigAuthorized")
                && !codex.get("localConfigAuthorized").isJsonNull()
                && codex.get("localConfigAuthorized").getAsBoolean();
    }
}
