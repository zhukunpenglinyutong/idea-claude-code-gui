package com.github.claudecodegui.action.tab;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.detached.DetachedChatFrame;
import com.github.claudecodegui.ui.detached.DetachedWindowManager;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;
import org.jetbrains.annotations.NotNull;

/**
 * Action to detach a tab from the CCG tool window and show it in a floating window.
 * Implements DumbAware interface to allow detaching during indexing.
 */
public class DetachTabAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(DetachTabAction.class);

    public DetachTabAction() {
        super(
                ClaudeCodeGuiBundle.message("action.detachTab.text"),
                ClaudeCodeGuiBundle.message("action.detachTab.description"),
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
            LOG.warn("[DetachTabAction] Project is null");
            return;
        }

        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            LOG.warn("[DetachTabAction] Tool window not found");
            return;
        }

        ContentManager contentManager = toolWindow.getContentManagerIfCreated();
        if (contentManager == null) {
            LOG.warn("[DetachTabAction] Tool window content manager is not created");
            return;
        }
        Content selectedContent = contentManager.getSelectedContent();
        if (selectedContent == null) {
            LOG.warn("[DetachTabAction] No tab selected");
            return;
        }

        // Get the ClaudeChatWindow associated with this content
        ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindowForContent(selectedContent);
        if (chatWindow == null) {
            LOG.warn("[DetachTabAction] Cannot find ClaudeChatWindow for content: " + selectedContent.getDisplayName());
            Messages.showErrorDialog(
                    project,
                    ClaudeCodeGuiBundle.message("action.detachTab.error.noChatWindow"),
                    ClaudeCodeGuiBundle.message("action.detachTab.error.title")
            );
            return;
        }

        // Check if already detached
        String sessionId = chatWindow.getSessionId();
        if (sessionId != null && DetachedWindowManager.isDetached(project, sessionId)) {
            LOG.warn("[DetachTabAction] Tab is already detached: " + selectedContent.getDisplayName());
            Messages.showInfoMessage(
                    project,
                    ClaudeCodeGuiBundle.message("action.detachTab.error.alreadyDetached"),
                    ClaudeCodeGuiBundle.message("action.detachTab.error.title")
            );
            return;
        }

        // Prevent detaching the last tab
        if (contentManager.getContentCount() <= 1) {
            LOG.warn("[DetachTabAction] Cannot detach the last tab");
            Messages.showWarningDialog(
                    project,
                    ClaudeCodeGuiBundle.message("action.detachTab.error.lastTab"),
                    ClaudeCodeGuiBundle.message("action.detachTab.error.title")
            );
            return;
        }

        // Perform the detach operation, passing chatWindow to avoid re-lookup race condition
        detachTab(project, contentManager, selectedContent, chatWindow);
    }

    /**
     * Detach a tab from the tool window.
     *
     * @param project        The project
     * @param contentManager The content manager
     * @param content        The content to detach
     * @param chatWindow     The chat window associated with the content (resolved in actionPerformed)
     */
    private void detachTab(@NotNull Project project,
                           @NotNull ContentManager contentManager,
                           @NotNull Content content,
                           @NotNull ClaudeChatWindow chatWindow) {
        ApplicationManager.getApplication().invokeLater(() -> {
            // Mark content as detaching to prevent contentRemoved listener
            // from disposing the ClaudeChatWindow or showing confirmation dialog.
            // Use try-finally to guarantee the flag is always cleared.
            ClaudeSDKToolWindow.markContentAsDetaching(content);
            try {
                // Verify content is still in the ContentManager (may have been removed between
                // actionPerformed and invokeLater execution)
                if (contentManager.getIndexOfContent(content) == -1) {
                    LOG.warn("[DetachTabAction] Content no longer in ContentManager, aborting detach");
                    return;
                }

                String tabName = content.getDisplayName();
                LOG.info("[DetachTabAction] Detaching tab: " + tabName);

                // Create the detached frame BEFORE removing content
                // This ensures the chatWindow.getContent() is still properly attached
                DetachedChatFrame detachedFrame = new DetachedChatFrame(project, content);

                // Remove content from ContentManager (but don't dispose it)
                // The detaching flag prevents the contentRemoved listener from
                // disposing the chat window or updating tab state
                contentManager.removeContent(content, false);

                // Clean up content mapping
                chatWindow.setParentContent(null);

                // Register the detached window
                String sessionId = chatWindow.getSessionId();
                DetachedWindowManager.registerDetached(project, sessionId, detachedFrame);

                // Show the detached window
                detachedFrame.setVisible(true);

                LOG.info("[DetachTabAction] Successfully detached tab: " + tabName);

            } catch (Exception ex) {
                LOG.error("[DetachTabAction] Error detaching tab", ex);
                Messages.showErrorDialog(
                        project,
                        ClaudeCodeGuiBundle.message("action.detachTab.error.failed") + ": " + ex.getMessage(),
                        ClaudeCodeGuiBundle.message("action.detachTab.error.title")
                );
            } finally {
                ClaudeSDKToolWindow.unmarkContentAsDetaching(content);
            }
        });
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

        // Enable only if there's a selected content and it's not the last tab
        boolean enabled = selectedContent != null && contentManager.getContentCount() > 1;
        e.getPresentation().setEnabledAndVisible(enabled);
    }
}
