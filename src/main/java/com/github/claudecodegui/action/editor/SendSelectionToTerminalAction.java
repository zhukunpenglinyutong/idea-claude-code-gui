package com.github.claudecodegui.action.editor;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.icon.PluginIconProvider;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Action that sends selected code to the plugin chat window.
 * Supports cross-platform shortcuts: Mac (Cmd+Option+K) and Windows/Linux (Ctrl+Alt+K).
 * Implements DumbAware to allow usage during index building.
 */
public class SendSelectionToTerminalAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendSelectionToTerminalAction.class);

    private final SelectionReferenceBuilder selectionReferenceBuilder;

    /**
     * Constructor - sets up localized action text and description.
     */
    public SendSelectionToTerminalAction() {
        this(new SelectionReferenceBuilder());
    }

    SendSelectionToTerminalAction(@NotNull SelectionReferenceBuilder selectionReferenceBuilder) {
        super(
            ClaudeCodeGuiBundle.message("action.sendToGui.text"),
            ClaudeCodeGuiBundle.message("action.sendToGui.description"),
            null
        );
        this.selectionReferenceBuilder = selectionReferenceBuilder;
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    /**
     * Main logic for executing the action.
     * With selection: sends selected code and opens the panel.
     * Without selection: just opens the CCG panel.
     */
    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        Editor editor = e.getData(CommonDataKeys.EDITOR);
        if (editor == null) {
            return;
        }

        String selectedText = editor.getSelectionModel().getSelectedText();
        if (selectedText == null || selectedText.isEmpty()) {
            // No selection — just open the panel
            activateToolWindow(project);
            return;
        }

        try {
            // Use ReadAction.nonBlocking() to safely retrieve file information on a background thread
            ReadAction
                .nonBlocking(() -> {
                    return buildSelectionReference(e);
                })
                .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), selectionInfo -> {
                    if (!selectionInfo.isSuccess()) {
                        SelectionReferenceFailureHandler.showBuildFailure(
                                selectionInfo,
                                message -> showInfo(project, message),
                                message -> showError(project, message)
                        );
                        return;
                    }

                    // Send to the plugin chat window (executed on the UI thread)
                    sendToChatWindow(project, selectionInfo.getReference());
                    LOG.info("已添加到待发送: " + selectionInfo.getReference());
                })
                .submit(AppExecutorUtil.getAppExecutorService());

        } catch (Exception ex) {
            showError(project, ClaudeCodeGuiBundle.message("send.failed", ex.getMessage()));
            LOG.error("Error: " + ex.getMessage(), ex);
        }
    }

    /**
     * Updates the action's availability state.
     * Always enabled when an editor is active.
     * With selection: sends selected code and opens the panel.
     * Without selection: just opens the CCG panel.
     */
    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setIcon(PluginIconProvider.getCurrentPluginIcon());

        Project project = e.getProject();
        if (project == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        Editor editor = e.getData(CommonDataKeys.EDITOR);

        // Always enable when an editor is active, regardless of selection
        e.getPresentation().setEnabledAndVisible(editor != null);
    }

    /**
     * Retrieves selected code information and formats it into the specified format.
     */
    private @NotNull SelectionReferenceBuilder.Result buildSelectionReference(@NotNull AnActionEvent e) {
        Editor editor = e.getData(CommonDataKeys.EDITOR);
        VirtualFile virtualFile = e.getData(CommonDataKeys.VIRTUAL_FILE);
        return selectionReferenceBuilder.build(editor, virtualFile);
    }

    /**
     * Sends the selection information to the plugin chat window.
     */
    private void sendToChatWindow(@NotNull Project project, @NotNull String text) {
        try {
            // Get the plugin tool window
            ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
            ToolWindow toolWindow = toolWindowManager.getToolWindow("CCG");

            if (toolWindow != null) {
                // If the window is not visible, activate it first and wait for it to open before sending content
                if (!toolWindow.isVisible()) {
                    // Activate the window
                    toolWindow.activate(() -> {
                        // After window activation, add a short delay to ensure the UI is fully loaded, then send content
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                Thread.sleep(300); // Wait 300ms to ensure the UI is fully loaded
                                ClaudeSDKToolWindow.addSelectionFromExternal(project, text);
                                LOG.info("窗口已激活并发送内容到项目: " + project.getName());
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                        });
                    }, true);
                } else {
                    // Window is already open, send content directly
                    ClaudeSDKToolWindow.addSelectionFromExternal(project, text);
                    // Ensure the window gains focus
                    toolWindow.activate(null, true);
                    LOG.info("聊天窗口已激活并发送内容到项目: " + project.getName());
                }
            } else {
                showError(project, ClaudeCodeGuiBundle.message("send.toolWindowNotFound"));
            }

        } catch (Exception ex) {
            showError(project, ClaudeCodeGuiBundle.message("send.sendToChatFailed", ex.getMessage()));
            LOG.error("Error occurred", ex);
        }
    }

    /**
     * Displays an error message.
     */
    private void showError(@Nullable Project project, @NotNull String message) {
        LOG.error(message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                com.intellij.openapi.ui.Messages.showErrorDialog(project, message, ClaudeCodeGuiBundle.message("dialog.error.title"));
            });
        }
    }

    /**
     * Displays an informational message.
     */
    private void showInfo(@Nullable Project project, @NotNull String message) {
        LOG.info(message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                com.intellij.openapi.ui.Messages.showInfoMessage(project, message, ClaudeCodeGuiBundle.message("dialog.info.title"));
            });
        }
    }

    /**
     * Activate the CCG tool window and focus the input field.
     */
    private void activateToolWindow(@NotNull Project project) {
        ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
        ToolWindow toolWindow = toolWindowManager.getToolWindow("CCG");
        if (toolWindow == null) {
            return;
        }
        toolWindow.activate(() -> {
            ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindow(project);
            if (chatWindow != null && !chatWindow.isDisposed()) {
                chatWindow.focusInputPane();
            }
        }, true);
    }
}
