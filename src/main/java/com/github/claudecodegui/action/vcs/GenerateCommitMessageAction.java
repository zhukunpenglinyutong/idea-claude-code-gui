package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.service.GitCommitMessageService;
import com.github.claudecodegui.service.commit.CommitMessageCallback;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.CheckinProjectPanel;
import com.intellij.openapi.vcs.CommitMessageI;
import com.intellij.openapi.vcs.VcsDataKeys;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangeListManager;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Action to generate Git commit messages using AI.
 *
 * <p>Streams the generated message into the commit box (without clobbering the
 * user's draft until tokens arrive), restores the draft on error, cancels any
 * in-flight generation on re-trigger, and prewarms the shared daemon when the
 * commit dialog opens.
 */
public class GenerateCommitMessageAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(GenerateCommitMessageAction.class);

    /** Active generation per project (for cancel + double-click guard). */
    private static final Map<Project, GitCommitMessageService> ACTIVE =
            Collections.synchronizedMap(new WeakHashMap<>());

    /** Projects whose shared daemon has already been prewarmed from this action. */
    private static final Set<Project> PREWARMED = Collections.newSetFromMap(new WeakHashMap<>());

    public GenerateCommitMessageAction() {
        super();
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            LOG.warn("Project is null");
            return;
        }

        CommitMessageI commitMessagePanel = getCommitMessagePanel(e);
        Collection<Change> changes = getUserSelectedChanges(e, project);

        if (commitMessagePanel == null) {
            LOG.error("Cannot access commit message panel");
            ClaudeNotifier.showWarning(project, ClaudeCodeGuiBundle.message("commit.cannotAccessPanel"));
            return;
        }

        if (changes == null || changes.isEmpty()) {
            LOG.warn("No changes selected");
            ClaudeNotifier.showWarning(project, ClaudeCodeGuiBundle.message("commit.noChanges"));
            return;
        }

        // Cancel any in-flight generation (double-click / re-trigger).
        cancelInFlight(project);

        final GitCommitMessageService service;
        try {
            service = new GitCommitMessageService(project);
        } catch (NoClassDefFoundError error) {
            // 兜底: update() 已按 Git4Idea 可用性隐藏入口, 这里防御极端时序
            // (如运行中被禁用插件)。git4idea 缺失时 CommitDiffProvider 无法加载。
            LOG.warn("Git4Idea became unavailable; aborting commit message generation", error);
            return;
        }
        setActive(project, service);

        // Preserve the user's existing draft; restored on error.
        final String savedDraft = readCurrentDraft(commitMessagePanel);
        final CommitMessageI panel = commitMessagePanel;
        final Project finalProject = project;

        ClaudeNotifier.setGenerating(project);

        // Clear the box and show a "generating" placeholder so it's obvious the
        // generation is in progress. The saved draft is restored on error.
        panel.setCommitMessage(ClaudeCodeGuiBundle.message("commit.generating"));

        // Snapshot on the UI thread — ChangeListManager data must not be walked
        // off-thread without a stable copy. Git diff + AI work is offloaded by
        // GitCommitMessageService (must not block the EDT / freeze the commit dialog).
        final List<Change> changesSnapshot = new ArrayList<>(changes);
        service.generateCommitMessage(changesSnapshot, new CommitMessageCallback() {
            @Override
            public void onProgress(String partial) {
                // Already dispatched on the EDT by CommitAIClient.
                if (isCurrent(finalProject, service) && partial != null && !partial.isEmpty()) {
                    panel.setCommitMessage(partial);
                }
            }

            @Override
            public void onSuccess(String commitMessage) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (isCurrent(finalProject, service)) {
                        clearActive(finalProject, service);
                        panel.setCommitMessage(commitMessage);
                        ClaudeNotifier.showSuccess(project, ClaudeCodeGuiBundle.message("commit.generateSuccess"));
                    }
                }, ModalityState.any());
            }

            @Override
            public void onError(String error) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (isCurrent(finalProject, service)) {
                        clearActive(finalProject, service);
                        // Restore the draft rather than leaving an empty box.
                        panel.setCommitMessage(savedDraft);
                        ClaudeNotifier.showError(project,
                                ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + error);
                    }
                }, ModalityState.any());
            }
        });
    }

    // -------------------------------------------------------------------------
    // Active-generation tracking
    // -------------------------------------------------------------------------

    private static void setActive(Project project, GitCommitMessageService service) {
        synchronized (ACTIVE) {
            ACTIVE.put(project, service);
        }
    }

    private static boolean isCurrent(Project project, GitCommitMessageService service) {
        synchronized (ACTIVE) {
            return ACTIVE.get(project) == service;
        }
    }

    private static void clearActive(Project project, GitCommitMessageService service) {
        synchronized (ACTIVE) {
            if (ACTIVE.get(project) == service) {
                ACTIVE.remove(project);
            }
        }
    }

    private static void cancelInFlight(Project project) {
        GitCommitMessageService previous;
        synchronized (ACTIVE) {
            previous = ACTIVE.remove(project);
        }
        if (previous != null) {
            previous.cancel();
        }
    }

    // -------------------------------------------------------------------------
    // Commit dialog accessors
    // -------------------------------------------------------------------------

    /**
     * Get CommitMessageI from available data sources.
     */
    @Nullable
    private CommitMessageI getCommitMessagePanel(@NotNull AnActionEvent e) {
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        if (workflowHandler instanceof CommitMessageI) {
            return (CommitMessageI) workflowHandler;
        }

        CommitMessageI messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        if (messageControl != null) {
            return messageControl;
        }

        return null;
    }

    /**
     * Best-effort read of the current commit-message text. {@link CommitMessageI}
     * declares no getter, but its concrete implementations (e.g. {@code CommitMessage}
     * and the commit-workflow UI) expose {@code getCommitMessage()} — read it via
     * reflection, matching the pattern used elsewhere in this action.
     */
    @NotNull
    private String readCurrentDraft(@NotNull CommitMessageI panel) {
        try {
            Method getter = panel.getClass().getMethod("getCommitMessage");
            Object value = getter.invoke(panel);
            return value instanceof String ? (String) value : "";
        } catch (Throwable t) {
            LOG.debug("Failed to read commit draft via reflection: " + t.getMessage());
            return "";
        }
    }

    /**
     * Get user-selected changes from the commit dialog (fallback chain across
     * IDEA versions).
     */
    @Nullable
    private Collection<Change> getUserSelectedChanges(@NotNull AnActionEvent e, @NotNull Project project) {
        Collection<Change> changes;

        // 1. COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges() via reflection.
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        if (workflowHandler != null) {
            changes = getIncludedChangesViaReflection(workflowHandler);
            if (changes != null && !changes.isEmpty()) {
                return changes;
            }
        }

        // 2. CheckinProjectPanel.getSelectedChanges() (legacy).
        Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        if (messageControl instanceof CheckinProjectPanel checkinPanel) {
            changes = checkinPanel.getSelectedChanges();
            if (changes != null && !changes.isEmpty()) {
                return changes;
            }
        }

        // 3. VcsDataKeys.CHANGES.
        Change[] changesArray = e.getData(VcsDataKeys.CHANGES);
        if (changesArray != null && changesArray.length > 0) {
            return java.util.Arrays.asList(changesArray);
        }

        // 4. Last resort — all changes.
        Collection<Change> allChanges = ChangeListManager.getInstance(project).getAllChanges();
        if (!allChanges.isEmpty()) {
            return allChanges;
        }

        return null;
    }

    /**
     * Get included changes from AbstractCommitWorkflowHandler via reflection
     * (graceful degradation on older IDEA versions without this API).
     */
    @Nullable
    private Collection<Change> getIncludedChangesViaReflection(@NotNull Object workflowHandler) {
        try {
            Method getUiMethod = workflowHandler.getClass().getMethod("getUi");
            Object ui = getUiMethod.invoke(workflowHandler);
            if (ui == null) {
                return null;
            }
            Method getIncludedChangesMethod = ui.getClass().getMethod("getIncludedChanges");
            Object result = getIncludedChangesMethod.invoke(ui);
            if (result instanceof Collection<?> col) {
                List<Change> changes = new ArrayList<>();
                for (Object item : col) {
                    if (item instanceof Change change) {
                        changes.add(change);
                    }
                }
                return changes;
            }
            return null;
        } catch (NoSuchMethodException ex) {
            LOG.debug("getIncludedChanges() not available (older IDEA version): " + ex.getMessage());
            return null;
        } catch (Exception ex) {
            LOG.debug("Failed to get included changes via reflection: " + ex.getMessage());
            return null;
        }
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        // Git4Idea 是可选依赖 (见 plugin.xml): 提交信息生成走 git4idea 的 git diff。
        // 没有它的环境 (如 Remote Development 的前端客户端) 直接隐藏入口。
        if (!isGit4IdeaAvailable()) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        Project project = e.getProject();
        boolean enabled = project != null;

        if (enabled) {
            try {
                enabled = new CodemossSettingsService().getCommitGenerationEnabled();
            } catch (Exception ex) {
                LOG.debug("Failed to check commit generation enabled setting: " + ex.getMessage());
            }
        }

        // Prewarm the shared daemon once, while the user is still selecting files,
        // so the first generation is fast.
        prewarmOnce(project);

        e.getPresentation().setText(ClaudeCodeGuiBundle.message("action.generateCommitMessage.text"));
        e.getPresentation().setDescription(ClaudeCodeGuiBundle.message("action.generateCommitMessage.description"));
        e.getPresentation().setEnabledAndVisible(enabled);
    }

    /**
     * Whether the optional Git4Idea plugin's classes are loadable. The commit
     * message generator needs its {@code git diff}; without it (e.g. the Remote
     * Development frontend client) the action hides itself instead of crashing.
     * Class-loadability is exactly the condition {@link GitCommitMessageService}
     * (via {@code CommitDiffProvider}) needs, and it also covers the
     * installed-but-disabled case.
     */
    private static boolean isGit4IdeaAvailable() {
        try {
            Class.forName("git4idea.repo.GitRepositoryManager");
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Prewarm the chat window's shared Claude daemon once per project when the
     * commit dialog (and thus this action) becomes visible. Retries until the
     * chat window exists.
     */
    private void prewarmOnce(@Nullable Project project) {
        if (project == null || PREWARMED.contains(project)) {
            return;
        }
        try {
            ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindow(project);
            if (chatWindow != null) {
                PREWARMED.add(project);
                String basePath = project.getBasePath();
                if (basePath != null) {
                    chatWindow.getClaudeSDKBridge().prewarmDaemonAsync(basePath);
                }
            }
        } catch (Throwable t) {
            LOG.debug("Commit prewarm failed: " + t.getMessage());
        }
    }
}
