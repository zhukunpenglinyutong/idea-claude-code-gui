package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.ui.detached.DetachedWindowManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.JBColor;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.content.ContentManagerEvent;
import com.intellij.ui.content.ContentManagerListener;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Claude SDK chat tool window.
 * Implements DumbAware to allow usage during index building.
 */
public class ClaudeSDKToolWindow implements ToolWindowFactory, DumbAware {

    private static final Logger LOG = Logger.getInstance(ClaudeSDKToolWindow.class);
    public static final String TOOL_WINDOW_ID = "CCG";
    public static final String TOOL_WINDOW_DISPLAY_NAME = "CC GUI";
    private static final Map<Project, ClaudeChatWindow> instances = new ConcurrentHashMap<>();
    private static final Map<Content, ClaudeChatWindow> contentToWindowMap = new ConcurrentHashMap<>();
    private static volatile boolean shutdownHookRegistered = false;
    private static final String TAB_NAME_PREFIX = "AI";
    private static final Set<Content> detachingContents =
            Collections.newSetFromMap(new ConcurrentHashMap<>());

    public static ClaudeChatWindow getChatWindow(Project project) {
        return instances.get(project);
    }

    public static String getNextTabName(ToolWindow toolWindow) {
        if (toolWindow == null) {
            return TAB_NAME_PREFIX + "1";
        }

        ContentManager contentManager = toolWindow.getContentManager();
        int maxNumber = 0;

        for (Content content : contentManager.getContents()) {
            String displayName = content.getDisplayName();
            if (displayName != null && displayName.startsWith(TAB_NAME_PREFIX)) {
                try {
                    int number = Integer.parseInt(displayName.substring(TAB_NAME_PREFIX.length()));
                    if (number > maxNumber) {
                        maxNumber = number;
                    }
                } catch (NumberFormatException ignored) {
                }
            }
        }

        return TAB_NAME_PREFIX + (maxNumber + 1);
    }

    static void registerWindow(Project project, ClaudeChatWindow window) {
        synchronized (instances) {
            ClaudeChatWindow oldInstance = instances.get(project);
            if (oldInstance != null && oldInstance != window) {
                LOG.warn("Window instance already exists for project " + project.getName() + ", replacing old instance");
                oldInstance.dispose();
            }
            instances.put(project, window);
        }
    }

    static void unregisterWindow(Project project, ClaudeChatWindow window) {
        synchronized (instances) {
            if (instances.get(project) == window) {
                instances.remove(project);
            }
        }
    }

    static void registerContentMapping(Content content, ClaudeChatWindow window) {
        contentToWindowMap.put(content, window);
    }

    static void unregisterContentMapping(Content content) {
        contentToWindowMap.remove(content);
    }

    private static Set<ClaudeChatWindow> collectProjectChatWindows(@NotNull Project project) {
        Set<ClaudeChatWindow> windows = Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        ClaudeChatWindow mainWindow = instances.get(project);
        if (mainWindow != null) {
            windows.add(mainWindow);
        }
        for (ClaudeChatWindow window : contentToWindowMap.values()) {
            if (window != null && project.equals(window.getProject())) {
                windows.add(window);
            }
        }
        windows.addAll(DetachedWindowManager.getAllDetachedChatWindows(project));
        return windows;
    }

    /**
     * Public version of {@link #collectProjectChatWindows(Project)} for NodeProcessRegistry.
     * Returns all chat windows belonging to the given project, including tab windows
     * and detached floating windows.
     */
    public static Set<ClaudeChatWindow> getAllChatWindowsForProject(@NotNull Project project) {
        return collectProjectChatWindows(project);
    }

    private static Set<ClaudeChatWindow> collectAllChatWindows() {
        Set<ClaudeChatWindow> windows = Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        windows.addAll(instances.values());
        windows.addAll(contentToWindowMap.values());
        windows.addAll(DetachedWindowManager.getAllDetachedChatWindows());
        return windows;
    }

    private static String resolveRestoredTabName(@NotNull TabStateService tabStateService, int index) {
        String savedName = tabStateService.getTabName(index);
        if (savedName != null && !savedName.isEmpty()) {
            LOG.info("[TabManager] Restored tab " + index + " name from storage: " + savedName);
            return savedName;
        }
        return TAB_NAME_PREFIX + (index + 1);
    }

    private static void cleanupWindowProcesses(@NotNull ClaudeChatWindow window) {
        try {
            if (window.getClaudeSDKBridge() != null) {
                window.getClaudeSDKBridge().cleanupAllProcesses();
            }
            if (window.getCodexSDKBridge() != null) {
                window.getCodexSDKBridge().cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.error("[ShutdownHook] Error cleaning up processes: " + e.getMessage(), e);
        }
    }

    private static void disposeProjectChatWindows(@NotNull Project project) {
        Set<ClaudeChatWindow> windows = collectProjectChatWindows(project);
        if (windows.isEmpty()) {
            return;
        }
        LOG.info("[ToolWindow] Disposing " + windows.size() + " chat window(s) for project: " + project.getName());
        for (ClaudeChatWindow window : new HashSet<>(windows)) {
            if (window != null && !window.isDisposed()) {
                try {
                    window.dispose();
                } catch (Exception e) {
                    LOG.error("[ToolWindow] Failed to dispose chat window for project: " + project.getName(), e);
                }
            }
        }
    }

    /**
     * Mark a Content as being detached (moving to a floating window).
     * This prevents the contentRemoved listener from disposing the associated ClaudeChatWindow.
     */
    public static void markContentAsDetaching(Content content) {
        detachingContents.add(content);
    }

    public static void unmarkContentAsDetaching(Content content) {
        detachingContents.remove(content);
    }

    static boolean isContentDetaching(Content content) {
        return detachingContents.contains(content);
    }

    public static ClaudeChatWindow getChatWindowForContent(Content content) {
        return content != null ? contentToWindowMap.get(content) : null;
    }

    @Override
    public void init(@NotNull ToolWindow toolWindow) {
        toolWindow.setTitle(TOOL_WINDOW_DISPLAY_NAME);
        toolWindow.setStripeTitle(TOOL_WINDOW_DISPLAY_NAME);
    }

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        registerShutdownHook();

        ContentFactory contentFactory = ContentFactory.getInstance();
        ContentManager contentManager = toolWindow.getContentManager();

        if (BridgePreloader.isBridgeReady()) {
            LOG.info("[ToolWindow] ai-bridge ready, creating chat window directly");
            createChatWindowContent(project, contentFactory, contentManager);
        } else {
            LOG.info("[ToolWindow] ai-bridge not ready, showing loading panel");
            JPanel loadingPanel = createLoadingPanel();
            Content loadingContent = contentFactory.createContent(loadingPanel, TAB_NAME_PREFIX + "1", false);
            contentManager.addContent(loadingContent);

            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    BridgePreloader.getSharedResolver().findSdkDir();
                    CompletableFuture<Boolean> future = BridgePreloader.waitForBridgeAsync();
                    Boolean ready = future.get(60, TimeUnit.SECONDS);

                    if (project.isDisposed()) { return; }

                    ToolWindowManager.getInstance(project).invokeLater(() -> {
                        if (project.isDisposed()) { return; }

                        if (ready != null && ready) {
                            LOG.info("[ToolWindow] ai-bridge ready, replacing loading panel with chat window");
                            replaceLoadingPanelWithChatWindow(project, contentFactory, contentManager, loadingContent);
                        } else {
                            LOG.error("[ToolWindow] ai-bridge preparation failed");
                            updateLoadingPanelWithError(loadingPanel, "AI Bridge preparation failed. Please restart IDE.");
                        }
                    });
                } catch (TimeoutException e) {
                    LOG.error("[ToolWindow] ai-bridge preparation timeout");
                    ToolWindowManager.getInstance(project).invokeLater(() -> {
                        if (!project.isDisposed()) {
                            updateLoadingPanelWithError(loadingPanel, "AI Bridge preparation timeout. Please restart IDE.");
                        }
                    });
                } catch (Exception e) {
                    LOG.error("[ToolWindow] ai-bridge preparation error: " + e.getMessage());
                    ToolWindowManager.getInstance(project).invokeLater(() -> {
                        if (!project.isDisposed()) {
                            updateLoadingPanelWithError(loadingPanel, "Error: " + e.getMessage());
                        }
                    });
                }
            });
        }

        if (PlatformUtils.isPluginDevMode()) {
            com.intellij.openapi.actionSystem.AnAction devToolsAction =
                    com.intellij.openapi.actionSystem.ActionManager.getInstance()
                            .getAction("ClaudeCodeGUI.OpenDevToolsAction");
            if (devToolsAction != null) {
                toolWindow.setTitleActions(java.util.List.of(devToolsAction));
            }
        }

        com.intellij.openapi.actionSystem.AnAction renameTabAction =
                com.intellij.openapi.actionSystem.ActionManager.getInstance()
                        .getAction("ClaudeCodeGUI.RenameTabAction");
        com.intellij.openapi.actionSystem.AnAction detachTabAction =
                com.intellij.openapi.actionSystem.ActionManager.getInstance()
                        .getAction("ClaudeCodeGUI.DetachTabAction");
        com.intellij.openapi.actionSystem.AnAction saveAsTemplateAction =
                com.intellij.openapi.actionSystem.ActionManager.getInstance()
                        .getAction("ClaudeCodeGUI.SaveAsTemplateAction");
        com.intellij.openapi.actionSystem.AnAction createFromTemplateAction =
                com.intellij.openapi.actionSystem.ActionManager.getInstance()
                        .getAction("ClaudeCodeGUI.CreateFromTemplateAction");

        com.intellij.openapi.actionSystem.DefaultActionGroup gearActions =
                new com.intellij.openapi.actionSystem.DefaultActionGroup();
        if (renameTabAction != null) {
            gearActions.add(renameTabAction);
        }
        if (detachTabAction != null) {
            gearActions.add(detachTabAction);
        }
        if (saveAsTemplateAction != null) {
            gearActions.addSeparator();
            gearActions.add(saveAsTemplateAction);
        }
        if (createFromTemplateAction != null) {
            gearActions.add(createFromTemplateAction);
        }
        toolWindow.setAdditionalGearActions(gearActions);

        registerProjectCloseListener(project);

        contentManager.addContentManagerListener(new ContentManagerListener() {
            @Override
            public void contentAdded(@NotNull ContentManagerEvent event) {
                updateTabCloseableState(contentManager);
                TabStateService tabStateService = TabStateService.getInstance(project);
                tabStateService.saveTabCount(contentManager.getContentCount());
            }

            @Override
            public void selectionChanged(@NotNull ContentManagerEvent event) {
                if (contentManager.getSelectedContent() != event.getContent()) {
                    return;
                }
                ClaudeChatWindow window = contentToWindowMap.get(event.getContent());
                if (window != null) {
                    window.onTabActivated();
                    window.loadRestoredHistoryIfNeeded();
                }
            }

            @Override
            public void contentRemoved(@NotNull ContentManagerEvent event) {
                updateTabCloseableState(contentManager);

                Content removedContent = event.getContent();
                if (isContentDetaching(removedContent)) {
                    LOG.info("[TabManager] Tab detaching to floating window, skipping dispose: "
                        + removedContent.getDisplayName());
                    return;
                }

                int removedIndex = event.getIndex();
                TabStateService tabStateService = TabStateService.getInstance(project);
                tabStateService.onTabRemoved(removedIndex);

                ClaudeChatWindow window = contentToWindowMap.get(removedContent);
                if (window != null) {
                    LOG.info("[TabManager] Disposing ClaudeChatWindow for removed tab: "
                        + removedContent.getDisplayName());
                    window.dispose();
                }
            }

            @Override
            public void contentRemoveQuery(@NotNull ContentManagerEvent event) {
                Content content = event.getContent();
                if (isContentDetaching(content)) {
                    return;
                }

                String tabName = content.getDisplayName();
                int result = com.intellij.openapi.ui.Messages.showYesNoDialog(
                    project,
                    ClaudeCodeGuiBundle.message("tab.close.confirm.message", tabName),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.title"),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.yes"),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.no"),
                    com.intellij.openapi.ui.Messages.getQuestionIcon()
                );

                if (result != com.intellij.openapi.ui.Messages.YES) {
                    event.consume();
                }
            }
        });

        updateTabCloseableState(contentManager);
    }

    private void updateTabCloseableState(ContentManager contentManager) {
        int tabCount = contentManager.getContentCount();
        boolean closeable = tabCount > 1;

        for (Content tab : contentManager.getContents()) {
            tab.setCloseable(closeable);
        }

        LOG.debug("[TabManager] Updated tab closeable state: count=" + tabCount + ", closeable=" + closeable);
    }

    private JPanel createLoadingPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setOpaque(false);

        JLabel iconLabel = new JLabel("⚙");
        iconLabel.setFont(iconLabel.getFont().deriveFont(48f));
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(iconLabel);

        centerPanel.add(Box.createVerticalStrut(16));

        JLabel textLabel = new JLabel(ClaudeCodeGuiBundle.message("toolwindow.preparingBridge"));
        textLabel.setFont(textLabel.getFont().deriveFont(14f));
        textLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(textLabel);

        panel.add(centerPanel);
        return panel;
    }

    private void updateLoadingPanelWithError(JPanel loadingPanel, String errorMessage) {
        loadingPanel.removeAll();

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setOpaque(false);

        JLabel iconLabel = new JLabel("⚠");
        iconLabel.setFont(iconLabel.getFont().deriveFont(48f));
        iconLabel.setForeground(JBColor.ORANGE);
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(iconLabel);

        centerPanel.add(Box.createVerticalStrut(16));

        JLabel textLabel = new JLabel(errorMessage);
        textLabel.setFont(textLabel.getFont().deriveFont(14f));
        textLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(textLabel);

        loadingPanel.add(centerPanel);
        loadingPanel.revalidate();
        loadingPanel.repaint();
    }

    private void replaceLoadingPanelWithChatWindow(
            @NotNull Project project,
            ContentFactory contentFactory,
            ContentManager contentManager,
            Content loadingContent
    ) {
        TabStateService tabStateService = TabStateService.getInstance(project);
        int savedTabCount = tabStateService.getTabCount();
        LOG.info("[TabManager] Restoring " + savedTabCount + " tabs from storage");

        ClaudeChatWindow firstChatWindow = new ClaudeChatWindow(project, false);
        String firstTabName = resolveRestoredTabName(tabStateService, 0);
        TabStateService.TabSessionState firstSavedState = tabStateService.getTabSessionState(0);

        loadingContent.setComponent(firstChatWindow.getContent());
        loadingContent.setDisplayName(firstTabName);
        firstChatWindow.setParentContent(loadingContent);
        loadingContent.setDisposer(firstChatWindow::dispose);
        restoreTabSessionState(firstSavedState, 0, firstChatWindow, true);

        for (int i = 1; i < savedTabCount; i++) {
            ClaudeChatWindow chatWindow = new ClaudeChatWindow(project, true);
            String tabName = resolveRestoredTabName(tabStateService, i);
            TabStateService.TabSessionState savedState = tabStateService.getTabSessionState(i);

            Content content = contentFactory.createContent(chatWindow.getContent(), tabName, false);
            chatWindow.setParentContent(content);
            content.setDisposer(chatWindow::dispose);
            contentManager.addContent(content);
            restoreTabSessionState(savedState, i, chatWindow, false);
        }

        updateTabCloseableState(contentManager);
    }

    private void createChatWindowContent(
            @NotNull Project project,
            ContentFactory contentFactory,
            ContentManager contentManager
    ) {
        TabStateService tabStateService = TabStateService.getInstance(project);
        int savedTabCount = tabStateService.getTabCount();
        LOG.info("[TabManager] Restoring " + savedTabCount + " tabs from storage");

        for (int i = 0; i < savedTabCount; i++) {
            boolean isFirstTab = (i == 0);
            ClaudeChatWindow chatWindow = new ClaudeChatWindow(project, !isFirstTab);
            String tabName = resolveRestoredTabName(tabStateService, i);
            TabStateService.TabSessionState savedState = tabStateService.getTabSessionState(i);

            Content content = contentFactory.createContent(chatWindow.getContent(), tabName, false);
            chatWindow.setParentContent(content);
            chatWindow.setOriginalTabName(tabName);
            content.setDisposer(chatWindow::dispose);
            contentManager.addContent(content);
            restoreTabSessionState(savedState, i, chatWindow, isFirstTab);
        }

        updateTabCloseableState(contentManager);
    }

    private void restoreTabSessionState(
            TabStateService.TabSessionState savedState,
            int tabIndex,
            ClaudeChatWindow chatWindow,
            boolean loadImmediately
    ) {
        if (savedState == null) {
            return;
        }
        chatWindow.restorePersistedTabSessionState(savedState, loadImmediately);
        LOG.info("[TabManager] Restored tab " + tabIndex + " session binding from storage");
    }

    private static synchronized void registerShutdownHook() {
        if (shutdownHookRegistered) {
            return;
        }
        shutdownHookRegistered = true;

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("[ShutdownHook] IDEA is shutting down, cleaning up all Node.js processes...");

            ExecutorService executor = Executors.newSingleThreadExecutor();
            try {
                Future<?> future = executor.submit(() -> {
                    for (ClaudeChatWindow window : collectAllChatWindows()) {
                        if (window != null) {
                            cleanupWindowProcesses(window);
                        }
                    }
                });

                future.get(3, TimeUnit.SECONDS);
                LOG.info("[ShutdownHook] Node.js process cleanup completed");
            } catch (TimeoutException e) {
                LOG.warn("[ShutdownHook] Process cleanup timed out (3s), forcing exit");
            } catch (Exception e) {
                LOG.error("[ShutdownHook] Process cleanup failed: " + e.getMessage());
            } finally {
                executor.shutdownNow();
            }
        }, "Claude-Process-Cleanup-Hook"));

        LOG.info("[ShutdownHook] JVM Shutdown Hook registered");
    }

    private static final CodeSnippetManager codeSnippetManager = new CodeSnippetManager(instances, contentToWindowMap);

    public static void addSelectionFromExternal(Project project, String selectionInfo) {
        codeSnippetManager.addSelectionFromExternal(project, selectionInfo);
    }

    /**
     * Register project closing listener to dispose all chat windows for the project.
     * This ensures proper cleanup when a project is closed.
     *
     * @param project The project to listen to
     */
    private void registerProjectCloseListener(@NotNull Project project) {
        ToolWindowLifecycleDisposableService lifecycleDisposable = ToolWindowLifecycleDisposableService.getInstance(project);
        if (!lifecycleDisposable.markProjectCloseListenerRegistered()) {
            return;
        }
        project.getMessageBus().connect(lifecycleDisposable).subscribe(
                com.intellij.openapi.project.ProjectManager.TOPIC,
                new com.intellij.openapi.project.ProjectManagerListener() {
                    @Override
                    public void projectClosing(@NotNull Project closingProject) {
                        if (closingProject.equals(project)) {
                            LOG.info("[ToolWindow] Project closing, disposing chat windows for: " + project.getName());
                            disposeProjectChatWindows(project);
                        }
                    }
                }
        );
    }
}
