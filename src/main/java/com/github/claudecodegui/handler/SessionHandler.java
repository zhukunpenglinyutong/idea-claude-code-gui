package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.session.SessionState;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Session management message handler.
 * Handles sending messages, interrupting, restarting, and creating new sessions.
 */
public class SessionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(SessionHandler.class);

    private static final String[] SUPPORTED_TYPES = {
            "send_message",
            "send_message_with_attachments",
            "interrupt_session",
            "restart_session"
            // Note: create_new_session should not be handled here; it should be handled by ClaudeSDKToolWindow.createNewSession()
    };

    public SessionHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "send_message":
                LOG.debug("[SessionHandler] 处理: send_message");
                handleSendMessage(content);
                return true;
            case "send_message_with_attachments":
                LOG.debug("[SessionHandler] 处理: send_message_with_attachments");
                handleSendMessageWithAttachments(content);
                return true;
            case "interrupt_session":
                LOG.debug("[SessionHandler] 处理: interrupt_session");
                handleInterruptSession();
                return true;
            case "restart_session":
                LOG.debug("[SessionHandler] 处理: restart_session");
                handleRestartSession();
                return true;
            default:
                return false;
        }
    }

    /**
     * Resolves the cached Node.js version, attempting recovery when the cache is stale.
     * If the version is absent but a cached path exists, re-verifies the path to restore
     * the detection result (e.g. after a new window resets the cache via setNodeExecutable).
     *
     * @return the Node.js version string, or null if detection fails entirely
     */
    private String resolveNodeVersion() {
        String nodeVersion = context.getClaudeSDKBridge().getCachedNodeVersion();
        if (nodeVersion != null) {
            return nodeVersion;
        }
        // Version absent — try to recover using the cached path (path may still be valid).
        String cachedPath = context.getClaudeSDKBridge().getCachedNodePath();
        if (cachedPath == null || cachedPath.isEmpty()) {
            return null;
        }
        LOG.info("[SessionHandler] Node version cache miss, re-verifying path: " + cachedPath);
        NodeDetectionResult recovery = context.getClaudeSDKBridge().verifyAndCacheNodePath(cachedPath);
        if (recovery != null && recovery.isFound()) {
            return recovery.getNodeVersion();
        }
        return null;
    }

    /**
     * Validates the Node.js version and reports failures to the webview. Must
     * run on a pooled thread: the cache-miss recovery in resolveNodeVersion
     * spawns probe processes with up to 5s waits, and message dispatch enters
     * this handler synchronously on the JCEF UI thread — an inline call would
     * freeze the webview on the first send after a cache reset.
     */
    private boolean ensureNodeVersionReady() {
        String nodeVersion = resolveNodeVersion();
        if (nodeVersion == null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("addErrorMessage", escapeJs("未检测到有效的 Node.js 版本，请在设置中配置或重新打开工具窗口。"));
            });
            return false;
        }
        if (!NodeDetector.isVersionSupported(nodeVersion)) {
            int minVersion = NodeDetector.MIN_NODE_MAJOR_VERSION;
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("addErrorMessage", escapeJs(
                        "Node.js 版本过低 (" + nodeVersion + ")，插件需要 v" + minVersion + " 或更高版本才能正常运行。请在设置中配置正确的 Node.js 路径。"));
            });
            return false;
        }
        return true;
    }

    /**
     * Send message to Claude
     * [FIX] Now parses JSON format to extract text, agent info and file tags
     */
    private void handleSendMessage(String content) {

        // [FIX] Parse JSON format to extract text, agent info and file tags
        String prompt;
        String agentPrompt = null;
        java.util.List<String> fileTagPaths = null;
        String requestedPermissionMode = null;
        String requestedReasoningEffort = null;
        String requestedCodexFastMode = null;
        String requestedDshPreset = null;
        try {
            Gson gson = new Gson();
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            prompt = payload != null && payload.has("text") && !payload.get("text").isJsonNull()
                             ? payload.get("text").getAsString()
                             : content; // Fallback to raw content if not JSON

            // Extract agent prompt from the message
            if (payload != null && payload.has("agent") && !payload.get("agent").isJsonNull()) {
                JsonObject agent = payload.getAsJsonObject("agent");
                if (agent.has("prompt") && !agent.get("prompt").isJsonNull()) {
                    agentPrompt = agent.get("prompt").getAsString();
                    String agentName = agent.has("name") ? agent.get("name").getAsString() : "Unknown";
                    LOG.info("[SessionHandler] Using agent from message: " + agentName);
                }
            }

            // [FIX] Extract file tags from the message (for Codex context injection)
            if (payload != null && payload.has("fileTags") && payload.get("fileTags").isJsonArray()) {
                JsonArray fileTagsArray = payload.getAsJsonArray("fileTags");
                fileTagPaths = new java.util.ArrayList<>();
                for (int i = 0; i < fileTagsArray.size(); i++) {
                    JsonObject fileTag = fileTagsArray.get(i).getAsJsonObject();
                    if (fileTag.has("absolutePath") && !fileTag.get("absolutePath").isJsonNull()) {
                        fileTagPaths.add(fileTag.get("absolutePath").getAsString());
                    }
                }
                if (!fileTagPaths.isEmpty()) {
                    LOG.info("[SessionHandler] Extracted " + fileTagPaths.size() + " file tags for context injection");
                }
            }

            // Extract requested permission mode from payload (optional, backward compatible)
            if (payload != null && payload.has("permissionMode") && !payload.get("permissionMode").isJsonNull()) {
                String mode = payload.get("permissionMode").getAsString();
                if (SessionState.isValidPermissionMode(mode)) {
                    requestedPermissionMode = mode;
                } else {
                    LOG.warn("[SessionHandler] Ignoring invalid permissionMode from payload: " + mode);
                }
            }

            requestedReasoningEffort = extractReasoningEffort(payload);

            if (payload != null && payload.has("codexFastMode") && !payload.get("codexFastMode").isJsonNull()) {
                requestedCodexFastMode = payload.get("codexFastMode").getAsString();
            }
            requestedDshPreset = extractDshPreset(payload);
        } catch (Exception e) {
            // If parsing fails, treat content as plain text (backward compatibility)
            LOG.debug("[SessionHandler] Message is plain text, not JSON: " + e.getMessage());
            prompt = content;
        }

        final String finalPrompt = prompt;
        final String finalAgentPrompt = agentPrompt;
        final java.util.List<String> finalFileTagPaths = fileTagPaths;
        final String finalRequestedPermissionMode = requestedPermissionMode;
        final String finalRequestedReasoningEffort = requestedReasoningEffort;
        final String finalRequestedCodexFastMode = requestedCodexFastMode;
        final String finalRequestedDshPreset = requestedDshPreset;

        CompletableFuture.runAsync(() -> {
            if (!ensureNodeVersionReady()) {
                return;
            }
            String currentWorkingDir = determineWorkingDirectory();
            String previousCwd = context.getSession().getCwd();

            if (!currentWorkingDir.equals(previousCwd)) {
                context.getSession().setCwd(currentWorkingDir);
                LOG.info("[SessionHandler] Updated working directory: " + currentWorkingDir);
            }

            // Capture project for use in async callbacks
            var project = context.getProject();
            if (project != null) {
                ClaudeNotifier.setWaiting(project);
            }

            // [FIX] Pass agent prompt and file tags directly to session
            context.getSession().send(finalPrompt, finalAgentPrompt, finalFileTagPaths,
                            finalRequestedPermissionMode, finalRequestedReasoningEffort,
                            finalRequestedCodexFastMode, finalRequestedDshPreset)
                .thenRun(() -> {
                    // Claude now triggers success on actual stream_end callback.
                    // Codex has no stream_end event, keep success trigger at completion.
                    var session = context.getSession();
                    if (project != null
                            && "codex".equals(session.getProvider())
                            && !session.isManuallyInterrupted()) {
                        ClaudeNotifier.showSuccess(
                            project,
                            ClaudeNotifier.buildTitleFromSession(session),
                            ClaudeNotifier.buildPreviewFromSession(session, "Task completed"));
                    }
                })
                .exceptionally(ex -> {
                    LOG.error("Failed to send message", ex);
                    if (project != null) {
                        ClaudeNotifier.showError(project, "Task failed: " + ex.getMessage());
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("发送失败: " + ex.getMessage()));
                    });
                    return null;
                    });
        });
    }

    /**
     * Send message with attachments.
     * [FIX] Now extracts agent info and file tags from payload.
     */
    private void handleSendMessageWithAttachments(String content) {
        try {
            Gson gson = new Gson();
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            String text = payload != null && payload.has("text") && !payload.get("text").isJsonNull()
                                  ? payload.get("text").getAsString()
                                  : "";

            java.util.List<ClaudeSession.Attachment> atts = new java.util.ArrayList<>();
            if (payload != null && payload.has("attachments") && payload.get("attachments").isJsonArray()) {
                JsonArray arr = payload.getAsJsonArray("attachments");
                for (int i = 0; i < arr.size(); i++) {
                    JsonObject a = arr.get(i).getAsJsonObject();
                    String fileName = a.has("fileName") && !a.get("fileName").isJsonNull()
                                              ? a.get("fileName").getAsString()
                                              : ("attachment-" + System.currentTimeMillis());
                    String mediaType = a.has("mediaType") && !a.get("mediaType").isJsonNull()
                                               ? a.get("mediaType").getAsString()
                                               : "application/octet-stream";
                    String data = a.has("data") && !a.get("data").isJsonNull()
                                          ? a.get("data").getAsString()
                                          : "";
                    atts.add(new ClaudeSession.Attachment(fileName, mediaType, data));
                }
            }

            // [FIX] Extract agent prompt from the payload for per-tab agent selection
            String agentPrompt = null;
            String requestedPermissionMode = null;
            String requestedReasoningEffort = null;
            String requestedCodexFastMode = null;
            String requestedDshPreset = null;
            if (payload != null && payload.has("agent") && !payload.get("agent").isJsonNull()) {
                JsonObject agent = payload.getAsJsonObject("agent");
                if (agent.has("prompt") && !agent.get("prompt").isJsonNull()) {
                    agentPrompt = agent.get("prompt").getAsString();
                    String agentName = agent.has("name") ? agent.get("name").getAsString() : "Unknown";
                    LOG.info("[SessionHandler] Using agent from attachment message: " + agentName);
                }
            }

            // [FIX] Extract file tags from the payload (for Codex context injection)
            java.util.List<String> fileTagPaths = null;
            if (payload != null && payload.has("fileTags") && payload.get("fileTags").isJsonArray()) {
                JsonArray fileTagsArray = payload.getAsJsonArray("fileTags");
                fileTagPaths = new java.util.ArrayList<>();
                for (int i = 0; i < fileTagsArray.size(); i++) {
                    JsonObject fileTag = fileTagsArray.get(i).getAsJsonObject();
                    if (fileTag.has("absolutePath") && !fileTag.get("absolutePath").isJsonNull()) {
                        fileTagPaths.add(fileTag.get("absolutePath").getAsString());
                    }
                }
                if (!fileTagPaths.isEmpty()) {
                    LOG.info("[SessionHandler] Extracted " + fileTagPaths.size() + " file tags for attachment message");
                }
            }

            if (payload != null && payload.has("permissionMode") && !payload.get("permissionMode").isJsonNull()) {
                String mode = payload.get("permissionMode").getAsString();
                if (SessionState.isValidPermissionMode(mode)) {
                    requestedPermissionMode = mode;
                } else {
                    LOG.warn("[SessionHandler] Ignoring invalid permissionMode from attachment payload: " + mode);
                }
            }

            requestedReasoningEffort = extractReasoningEffort(payload);

            if (payload != null && payload.has("codexFastMode") && !payload.get("codexFastMode").isJsonNull()) {
                requestedCodexFastMode = payload.get("codexFastMode").getAsString();
            }
            requestedDshPreset = extractDshPreset(payload);

            sendMessageWithAttachments(text, atts, agentPrompt, fileTagPaths, requestedPermissionMode,
                    requestedReasoningEffort, requestedCodexFastMode, requestedDshPreset);
        } catch (Exception e) {
            LOG.error("[SessionHandler] 解析附件负载失败: " + e.getMessage(), e);
            handleSendMessage(content);
        }
    }

    /**
     * Send message with attachments to Claude
     * [FIX] Now accepts agent prompt and file tags parameters
     */
    private void sendMessageWithAttachments(
        String prompt,
        List<ClaudeSession.Attachment> attachments,
        String agentPrompt,
        java.util.List<String> fileTagPaths,
        String requestedPermissionMode,
        String requestedReasoningEffort,
        String requestedCodexFastMode,
        String requestedDshPreset
    ) {
        // Version check (consistent with handleSendMessage) — runs inside the
        // async block below; see ensureNodeVersionReady for why it must not
        // block the JCEF UI thread.
        final String finalAgentPrompt = agentPrompt;
        final java.util.List<String> finalFileTagPaths = fileTagPaths;
        final String finalRequestedPermissionMode = requestedPermissionMode;
        final String finalRequestedReasoningEffort = requestedReasoningEffort;
        final String finalRequestedCodexFastMode = requestedCodexFastMode;
        final String finalRequestedDshPreset = requestedDshPreset;

        CompletableFuture.runAsync(() -> {
            if (!ensureNodeVersionReady()) {
                return;
            }
            String currentWorkingDir = determineWorkingDirectory();
            String previousCwd = context.getSession().getCwd();
            if (!currentWorkingDir.equals(previousCwd)) {
                context.getSession().setCwd(currentWorkingDir);
                LOG.info("[SessionHandler] Updated working directory: " + currentWorkingDir);
            }

            // Capture project for use in async callbacks
            var project = context.getProject();
            if (project != null) {
                ClaudeNotifier.setWaiting(project);
            }

            // [FIX] Pass agent prompt and file tags directly to session
            context.getSession().send(prompt, attachments, finalAgentPrompt, finalFileTagPaths,
                            finalRequestedPermissionMode, finalRequestedReasoningEffort,
                            finalRequestedCodexFastMode, finalRequestedDshPreset)
                .thenRun(() -> {
                    // Claude now triggers success on actual stream_end callback.
                    // Codex has no stream_end event, keep success trigger at completion.
                    var session = context.getSession();
                    if (project != null
                            && "codex".equals(session.getProvider())
                            && !session.isManuallyInterrupted()) {
                        ClaudeNotifier.showSuccess(
                            project,
                            ClaudeNotifier.buildTitleFromSession(session),
                            ClaudeNotifier.buildPreviewFromSession(session, "Task completed"));
                    }
                })
                .exceptionally(ex -> {
                    LOG.error("Failed to send message with attachments", ex);
                    if (project != null) {
                        ClaudeNotifier.showError(project, "Task failed: " + ex.getMessage());
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("addErrorMessage", escapeJs("发送失败: " + ex.getMessage()));
                    });
                    return null;
                    });
        });
    }

    /**
     * Interrupt the current session.
     */
    private void handleInterruptSession() {
        context.getSession().interrupt().thenRun(() -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                // [FIX] Notify frontend that stream has ended and reset loading state
                // This ensures streamActive flag is reset and loading=false takes effect
                context.callJavaScript("onStreamEnd");
                context.callJavaScript("showLoading", "false");
            });
        });
    }

    /**
     * Restart the session.
     */
    private void handleRestartSession() {
        context.getSession().restart().thenRun(() -> {
            ApplicationManager.getApplication().invokeLater(() -> {});
        });
    }

    /**
     * Determine the appropriate working directory.
     */
    private String determineWorkingDirectory() {
        String projectPath = context.getProject().getBasePath();

        // Prefer the user-configured working directory first, normalized so that
        // relative segments (e.g. "..") are collapsed. This must match the directory
        // history is stored under (see WorkingDirectoryManager#resolveEffectiveWorkingDirectory).
        if (projectPath != null && new File(projectPath).exists()) {
            try {
                com.github.claudecodegui.settings.CodemossSettingsService settingsService =
                        new com.github.claudecodegui.settings.CodemossSettingsService();
                String resolvedPath = settingsService.getEffectiveWorkingDirectory(projectPath);
                if (resolvedPath != null && !resolvedPath.isEmpty()) {
                    LOG.info("[SessionHandler] Using working directory: " + resolvedPath);
                    return resolvedPath;
                }
            } catch (Exception e) {
                LOG.warn("[SessionHandler] Failed to resolve working directory: " + e.getMessage());
            }
        }

        // When projectPath is invalid (null or missing), try the active file's
        // parent directory first — typical case: single-file temporary project
        // (projectPath in /tmp) while the actual file is under the user's home.
        if (projectPath == null || !new File(projectPath).exists()) {
            String activeFileDir = resolveWorkingDirectoryFromActiveFile(projectPath);
            if (activeFileDir != null && !activeFileDir.isEmpty()) {
                return activeFileDir;
            }
            String userHome = NodeDetector.resolveHomeForFileOps();
            LOG.warn("[SessionHandler] Using user home directory as fallback: " + userHome);
            return userHome;
        }

        // Use project root as the default working directory.
        return projectPath;
    }

    private String extractReasoningEffort(JsonObject payload) {
        if (payload == null || !payload.has("reasoningEffort") || payload.get("reasoningEffort").isJsonNull()) {
            return null;
        }
        return payload.get("reasoningEffort").getAsString();
    }

    private String extractDshPreset(JsonObject payload) {
        if (payload == null || !payload.has("dshPreset") || payload.get("dshPreset").isJsonNull()) {
            return null;
        }
        String preset = payload.get("dshPreset").getAsString();
        return SessionState.isValidDshPreset(preset) ? preset.trim() : null;
    }

    /**
     * Tries to infer a working directory from the currently active file.
     * Returns the parent directory only when the file is outside project root;
     * otherwise returns null.
     */
    private String resolveWorkingDirectoryFromActiveFile(String projectPath) {
        try {
            VirtualFile[] selectedFiles = ApplicationManager.getApplication().runReadAction(
                    (com.intellij.openapi.util.Computable<VirtualFile[]>) () ->
                            FileEditorManager.getInstance(context.getProject()).getSelectedFiles()
            );
            if (selectedFiles == null || selectedFiles.length == 0) {
                return null;
            }

            for (VirtualFile selectedFile : selectedFiles) {
                if (selectedFile == null || !selectedFile.isInLocalFileSystem()) {
                    continue;
                }

                String selectedPath = selectedFile.getPath();
                if (selectedPath == null || selectedPath.isEmpty()) {
                    continue;
                }

                File localFile = new File(selectedPath);
                if (!localFile.exists()) {
                    continue;
                }

                String filePath = localFile.getAbsolutePath();
                String candidateDir = localFile.isDirectory()
                        ? filePath
                        : localFile.getParent();
                if (candidateDir == null || candidateDir.isEmpty()) {
                    continue;
                }

                if (projectPath != null && !projectPath.isEmpty() && isPathWithin(filePath, projectPath)) {
                    continue;
                }

                LOG.info("[SessionHandler] Active file is outside project root, using its parent as working directory: "
                        + candidateDir + " (activeFile=" + filePath + ", projectPath=" + projectPath + ")");
                return candidateDir;
            }
        } catch (Exception e) {
            LOG.debug("[SessionHandler] Failed to resolve working directory from active file: " + e.getMessage());
        }

        return null;
    }

    /**
     * Checks whether childPath is inside basePath (including equality).
     */
    private boolean isPathWithin(String childPath, String basePath) {
        if (childPath == null || basePath == null) {
            return false;
        }

        try {
            Path child = Paths.get(childPath).toAbsolutePath().normalize();
            Path base = Paths.get(basePath).toAbsolutePath().normalize();
            return child.startsWith(base);
        } catch (Exception ignored) {
            return childPath.startsWith(basePath);
        }
    }
}
