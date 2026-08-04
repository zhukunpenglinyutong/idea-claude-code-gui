package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.TokenUsageUtils;
import com.github.claudecodegui.util.IgnoreRuleMatcher;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.List;

/**
 * Handles usage statistics push and context bar refresh operations.
 */
public class UsagePushService {

    private static final Logger LOG = Logger.getInstance(UsagePushService.class);

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public UsagePushService(HandlerContext context) {
        this.context = context;
    }

    /**
     * Push usage update after model switch.
     * Recalculates percentage and maxTokens based on the new model's context limit.
     */
    public void pushUsageUpdateAfterModelChange(int newMaxTokens) {
        try {
            ClaudeSession session = context.getSession();
            if (session == null) {
                clearUsageDisplay();
                return;
            }

            // Extract the latest usage information from the current session
            List<ClaudeSession.Message> messages = session.getMessages();
            JsonObject lastUsage = TokenUsageUtils.findLastUsageFromSessionMessages(messages);
            if (lastUsage == null) {
                // The provider has not reported a real context snapshot yet. Avoid
                // presenting a static model limit as authoritative session capacity.
                clearUsageDisplay();
                return;
            }
            int usedTokens = TokenUsageUtils.extractUsedTokens(lastUsage, session.getProvider());

            // Send update
            sendUsageUpdate(usedTokens, newMaxTokens);

        } catch (Exception e) {
            LOG.error("[UsagePushService] Failed to push usage update after model change: " + e.getMessage(), e);
        }
    }

    /**
     * Push the usage already retained by the active session during WebView recovery.
     * An empty session is intentionally left untouched: its history may still be
     * loading, and publishing zero with a static limit would overwrite valid UI state.
     *
     * @param fallbackMaxTokens static model limit used only when provider usage does
     *                          not contain a session-specific context window
     * @return true when a usage snapshot was available and scheduled for delivery
     */
    public boolean pushCurrentUsageIfAvailable(int fallbackMaxTokens) {
        try {
            ClaudeSession session = context.getSession();
            if (session == null) {
                return false;
            }

            JsonObject lastUsage = TokenUsageUtils.findLastUsageFromSessionMessages(session.getMessages());
            if (lastUsage == null) {
                return false;
            }

            int usedTokens = TokenUsageUtils.extractUsedTokens(lastUsage, session.getProvider());
            int maxTokens = TokenUsageUtils.extractMaxTokens(lastUsage, fallbackMaxTokens);
            sendUsageUpdate(usedTokens, maxTokens);
            return true;
        } catch (Exception e) {
            LOG.error("[UsagePushService] Failed to restore current usage: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Send usage update to the frontend.
     */
    public void sendUsageUpdate(int usedTokens, int maxTokens) {
        int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

        LOG.info("[UsagePushService] Sending usage update: usedTokens=" + usedTokens + ", maxTokens=" + maxTokens + ", percentage=" + percentage + "%");

        // Build usage update data
        JsonObject usageUpdate = new JsonObject();
        usageUpdate.addProperty("percentage", percentage);
        usageUpdate.addProperty("totalTokens", usedTokens);
        usageUpdate.addProperty("limit", maxTokens);
        usageUpdate.addProperty("usedTokens", usedTokens);
        usageUpdate.addProperty("maxTokens", maxTokens);

        sendUsagePayload(usageUpdate);
    }

    /**
     * Clear provider-specific usage details while the next provider snapshot is
     * unknown. Only percentage is sent so the frontend also clears its tooltip
     * numerator and denominator.
     */
    public void clearUsageDisplay() {
        JsonObject usageUpdate = new JsonObject();
        usageUpdate.addProperty("percentage", 0);
        sendUsagePayload(usageUpdate);
    }

    private void sendUsagePayload(JsonObject usageUpdate) {
        String usageJson = gson.toJson(usageUpdate);

        // Push to frontend (must be executed on the EDT thread)
        ApplicationManager.getApplication().invokeLater(() -> {
            if (context.getBrowser() != null && !context.isDisposed()) {
                String js = "(function() {" +
                        "  if (typeof window.onUsageUpdate === 'function') {" +
                        "    window.onUsageUpdate('" + context.escapeJs(usageJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } else {
                LOG.warn("[UsagePushService] Cannot send usage update: browser is null or disposed");
            }
        });
    }

    /**
     * Refresh the context bar with the currently open editor file.
     */
    public void refreshContextBar() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getProject() == null) {
                    return;
                }

                // Check if auto-open file is enabled
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    CodemossSettingsService settingsService = new CodemossSettingsService();
                    boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                    if (!autoOpenFileEnabled) {
                        // If auto-open file is disabled, clear the ContextBar display
                        context.callJavaScript("clearSelectionInfo");
                        return;
                    }
                }

                // Get cached .gitignore matcher for filtering sensitive files
                IgnoreRuleMatcher gitIgnoreMatcher = IgnoreRuleMatcher.forProjectSafe(projectPath);

                FileEditorManager editorManager = FileEditorManager.getInstance(context.getProject());
                Editor editor = editorManager.getSelectedTextEditor();
                String selectionInfo = null;

                if (editor != null) {
                    VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
                    if (file != null) {
                        String path = file.getPath();

                        // Filter out .gitignore'd files to prevent sensitive files from being auto-opened
                        if (gitIgnoreMatcher != null && gitIgnoreMatcher.isFileIgnored(path)) {
                            context.callJavaScript("clearSelectionInfo");
                            return;
                        }

                        selectionInfo = "@" + path;

                        SelectionModel selectionModel = editor.getSelectionModel();
                        if (selectionModel.hasSelection()) {
                            int startLine = editor.getDocument().getLineNumber(selectionModel.getSelectionStart()) + 1;
                            int endLine = editor.getDocument().getLineNumber(selectionModel.getSelectionEnd()) + 1;

                            if (endLine > startLine
                                    && editor.offsetToLogicalPosition(selectionModel.getSelectionEnd()).column == 0) {
                                endLine--;
                            }
                            selectionInfo += "#L" + startLine + "-" + endLine;
                        }
                    }
                } else {
                    VirtualFile[] files = editorManager.getSelectedFiles();
                    if (files.length > 0 && files[0] != null) {
                        String path = files[0].getPath();

                        // Filter out .gitignore'd files
                        if (gitIgnoreMatcher != null && gitIgnoreMatcher.isFileIgnored(path)) {
                            context.callJavaScript("clearSelectionInfo");
                            return;
                        }

                        selectionInfo = "@" + path;
                    }
                }

                if (selectionInfo != null && !selectionInfo.isEmpty()) {
                    context.callJavaScript("addSelectionInfo", context.escapeJs(selectionInfo));
                } else {
                    context.callJavaScript("clearSelectionInfo");
                }
            } catch (Exception e) {
                LOG.warn("[UsagePushService] Failed to refresh context bar: " + e.getMessage());
            }
        });
    }
}
