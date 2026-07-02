package com.github.claudecodegui.action.tab;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.InputValidatorEx;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Action to rename the current tab in the CC GUI tool window.
 * Implements DumbAware interface to allow renaming during indexing.
 */
public class RenameTabAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(RenameTabAction.class);

    /**
     * Maximum length for tab names.
     * This limit ensures tab names display properly in the UI without truncation or layout issues.
     */
    private static final int MAX_TAB_NAME_LENGTH = 50;

    public RenameTabAction() {
        super(
            ClaudeCodeGuiBundle.message("action.renameTab.text"),
            ClaudeCodeGuiBundle.message("action.renameTab.description"),
            null
        );
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            LOG.warn("[RenameTabAction] Project is null");
            return;
        }

        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            LOG.warn("[RenameTabAction] Tool window not found");
            return;
        }

        ContentManager contentManager = toolWindow.getContentManagerIfCreated();
        if (contentManager == null) {
            LOG.warn("[RenameTabAction] Tool window content manager is not created");
            return;
        }
        Content selectedContent = contentManager.getSelectedContent();
        if (selectedContent == null) {
            LOG.warn("[RenameTabAction] No tab selected");
            return;
        }

        String currentName = selectedContent.getDisplayName();

        // Show input dialog with current name as default
        String newName = Messages.showInputDialog(
            project,
            ClaudeCodeGuiBundle.message("action.renameTab.dialogLabel"),
            ClaudeCodeGuiBundle.message("action.renameTab.dialogTitle"),
            null,
            currentName,
            new TabNameInputValidator()
        );

        // User cancelled or input is invalid
        if (newName == null) {
            return;
        }

        // Trim the input
        newName = newName.trim();

        // Update the tab name
        selectedContent.setDisplayName(newName);

        // Update originalTabName so status indicators won't revert to the old name
        ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindowForContent(selectedContent);
        if (chatWindow != null) {
            chatWindow.setOriginalTabName(newName);
        }

        // Get tab index and save to persistent storage
        int tabIndex = contentManager.getIndexOfContent(selectedContent);
        if (tabIndex >= 0) {
            TabStateService tabStateService = TabStateService.getInstance(project);
            tabStateService.saveTabName(tabIndex, newName);
        }

        LOG.info(String.format("[RenameTabAction] Renamed tab from '%s' to '%s'", currentName, newName));
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        // Avoid lazily creating tool window contents during action updates.
        ContentManager contentManager = toolWindow.getContentManagerIfCreated();
        if (contentManager == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        Content selectedContent = contentManager.getSelectedContent();
        e.getPresentation().setEnabledAndVisible(selectedContent != null);
    }

    /**
     * Input validator for tab name.
     * Validates that the name is not empty and does not exceed maximum length.
     * Provides detailed error messages for invalid input.
     */
    private static class TabNameInputValidator implements InputValidatorEx {
        @Override
        public boolean checkInput(@Nullable String inputString) {
            if (inputString == null) {
                return false;
            }
            String trimmed = inputString.trim();
            return !trimmed.isEmpty() && trimmed.length() <= MAX_TAB_NAME_LENGTH;
        }

        @Override
        public boolean canClose(@Nullable String inputString) {
            return checkInput(inputString);
        }

        @Override
        public @Nullable String getErrorText(@Nullable String inputString) {
            if (inputString == null || inputString.trim().isEmpty()) {
                return ClaudeCodeGuiBundle.message("action.renameTab.error.empty");
            }
            if (inputString.trim().length() > MAX_TAB_NAME_LENGTH) {
                return ClaudeCodeGuiBundle.message("action.renameTab.error.tooLong");
            }
            return null;
        }
    }
}
