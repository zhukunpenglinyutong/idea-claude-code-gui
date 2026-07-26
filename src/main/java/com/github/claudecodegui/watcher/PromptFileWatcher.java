package com.github.claudecodegui.watcher;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.model.PromptScope;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;

import java.util.List;

/**
 * Watches for changes to .codemoss/prompt.json files and notifies listeners.
 * Monitors both global and project-specific prompt files for external modifications.
 */
public class PromptFileWatcher implements BulkFileListener {
    private static final Logger LOG = Logger.getInstance(PromptFileWatcher.class);

    private final Project project;
    private final CodemossSettingsService settingsService;
    private final Gson gson;
    private final PromptChangeListener onPromptsChanged;
    private MessageBusConnection connection;

    /**
     * Create a new PromptFileWatcher.
     *
     * @param project IntelliJ Project instance
     * @param settingsService Settings service for loading prompts
     * @param onPromptsChanged Callback when prompts change: (scope, provider, promptsJson) -> void
     */
    public PromptFileWatcher(
        Project project,
        CodemossSettingsService settingsService,
        PromptChangeListener onPromptsChanged
    ) {
        this.project = project;
        this.settingsService = settingsService;
        this.gson = new Gson();
        this.onPromptsChanged = onPromptsChanged;
    }

    @Override
    public void after(@NotNull List<? extends VFileEvent> events) {
        for (VFileEvent event : events) {
            // Only handle content change events (file modifications)
            if (!(event instanceof VFileContentChangeEvent)) {
                continue;
            }

            VirtualFile file = event.getFile();
            if (file == null) {
                continue;
            }

            String filePath = file.getPath();

            // Check if this is a project prompt.json file
            if (isProjectPromptFile(filePath)) {
                LOG.info("[PromptFileWatcher] Detected change in project prompt.json: " + filePath);
                reloadAndNotify(PromptScope.PROJECT);
                continue;
            }

            // Check if this is a global prompt.json file
            if (isGlobalPromptFile(filePath)) {
                LOG.info("[PromptFileWatcher] Detected change in global prompt.json: " + filePath);
                reloadAndNotify(PromptScope.GLOBAL);
            }
        }
    }

    /**
     * Check if the file path matches project prompt.json pattern.
     * Pattern: <project-path>/.codemoss/prompt.json
     */
    private boolean isProjectPromptFile(String filePath) {
        if (project == null || project.getBasePath() == null) {
            return false;
        }

        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        boolean isWsl = NodeDetector.isWslPath(nodePath);
        String normalizedFilePath = isWsl ? NodeDetector.convertToWslPath(filePath) : filePath;
        String projectPromptPath = (isWsl ? NodeDetector.convertToWslPath(project.getBasePath()) : project.getBasePath()) + "/.codemoss/prompt.json";
        return normalizedFilePath.equals(projectPromptPath);
    }

    /**
     * Check if the file path matches global prompt.json pattern.
     * Pattern: ~/.codemoss/prompt.json
     */
    private boolean isGlobalPromptFile(String filePath) {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        String globalPromptPath = homeDir + "/.codemoss/prompt.json";
        return filePath.equals(globalPromptPath);
    }

    /**
     * Reload prompts from file and notify listeners.
     */
    private void reloadAndNotify(PromptScope scope) {
        try {
            notifyProvider(scope, "claude");
            notifyProvider(scope, "codex");
        } catch (Exception e) {
            LOG.error("[PromptFileWatcher] Failed to reload prompts for scope=" + scope.getValue(), e);
        }
    }

    private void notifyProvider(PromptScope scope, String provider) throws Exception {
        List<JsonObject> prompts = settingsService.getPrompts(scope, project, provider);
        String promptsJson = gson.toJson(prompts);
        if (onPromptsChanged != null) {
            onPromptsChanged.accept(scope, provider, promptsJson);
        }
        LOG.info("[PromptFileWatcher] Reloaded " + prompts.size()
                + " prompts for scope=" + scope.getValue() + ", provider=" + provider);
    }

    /**
     * Start watching for file changes.
     * Uses MessageBusConnection for automatic cleanup when project is disposed.
     */
    public void startWatching() {
        if (connection != null) {
            LOG.warn("[PromptFileWatcher] Already watching, skipping");
            return;
        }

        // Create connection tied to project lifecycle (auto-disposed on project close)
        connection = project.getMessageBus().connect();
        connection.subscribe(VirtualFileManager.VFS_CHANGES, this);

        LOG.info("[PromptFileWatcher] Started watching prompt files");
    }

    /**
     * Stop watching for file changes.
     * Call this method when you want to manually stop watching.
     * Note: Connection will be auto-disposed when project closes.
     */
    public void stopWatching() {
        if (connection != null) {
            connection.disconnect();
            connection = null;
            LOG.info("[PromptFileWatcher] Stopped watching prompt files");
        }
    }

    @FunctionalInterface
    public interface PromptChangeListener {
        void accept(PromptScope scope, String provider, String promptsJson);
    }
}
