package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Abstract base class for actions scoped to the Claude chat tool window.
 * Only enabled when the CCG tool window is active and focused.
 */
public abstract class ChatToolWindowAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(ChatToolWindowAction.class);
    private static final String TOOL_WINDOW_ID = "CCG";

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            e.getPresentation().setEnabled(false);
            return;
        }
        e.getPresentation().setEnabled(isChatToolWindowActive(project));
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) { return; }

        ClaudeChatWindow chatWindow = getActiveChatWindow(project);
        if (chatWindow == null) {
            LOG.warn("Chat window not found for project: " + project.getName());
            return;
        }

        performAction(e, project, chatWindow);
    }

    /**
     * Subclasses implement this to perform the actual action.
     */
    protected abstract void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow);

    /**
     * Check if the CCG tool window is currently active (focused).
     */
    private boolean isChatToolWindowActive(@NotNull Project project) {
        ToolWindowManager twm = ToolWindowManager.getInstance(project);
        ToolWindow toolWindow = twm.getToolWindow(TOOL_WINDOW_ID);
        return toolWindow != null && toolWindow.isActive();
    }

    /**
     * Get the active ClaudeChatWindow for the given project.
     */
    @Nullable
    protected ClaudeChatWindow getActiveChatWindow(@NotNull Project project) {
        ToolWindowManager twm = ToolWindowManager.getInstance(project);
        ToolWindow toolWindow = twm.getToolWindow(TOOL_WINDOW_ID);
        if (toolWindow != null) {
            Content selectedContent = toolWindow.getContentManager().getSelectedContent();
            if (selectedContent != null) {
                ClaudeChatWindow window = ClaudeSDKToolWindow.getChatWindowForContent(selectedContent);
                if (window != null) { return window; }
            }
        }
        // Fallback to legacy single-window lookup
        return ClaudeSDKToolWindow.getChatWindow(project);
    }
}
