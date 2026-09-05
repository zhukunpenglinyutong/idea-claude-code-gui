package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

/**
 * Provider management message handler.
 * Handles provider CRUD operations and switching.
 * Supports both Claude and Codex providers.
 */
public class ProviderHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
            // Claude provider operations
            "get_providers",
            "get_current_claude_config",
            "get_thinking_enabled",
            "set_thinking_enabled",
            "add_provider",
            "update_provider",
            "delete_provider",
            "switch_provider",
            "get_active_provider",
            "preview_cc_switch_import",
            "open_file_chooser_for_cc_switch",
            "save_imported_providers",
            "sort_providers",
            // Codex provider operations
            "get_codex_providers",
            "get_current_codex_config",
            "add_codex_provider",
            "update_codex_provider",
            "delete_codex_provider",
            "switch_codex_provider",
            "revoke_codex_local_config_authorization",
            "get_active_codex_provider",
            "sort_codex_providers",
            "preview_codex_cc_switch_import",
            "open_file_chooser_for_codex_cc_switch",
            "save_imported_codex_providers",
            // CodeBuddy local configuration consent
            "get_codebuddy_local_config_status",
            "authorize_codebuddy_local_config",
            "revoke_codebuddy_local_config",
            "get_codebuddy_models_config",
            "save_codebuddy_models_config"
    };

    private final ClaudeProviderOperations claudeOps;
    private final CodexProviderOperations codexOps;
    private final ProviderImportExportSupport importExportSupport;
    private final ProviderOrderingService orderingService;
    private final CodeBuddyProviderOperations codeBuddyOps;

    public ProviderHandler(HandlerContext context) {
        super(context);
        this.claudeOps = new ClaudeProviderOperations(context);
        this.codexOps = new CodexProviderOperations(context);
        this.importExportSupport = new ProviderImportExportSupport(context, claudeOps, codexOps);
        this.orderingService = new ProviderOrderingService(context, claudeOps, codexOps);
        this.codeBuddyOps = new CodeBuddyProviderOperations(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            // Claude provider operations
            case "get_providers":
                claudeOps.handleGetProviders();
                return true;
            case "get_current_claude_config":
                claudeOps.handleGetCurrentClaudeConfig();
                return true;
            case "get_thinking_enabled":
                claudeOps.handleGetThinkingEnabled();
                return true;
            case "set_thinking_enabled":
                claudeOps.handleSetThinkingEnabled(content);
                return true;
            case "add_provider":
                claudeOps.handleAddProvider(content);
                return true;
            case "update_provider":
                claudeOps.handleUpdateProvider(content);
                return true;
            case "delete_provider":
                claudeOps.handleDeleteProvider(content);
                return true;
            case "switch_provider":
                claudeOps.handleSwitchProvider(content);
                return true;
            case "get_active_provider":
                claudeOps.handleGetActiveProvider();
                return true;
            case "preview_cc_switch_import":
                importExportSupport.handlePreviewCcSwitchImport();
                return true;
            case "open_file_chooser_for_cc_switch":
                importExportSupport.handleOpenFileChooserForCcSwitch();
                return true;
            case "save_imported_providers":
                importExportSupport.handleSaveImportedProviders(content);
                return true;
            case "sort_providers":
                orderingService.handleSortProviders(content);
                return true;
            // Codex provider operations
            case "get_codex_providers":
                codexOps.handleGetCodexProviders();
                return true;
            case "get_current_codex_config":
                codexOps.handleGetCurrentCodexConfig();
                return true;
            case "add_codex_provider":
                codexOps.handleAddCodexProvider(content);
                return true;
            case "update_codex_provider":
                codexOps.handleUpdateCodexProvider(content);
                return true;
            case "delete_codex_provider":
                codexOps.handleDeleteCodexProvider(content);
                return true;
            case "switch_codex_provider":
                codexOps.handleSwitchCodexProvider(content);
                return true;
            case "revoke_codex_local_config_authorization":
                codexOps.handleRevokeCodexLocalConfigAuthorization(content);
                return true;
            case "get_active_codex_provider":
                codexOps.handleGetActiveCodexProvider();
                return true;
            case "sort_codex_providers":
                orderingService.handleSortCodexProviders(content);
                return true;
            // Codex cc-switch import operations
            case "preview_codex_cc_switch_import":
                importExportSupport.handlePreviewCodexCcSwitchImport();
                return true;
            case "open_file_chooser_for_codex_cc_switch":
                importExportSupport.handleOpenFileChooserForCodexCcSwitch();
                return true;
            case "save_imported_codex_providers":
                importExportSupport.handleSaveImportedCodexProviders(content);
                return true;
            case "get_codebuddy_local_config_status":
                codeBuddyOps.handleGetLocalConfigStatus();
                return true;
            case "authorize_codebuddy_local_config":
                codeBuddyOps.handleAuthorizeLocalConfig();
                return true;
            case "revoke_codebuddy_local_config":
                codeBuddyOps.handleRevokeLocalConfig();
                return true;
            case "get_codebuddy_models_config":
                codeBuddyOps.handleGetModelsConfig();
                return true;
            case "save_codebuddy_models_config":
                codeBuddyOps.handleSaveModelsConfig(content);
                return true;
            default:
                return false;
        }
    }
}
