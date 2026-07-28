package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.model.ConflictStrategy;
import com.github.claudecodegui.model.PromptScope;
import com.github.claudecodegui.settings.AbstractPromptManager;
import com.github.claudecodegui.watcher.PromptFileWatcher;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationType;
import com.intellij.notification.Notifications;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.LocalFileSystem;

import java.awt.*;
import java.io.File;
import java.io.FileWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.List;

/**
 * Prompt library management message handler.
 */
public class PromptHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PromptHandler.class);

    private static final long MAX_IMPORT_FILE_SIZE = 5 * 1024 * 1024; // 5MB

    private static final String[] SUPPORTED_TYPES = {
        "get_prompts",
        "get_project_info",
        "add_prompt",
        "update_prompt",
        "delete_prompt",
        "export_prompts",
        "import_prompts_file",
        "save_imported_prompts"
    };

    private final CodemossSettingsService settingsService;
    private final Gson gson;
    private final PromptFileWatcher fileWatcher;

    public PromptHandler(HandlerContext context) {
        super(context);
        this.settingsService = context.getSettingsService();
        this.gson = new Gson();

        // Initialize file watcher to monitor .codemoss/prompt.json changes
        this.fileWatcher = new PromptFileWatcher(
            context.getProject(),
            settingsService,
            (scope, provider, promptsJson) -> {
                // When file changes, notify frontend to update cache
                final String callbackName = scope == PromptScope.GLOBAL
                    ? "window.updateGlobalPrompts"
                    : "window.updateProjectPrompts";
                final String payloadJson = promptListPayloadJson(provider, promptsJson);

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript(callbackName, escapeJs(payloadJson));
                });

                LOG.info("[PromptHandler] File watcher triggered update for scope="
                        + scope.getValue() + ", provider=" + provider);
            }
        );

        // Start watching for file changes
        fileWatcher.startWatching();
    }

    /**
     * Cleanup method called when the handler is disposed.
     * Stops the file watcher to prevent memory leaks.
     */
    public void dispose() {
        if (fileWatcher != null) {
            fileWatcher.stopWatching();
        }
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_prompts":
                handleGetPrompts(content);
                return true;
            case "get_project_info":
                handleGetProjectInfo(content);
                return true;
            case "add_prompt":
                handleAddPrompt(content);
                return true;
            case "update_prompt":
                handleUpdatePrompt(content);
                return true;
            case "delete_prompt":
                handleDeletePrompt(content);
                return true;
            case "export_prompts":
                handleExportPrompts(content);
                return true;
            case "import_prompts_file":
                handleImportPromptsFile(content);
                return true;
            case "save_imported_prompts":
                handleSaveImportedPrompts(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Parse scope from message data.
     * Defaults to GLOBAL scope if parsing fails or scope is not specified.
     *
     * @param data The message data (can be null or empty)
     * @return The parsed PromptScope, or GLOBAL if parsing fails
     */
    private PromptScope parseScopeFromData(String data) {
        if (data == null || data.trim().isEmpty()) {
            return PromptScope.GLOBAL;
        }

        try {
            JsonObject json = gson.fromJson(data, JsonObject.class);
            if (json == null || !json.has("scope")) {
                return PromptScope.GLOBAL;
            }

            String scopeStr = json.get("scope").getAsString();
            return PromptScope.fromString(scopeStr);
        } catch (Exception e) {
            LOG.warn("[PromptHandler] Failed to parse scope, defaulting to GLOBAL: " + e.getMessage());
            return PromptScope.GLOBAL;
        }
    }

    private String parseProviderFromData(String data) {
        if (data == null || data.trim().isEmpty()) {
            return "claude";
        }
        try {
            JsonObject json = gson.fromJson(data, JsonObject.class);
            if (json == null || !json.has("provider")) {
                return "claude";
            }
            return CodemossSettingsService.normalizePromptProvider(json.get("provider").getAsString());
        } catch (Exception e) {
            LOG.warn("[PromptHandler] Failed to parse provider, defaulting to Claude: " + e.getMessage());
            return "claude";
        }
    }

    private String promptRefreshJson(PromptScope scope, String provider) {
        JsonObject payload = new JsonObject();
        payload.addProperty("scope", scope.getValue());
        payload.addProperty("provider", CodemossSettingsService.normalizePromptProvider(provider));
        return gson.toJson(payload);
    }

    private String promptListPayloadJson(String provider, String promptsJson) {
        JsonObject payload = new JsonObject();
        payload.addProperty("provider", CodemossSettingsService.normalizePromptProvider(provider));
        payload.add("prompts", JsonParser.parseString(promptsJson));
        return gson.toJson(payload);
    }

    /**
     * Get all prompts.
     * Supports scope parameter for filtering by GLOBAL or PROJECT scope.
     *
     * @param content Message content containing optional scope parameter
     */
    private void handleGetPrompts(String content) {
        try {
            PromptScope scope = parseScopeFromData(content);
            String provider = parseProviderFromData(content);
            LOG.debug("[PromptHandler] Getting prompts for scope=" + scope.getValue() + ", provider=" + provider);

            List<JsonObject> prompts = settingsService.getPrompts(scope, context.getProject(), provider);
            LOG.debug("[PromptHandler] Retrieved " + prompts.size()
                    + " prompts for scope=" + scope.getValue() + ", provider=" + provider);

            String promptsJson = promptListPayloadJson(provider, gson.toJson(prompts));

            // Call different window callbacks based on scope
            final String callbackName = scope == PromptScope.GLOBAL
                ? "window.updateGlobalPrompts"
                : "window.updateProjectPrompts";

            ApplicationManager.getApplication().invokeLater(() -> {
                LOG.debug("[PromptHandler] Sending " + prompts.size() + " prompts to frontend via " + callbackName);
                callJavaScript(callbackName, escapeJs(promptsJson));
            });
        } catch (IllegalStateException e) {
            // If project prompts are requested but project is not ready yet, silently fail
            // Don't send empty array to frontend - let it retry later when user triggers "!"
            PromptScope scope = parseScopeFromData(content);
            if (scope == PromptScope.PROJECT && e.getMessage() != null && e.getMessage().contains("Project not available")) {
                LOG.warn("[PromptHandler] Project not ready yet, skipping project prompts callback (will retry on user action)");
                // Don't call frontend callback - let frontend stay in idle/loading state
                return;
            }

            // For other errors, send empty array
            final String callbackName = scope == PromptScope.GLOBAL
                ? "window.updateGlobalPrompts"
                : "window.updateProjectPrompts";

            ApplicationManager.getApplication().invokeLater(() -> {
                LOG.error("[PromptHandler] Sending empty prompts list due to error: " + e.getMessage());
                String provider = parseProviderFromData(content);
                callJavaScript(callbackName, escapeJs(promptListPayloadJson(provider, "[]")));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to get prompts: " + e.getMessage(), e);

            // Parse scope again for error callback
            PromptScope scope = parseScopeFromData(content);
            final String callbackName = scope == PromptScope.GLOBAL
                ? "window.updateGlobalPrompts"
                : "window.updateProjectPrompts";

            ApplicationManager.getApplication().invokeLater(() -> {
                LOG.error("[PromptHandler] Sending empty prompts list due to error");
                String provider = parseProviderFromData(content);
                callJavaScript(callbackName, escapeJs(promptListPayloadJson(provider, "[]")));
            });
        }
    }

    /**
     * Get project information.
     * Returns the current project name and availability status.
     *
     * @param content Message content (not used)
     */
    private void handleGetProjectInfo(String content) {
        try {
            JsonObject projectInfo = new JsonObject();
            Project project = context.getProject();

            if (project != null && !project.isDisposed() && project.getBasePath() != null) {
                projectInfo.addProperty("available", true);
                projectInfo.addProperty("name", project.getName());
                projectInfo.addProperty("path", NodeDetector.convertToWslPath(project.getBasePath()));
            } else {
                projectInfo.addProperty("available", false);
                projectInfo.addProperty("name", (String) null);
                projectInfo.addProperty("path", (String) null);
            }

            String projectInfoJson = gson.toJson(projectInfo);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateProjectInfo", escapeJs(projectInfoJson));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to get project info: " + e.getMessage(), e);

            // Send null project info on error
            JsonObject projectInfo = new JsonObject();
            projectInfo.addProperty("available", false);
            projectInfo.addProperty("name", (String) null);
            projectInfo.addProperty("path", (String) null);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateProjectInfo", escapeJs(gson.toJson(projectInfo)));
            });
        }
    }

    /**
     * Add a prompt.
     * Supports scope parameter to specify GLOBAL or PROJECT scope.
     * Format: {"scope":"global|project","prompt":{...}} or legacy format {...}
     *
     * @param content Message content containing prompt data and optional scope
     */
    private void handleAddPrompt(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            // Parse scope (default to GLOBAL)
            PromptScope scope = PromptScope.GLOBAL;
            if (data.has("scope")) {
                scope = PromptScope.fromString(data.get("scope").getAsString());
            }
            String provider = parseProviderFromData(content);

            // Extract prompt object (support both new and legacy formats)
            JsonObject prompt;
            if (data.has("prompt")) {
                prompt = data.getAsJsonObject("prompt");
            } else {
                // Legacy format: entire data object is the prompt
                prompt = data;
            }

            settingsService.addPrompt(prompt, scope, context.getProject(), provider);

            // Refresh the list
            final PromptScope finalScope = scope;
            final String finalProvider = provider;
            ApplicationManager.getApplication().invokeLater(() -> {
                // Refresh with the same scope
                handleGetPrompts(promptRefreshJson(finalScope, finalProvider));
                callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"add\"}"));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to add prompt: " + e.getMessage(), e);
            sendErrorResult("add", "Failed to add prompt");
        }
    }

    /**
     * Update a prompt.
     * Supports scope parameter to specify GLOBAL or PROJECT scope.
     * Format: {"scope":"global|project","id":"...","updates":{...}}
     *
     * @param content Message content containing prompt id, updates, and optional scope
     */
    private void handleUpdatePrompt(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("id") || data.get("id").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'id' field in update request");
                sendErrorResult("update", "Missing 'id' field in request");
                return;
            }
            if (!data.has("updates") || data.get("updates").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'updates' field in update request");
                sendErrorResult("update", "Missing 'updates' field in request");
                return;
            }

            // Parse scope (default to GLOBAL)
            PromptScope scope = PromptScope.GLOBAL;
            if (data.has("scope")) {
                scope = PromptScope.fromString(data.get("scope").getAsString());
            }
            String provider = parseProviderFromData(content);

            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            settingsService.updatePrompt(id, updates, scope, context.getProject(), provider);

            // Refresh the list
            final PromptScope finalScope = scope;
            final String finalProvider = provider;
            ApplicationManager.getApplication().invokeLater(() -> {
                // Refresh with the same scope
                handleGetPrompts(promptRefreshJson(finalScope, finalProvider));
                callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"update\"}"));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to update prompt: " + e.getMessage(), e);
            sendErrorResult("update", "Failed to update prompt");
        }
    }

    /**
     * Delete a prompt.
     * Supports scope parameter to specify GLOBAL or PROJECT scope.
     * Format: {"scope":"global|project","id":"..."}
     *
     * @param content Message content containing prompt id and optional scope
     */
    private void handleDeletePrompt(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("id") || data.get("id").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'id' field in delete request");
                sendErrorResult("delete", "Missing 'id' field in request");
                return;
            }

            // Parse scope (default to GLOBAL)
            PromptScope scope = PromptScope.GLOBAL;
            if (data.has("scope")) {
                scope = PromptScope.fromString(data.get("scope").getAsString());
            }
            String provider = parseProviderFromData(content);

            String id = data.get("id").getAsString();

            boolean deleted = settingsService.deletePrompt(id, scope, context.getProject(), provider);

            if (deleted) {
                // Refresh the list
                final PromptScope finalScope = scope;
                final String finalProvider = provider;
                ApplicationManager.getApplication().invokeLater(() -> {
                    // Refresh with the same scope
                    handleGetPrompts(promptRefreshJson(finalScope, finalProvider));
                    callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"delete\"}"));
                });
            } else {
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("operation", "delete");
                errorResult.addProperty("error", "Prompt not found");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
                });
            }
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to delete prompt: " + e.getMessage(), e);
            sendErrorResult("delete", "Failed to delete prompt");
        }
    }

    /**
     * Send error result to frontend
     */
    private void sendErrorResult(String operation, String error) {
        JsonObject errorResult = new JsonObject();
        errorResult.addProperty("success", false);
        errorResult.addProperty("operation", operation);
        errorResult.addProperty("error", error);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
        });
    }

    /**
     * Handle exporting selected prompts to a JSON file.
     * Supports scope parameter to specify GLOBAL or PROJECT scope.
     * Format: {"scope":"global|project","promptIds":[...]}
     *
     * @param content Message content containing optional scope and promptIds
     */
    private void handleExportPrompts(String content) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                // Parse scope (default to GLOBAL)
                PromptScope scope = parseScopeFromData(content);
                String provider = parseProviderFromData(content);
                List<JsonObject> prompts = settingsService.getPrompts(scope, context.getProject(), provider);

                // Filter prompts by selected IDs if provided
                if (content != null && !content.isEmpty()) {
                    try {
                        JsonObject data = gson.fromJson(content, JsonObject.class);
                        if (data.has("promptIds")) {
                            JsonArray promptIdsArray = data.getAsJsonArray("promptIds");
                            java.util.Set<String> selectedIds = new java.util.HashSet<>();
                            for (int i = 0; i < promptIdsArray.size(); i++) {
                                selectedIds.add(promptIdsArray.get(i).getAsString());
                            }

                            prompts = prompts.stream()
                                .filter(prompt -> {
                                    String id = prompt.has("id") ? prompt.get("id").getAsString() : "";
                                    return selectedIds.contains(id);
                                })
                                .collect(java.util.stream.Collectors.toList());
                        }
                    } catch (Exception e) {
                        LOG.warn("[PromptHandler] Failed to parse promptIds, exporting all: " + e.getMessage());
                    }
                }

                if (prompts.isEmpty()) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Export Failed",
                            "No prompts to export",
                            NotificationType.WARNING
                    ));
                    return;
                }

                // Create export data structure
                SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
                String exportTime = dateFormat.format(new Date());

                JsonObject exportData = new JsonObject();
                exportData.addProperty("format", "claude-code-prompts-export-v1");
                exportData.addProperty("exportTime", exportTime);
                exportData.addProperty("promptCount", prompts.size());
                exportData.addProperty("provider", provider);

                JsonArray promptsArray = new JsonArray();
                for (JsonObject prompt : prompts) {
                    promptsArray.add(prompt);
                }
                exportData.add("prompts", promptsArray);

                // Open file save dialog
                FileDialog fileDialog = new FileDialog((Frame) null, "Export Prompts", FileDialog.SAVE);

                // Generate default filename with timestamp
                SimpleDateFormat filenameDateFormat = new SimpleDateFormat("yyyyMMdd-HHmmss");
                String defaultFilename = "prompts-" + filenameDateFormat.format(new Date()) + ".json";
                fileDialog.setFile(defaultFilename);
                fileDialog.setFilenameFilter((dir, name) -> name.toLowerCase().endsWith(".json"));
                fileDialog.setVisible(true);

                String directory = fileDialog.getDirectory();
                String filename = fileDialog.getFile();

                if (directory == null || filename == null) {
                    LOG.info("[PromptHandler] Export cancelled by user");
                    return;
                }

                File file = new File(directory, filename);

                // Write JSON to file
                try (FileWriter writer = new FileWriter(file, StandardCharsets.UTF_8)) {
                    gson.toJson(exportData, writer);
                    LOG.info("[PromptHandler] Successfully exported " + prompts.size() + " prompts to " + file.getAbsolutePath());

                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Export Successful",
                            "Exported " + prompts.size() + " prompts to " + filename,
                            NotificationType.INFORMATION
                    ));
                } catch (Exception e) {
                    LOG.error("[PromptHandler] Failed to write export file: " + e.getMessage(), e);
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Export Failed",
                            "Failed to write file: " + e.getMessage(),
                            NotificationType.ERROR
                    ));
                }
            } catch (Exception e) {
                LOG.error("[PromptHandler] Failed to export prompts: " + e.getMessage(), e);
                Notifications.Bus.notify(new Notification(
                        "Codemoss",
                        "Export Failed",
                        "Failed to export prompts: " + e.getMessage(),
                        NotificationType.ERROR
                ));
            }
        });
    }

    /**
     * Handle importing prompts from a JSON file.
     * Supports scope parameter to specify GLOBAL or PROJECT scope.
     * Format: {"scope":"global|project"}
     *
     * @param content Message content containing optional scope
     */
    private void handleImportPromptsFile(String content) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                // Parse scope (default to GLOBAL)
                PromptScope scope = parseScopeFromData(content);
                String provider = parseProviderFromData(content);
                // Create file chooser descriptor for JSON files
                FileChooserDescriptor descriptor = new FileChooserDescriptor(
                    true,  // chooseFiles
                    false, // chooseFolders
                    false, // chooseJars
                    false, // chooseJarsAsFiles
                    false, // chooseJarContents
                    false  // chooseMultiple
                );
                descriptor.setTitle("Import Prompts");
                descriptor.setDescription("Select a JSON file containing exported prompts");
                descriptor.withFileFilter(vFile -> vFile.getExtension() != null && vFile.getExtension().equalsIgnoreCase("json"));

                // Set initial directory to project base path
                VirtualFile initialDir = null;
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    initialDir = LocalFileSystem.getInstance().findFileByPath(NodeDetector.toVfsPath(projectPath));
                }

                // Show file chooser
                VirtualFile[] selectedFiles = FileChooser.chooseFiles(descriptor, context.getProject(), initialDir);

                if (selectedFiles.length == 0) {
                    LOG.info("[PromptHandler] Import cancelled by user");
                    return;
                }

                VirtualFile selectedFile = selectedFiles[0];
                File file = new File(selectedFile.getPath());

                // Check file size (limit to 5MB)
                long fileSize = file.length();
                long maxSize = MAX_IMPORT_FILE_SIZE;
                if (fileSize > maxSize) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            "File size exceeds 5MB limit",
                            NotificationType.ERROR
                    ));
                    return;
                }

                // Read and parse file
                String fileContent = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
                JsonObject importData = JsonParser.parseString(fileContent).getAsJsonObject();

                // Validate format
                if (!importData.has("format") || !importData.get("format").getAsString().startsWith("claude-code-prompts-export-v")) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            "Invalid file format. Please select a valid prompts export file.",
                            NotificationType.ERROR
                    ));
                    return;
                }

                if (!importData.has("prompts")) {
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            "No prompts found in file",
                            NotificationType.ERROR
                    ));
                    return;
                }

                JsonArray promptsArray = importData.getAsJsonArray("prompts");
                List<JsonObject> promptsToImport = new ArrayList<>();

                for (int i = 0; i < promptsArray.size(); i++) {
                    JsonObject prompt = promptsArray.get(i).getAsJsonObject().deepCopy();
                    prompt.addProperty("provider", provider);
                    promptsToImport.add(prompt);
                }

                // Validate and detect conflicts
                AbstractPromptManager promptManager = settingsService.getPromptManager(scope, context.getProject());
                Set<String> conflicts = settingsService.detectPromptConflicts(
                        promptsToImport, scope, context.getProject(), provider);

                // Prepare preview data
                JsonObject previewData = new JsonObject();
                JsonArray itemsArray = new JsonArray();

                for (JsonObject prompt : promptsToImport) {
                    String validationError = promptManager.validatePrompt(prompt);
                    if (validationError != null) {
                        LOG.warn("[PromptHandler] Invalid prompt in import: " + validationError);
                        continue;
                    }

                    String id = prompt.get("id").getAsString();
                    boolean hasConflict = conflicts.contains(id);

                    JsonObject item = new JsonObject();
                    item.add("data", prompt);
                    item.addProperty("status", hasConflict ? "update" : "new");
                    item.addProperty("conflict", hasConflict);
                    itemsArray.add(item);
                }

                previewData.add("items", itemsArray);

                JsonObject summary = new JsonObject();
                summary.addProperty("total", itemsArray.size());
                summary.addProperty("newCount", (int) itemsArray.asList().stream()
                        .filter(item -> !item.getAsJsonObject().get("conflict").getAsBoolean()).count());
                summary.addProperty("updateCount", conflicts.size());
                previewData.add("summary", summary);

                // Send preview to frontend
                String previewJson = gson.toJson(previewData);
                callJavaScript("window.promptImportPreviewResult", escapeJs(previewJson));

                LOG.info("[PromptHandler] Prepared import preview with " + itemsArray.size() + " prompts");

            } catch (Exception e) {
                LOG.error("[PromptHandler] Failed to import prompts file: " + e.getMessage(), e);
                Notifications.Bus.notify(new Notification(
                        "Codemoss",
                        "Import Failed",
                        "Failed to read file: " + e.getMessage(),
                        NotificationType.ERROR
                ));
            }
        });
    }

    /**
     * Handle saving imported prompts.
     * Supports scope parameter to specify GLOBAL or PROJECT scope.
     * Format: {"scope":"global|project","prompts":[...],"strategy":"..."}
     *
     * @param content Message content containing prompts, strategy, and optional scope
     */
    private void handleSaveImportedPrompts(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("prompts") || !data.has("strategy")) {
                LOG.error("[PromptHandler] Missing required fields in save request");
                sendImportErrorResult("Missing required fields");
                return;
            }

            // Parse scope (default to GLOBAL)
            PromptScope scope = PromptScope.GLOBAL;
            if (data.has("scope")) {
                scope = PromptScope.fromString(data.get("scope").getAsString());
            }
            String provider = parseProviderFromData(content);

            JsonArray selectedPromptsArray = data.getAsJsonArray("prompts");
            String strategyStr = data.get("strategy").getAsString();
            ConflictStrategy strategy = ConflictStrategy.fromValue(strategyStr);

            List<JsonObject> promptsToImport = new ArrayList<>();
            for (int i = 0; i < selectedPromptsArray.size(); i++) {
                JsonObject prompt = selectedPromptsArray.get(i).getAsJsonObject().deepCopy();
                prompt.addProperty("provider", provider);
                promptsToImport.add(prompt);
            }

            Map<String, Object> result = settingsService.batchImportPrompts(
                    promptsToImport, strategy, scope, context.getProject(), provider);

            // Add scope to result for frontend to know which list to refresh
            result.put("scope", scope.getValue());
            result.put("provider", provider);

            // Send result to frontend
            final PromptScope finalScope = scope;
            final String finalProvider = provider;
            ApplicationManager.getApplication().invokeLater(() -> {
                String resultJson = gson.toJson(result);
                callJavaScript("window.promptImportResult", escapeJs(resultJson));

                // Refresh the list with the same scope
                handleGetPrompts(promptRefreshJson(finalScope, finalProvider));

                // Show notification
                boolean success = Boolean.TRUE.equals(result.get("success"));
                int imported = result.get("imported") instanceof Number ? ((Number) result.get("imported")).intValue() : 0;
                int updated = result.get("updated") instanceof Number ? ((Number) result.get("updated")).intValue() : 0;
                int skipped = result.get("skipped") instanceof Number ? ((Number) result.get("skipped")).intValue() : 0;

                if (success) {
                    String message = String.format("Imported %d prompts (%d new, %d updated, %d skipped)",
                            imported + updated, imported, updated, skipped);
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Successful",
                            message,
                            NotificationType.INFORMATION
                    ));
                } else {
                    @SuppressWarnings("unchecked")
                    List<String> errors = (List<String>) result.get("errors");
                    String errorMsg = errors.isEmpty() ? "Unknown error" : errors.get(0);
                    Notifications.Bus.notify(new Notification(
                            "Codemoss",
                            "Import Failed",
                            errorMsg,
                            NotificationType.ERROR
                    ));
                }

                LOG.info(String.format("[PromptHandler] Import completed: %d imported, %d updated, %d skipped",
                        imported, updated, skipped));
            });

        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to save imported prompts: " + e.getMessage(), e);
            sendImportErrorResult("Failed to save prompts: " + e.getMessage());
        }
    }

    /**
     * Send import error result to frontend
     */
    private void sendImportErrorResult(String error) {
        JsonObject errorResult = new JsonObject();
        errorResult.addProperty("success", false);
        errorResult.addProperty("error", error);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.promptImportResult", escapeJs(gson.toJson(errorResult)));
            Notifications.Bus.notify(new Notification(
                    "Codemoss",
                    "Import Failed",
                    error,
                    NotificationType.ERROR
            ));
        });
    }
}
