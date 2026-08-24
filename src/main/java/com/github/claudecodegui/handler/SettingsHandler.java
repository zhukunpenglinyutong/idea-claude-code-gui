package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.provider.ModelProviderHandler;

import com.github.claudecodegui.util.LanguageConfigService;
import com.github.claudecodegui.util.ThemeConfigService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Settings and usage statistics message handler.
 * Delegates to focused sub-handlers for each concern.
 */
public class SettingsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(SettingsHandler.class);
    private final Gson gson = new Gson();

    private final InputHistoryHandler inputHistoryHandler;
    private final SoundSettingsHandler soundSettingsHandler;
    private final UsagePushService usagePushService;
    private final PermissionModeHandler permissionModeHandler;
    private final ModelProviderHandler modelProviderHandler;
    private final NodePathHandler nodePathHandler;
    private final ClaudeCliPathHandler claudeCliPathHandler;
    private final ProjectConfigHandler projectConfigHandler;
    // Handle for the theme-change callback registered with ThemeConfigService.
    // Kept so it can be cleanly unregistered when the owning window is disposed,
    // preventing notifications to disposed webviews (issue #1586).
    private ThemeConfigService.RegisteredCallback themeCallbackHandle;
    private final CodexSubscriptionQuotaHandler codexSubscriptionQuotaHandler;
    private final TokenTrackerHandler tokenTrackerHandler;
    private final DshPresetHandler dshPresetHandler;

    private static final String[] SUPPORTED_TYPES = {
        "get_mode",
        "set_mode",
        "set_model",
        "set_provider",
        "set_reasoning_effort",
        "set_codex_fast_mode",
        "set_dsh_preset",
        "get_gemini_models",
        "get_node_path",
        "set_node_path",
        "get_claude_cli_path",
        "set_claude_cli_path",
        // TokenTracker local usage dashboard (vendored tokentracker-cli server)
        "tt_detect_cli",
        "tt_install_cli",
        "tt_ensure_server",
        "tt_proxy",
        "get_codex_subscription_quota",
        "get_working_directory",
        "set_working_directory",
        "get_editor_font_config",
        "get_ui_font_config",
        "set_ui_font_config",
        "browse_ui_font_file",
        "get_code_font_config",
        "set_code_font_config",
        "browse_code_font_file",
        "get_streaming_enabled",
        "set_streaming_enabled",
        "get_codex_sandbox_mode",
        "set_codex_sandbox_mode",
        "get_send_shortcut",
        "set_send_shortcut",
        "get_auto_open_file_enabled",
        "set_auto_open_file_enabled",
        "get_permission_dialog_timeout",
        "set_permission_dialog_timeout",
        "get_commit_generation_enabled",
        "set_commit_generation_enabled",
        "get_status_bar_widget_enabled",
        "set_status_bar_widget_enabled",

        "get_task_completion_notification_enabled",
        "set_task_completion_notification_enabled",
        "get_ask_user_question_notification_enabled",
        "set_ask_user_question_notification_enabled",
        "get_system_notification_only_when_unfocused",
        "set_system_notification_only_when_unfocused",
        "get_ask_user_question_sound_notification_enabled",
        "set_ask_user_question_sound_notification_enabled",
        "get_ide_theme",
        "get_commit_prompt",
        "set_commit_prompt",
        "get_commit_ai_config",
        "set_commit_ai_config",
        "get_prompt_enhancer_config",
        "set_prompt_enhancer_config",
        "get_project_commit_prompt",
        "set_project_commit_prompt",
        "get_input_history",
        "record_input_history",
        "delete_input_history_item",
        "clear_input_history",
        // Sound notification configuration
        "get_sound_notification_config",
        "set_sound_notification_enabled",
        "set_sound_only_when_unfocused",
        "set_selected_sound",
        "set_custom_sound_path",
        "test_sound",
        "browse_sound_file",
        // User language preference
        "set_user_language",
        "get_user_language",
        "clear_user_language"
    };

    public SettingsHandler(HandlerContext context) {
        super(context);
        this.inputHistoryHandler = new InputHistoryHandler(context);
        this.soundSettingsHandler = new SoundSettingsHandler(context);
        this.usagePushService = new UsagePushService(context);
        this.permissionModeHandler = new PermissionModeHandler(context);
        this.modelProviderHandler = new ModelProviderHandler(context, usagePushService);
        this.nodePathHandler = new NodePathHandler(context);
        this.claudeCliPathHandler = new ClaudeCliPathHandler(context);
        this.projectConfigHandler = new ProjectConfigHandler(context);
        this.codexSubscriptionQuotaHandler = new CodexSubscriptionQuotaHandler(context);
        this.tokenTrackerHandler = new TokenTrackerHandler(context);
        this.dshPresetHandler = new DshPresetHandler(context);
        // Register theme change listener to automatically notify frontend when IDE theme changes
        registerThemeChangeListener();
    }

    /**
     * Register theme change listener.
     * Uses the multi-callback API so that every open ClaudeChatWindow receives
     * theme change notifications. The returned handle is stored for clean
     * unregistration in {@link #dispose()}.
     */
    private void registerThemeChangeListener() {
        themeCallbackHandle = ThemeConfigService.registerThemeChangeListener(themeConfig -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onIdeThemeChanged", escapeJs(themeConfig.toString()));
            });
        }, true);
    }

    /**
     * Unregister the theme change callback to prevent notifications to a disposed webview.
     * Should be called when the owning ClaudeChatWindow is disposed.
     */
    public void dispose() {
        if (themeCallbackHandle != null) {
            ThemeConfigService.unregisterThemeChangeListener(themeCallbackHandle);
            themeCallbackHandle = null;
        }
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            // Permission mode
            case "get_mode":
                permissionModeHandler.handleGetMode();
                return true;
            case "set_mode":
                permissionModeHandler.handleSetMode(content);
                return true;
            // Model and provider
            case "set_model":
                modelProviderHandler.handleSetModel(content);
                return true;
            case "set_provider":
                modelProviderHandler.handleSetProvider(content);
                return true;
            case "set_reasoning_effort":
                modelProviderHandler.handleSetReasoningEffort(content);
                return true;
            case "set_codex_fast_mode":
                modelProviderHandler.handleSetCodexFastMode(content);
                return true;
            case "set_dsh_preset":
                dshPresetHandler.handleSetDshPreset(content);
                return true;
            case "get_gemini_models":
                modelProviderHandler.handleGetGeminiModels(content);
                return true;
            // Node path
            case "get_node_path":
                nodePathHandler.handleGetNodePath();
                return true;
            case "set_node_path":
                nodePathHandler.handleSetNodePath(content);
                return true;
            // Claude CLI path
            case "get_claude_cli_path":
                claudeCliPathHandler.handleGetClaudeCliPath();
                return true;
            case "set_claude_cli_path":
                claudeCliPathHandler.handleSetClaudeCliPath(content);
                return true;
            // TokenTracker local usage dashboard
            case "tt_detect_cli":
                tokenTrackerHandler.handleDetectCli(content);
                return true;
            case "tt_install_cli":
                tokenTrackerHandler.handleInstallCli(content);
                return true;
            case "tt_ensure_server":
                tokenTrackerHandler.handleEnsureServer(content);
                return true;
            case "tt_proxy":
                tokenTrackerHandler.handleProxy(content);
                return true;
            case "get_codex_subscription_quota":
                codexSubscriptionQuotaHandler.handleGetCodexSubscriptionQuota();
                return true;
            case "get_working_directory":
                projectConfigHandler.handleGetWorkingDirectory();
                return true;
            case "set_working_directory":
                projectConfigHandler.handleSetWorkingDirectory(content);
                return true;
            case "get_editor_font_config":
                projectConfigHandler.handleGetEditorFontConfig();
                return true;
            case "get_ui_font_config":
                projectConfigHandler.handleGetUiFontConfig();
                return true;
            case "set_ui_font_config":
                projectConfigHandler.handleSetUiFontConfig(content);
                return true;
            case "browse_ui_font_file":
                projectConfigHandler.handleBrowseUiFontFile();
                return true;
            case "get_code_font_config":
                projectConfigHandler.handleGetCodeFontConfig();
                return true;
            case "set_code_font_config":
                projectConfigHandler.handleSetCodeFontConfig(content);
                return true;
            case "browse_code_font_file":
                projectConfigHandler.handleBrowseCodeFontFile();
                return true;
            case "get_streaming_enabled":
                projectConfigHandler.handleGetStreamingEnabled();
                return true;
            case "set_streaming_enabled":
                projectConfigHandler.handleSetStreamingEnabled(content);
                return true;
            case "get_codex_sandbox_mode":
                projectConfigHandler.handleGetCodexSandboxMode();
                return true;
            case "set_codex_sandbox_mode":
                projectConfigHandler.handleSetCodexSandboxMode(content);
                return true;
            case "get_send_shortcut":
                projectConfigHandler.handleGetSendShortcut();
                return true;
            case "set_send_shortcut":
                projectConfigHandler.handleSetSendShortcut(content);
                return true;
            case "get_auto_open_file_enabled":
                projectConfigHandler.handleGetAutoOpenFileEnabled();
                return true;
            case "set_auto_open_file_enabled":
                projectConfigHandler.handleSetAutoOpenFileEnabled(content);
                return true;
            case "get_permission_dialog_timeout":
                projectConfigHandler.handleGetPermissionDialogTimeout();
                return true;
            case "set_permission_dialog_timeout":
                projectConfigHandler.handleSetPermissionDialogTimeout(content);
                return true;
            case "get_commit_generation_enabled":
                projectConfigHandler.handleGetCommitGenerationEnabled();
                return true;
            case "set_commit_generation_enabled":
                projectConfigHandler.handleSetCommitGenerationEnabled(content);
                return true;
            case "get_status_bar_widget_enabled":
                projectConfigHandler.handleGetStatusBarWidgetEnabled();
                return true;
            case "set_status_bar_widget_enabled":
                projectConfigHandler.handleSetStatusBarWidgetEnabled(content);
                return true;

            case "get_task_completion_notification_enabled":
                projectConfigHandler.handleGetTaskCompletionNotificationEnabled();
                return true;
            case "set_task_completion_notification_enabled":
                projectConfigHandler.handleSetTaskCompletionNotificationEnabled(content);
                return true;
            case "get_ask_user_question_notification_enabled":
                projectConfigHandler.handleGetAskUserQuestionNotificationEnabled();
                return true;
            case "set_ask_user_question_notification_enabled":
                projectConfigHandler.handleSetAskUserQuestionNotificationEnabled(content);
                return true;
            case "get_system_notification_only_when_unfocused":
                projectConfigHandler.handleGetSystemNotificationOnlyWhenUnfocused();
                return true;
            case "set_system_notification_only_when_unfocused":
                projectConfigHandler.handleSetSystemNotificationOnlyWhenUnfocused(content);
                return true;
            case "get_ask_user_question_sound_notification_enabled":
                projectConfigHandler.handleGetAskUserQuestionSoundNotificationEnabled();
                return true;
            case "set_ask_user_question_sound_notification_enabled":
                projectConfigHandler.handleSetAskUserQuestionSoundNotificationEnabled(content);
                return true;
            case "get_ai_title_generation_enabled":
                projectConfigHandler.handleGetAiTitleGenerationEnabled();
                return true;
            case "set_ai_title_generation_enabled":
                projectConfigHandler.handleSetAiTitleGenerationEnabled(content);
                return true;
            case "get_ide_theme":
                projectConfigHandler.handleGetIdeTheme();
                return true;
            case "get_commit_prompt":
                projectConfigHandler.handleGetCommitPrompt();
                return true;
            case "set_commit_prompt":
                projectConfigHandler.handleSetCommitPrompt(content);
                return true;
            case "get_commit_ai_config":
                projectConfigHandler.handleGetCommitAiConfig();
                return true;
            case "set_commit_ai_config":
                projectConfigHandler.handleSetCommitAiConfig(content);
                return true;
            case "get_prompt_enhancer_config":
                projectConfigHandler.handleGetPromptEnhancerConfig();
                return true;
            case "set_prompt_enhancer_config":
                projectConfigHandler.handleSetPromptEnhancerConfig(content);
                return true;
            case "get_project_commit_prompt":
                projectConfigHandler.handleGetProjectCommitPrompt();
                return true;
            case "set_project_commit_prompt":
                projectConfigHandler.handleSetProjectCommitPrompt(content);
                return true;
            // Input history
            case "get_input_history":
                inputHistoryHandler.handleGetInputHistory();
                return true;
            case "record_input_history":
                inputHistoryHandler.handleRecordInputHistory(content);
                return true;
            case "delete_input_history_item":
                inputHistoryHandler.handleDeleteInputHistoryItem(content);
                return true;
            case "clear_input_history":
                inputHistoryHandler.handleClearInputHistory();
                return true;
            // Sound notification configuration
            case "get_sound_notification_config":
                soundSettingsHandler.handleGetSoundNotificationConfig();
                return true;
            case "set_sound_notification_enabled":
                soundSettingsHandler.handleSetSoundNotificationEnabled(content);
                return true;
            case "set_sound_only_when_unfocused":
                soundSettingsHandler.handleSetSoundOnlyWhenUnfocused(content);
                return true;
            case "set_selected_sound":
                soundSettingsHandler.handleSetSelectedSound(content);
                return true;
            case "set_custom_sound_path":
                soundSettingsHandler.handleSetCustomSoundPath(content);
                return true;
            case "test_sound":
                soundSettingsHandler.handleTestSound(content);
                return true;
            case "browse_sound_file":
                soundSettingsHandler.handleBrowseSoundFile();
                return true;
            // User language preference
            case "set_user_language":
                handleSetUserLanguage(content);
                return true;
            case "get_user_language":
                handleGetUserLanguage();
                return true;
            case "clear_user_language":
                handleClearUserLanguage();
                return true;
            default:
                return false;
        }
    }

    /**
     * Handle set_user_language: save user's manual language preference.
     * On failure, push the authoritative config back so the webview can roll
     * back its optimistic UI update.
     */
    private void handleSetUserLanguage(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String language = json.has("language") && !json.get("language").isJsonNull()
                    ? json.get("language").getAsString() : null;
            if (language == null || language.isEmpty()) {
                LOG.warn("[SettingsHandler] set_user_language rejected: empty language");
                pushLanguageConfig();
                return;
            }
            LanguageConfigService.setUserLanguage(context.getSettingsService(), language);
            LOG.info("[SettingsHandler] Saved user language preference: " + language);
            pushLanguageConfig();
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to save user language: " + e.getMessage(), e);
            pushLanguageConfig();
        }
    }

    /**
     * Handle get_user_language: return user's saved language preference.
     */
    private void handleGetUserLanguage() {
        String userLanguage = LanguageConfigService.getUserLanguage(context.getSettingsService());
        JsonObject response = new JsonObject();
        response.addProperty("language", userLanguage != null ? userLanguage : "");
        response.addProperty("manuallySet", userLanguage != null);
        callJavaScript("window.onUserLanguage", escapeJs(response.toString()));
    }

    /**
     * Handle clear_user_language: clear user's manual language preference.
     * Pushes the authoritative config on both success and failure so the
     * webview always reflects the persisted state.
     */
    private void handleClearUserLanguage() {
        try {
            LanguageConfigService.clearUserLanguage(context.getSettingsService());
            LOG.info("[SettingsHandler] Cleared user language preference");
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to clear user language: " + e.getMessage(), e);
        } finally {
            pushLanguageConfig();
        }
    }

    private void pushLanguageConfig() {
        JsonObject languageConfig = LanguageConfigService.getLanguageConfig(context.getSettingsService());
        callJavaScript("window.applyIdeaLanguageConfig", escapeJs(languageConfig.toString()));
    }

    /**
     * Expose getModelContextLimit for callers that previously used the static method on SettingsHandler.
     */
    public static int getModelContextLimit(String model) {
        return ModelProviderHandler.getModelContextLimit(model);
    }

    public static int getModelContextLimit(String provider, String model) {
        return ModelProviderHandler.getModelContextLimit(provider, model);
    }
}
