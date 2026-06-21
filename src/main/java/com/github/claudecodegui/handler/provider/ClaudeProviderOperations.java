package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.ProviderManager;

import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.Executor;

/**
 * Handles Claude provider CRUD operations and switching.
 */
public class ClaudeProviderOperations {
    private static final Logger LOG = Logger.getInstance(ClaudeProviderOperations.class);
    private static final Gson GSON = new Gson();

    private final HandlerContext context;

    // Serialize all Claude provider operations on a single background thread.
    // Callers invoke these handlers from invokeLater (EDT), and getClaudeProviders()
    // now touches PasswordSafe / keychain / disk per saved account — running that on
    // the EDT would freeze the UI ("Slow operations are prohibited on EDT").
    // A single-thread executor also serializes read-modify-write on
    // ~/.codemoss/config.json, preventing lost updates from interleaved operations.
    private final Executor providerOpsExecutor =
            AppExecutorUtil.createBoundedApplicationPoolExecutor(
                    "ClaudeCodeGUI Claude provider operations", 1);

    public ClaudeProviderOperations(HandlerContext context) {
        this.context = context;
    }

    public void handleGetThinkingEnabled() {
        try {
            Boolean enabled = context.getSettingsService().getAlwaysThinkingEnabledFromClaudeSettings();
            boolean value = enabled != null ? enabled : true;

            JsonObject payload = new JsonObject();
            payload.addProperty("enabled", value);
            payload.addProperty("explicit", enabled != null);

            String json = GSON.toJson(payload);

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.updateThinkingEnabled", context.escapeJs(json));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get thinking enabled: " + e.getMessage(), e);
        }
    }

    public void handleSetThinkingEnabled(String content) {
        try {
            Boolean enabled = null;
            if (content != null && !content.trim().isEmpty()) {
                try {
                    JsonObject data = GSON.fromJson(content, JsonObject.class);
                    if (data != null && data.has("enabled") && !data.get("enabled").isJsonNull()) {
                        enabled = data.get("enabled").getAsBoolean();
                    }
                } catch (Exception e) {
                    LOG.debug("[ProviderHandler] Content is not JSON, treating as raw string", e);
                }
            }

            if (enabled == null) {
                enabled = Boolean.parseBoolean(content != null ? content.trim() : "false");
            }

            context.getSettingsService().setAlwaysThinkingEnabledInClaudeSettings(enabled);
            try {
                context.getSettingsService().setAlwaysThinkingEnabledInActiveProvider(enabled);
            } catch (Exception e) {
                LOG.debug("[ProviderHandler] Failed to set thinking in active provider", e);
            }

            JsonObject payload = new JsonObject();
            payload.addProperty("enabled", enabled);
            payload.addProperty("explicit", true);
            String json = GSON.toJson(payload);

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.updateThinkingEnabled", context.escapeJs(json));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to set thinking enabled: " + e.getMessage(), e);
        }
    }

    /**
     * Get all providers.
     */
    public void handleGetProviders() {
        providerOpsExecutor.execute(() -> {
            try {
                java.util.List<JsonObject> providers = context.getSettingsService().getClaudeProviders();
                String providersJson = GSON.toJson(providers);

                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.updateProviders", context.escapeJs(providersJson));
                });
            } catch (Exception e) {
                LOG.error("[ProviderHandler] Failed to get providers: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Get current Claude CLI configuration (~/.claude/settings.json).
     */
    public void handleGetCurrentClaudeConfig() {
        try {
            JsonObject config = context.getSettingsService().getCurrentClaudeConfig();
            String configJson = GSON.toJson(config);

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.updateCurrentClaudeConfig", context.escapeJs(configJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get current claude config: " + e.getMessage(), e);
        }
    }

    /**
     * Add a provider.
     */
    public void handleAddProvider(String content) {
        try {
            JsonObject provider = GSON.fromJson(content, JsonObject.class);
            context.getSettingsService().addClaudeProvider(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetProviders(); // Refresh list
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to add provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.addFailed", e.getMessage())));
            });
        }
    }

    /**
     * Update a provider.
     */
    public void handleUpdateProvider(String content) {
        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            if (ProviderManager.LOCAL_SETTINGS_PROVIDER_ID.equals(id) || ProviderManager.CLI_LOGIN_PROVIDER_ID.equals(id)) {
                throw new IllegalArgumentException("Special provider '" + id + "' cannot be updated via update_provider");
            }

            context.getSettingsService().updateClaudeProvider(id, updates);

            boolean syncedActiveProvider = false;
            JsonObject activeProvider = context.getSettingsService().getActiveClaudeProvider();
            if (activeProvider != null &&
                        activeProvider.has("id") &&
                        id.equals(activeProvider.get("id").getAsString())) {
                context.getSettingsService().applyProviderToClaudeSettings(activeProvider);
                syncedActiveProvider = true;
            }

            final boolean finalSynced = syncedActiveProvider;
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetProviders(); // Refresh list
                if (finalSynced) {
                    handleGetActiveProvider(); // Refresh active provider config
                }
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to update provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.updateFailed", e.getMessage())));
            });
        }
    }

    /**
     * Delete a provider.
     */
    public void handleDeleteProvider(String content) {
        LOG.debug("[ProviderHandler] ========== handleDeleteProvider START ==========");
        LOG.debug("[ProviderHandler] Received content: " + content);

        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            LOG.debug("[ProviderHandler] Parsed JSON data: " + data);

            if (!data.has("id")) {
                LOG.error("[ProviderHandler] ERROR: Missing 'id' field in request");
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.deleteMissingId")));
                });
                return;
            }

            String id = data.get("id").getAsString();
            LOG.info("[ProviderHandler] Deleting provider with ID: " + id);

            DeleteResult result = context.getSettingsService().deleteClaudeProvider(id);
            LOG.debug("[ProviderHandler] Delete result - success: " + result.isSuccess());

            if (result.isSuccess()) {
                LOG.info("[ProviderHandler] Delete successful, refreshing provider list");
                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetProviders(); // Refresh list
                });
            } else {
                String errorMsg = result.getUserFriendlyMessage();
                LOG.warn("[ProviderHandler] Delete provider failed: " + errorMsg);
                LOG.warn("[ProviderHandler] Error type: " + result.getErrorType());
                LOG.warn("[ProviderHandler] Error details: " + result.getErrorMessage());
                ApplicationManager.getApplication().invokeLater(() -> {
                    LOG.debug("[ProviderHandler] Calling window.showError with: " + errorMsg);
                    context.callJavaScript("window.showError", context.escapeJs(errorMsg));
                });
            }
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Exception in handleDeleteProvider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.deleteFailed", e.getMessage())));
            });
        }

        LOG.debug("[ProviderHandler] ========== handleDeleteProvider END ==========");
    }

    /**
     * Save the account currently authenticated in Claude CLI into PasswordSafe.
     */
    public void handleSaveCurrentClaudeAccount() {
        providerOpsExecutor.execute(() -> {
            try {
                JsonObject account = context.getSettingsService().saveCurrentClaudeOAuthAccount();
                String email = account != null && account.has("emailAddress")
                        ? account.get("emailAddress").getAsString()
                        : "";
                try {
                    context.getClaudeSDKBridge().shutdownDaemon();
                } catch (Exception e) {
                    LOG.warn("[ProviderHandler] Failed to shut down daemon after saving OAuth account", e);
                }
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showSwitchSuccess",
                            context.escapeJs("Claude account saved" + (email.isBlank() ? "" : ": " + email)));
                    handleGetProviders();
                });
            } catch (Exception e) {
                LOG.error("[ProviderHandler] Failed to save current Claude OAuth account", e);
                ApplicationManager.getApplication().invokeLater(() ->
                        context.callJavaScript("window.showError", context.escapeJs(e.getMessage())));
            }
        });
    }

    /**
     * Remove a saved OAuth account from plugin metadata and PasswordSafe.
     */
    public void handleDeleteClaudeAccount(String content) {
        providerOpsExecutor.execute(() -> handleDeleteClaudeAccountInBackground(content));
    }

    private void handleDeleteClaudeAccountInBackground(String content) {
        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();
            context.getSettingsService().deleteClaudeOAuthAccount(id);
            try {
                context.getClaudeSDKBridge().shutdownDaemon();
            } catch (Exception e) {
                LOG.warn("[ProviderHandler] Failed to shut down daemon after deleting OAuth account", e);
            }
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showSwitchSuccess",
                        context.escapeJs("Claude account removed"));
                handleGetProviders();
                handleGetActiveProvider();
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to delete Claude OAuth account", e);
            ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs(e.getMessage())));
        }
    }

    /**
     * Switch provider.
     */
    public void handleSwitchProvider(String content) {
        providerOpsExecutor.execute(() -> handleSwitchProviderInBackground(content));
    }

    private void handleSwitchProviderInBackground(String content) {
        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();

            // Shut down the Claude daemon before applying any provider switch.
            //
            // The daemon caches process.env (set once at boot by setupApiKey() reading
            // ~/.codemoss/config.json) and the Agent SDK spawns its CLI subprocess at
            // runtime-creation time, freezing whatever ANTHROPIC_API_KEY / OAuth state
            // was active then. Live runtimes are reused across turns by signature, and
            // that signature does NOT include auth state — so without a restart, the
            // next message after a provider switch would silently keep using the old
            // credential until the daemon idle-timed out (10 min – 6 hr).
            //
            // Killing the daemon here forces a fresh spawn on the next request, where
            // setupApiKey() re-reads config.json and applies the new auth mode.
            try {
                context.getClaudeSDKBridge().shutdownDaemon();
            } catch (Exception e) {
                LOG.warn("[ProviderHandler] Failed to shut down Claude daemon during switch", e);
            }
            context.getSettingsService().refreshActiveClaudeOAuthAccount();

            if (ProviderManager.DISABLED_PROVIDER_ID.equals(id)) {
                context.getSettingsService().deactivateClaudeProvider();

                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showSwitchSuccess",
                            context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerDisabled")));
                    handleGetProviders();
                    handleGetActiveProvider();
                });
                return;
            }

            // Clean up CLI login flag when switching to any non-CLI-login provider
            if (!ProviderManager.CLI_LOGIN_PROVIDER_ID.equals(id)) {
                try {
                    context.getSettingsService().removeCliLoginFromClaudeSettings();
                } catch (Exception e) {
                    LOG.debug("[ProviderHandler] Failed to clean up CLI login flag", e);
                }
            }

            if (ProviderManager.LOCAL_SETTINGS_PROVIDER_ID.equals(id)) {
                // Validate settings.json exists
                Path settingsPath = Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", "settings.json");
                if (!Files.exists(settingsPath)) {
                    LOG.warn("[ProviderHandler] Local settings.json does not exist at: " + settingsPath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        context.callJavaScript("window.showError",
                                context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.localProviderSettingsNotFound")));
                    });
                    return;
                }

                // Validate JSON format
                try {
                    String settingsContent = Files.readString(settingsPath);
                    GSON.fromJson(settingsContent, JsonObject.class);
                } catch (JsonSyntaxException e) {
                    LOG.error("[ProviderHandler] Invalid JSON in settings.json: " + e.getMessage(), e);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        context.callJavaScript("window.showError",
                                context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.localProviderInvalidJson", e.getMessage())));
                    });
                    return;
                }

                JsonObject config = context.getSettingsService().readConfig();
                if (!config.has("claude")) {
                    JsonObject claude = new JsonObject();
                    claude.add("providers", new JsonObject());
                    claude.addProperty("current", "");
                    config.add("claude", claude);
                }
                config.getAsJsonObject("claude").addProperty("current", id);
                context.getSettingsService().writeConfig(config);

                LOG.info("[ProviderHandler] Switched to LOCAL settings.json provider");

                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showSwitchSuccess",
                            context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.localProviderSwitchSuccess")));
                    handleGetProviders();
                    handleGetActiveProvider();
                });
                return;
            }

            if (ProviderManager.CLI_LOGIN_PROVIDER_ID.equals(id)) {
                // Apply CLI login mode to settings.json
                context.getSettingsService().applyCliLoginToClaudeSettings();

                // Update config.json to set CLI login as current provider
                JsonObject config = context.getSettingsService().readConfig();
                if (!config.has("claude")) {
                    JsonObject claude = new JsonObject();
                    claude.add("providers", new JsonObject());
                    claude.addProperty("current", "");
                    config.add("claude", claude);
                }
                config.getAsJsonObject("claude").addProperty("current", id);
                context.getSettingsService().writeConfig(config);

                LOG.info("[ProviderHandler] Switched to CLI login provider");

                // Read account info for display
                com.google.gson.JsonObject accountInfo = context.getSettingsService().readCliLoginAccountInfo();
                final String accountEmail = accountInfo != null && accountInfo.has("emailAddress")
                        ? accountInfo.get("emailAddress").getAsString() : null;

                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showSwitchSuccess",
                            context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.cliLoginSwitchSuccess")));
                    handleGetProviders();
                    handleGetActiveProvider();
                    if (accountEmail != null) {
                        context.callJavaScript("window.updateCliLoginAccountInfo",
                                context.escapeJs(accountEmail));
                    }
                });
                return;
            }

            context.getSettingsService().switchClaudeProvider(id);
            context.getSettingsService().applyActiveProviderToClaudeSettings();

            ApplicationManager.getApplication().invokeLater(() -> {
                String successMsg = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerSwitchSuccess")
                        + com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.switchSyncClaude");
                context.callJavaScript("window.showSwitchSuccess", context.escapeJs(successMsg));
                handleGetProviders();
                handleGetActiveProvider();
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to switch provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerSwitchFailed") + ": " + e.getMessage()));
            });
        }
    }

    /**
     * Get the currently active provider.
     */
    public void handleGetActiveProvider() {
        providerOpsExecutor.execute(() -> {
            try {
                JsonObject provider = context.getSettingsService().getActiveClaudeProvider();
                String providerJson = GSON.toJson(provider);

                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.updateActiveProvider", context.escapeJs(providerJson));
                });
            } catch (Exception e) {
                LOG.error("[ProviderHandler] Failed to get active provider: " + e.getMessage(), e);
            }
        });
    }
}
