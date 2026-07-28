package com.github.claudecodegui.action.tab;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import org.jetbrains.annotations.NotNull;


/**
 * Action to create a new chat tab in the CC GUI tool window
 */
public class CreateNewTabAction extends AnAction {

    private static final Logger LOG = Logger.getInstance(CreateNewTabAction.class);

    public CreateNewTabAction() {
        super(
            ClaudeCodeGuiBundle.message("action.createNewTab.text"),
            ClaudeCodeGuiBundle.message("action.createNewTab.description"),
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
            LOG.error("[CreateNewTabAction] Project is null");
            return;
        }

        ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
        if (toolWindow == null) {
            LOG.error("[CreateNewTabAction] Tool window not found");
            return;
        }

        ContentManager contentManager = toolWindow.getContentManager();
        Content selectedContent = contentManager.getSelectedContent();
        ClaudeChatWindow sourceWindow = selectedContent == null
                ? null
                : ClaudeSDKToolWindow.getChatWindowForContent(selectedContent);
        if (sourceWindow == null) {
            sourceWindow = ClaudeSDKToolWindow.getChatWindow(project);
        }

        // Create a new chat window instance with skipRegister=true (don't replace the main instance)
        ClaudeChatWindow newChatWindow = new ClaudeChatWindow(project, true);
        newChatWindow.inheritSessionPreferencesFrom(sourceWindow);

        // Create a tab name in the format "AIN"
        String tabName = ClaudeSDKToolWindow.getNextTabName(toolWindow);

        // Create and add the new tab content
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(newChatWindow.getContent(), tabName, false);
        content.setCloseable(true);
        content.setDisposer(newChatWindow::dispose);

        contentManager.addContent(content);
        newChatWindow.setParentContent(content);
        contentManager.setSelectedContent(content);

        // Ensure the tool window is visible
        toolWindow.show(null);

        LOG.info("[CreateNewTabAction] Created new tab: " + tabName);
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        // Only enable this action when there's a valid project
        e.getPresentation().setEnabled(e.getProject() != null);
    }
}
