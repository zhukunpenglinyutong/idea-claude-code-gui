package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.action.SendShortcutSync;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.ui.icon.PluginIconProvider;
import com.github.claudecodegui.ui.icon.ToolWindowIconService;
import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.util.ThemeConfigService;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.concurrent.CompletableFuture;

/**
 * Handles project-level configuration: working directory, streaming, sandbox mode,
 * auto-open file, send shortcut, commit prompt, IDE theme, editor font config, and usage statistics.
 */
public class ProjectConfigHandler {

    private static final Logger LOG = Logger.getInstance(ProjectConfigHandler.class);
    static final String SEND_SHORTCUT_PROPERTY_KEY = "claude.code.send.shortcut";

    private final HandlerContext context;
    private final CodemossSettingsService settingsService;
    private final Gson gson = new Gson();

    public ProjectConfigHandler(HandlerContext context) {
        this.context = context;
        this.settingsService = context.getSettingsService();
    }

    // ---- Internal helpers --------------------------------------------------

    @FunctionalInterface
    private interface ThrowingJsonSupplier { JsonElement get() throws Exception; }

    @FunctionalInterface
    private interface ThrowingBooleanConsumer { void accept(boolean value) throws Exception; }

    @FunctionalInterface
    private interface ThrowingProjectBooleanConsumer { void accept(String projectPath, boolean value) throws Exception; }

    private void pushJson(String jsCallback, JsonElement payload) {
        String json = gson.toJson(payload);
        ApplicationManager.getApplication().invokeLater(() ->
            context.callJavaScript(jsCallback, context.escapeJs(json)));
    }

    private void showError(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
            context.callJavaScript("window.showError", context.escapeJs(message)));
    }

    private void showSuccess(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
            context.callJavaScript("window.showSuccess", context.escapeJs(message)));
    }

    private static JsonObject jsonOf(String key, boolean value) {
        JsonObject obj = new JsonObject();
        obj.addProperty(key, value);
        return obj;
    }

    private static JsonObject jsonOf(String key, String value) {
        JsonObject obj = new JsonObject();
        obj.addProperty(key, value);
        return obj;
    }

    private static JsonObject jsonOf(String key, int value) {
        JsonObject obj = new JsonObject();
        obj.addProperty(key, value);
        return obj;
    }

    /** Run a getter and push the JSON payload; on error, push {@code fallback} so the UI always gets a response. */
    private void respondWithJson(String jsCallback, ThrowingJsonSupplier producer, JsonElement fallback,
                                 String errorLogMessage) {
        try {
            pushJson(jsCallback, producer.get());
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] " + errorLogMessage + "; errorClass="
                    + e.getClass().getSimpleName(), e);
            if (fallback != null) {
                pushJson(jsCallback, fallback);
            }
        }
    }

    private boolean readBoolean(JsonObject json, String field, boolean defaultValue) {
        if (json == null || !json.has(field) || json.get(field).isJsonNull()) { return defaultValue; }
        return json.get(field).getAsBoolean();
    }

    private String readString(JsonObject json, String field, String defaultValue) {
        if (json == null || !json.has(field) || json.get(field).isJsonNull()) { return defaultValue; }
        return json.get(field).getAsString();
    }

    /** Standard boolean-toggle setter: parse one field, apply mutation, log, echo back via {@code jsCallback}. */
    private void handleBooleanToggle(String content, String field, boolean defaultValue,
                                     String logLabel, ThrowingBooleanConsumer mutation,
                                     String jsCallback, String errorMessage) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = readBoolean(json, field, defaultValue);
            mutation.accept(enabled);
            LOG.info("[ProjectConfigHandler] Set " + logLabel + ": " + enabled);
            pushJson(jsCallback, jsonOf(field, enabled));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set " + logLabel + ": " + e.getMessage(), e);
            showError(errorMessage);
        }
    }

    /** Project-scoped variant of {@link #handleBooleanToggle}; validates project path first. */
    private void handleProjectBooleanToggle(String content, String field, boolean defaultValue,
                                            String logLabel, ThrowingProjectBooleanConsumer mutation,
                                            String jsCallback, String errorMessage) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                showError("Unable to resolve project path");
                return;
            }
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = readBoolean(json, field, defaultValue);
            mutation.accept(projectPath, enabled);
            LOG.info("[ProjectConfigHandler] Set " + logLabel + ": " + enabled);
            pushJson(jsCallback, jsonOf(field, enabled));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set " + logLabel + ": " + e.getMessage(), e);
            showError(errorMessage + ": " + e.getMessage());
        }
    }

    // ---- Working Directory -------------------------------------------------

    public void handleGetWorkingDirectory() {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.updateWorkingDirectory", "{}"));
                return;
            }
            String customWorkingDir = settingsService.getCustomWorkingDirectory(projectPath);
            JsonObject response = new JsonObject();
            response.addProperty("projectPath", projectPath);
            response.addProperty("customWorkingDir", customWorkingDir != null ? customWorkingDir : "");
            pushJson("window.updateWorkingDirectory", response);
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get working directory: " + e.getMessage(), e);
            showError("Failed to get working directory config: " + e.getMessage());
        }
    }

    public void handleSetWorkingDirectory(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                showError("Unable to resolve project path");
                return;
            }
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String customWorkingDir = readString(json, "customWorkingDir", null);
            if (customWorkingDir != null && !customWorkingDir.trim().isEmpty()) {
                java.io.File workingDirFile = new java.io.File(customWorkingDir);
                if (!workingDirFile.isAbsolute()) {
                    workingDirFile = new java.io.File(projectPath, customWorkingDir);
                }
                if (!workingDirFile.exists() || !workingDirFile.isDirectory()) {
                    showError("Working directory does not exist: " + workingDirFile.getAbsolutePath());
                    return;
                }
            }
            settingsService.setCustomWorkingDirectory(projectPath, customWorkingDir);
            LOG.info("[ProjectConfigHandler] Set custom working directory: " + customWorkingDir);
            showSuccess("Working directory config saved");
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set working directory: " + e.getMessage(), e);
            showError("Failed to save working directory config: " + e.getMessage());
        }
    }

    public void handleGetStreamingEnabled() {
        respondWithJson("window.updateStreamingEnabled",
            () -> {
                String projectPath = context.getProject().getBasePath();
                boolean enabled = projectPath == null || settingsService.getStreamingEnabled(projectPath);
                return jsonOf("streamingEnabled", enabled);
            },
            jsonOf("streamingEnabled", true),
            "Failed to get streaming enabled");
    }

    public void handleSetStreamingEnabled(String content) {
        handleProjectBooleanToggle(content, "streamingEnabled", true, "streaming enabled",
            settingsService::setStreamingEnabled,
            "window.updateStreamingEnabled",
            "Failed to save streaming config");
    }

    public void handleGetCodexSandboxMode() {
        respondWithJson("window.updateCodexSandboxMode",
            () -> jsonOf("sandboxMode", settingsService.getCodexSandboxMode(context.getProject().getBasePath())),
            jsonOf("sandboxMode", "danger-full-access"),
            "Failed to get Codex sandbox mode");
    }

    public void handleSetCodexSandboxMode(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String sandboxMode = readString(json, "sandboxMode", "danger-full-access");
            settingsService.setCodexSandboxMode(projectPath, sandboxMode);
            LOG.info("[ProjectConfigHandler] Set Codex sandbox mode: " + sandboxMode);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.updateCodexSandboxMode",
                    context.escapeJs(gson.toJson(jsonOf("sandboxMode", sandboxMode))));
                context.callJavaScript("window.showSuccessI18n", "toast.saveSuccess");
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set Codex sandbox mode: " + e.getMessage(), e);
            showError("Failed to save Codex sandbox mode: " + e.getMessage());
        }
    }

    public void handleGetAutoOpenFileEnabled() {
        respondWithJson("window.updateAutoOpenFileEnabled",
            () -> {
                String projectPath = context.getProject().getBasePath();
                boolean enabled = projectPath != null && settingsService.getAutoOpenFileEnabled(projectPath);
                return jsonOf("autoOpenFileEnabled", enabled);
            },
            jsonOf("autoOpenFileEnabled", false),
            "Failed to get auto open file enabled");
    }

    public void handleSetAutoOpenFileEnabled(String content) {
        handleProjectBooleanToggle(content, "autoOpenFileEnabled", false, "auto open file enabled",
            settingsService::setAutoOpenFileEnabled,
            "window.updateAutoOpenFileEnabled",
            "Failed to save auto open file config");
    }

    public void handleGetPermissionDialogTimeout() {
        respondWithJson("window.updatePermissionDialogTimeout",
            () -> jsonOf("permissionDialogTimeoutSeconds", settingsService.getPermissionDialogTimeoutSeconds()),
            jsonOf("permissionDialogTimeoutSeconds", CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS),
            "Failed to get permission dialog timeout");
    }

    public void handleSetPermissionDialogTimeout(String content) {
        try {
            JsonObject response = setPermissionDialogTimeoutAndCreateResponse(content);
            LOG.info("[ProjectConfigHandler] Set permission dialog timeout: "
                    + response.get("permissionDialogTimeoutSeconds").getAsInt() + "s");
            pushJson("window.updatePermissionDialogTimeout", response);
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set permission dialog timeout; errorClass="
                    + e.getClass().getSimpleName(), e);
            showError("Failed to save permission dialog timeout. See IDE log for details.");
        }
    }

    JsonObject setPermissionDialogTimeoutAndCreateResponse(String content) throws Exception {
        JsonObject json = gson.fromJson(content, JsonObject.class);
        // Strict type check: only accept a JSON numeric primitive. Anything else
        // (string, boolean, array, object, null, missing) falls back to default.
        int seconds = CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
        if (json != null && json.has("permissionDialogTimeoutSeconds")) {
            JsonElement element = json.get("permissionDialogTimeoutSeconds");
            if (element != null
                    && element.isJsonPrimitive()
                    && element.getAsJsonPrimitive().isNumber()) {
                seconds = element.getAsInt();
            }
        }
        settingsService.setPermissionDialogTimeoutSeconds(seconds);
        int effectiveSeconds = settingsService.getPermissionDialogTimeoutSeconds();
        return jsonOf("permissionDialogTimeoutSeconds", effectiveSeconds);
    }

    public void handleGetSendShortcut() {
        try {
            String sendShortcut = PropertiesComponent.getInstance().getValue(SEND_SHORTCUT_PROPERTY_KEY, "enter");
            pushJson("window.updateSendShortcut", jsonOf("sendShortcut", sendShortcut));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get send shortcut: " + e.getMessage(), e);
        }
    }

    public void handleSetSendShortcut(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String sendShortcut = readString(json, "sendShortcut", "enter");
            if (!"enter".equals(sendShortcut) && !"cmdEnter".equals(sendShortcut)) {
                sendShortcut = "enter";
            }
            PropertiesComponent.getInstance().setValue(SEND_SHORTCUT_PROPERTY_KEY, sendShortcut);
            SendShortcutSync.sync(sendShortcut);
            LOG.info("[ProjectConfigHandler] Set send shortcut: " + sendShortcut);
            pushJson("window.updateSendShortcut", jsonOf("sendShortcut", sendShortcut));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set send shortcut: " + e.getMessage(), e);
            showError("Failed to save send shortcut setting: " + e.getMessage());
        }
    }

    public void handleGetCommitPrompt() {
        try {
            String commitPrompt = settingsService.getCommitPrompt();
            String projectPath = context.getProject().getBasePath();
            String projectCommitPrompt = projectPath != null
                    ? settingsService.getProjectCommitPrompt(projectPath)
                    : "";
            JsonObject payload = new JsonObject();
            payload.addProperty("commitPrompt", commitPrompt);
            payload.addProperty("projectCommitPrompt", projectCommitPrompt);
            pushJson("window.updateCommitPrompt", payload);
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get commit prompt: " + e.getMessage(), e);
        }
    }

    public void handleSetCommitPrompt(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json == null || !json.has("prompt")) {
                LOG.warn("[ProjectConfigHandler] Invalid commit prompt request: missing prompt field");
                return;
            }
            String prompt = json.get("prompt").getAsString();
            if (prompt == null) {
                showError("Prompt cannot be empty");
                return;
            }
            prompt = prompt.trim();
            final int MAX_PROMPT_LENGTH = 10000;
            if (prompt.length() > MAX_PROMPT_LENGTH) {
                LOG.warn("[ProjectConfigHandler] Commit prompt too long: " + prompt.length() + " characters");
                showError("Prompt length must not exceed " + MAX_PROMPT_LENGTH + " characters");
                return;
            }
            final String validatedPrompt = prompt;
            settingsService.setCommitPrompt(validatedPrompt);
            LOG.info("[ProjectConfigHandler] Set commit prompt, length: " + validatedPrompt.length());
            JsonObject response = new JsonObject();
            response.addProperty("commitPrompt", validatedPrompt);
            response.addProperty("saved", true);
            pushJson("window.updateCommitPrompt", response);
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set commit prompt: " + e.getMessage(), e);
            showError("Failed to save commit prompt: " + e.getMessage());
        }
    }

    public void handleGetPromptEnhancerConfig() {
        try {
            pushJson("window.updatePromptEnhancerConfig", settingsService.getPromptEnhancerConfig());
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get prompt enhancer config: " + e.getMessage(), e);
            showError(ClaudeCodeGuiBundle.message("projectConfig.promptEnhancer.getFailed", e.getMessage()));
        }
    }

    public void handleSetPromptEnhancerConfig(String content) {
        applyAiProviderConfig(content,
            settingsService::setPromptEnhancerConfig,
            settingsService::getPromptEnhancerConfig,
            "window.updatePromptEnhancerConfig",
            "Failed to set prompt enhancer config",
            "projectConfig.promptEnhancer.saveFailed");
    }

    public void handleGetCommitAiConfig() {
        try {
            pushJson("window.updateCommitAiConfig", settingsService.getCommitAiConfig());
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get commit AI config: " + e.getMessage(), e);
            showError(ClaudeCodeGuiBundle.message("projectConfig.commitAi.getFailed", e.getMessage()));
        }
    }

    public void handleSetCommitAiConfig(String content) {
        applyAiProviderConfig(content,
            settingsService::setCommitAiConfig,
            settingsService::getCommitAiConfig,
            "window.updateCommitAiConfig",
            "Failed to set commit AI config",
            "projectConfig.commitAi.saveFailed");
    }

    @FunctionalInterface
    private interface AiProviderSetter {
        void apply(String provider, String claudeModel, String codexModel) throws Exception;
    }

    @FunctionalInterface
    private interface ThrowingJsonObjectSupplier { JsonObject get() throws Exception; }

    /** Shared logic for AI provider+models configs (prompt enhancer, commit AI, etc.). */
    private void applyAiProviderConfig(String content, AiProviderSetter setter,
                                       ThrowingJsonObjectSupplier getter,
                                       String jsCallback, String errorLogMessage, String errorBundleKey) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String provider = readString(json, "provider", null);
            JsonObject models = json != null && json.has("models") && json.get("models").isJsonObject()
                    ? json.getAsJsonObject("models")
                    : new JsonObject();
            setter.apply(provider, readString(models, "claude", null), readString(models, "codex", null));
            pushJson(jsCallback, getter.get());
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] " + errorLogMessage + ": " + e.getMessage(), e);
            showError(ClaudeCodeGuiBundle.message(errorBundleKey, e.getMessage()));
        }
    }

    public void handleGetProjectCommitPrompt() {
        try {
            String projectPath = context.getProject().getBasePath();
            String projectCommitPrompt = projectPath != null
                    ? settingsService.getProjectCommitPrompt(projectPath)
                    : "";
            pushJson("window.updateProjectCommitPrompt", jsonOf("projectCommitPrompt", projectCommitPrompt));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get project commit prompt: " + e.getMessage(), e);
        }
    }

    public void handleSetProjectCommitPrompt(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                showError("Cannot resolve project path");
                return;
            }
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json == null || !json.has("prompt")) {
                LOG.warn("[ProjectConfigHandler] Invalid project commit prompt request: missing prompt field");
                return;
            }
            String prompt = json.get("prompt").getAsString();
            if (prompt == null) {
                showError("Prompt cannot be empty");
                return;
            }
            prompt = prompt.trim();
            final int MAX_PROMPT_LENGTH = 10000;
            if (prompt.length() > MAX_PROMPT_LENGTH) {
                LOG.warn("[ProjectConfigHandler] Project commit prompt too long: " + prompt.length() + " characters");
                showError("Prompt length must not exceed " + MAX_PROMPT_LENGTH + " characters");
                return;
            }
            final String validatedPrompt = prompt;
            settingsService.setProjectCommitPrompt(projectPath, validatedPrompt);
            LOG.info("[ProjectConfigHandler] Set project commit prompt, length: " + validatedPrompt.length() + ", project: " + projectPath);
            JsonObject response = new JsonObject();
            response.addProperty("projectCommitPrompt", validatedPrompt);
            response.addProperty("saved", true);
            pushJson("window.updateProjectCommitPrompt", response);
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set project commit prompt: " + e.getMessage(), e);
            showError("Failed to save project commit prompt: " + e.getMessage());
        }
    }

    public void handleGetIdeTheme() {
        try {
            String themeConfigJson = ThemeConfigService.getIdeThemeConfig().toString();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.onIdeThemeReceived", context.escapeJs(themeConfigJson)));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get IDE theme: " + e.getMessage(), e);
        }
    }

    public void handleGetEditorFontConfig() {
        try {
            String fontConfigJson = FontConfigService.getEditorFontConfig().toString();
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.onEditorFontConfigReceived", context.escapeJs(fontConfigJson)));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get editor font config: " + e.getMessage(), e);
        }
    }

    public void handleGetUiFontConfig() {
        dispatchUiFontConfigUpdate();
    }

    public void handleSetUiFontConfig(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String mode = readString(json, "mode", FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR);
            String customFontPath = readString(json, "customFontPath", null);

            if (FontConfigService.UI_FONT_MODE_CUSTOM_FILE.equals(mode)) {
                FontConfigService.ValidationResult validation = FontConfigService.validateCustomUiFontFile(customFontPath);
                if (!validation.valid()) {
                    showError("Invalid font file: " + validation.errorMessage());
                    return;
                }
            }

            settingsService.setUiFontConfig(mode, customFontPath);
            dispatchUiFontConfigUpdate();
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set UI font config: " + e.getMessage(), e);
            showError("Failed to save font config: " + e.getMessage());
        }
    }

    public void handleGetCodeFontConfig() {
        dispatchCodeFontConfigUpdate();
    }

    public void handleSetCodeFontConfig(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String mode = readString(json, "mode", FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR);
            String customFontPath = readString(json, "customFontPath", null);

            if (FontConfigService.UI_FONT_MODE_CUSTOM_FILE.equals(mode)) {
                FontConfigService.ValidationResult validation = FontConfigService.validateCustomUiFontFile(customFontPath);
                if (!validation.valid()) {
                    showError("Invalid font file: " + validation.errorMessage());
                    return;
                }
            }

            settingsService.setCodeFontConfig(mode, customFontPath);
            dispatchCodeFontConfigUpdate();
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to set code font config: " + e.getMessage(), e);
            showError("Failed to save code font config: " + e.getMessage());
        }
    }

    public void handleBrowseUiFontFile() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileChooserDescriptor descriptor = new FileChooserDescriptor(true, false, false, false, false, false)
                    .withFileFilter(file -> {
                        String ext = file.getExtension();
                        return ext != null && (ext.equalsIgnoreCase("ttf") || ext.equalsIgnoreCase("otf"));
                    })
                    .withTitle("Select Font File")
                    .withDescription("Select a TTF or OTF font file");

                FileChooser.chooseFile(descriptor, context.getProject(), resolveCurrentCustomFontFile(), this::saveSelectedCustomFont);
            } catch (Exception e) {
                LOG.error("[ProjectConfigHandler] Failed to open font file chooser: " + e.getMessage(), e);
            }
        });
    }

    public void handleBrowseCodeFontFile() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileChooserDescriptor descriptor = new FileChooserDescriptor(true, false, false, false, false, false)
                    .withFileFilter(file -> {
                        String ext = file.getExtension();
                        return ext != null && (ext.equalsIgnoreCase("ttf") || ext.equalsIgnoreCase("otf"));
                    })
                    .withTitle("Select Font File")
                    .withDescription("Select a TTF or OTF font file");

                FileChooser.chooseFile(descriptor, context.getProject(), resolveCurrentCustomCodeFontFile(), this::saveSelectedCodeFont);
            } catch (Exception e) {
                LOG.error("[ProjectConfigHandler] Failed to open code font file chooser: " + e.getMessage(), e);
            }
        });
    }

    private VirtualFile resolveCurrentCustomFontFile() {
        try {
            JsonObject persistedUiFont = settingsService.getUiFontConfig();
            if (persistedUiFont.has("customFontPath") && !persistedUiFont.get("customFontPath").isJsonNull()) {
                return LocalFileSystem.getInstance().findFileByPath(persistedUiFont.get("customFontPath").getAsString());
            }
        } catch (Exception e) {
            LOG.warn("[ProjectConfigHandler] Failed to resolve current custom font path: " + e.getMessage());
        }
        return null;
    }

    private VirtualFile resolveCurrentCustomCodeFontFile() {
        try {
            JsonObject persistedCodeFont = settingsService.getCodeFontConfig();
            if (persistedCodeFont.has("customFontPath") && !persistedCodeFont.get("customFontPath").isJsonNull()) {
                return LocalFileSystem.getInstance().findFileByPath(persistedCodeFont.get("customFontPath").getAsString());
            }
        } catch (Exception e) {
            LOG.warn("[ProjectConfigHandler] Failed to resolve current custom code font path: " + e.getMessage());
        }
        return null;
    }

    private void saveSelectedCustomFont(VirtualFile file) {
        if (file == null) { return; }
        String path = file.getPath();
        FontConfigService.ValidationResult validation = FontConfigService.validateCustomUiFontFile(path);
        if (!validation.valid()) {
            context.callJavaScript("window.showError", context.escapeJs("Invalid font file: " + validation.errorMessage()));
            return;
        }
        try {
            settingsService.setUiFontConfig(FontConfigService.UI_FONT_MODE_CUSTOM_FILE, path);
            dispatchUiFontConfigUpdate();
            context.callJavaScript("window.showSuccessI18n", context.escapeJs("toast.saveSuccess"));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to save selected font file: " + e.getMessage(), e);
            context.callJavaScript("window.showError", context.escapeJs("Failed to save font config: " + e.getMessage()));
        }
    }

    private void saveSelectedCodeFont(VirtualFile file) {
        if (file == null) { return; }
        String path = file.getPath();
        FontConfigService.ValidationResult validation = FontConfigService.validateCustomUiFontFile(path);
        if (!validation.valid()) {
            context.callJavaScript("window.showError", context.escapeJs("Invalid font file: " + validation.errorMessage()));
            return;
        }
        try {
            settingsService.setCodeFontConfig(FontConfigService.UI_FONT_MODE_CUSTOM_FILE, path);
            dispatchCodeFontConfigUpdate();
            context.callJavaScript("window.showSuccessI18n", context.escapeJs("toast.saveSuccess"));
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to save selected code font file: " + e.getMessage(), e);
            context.callJavaScript("window.showError", context.escapeJs("Failed to save code font config: " + e.getMessage()));
        }
    }

    public void handleGetCommitGenerationEnabled() {
        respondWithJson("window.updateCommitGenerationEnabled",
            () -> jsonOf("commitGenerationEnabled", settingsService.getCommitGenerationEnabled()),
            jsonOf("commitGenerationEnabled", true),
            "Failed to get commit generation enabled");
    }

    public void handleSetCommitGenerationEnabled(String content) {
        handleBooleanToggle(content, "commitGenerationEnabled", true, "commit generation enabled",
            settingsService::setCommitGenerationEnabled,
            "window.updateCommitGenerationEnabled",
            "Failed to save AI commit generation config");
    }

    public void handleGetAiTitleGenerationEnabled() {
        respondWithJson("window.updateAiTitleGenerationEnabled",
            () -> jsonOf("aiTitleGenerationEnabled", settingsService.getAiTitleGenerationEnabled()),
            jsonOf("aiTitleGenerationEnabled", true),
            "Failed to get AI title generation enabled");
    }

    public void handleSetAiTitleGenerationEnabled(String content) {
        handleBooleanToggle(content, "aiTitleGenerationEnabled", true, "AI title generation enabled",
            settingsService::setAiTitleGenerationEnabled,
            "window.updateAiTitleGenerationEnabled",
            "Failed to save AI title generation config");
    }

    public void handleGetStatusBarWidgetEnabled() {
        respondWithJson("window.updateStatusBarWidgetEnabled",
            () -> jsonOf("statusBarWidgetEnabled", settingsService.getStatusBarWidgetEnabled()),
            jsonOf("statusBarWidgetEnabled", true),
            "Failed to get status bar widget enabled");
    }

    public void handleSetStatusBarWidgetEnabled(String content) {
        handleBooleanToggle(content, "statusBarWidgetEnabled", true, "status bar widget enabled",
            settingsService::setStatusBarWidgetEnabled,
            "window.updateStatusBarWidgetEnabled",
            "Failed to save status bar config");
    }

    public void handleGetCoDriverToolIconEnabled() {
        respondWithJson("window.updateCoDriverToolIconEnabled",
            () -> jsonOf("codriverToolIconEnabled", settingsService.getCoDriverToolIconEnabled()),
            jsonOf("codriverToolIconEnabled", true),
            "Failed to get CoDriver tool icon enabled");
    }

    public void handleSetCoDriverToolIconEnabled(String content) {
        handleBooleanToggle(content, "codriverToolIconEnabled", true, "CoDriver tool icon enabled",
            enabled -> {
                settingsService.setCoDriverToolIconEnabled(enabled);
                PluginIconProvider.setCoDriverIconEnabledCache(enabled);
                ToolWindowIconService.applyIcon(context.getProject(), enabled);
            },
            "window.updateCoDriverToolIconEnabled",
            "Failed to save CoDriver tool icon config");
    }

    public void handleGetTaskCompletionNotificationEnabled() {
        respondWithJson("window.updateTaskCompletionNotificationEnabled",
            () -> jsonOf("taskCompletionNotificationEnabled", settingsService.getTaskCompletionNotificationEnabled()),
            jsonOf("taskCompletionNotificationEnabled", false),
            "Failed to get task completion notification enabled");
    }

    public void handleSetTaskCompletionNotificationEnabled(String content) {
        // Default to disabled when payload is missing or the field is absent/null (opt-in feature).
        handleBooleanToggle(content, "taskCompletionNotificationEnabled", false, "task completion notification enabled",
            settingsService::setTaskCompletionNotificationEnabled,
            "window.updateTaskCompletionNotificationEnabled",
            "Failed to save task completion notification setting");
    }

    private void dispatchUiFontConfigUpdate() {
        try {
            String uiFontConfigJson = FontConfigService.getResolvedUiFontConfigJson(settingsService);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.onUiFontConfigReceived", context.escapeJs(uiFontConfigJson));
                context.callJavaScript("window.applyUiFontConfig", context.escapeJs(uiFontConfigJson));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to dispatch UI font config: " + e.getMessage(), e);
        }
    }

    private void dispatchCodeFontConfigUpdate() {
        try {
            String codeFontConfigJson = FontConfigService.getResolvedCodeFontConfigJson(settingsService);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.onCodeFontConfigReceived", context.escapeJs(codeFontConfigJson));
                context.callJavaScript("window.applyCodeFontConfig", context.escapeJs(codeFontConfigJson));
            });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to dispatch code font config: " + e.getMessage(), e);
        }
    }

    /** Get usage statistics. Supports both Claude and Codex providers. */
    public void handleGetUsageStatistics(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String projectPath = "all";
                String provider = "claude";
                long cutoffTime = 0;
                if (content != null && !content.isEmpty() && !content.equals("{}")) {
                    try {
                        JsonObject json = gson.fromJson(content, JsonObject.class);
                        if (json.has("scope")) {
                            projectPath = "current".equals(json.get("scope").getAsString())
                                ? context.getProject().getBasePath() : "all";
                        }
                        if (json.has("provider")) {
                            provider = json.get("provider").getAsString();
                        }
                        if (json.has("dateRange")) {
                            String dateRange = json.get("dateRange").getAsString();
                            long now = System.currentTimeMillis();
                            if ("7d".equals(dateRange)) { cutoffTime = now - 7L * 24 * 60 * 60 * 1000; }
                            else if ("30d".equals(dateRange)) { cutoffTime = now - 30L * 24 * 60 * 60 * 1000; }
                        }
                    } catch (Exception e) {
                        projectPath = "current".equals(content) ? context.getProject().getBasePath() : content;
                    }
                }
                String json;
                if ("codex".equals(provider)) {
                    CodexHistoryReader reader = new CodexHistoryReader();
                    CodexHistoryReader.ProjectStatistics stats = reader.getProjectStatistics(projectPath, cutoffTime);
                    LOG.info("[ProjectConfigHandler] Codex statistics - sessions: " + stats.totalSessions +
                             ", cost: " + stats.estimatedCost + ", total tokens: " + stats.totalUsage.totalTokens);
                    json = gson.toJson(stats);
                } else {
                    ClaudeHistoryReader reader = new ClaudeHistoryReader();
                    json = gson.toJson(reader.getProjectStatistics(projectPath, cutoffTime));
                }
                final String statsJson = json;
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.updateUsageStatistics", context.escapeJs(statsJson)));
            } catch (Exception e) {
                LOG.error("[ProjectConfigHandler] Failed to get usage statistics: " + e.getMessage(), e);
                showError("Failed to get statistics: " + e.getMessage());
            }
        });
    }
}
