package com.github.claudecodegui.action.editor;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.icon.PluginIconProvider;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

import java.util.concurrent.TimeUnit;

/**
 * Action to send file paths from the project tree to the CCG input box.
 * Shown in the project file tree context menu.
 * Implements DumbAware to allow usage during index building.
 */
public class SendFilePathToInputAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendFilePathToInputAction.class);

    /**
     * Constructor - sets localized action text and description.
     */
    public SendFilePathToInputAction() {
        super(
            ClaudeCodeGuiBundle.message("action.sendFilePath.text"),
            ClaudeCodeGuiBundle.message("action.sendFilePath.description"),
            null
        );
    }

    /**
     * Use background thread for action updates.
     * This allows safe access to VirtualFile data in the update() method.
     */
    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    /**
     * Main action execution logic.
     */
    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        // Get selected files
        VirtualFile[] files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY);
        if (files == null || files.length == 0) {
            VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);
            if (file != null) {
                files = new VirtualFile[]{file};
            }
        }

        if (files == null || files.length == 0) {
            LOG.warn("No files selected");
            return;
        }

        // Build file path string (supports multi-selection)
        StringBuilder pathBuilder = new StringBuilder();
        for (int i = 0; i < files.length; i++) {
            if (i > 0) {
                pathBuilder.append(" ");
            }
            // Add @ prefix with absolute path
            pathBuilder.append("@").append(files[i].getPath());
        }

        String filePaths = pathBuilder.toString();
        LOG.info("Sending file paths to input: " + filePaths);

        // Send to chat window
        sendToChatWindow(project, filePaths);
    }

    /**
     * Update action availability.
     * Only enabled when files are selected.
     */
    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setIcon(PluginIconProvider.getCurrentPluginIcon());

        Project project = e.getProject();
        if (project == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        // Check if any files are selected
        VirtualFile[] files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY);
        if (files == null || files.length == 0) {
            VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);
            if (file == null) {
                e.getPresentation().setEnabledAndVisible(false);
                return;
            }
        }

        e.getPresentation().setEnabledAndVisible(true);
    }

    /**
     * Send file paths to the plugin's chat input box.
     */
    private void sendToChatWindow(@NotNull Project project, @NotNull String filePaths) {
        try {
            // Get the plugin tool window
            ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
            ToolWindow toolWindow = toolWindowManager.getToolWindow("CCG");

            if (toolWindow != null) {
                // If window is not visible, activate it first, then send content after it opens
                if (!toolWindow.isVisible()) {
                    // Activate window
                    toolWindow.activate(() -> {
                        // After activation, delay briefly to ensure UI is loaded, then send content
                        AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
                            ApplicationManager.getApplication().invokeLater(() -> {
                                try {
                                    if (project.isDisposed()) { return; }
                                    ClaudeSDKToolWindow.addSelectionFromExternal(project, filePaths);
                                    LOG.info("Window activated and sent file paths to project: " + project.getName());
                                } catch (Exception ex) {
                                    LOG.warn("Failed to send file paths after activation: " + ex.getMessage(), ex);
                                }
                            });
                        }, 300, TimeUnit.MILLISECONDS);
                    }, true);
                } else {
                    // Window is already visible, send content directly
                    ClaudeSDKToolWindow.addSelectionFromExternal(project, filePaths);
                    // Ensure window gets focus
                    toolWindow.activate(null, true);
                    LOG.info("Chat window activated and sent file paths to project: " + project.getName());
                }
            } else {
                LOG.error("CCG tool window not found");
            }

        } catch (Exception ex) {
            LOG.error("Failed to send to chat window: " + ex.getMessage(), ex);
        }
    }
}
