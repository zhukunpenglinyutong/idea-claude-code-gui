package com.github.claudecodegui.ui.detached;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.ide.ui.LafManager;
import com.intellij.ide.ui.LafManagerListener;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.openapi.wm.WindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.UIUtil;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.awt.event.WindowListener;

/**
 * Detached chat window as a standalone JFrame.
 * Allows users to separate a tab from the tool window and use it in a floating window.
 */
public class DetachedChatFrame extends JFrame {

    private static final Logger LOG = Logger.getInstance(DetachedChatFrame.class);

    private final Project project;
    private final ClaudeChatWindow chatWindow;
    private final String originalTabName;
    private final int originalTabIndex;
    private final JComponent originalContent;
    private final Disposable frameDisposable = Disposer.newDisposable("DetachedChatFrame");
    private JPanel toolbar;
    private volatile boolean disposed = false;

    /**
     * Create a detached chat window from an existing Content.
     *
     * @param project The current project
     * @param content The Content to detach
     */
    public DetachedChatFrame(Project project, Content content) {
        super(ClaudeSDKToolWindow.TOOL_WINDOW_DISPLAY_NAME + " - " + content.getDisplayName());
        this.project = project;
        this.originalTabName = content.getDisplayName();
        this.chatWindow = ClaudeSDKToolWindow.getChatWindowForContent(content);

        if (chatWindow == null) {
            LOG.error("[DetachedChatFrame] Cannot find ClaudeChatWindow for content: " + originalTabName);
            throw new IllegalStateException("ClaudeChatWindow not found for content");
        }

        // Get original tab index before removing from ContentManager
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
        if (toolWindow != null) {
            ContentManager contentManager = toolWindow.getContentManager();
            this.originalTabIndex = contentManager.getIndexOfContent(content);
        } else {
            this.originalTabIndex = -1;
        }

        // Store the original content component
        this.originalContent = chatWindow.getContent();

        setupUI();
        setupWindowListeners();
        applyIdeTheme();

        LOG.info("[DetachedChatFrame] Created detached window for: " + originalTabName);
    }

    /**
     * Setup the UI components for the detached window.
     */
    private void setupUI() {
        // Set window icon (use PNG since ImageIcon doesn't support SVG)
        try {
            java.net.URL iconUrl = getClass().getResource("/icons/logo-16.png");
            if (iconUrl != null) {
                setIconImage(new ImageIcon(iconUrl).getImage());
            }
        } catch (Exception e) {
            LOG.warn("[DetachedChatFrame] Failed to load window icon", e);
        }

        // Create main panel with BorderLayout
        JPanel mainPanel = new JPanel(new BorderLayout());

        // Add toolbar at the top
        toolbar = createToolbar();
        mainPanel.add(toolbar, BorderLayout.NORTH);

        // Add chat content in the center
        mainPanel.add(originalContent, BorderLayout.CENTER);

        setContentPane(mainPanel);

        // Set window size and position relative to IDE window to avoid overlap
        setSize(1200, 800);
        Frame ideFrame = WindowManager.getInstance().getFrame(project);
        if (ideFrame != null) {
            // Offset from IDE window with stacking offset based on existing detached count
            int offset = DetachedWindowManager.getDetachedWindowCount(project) * 30;
            Point ideLocation = ideFrame.getLocation();
            setLocation(ideLocation.x + 50 + offset, ideLocation.y + 50 + offset);
        } else {
            setLocationRelativeTo(null);
        }

        // Make window resizable
        setResizable(true);
    }

    /**
     * Create the toolbar with action buttons.
     */
    private JPanel createToolbar() {
        JPanel toolbarPanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 10, 5));
        toolbarPanel.setBorder(JBUI.Borders.empty(5));

        // Reattach button
        JButton reattachBtn = new JButton(ClaudeCodeGuiBundle.message("detachedWindow.reattach"));
        reattachBtn.setToolTipText(ClaudeCodeGuiBundle.message("detachedWindow.reattach.tooltip"));
        reattachBtn.addActionListener(e -> reattachToToolWindow());
        toolbarPanel.add(reattachBtn);

        return toolbarPanel;
    }

    /**
     * Setup window event listeners.
     */
    private void setupWindowListeners() {
        setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);

        addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent e) {
                onWindowClosing();
            }
        });
    }

    /**
     * Apply IDE theme to the window and listen for theme changes.
     */
    private void applyIdeTheme() {
        updateThemeColors();

        // Listen for IDE theme changes to keep the detached window in sync
        ApplicationManager.getApplication().getMessageBus().connect(this.frameDisposable)
                .subscribe(LafManagerListener.TOPIC,
                        new LafManagerListener() {
                            @Override
                            public void lookAndFeelChanged(@NotNull LafManager source) {
                                ApplicationManager.getApplication().invokeLater(DetachedChatFrame.this::updateThemeColors);
                            }
                        });
    }

    /**
     * Update the window colors to match the current IDE theme.
     */
    private void updateThemeColors() {
        if (!isDisplayable()) { return; }

        Color bg = UIUtil.getPanelBackground();
        getContentPane().setBackground(bg);
        if (toolbar != null) {
            toolbar.setBackground(bg);
        }
        getContentPane().repaint();
    }

    /**
     * Handle window closing event.
     * Ask user whether to reattach to tool window or destroy the session.
     */
    private void onWindowClosing() {
        // If project is already disposed, just clean up the session
        if (project.isDisposed()) {
            disposeSession();
            return;
        }

        int choice = Messages.showYesNoCancelDialog(
                project,
                ClaudeCodeGuiBundle.message("detachedWindow.close.message"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.title"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.reattach"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.destroy"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.cancel"),
                Messages.getQuestionIcon()
        );

        if (choice == Messages.YES) {
            // Reattach to tool window
            reattachToToolWindow();
        } else if (choice == Messages.NO) {
            // Destroy session
            disposeSession();
        }
        // CANCEL - do nothing
    }

    /**
     * Reattach the chat window to the tool window as a tab.
     */
    public void reattachToToolWindow() {
        LOG.info("[DetachedChatFrame] Reattaching to tool window: " + originalTabName);

        ToolWindowManager.getInstance(this.project).invokeLater(() -> {
            try {
                // If project is disposed, cannot reattach — clean up instead
                if (this.project.isDisposed()) {
                    LOG.warn("[DetachedChatFrame] Project is disposed, cannot reattach");
                    disposeSession();
                    return;
                }

                ToolWindow toolWindow = ToolWindowManager.getInstance(this.project)
                        .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
                if (toolWindow == null) {
                    LOG.error("[DetachedChatFrame] Tool window not found");
                    Messages.showErrorDialog(
                            this.project,
                            ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.noToolWindow"),
                            ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.title")
                    );
                    return;
                }

                ContentManager contentManager = toolWindow.getContentManager();

                // Remove content from JFrame
                getContentPane().removeAll();

                // Create new Content
                ContentFactory factory = ContentFactory.getInstance();
                Content content = factory.createContent(originalContent, originalTabName, false);
                content.setCloseable(true);
                content.setDisposer(this.chatWindow::dispose);
                this.chatWindow.setParentContent(content);

                // Add back to ContentManager at original index if possible
                if (originalTabIndex >= 0 && originalTabIndex < contentManager.getContentCount()) {
                    contentManager.addContent(content, originalTabIndex);
                } else {
                    contentManager.addContent(content);
                }
                contentManager.setSelectedContent(content);

                // Show the tool window
                toolWindow.show();

                // Revalidate and repaint to ensure proper rendering
                originalContent.revalidate();
                originalContent.repaint();

                // Unregister from DetachedWindowManager before disposing the frame
                DetachedWindowManager.unregisterDetached(this.project, this);

                // Close this window
                dispose();

                LOG.info("[DetachedChatFrame] Successfully reattached: " + originalTabName);
            } catch (Exception e) {
                LOG.error("[DetachedChatFrame] Error reattaching to tool window", e);
                Messages.showErrorDialog(
                        this.project,
                        ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.failed") + ": " + e.getMessage(),
                        ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.title")
                );
            }
        });
    }

    /**
     * Dispose the session and close the window.
     */
    private void disposeSession() {
        LOG.info("[DetachedChatFrame] Disposing session: " + originalTabName);

        if (this.project.isDisposed()) {
            disposeSessionImmediately(false);
            return;
        }

        ToolWindowManager.getInstance(this.project).invokeLater(() -> disposeSessionImmediately(true));
    }

    private void disposeSessionImmediately(boolean syncTabState) {
        try {
            // Unregister from DetachedWindowManager
            DetachedWindowManager.unregisterDetached(this.project, this);

            // Dispose the chat window (this will clean up all resources)
            this.chatWindow.dispose();

            if (syncTabState && !this.project.isDisposed()) {
                syncTabStateWithToolWindow();
            }

            // Close this window
            dispose();

            LOG.info("[DetachedChatFrame] Session disposed: " + originalTabName);
        } catch (Exception e) {
            LOG.error("[DetachedChatFrame] Error disposing session", e);
        }
    }

    private void syncTabStateWithToolWindow() {
        try {
            ToolWindow toolWindow = ToolWindowManager.getInstance(this.project)
                    .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
            if (toolWindow != null) {
                int actualCount = toolWindow.getContentManager().getContentCount();
                com.github.claudecodegui.settings.TabStateService.getInstance(this.project)
                        .saveTabCount(actualCount);
            }
        } catch (Exception e) {
            LOG.warn("[DetachedChatFrame] Failed to sync tab state: " + e.getMessage());
        }
    }

    @Override
    public void dispose() {
        if (disposed) { return; }
        disposed = true;

        LOG.info("[DetachedChatFrame] Disposing window: " + originalTabName);

        Disposer.dispose(this.frameDisposable);

        // Remove all window listeners
        for (WindowListener listener : getWindowListeners()) {
            removeWindowListener(listener);
        }

        // Clear content
        getContentPane().removeAll();

        // Call parent dispose
        super.dispose();
    }

    /**
     * Get the associated ClaudeChatWindow.
     */
    public ClaudeChatWindow getChatWindow() {
        return chatWindow;
    }

    /**
     * Get the original tab name.
     */
    public String getOriginalTabName() {
        return originalTabName;
    }
}
