package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;

/**
 * Handles Codex provider CRUD operations and switching.
 */
public class CodexProviderOperations {

    private static final Logger LOG = Logger.getInstance(CodexProviderOperations.class);
    private static final Gson GSON = new Gson();

    private final HandlerContext context;

    public CodexProviderOperations(HandlerContext context) {
        this.context = context;
    }

    /**
     * Get all Codex providers
     */
    public void handleGetCodexProviders() {
        try {
            List<JsonObject> providers = context.getSettingsService().getCodexProviders();
            String providersJson = GSON.toJson(providers);

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.updateCodexProviders", context.escapeJs(providersJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get Codex providers: " + e.getMessage(), e);
        }
    }

    /**
     * Get current Codex CLI configuration (~/.codex/)
     */
    public void handleGetCurrentCodexConfig() {
        try {
            JsonObject config = context.getSettingsService().getCurrentCodexConfig();
            String configJson = GSON.toJson(config);

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.updateCurrentCodexConfig", context.escapeJs(configJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get current Codex config: " + e.getMessage(), e);
        }
    }

    /**
     * Add Codex provider
     */
    public void handleAddCodexProvider(String content) {
        try {
            JsonObject provider = GSON.fromJson(content, JsonObject.class);
            context.getSettingsService().addCodexProvider(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetCodexProviders(); // Refresh list
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to add Codex provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.addCodexFailed", e.getMessage())));
            });
        }
    }

    /**
     * Update Codex provider
     */
    public void handleUpdateCodexProvider(String content) {
        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            context.getSettingsService().updateCodexProvider(id, updates);

            boolean syncedActiveProvider = false;
            JsonObject activeProvider = context.getSettingsService().getActiveCodexProvider();
            if (activeProvider != null &&
                        activeProvider.has("id") &&
                        id.equals(activeProvider.get("id").getAsString())) {
                context.getSettingsService().applyActiveProviderToCodexSettings();
                syncedActiveProvider = true;
            }

            final boolean finalSynced = syncedActiveProvider;
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetCodexProviders(); // Refresh list
                if (finalSynced) {
                    handleGetActiveCodexProvider(); // Refresh active provider config
                }
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to update Codex provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.updateCodexFailed", e.getMessage())));
            });
        }
    }

    /**
     * Delete Codex provider
     */
    public void handleDeleteCodexProvider(String content) {
        LOG.debug("[ProviderHandler] ========== handleDeleteCodexProvider START ==========");
        LOG.debug("[ProviderHandler] Received content: " + content);

        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            LOG.debug("[ProviderHandler] Parsed JSON data: " + data);

            if (!data.has("id")) {
                LOG.error("[ProviderHandler] ERROR: Missing 'id' field in request");
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.deleteCodexMissingId")));
                });
                return;
            }

            String id = data.get("id").getAsString();
            LOG.info("[ProviderHandler] Deleting Codex provider with ID: " + id);

            DeleteResult result = context.getSettingsService().deleteCodexProvider(id);
            LOG.debug("[ProviderHandler] Delete result - success: " + result.isSuccess());

            if (result.isSuccess()) {
                LOG.info("[ProviderHandler] Delete successful, refreshing provider list");
                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetCodexProviders(); // Refresh list
                });
            } else {
                String errorMsg = result.getUserFriendlyMessage();
                LOG.warn("[ProviderHandler] Delete Codex provider failed: " + errorMsg);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showError", context.escapeJs(errorMsg));
                });
            }
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Exception in handleDeleteCodexProvider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.deleteCodexFailed", e.getMessage())));
            });
        }

        LOG.debug("[ProviderHandler] ========== handleDeleteCodexProvider END ==========");
    }

    /**
     * Drop the cached subscription quota so the UI refetches for the newly active account.
     * A cli_login snapshot belongs to the previous OAuth account and must not linger.
     */
    private void invalidateCodexQuotaCache() {
        try {
            ApplicationManager.getApplication()
                    .getService(com.github.claudecodegui.service.CodexSubscriptionQuotaService.class)
                    .invalidateCache();
        } catch (Exception e) {
            LOG.warn("[ProviderHandler] Failed to invalidate Codex quota cache: " + e.getMessage());
        }
    }

    /**
     * Switch Codex provider
     */
    public void handleSwitchCodexProvider(String content) {
        try {
            JsonObject data = GSON.fromJson(content, JsonObject.class);
            String id = data.get("id").getAsString();

            // Handle Codex CLI Login virtual provider
            if (com.github.claudecodegui.settings.CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(id)) {
                handleSwitchToCodexCliLogin();
                return;
            }

            context.getSettingsService().switchCodexProvider(id);
            context.getSettingsService().applyActiveProviderToCodexSettings();
            invalidateCodexQuotaCache();

            ApplicationManager.getApplication().invokeLater(() -> {
                String successMsg = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerSwitchSuccess")
                        + com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.switchSyncCodex");
                context.callJavaScript("window.showSwitchSuccess", context.escapeJs(successMsg));
                handleGetCodexProviders(); // Refresh provider list
                handleGetCurrentCodexConfig(); // Refresh Codex CLI config display
                handleGetActiveCodexProvider(); // Refresh active provider config
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to switch Codex provider: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerSwitchFailed") + ": " + e.getMessage()));
            });
        }
    }

    /**
     * Authorize read access to ~/.codex/{config.toml,auth.json} without changing the active provider.
     */
    public void handleAuthorizeCodexLocalConfig() {
        try {
            context.getSettingsService().setCodexLocalConfigAuthorized(true);

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showSwitchSuccess", context.escapeJs(
                        com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.codexCliLoginSwitchSuccess")));
                handleGetCodexProviders();
                handleGetCurrentCodexConfig();
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to authorize local Codex config: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(
                        com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerSwitchFailed")
                                + ": " + e.getMessage()));
            });
        }
    }

    /**
     * Revoke local Codex config authorization and stop reading ~/.codex/{config.toml,auth.json}.
     */
    public void handleRevokeCodexLocalConfigAuthorization(String content) {
        try {
            JsonObject data = content == null || content.isBlank()
                    ? new JsonObject()
                    : GSON.fromJson(content, JsonObject.class);
            String fallbackProviderId = data != null && data.has("fallbackProviderId")
                    && !data.get("fallbackProviderId").isJsonNull()
                    ? data.get("fallbackProviderId").getAsString()
                    : "";

            JsonObject activeProvider = context.getSettingsService().getActiveCodexProvider();
            boolean wasCliLoginActive = activeProvider != null
                    && activeProvider.has("id")
                    && com.github.claudecodegui.settings.CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID
                    .equals(activeProvider.get("id").getAsString());

            context.getSettingsService().setCodexLocalConfigAuthorized(false);
            invalidateCodexQuotaCache();

            if (wasCliLoginActive) {
                context.getSettingsService().switchCodexProvider(fallbackProviderId);
                if (fallbackProviderId != null && !fallbackProviderId.isBlank()) {
                    context.getSettingsService().applyActiveProviderToCodexSettings();
                }
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showSwitchSuccess", context.escapeJs(
                        com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.codexLocalConfigAuthorizationRevoked")));
                handleGetCodexProviders();
                handleGetCurrentCodexConfig();
                handleGetActiveCodexProvider();
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to revoke Codex local config authorization: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(
                        com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerSwitchFailed") + ": " + e.getMessage()));
            });
        }
    }

    /**
     * Handle switching to authorized local Codex config mode.
     * This grants read access to ~/.codex/config.toml and auth.json without modifying them.
     */
    private void handleSwitchToCodexCliLogin() {
        try {
            if (!context.getSettingsService().isCodexLocalConfigAuthorized()) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.showError", context.escapeJs(
                            com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message(
                                    "error.codexLocalAccessNotAuthorized")));
                });
                return;
            }

            // Update config.json to set CLI login as current
            context.getSettingsService().switchCodexProvider(
                    com.github.claudecodegui.settings.CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID);
            invalidateCodexQuotaCache();

            LOG.info("[ProviderHandler] Authorized local Codex config provider");

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showSwitchSuccess", context.escapeJs(
                        com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.codexCliLoginSwitchSuccess")));
                handleGetCodexProviders();
                handleGetCurrentCodexConfig();
                handleGetActiveCodexProvider();
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to switch to Codex CLI login: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs(
                        com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("toast.providerSwitchFailed") + ": " + e.getMessage()));
            });
        }
    }

    /**
     * Get currently active Codex provider
     */
    public void handleGetActiveCodexProvider() {
        try {
            JsonObject provider = context.getSettingsService().getActiveCodexProvider();
            String providerJson = GSON.toJson(provider);

            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.updateActiveCodexProvider", context.escapeJs(providerJson));
            });
        } catch (Exception e) {
            LOG.error("[ProviderHandler] Failed to get active Codex provider: " + e.getMessage(), e);
        }
    }
}
