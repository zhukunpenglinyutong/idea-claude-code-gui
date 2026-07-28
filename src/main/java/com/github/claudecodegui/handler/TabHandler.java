package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.github.claudecodegui.settings.TabStateService;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;


/**
 * Tab management handler
 * Handles creating new chat tabs in the tool window
 */
public class TabHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(TabHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "create_new_tab"
    };

    public TabHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("create_new_tab".equals(type)) {
            LOG.debug("[TabHandler] Processing create_new_tab");
            handleCreateNewTab();
            return true;
        }
        return false;
    }

    /**
     * Create a new chat tab in the tool window
     */
    private void handleCreateNewTab() {
        Project project = context.getProject();

        ToolWindowManager.getInstance(project).invokeLater(() -> {
            try {
                // Get the tool window
                ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                        .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
                if (toolWindow == null) {
                    LOG.error("[TabHandler] Tool window not found");
                    callJavaScript("addErrorMessage", escapeJs("无法找到 CCG 工具窗口"));
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

                // Get tab index before adding content
                int tabIndex = contentManager.getContentCount();

                // Check if there's a saved name for this tab index
                TabStateService tabStateService = TabStateService.getInstance(project);
                String savedName = tabStateService.getTabName(tabIndex);

                // Create a tab name: use saved name or generate new one
                String tabName;
                if (savedName != null && !savedName.isEmpty()) {
                    tabName = savedName;
                    LOG.info("[TabHandler] Restored tab name from storage: " + tabName);
                } else {
                    tabName = ClaudeSDKToolWindow.getNextTabName(toolWindow);
                }

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

                LOG.info("[TabHandler] Created new tab: " + tabName);
            } catch (Exception e) {
                LOG.error("[TabHandler] Error creating new tab: " + e.getMessage(), e);
                callJavaScript("addErrorMessage", escapeJs("创建新标签页失败: " + e.getMessage()));
            }
        });
    }
}
