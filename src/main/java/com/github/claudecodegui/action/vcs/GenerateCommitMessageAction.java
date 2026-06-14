package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.service.GitCommitMessageService;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.ui.icon.PluginIconProvider;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
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
import java.util.List;

/**
 * Action to generate Git commit messages using AI.
 */
public class GenerateCommitMessageAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(GenerateCommitMessageAction.class);

    public GenerateCommitMessageAction() {
        super();
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        LOG.info("GenerateCommitMessageAction triggered");

        Project project = e.getProject();
        if (project == null) {
            LOG.warn("Project is null");
            return;
        }

        LOG.info("Project: " + project.getName());

        // Get CommitMessageI for setting the commit message
        CommitMessageI commitMessagePanel = getCommitMessagePanel(e);

        // Get user-selected changes using the new method with proper fallback chain
        Collection<Change> changes = getUserSelectedChanges(e, project);

        // Check if we successfully obtained required objects
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

        LOG.info("Successfully obtained CommitMessageI and changes, proceeding to generate commit message");

        // Save references for async callback
        final CommitMessageI finalCommitMessagePanel = commitMessagePanel;
        final Collection<Change> finalChanges = changes;

        // Show "generating..." placeholder in commit message box
        String generatingText = ClaudeCodeGuiBundle.message("commit.generating");
        commitMessagePanel.setCommitMessage(generatingText);

        // Generate commit message asynchronously
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                GitCommitMessageService service = new GitCommitMessageService(project);
                service.generateCommitMessage(finalChanges, new GitCommitMessageService.CommitMessageCallback() {
                    @Override
                    public void onSuccess(String commitMessage) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            // Set the generated commit message
                            finalCommitMessagePanel.setCommitMessage(commitMessage);
                            ClaudeNotifier.showSuccess(project, ClaudeCodeGuiBundle.message("commit.generateSuccess"));
                        });
                    }

                    @Override
                    public void onError(String error) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            // Clear placeholder text
                            finalCommitMessagePanel.setCommitMessage("");
                            ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + error);
                        });
                    }
                });
            } catch (Exception ex) {
                LOG.error("Failed to generate commit message", ex);
                ApplicationManager.getApplication().invokeLater(() -> {
                    // Clear placeholder text
                    finalCommitMessagePanel.setCommitMessage("");
                    ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + ex.getMessage());
                });
            }
        });
    }

    /**
     * Get CommitMessageI from available data sources.
     */
    @Nullable
    private CommitMessageI getCommitMessagePanel(@NotNull AnActionEvent e) {
        // Try COMMIT_WORKFLOW_HANDLER first (newer IDEA versions)
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        if (workflowHandler instanceof CommitMessageI) {
            LOG.info("Got CommitMessageI from COMMIT_WORKFLOW_HANDLER");
            return (CommitMessageI) workflowHandler;
        }

        // Try COMMIT_MESSAGE_CONTROL
        CommitMessageI messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        if (messageControl != null) {
            LOG.info("Got CommitMessageI from COMMIT_MESSAGE_CONTROL");
            return messageControl;
        }

        return null;
    }

    /**
     * Get user-selected changes from the commit dialog.
     * Uses a fallback chain to support different IDEA versions:
     * 1. COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges() - preferred, gets user-checked files
     * 2. CheckinProjectPanel.getSelectedChanges() - legacy fallback
     * 3. VcsDataKeys.CHANGES - context-based fallback
     * 4. ChangeListManager.getAllChanges() - last resort fallback
     */
    @Nullable
    private Collection<Change> getUserSelectedChanges(@NotNull AnActionEvent e, @NotNull Project project) {
        Collection<Change> changes;

        // Method 1: Try COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges() via reflection
        // This is the preferred method as it returns only user-checked files in the commit dialog
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        if (workflowHandler != null) {
            changes = getIncludedChangesViaReflection(workflowHandler);
            if (changes != null && !changes.isEmpty()) {
                LOG.info("Got " + changes.size() + " changes from COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges()");
                return changes;
            }
        }

        // Method 2: Try CheckinProjectPanel.getSelectedChanges() (legacy)
        Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        if (messageControl instanceof CheckinProjectPanel checkinPanel) {
            changes = checkinPanel.getSelectedChanges();
            if (changes != null && !changes.isEmpty()) {
                LOG.info("Got " + changes.size() + " changes from CheckinProjectPanel.getSelectedChanges() (fallback)");
                return changes;
            }
        }

        // Method 3: Try VcsDataKeys.CHANGES
        Change[] changesArray = e.getData(VcsDataKeys.CHANGES);
        if (changesArray != null && changesArray.length > 0) {
            changes = java.util.Arrays.asList(changesArray);
            LOG.info("Got " + changes.size() + " changes from VcsDataKeys.CHANGES (fallback)");
            return changes;
        }

        // Method 4: Last resort - get all changes from ChangeListManager
        ChangeListManager changeListManager = ChangeListManager.getInstance(project);
        Collection<Change> allChanges = changeListManager.getAllChanges();
        if (!allChanges.isEmpty()) {
            LOG.info("Got " + allChanges.size() + " changes from ChangeListManager.getAllChanges() (last resort fallback)");
            return allChanges;
        }

        LOG.warn("Failed to get changes from any data source");
        return null;
    }

    /**
     * Get included changes from AbstractCommitWorkflowHandler via reflection.
     * This method uses reflection to call handler.ui.getIncludedChanges() which returns
     * only the files that the user has checked in the commit dialog.
     * <p>
     * The reflection approach is necessary because:
     * - AbstractCommitWorkflowHandler.ui.getIncludedChanges() was introduced in newer IDEA versions
     * - Direct method call would cause ClassNotFoundException in older IDEA versions
     * - This allows graceful degradation when the API is unavailable
     */
    @Nullable
    private Collection<Change> getIncludedChangesViaReflection(@NotNull Object workflowHandler) {
        try {
            // Get the 'ui' property from AbstractCommitWorkflowHandler
            // The ui property is of type CommitWorkflowUi which has getIncludedChanges() method
            Method getUiMethod = workflowHandler.getClass().getMethod("getUi");
            Object ui = getUiMethod.invoke(workflowHandler);

            if (ui == null) {
                LOG.debug("workflowHandler.getUi() returned null");
                return null;
            }

            // Call getIncludedChanges() on the ui object
            // This returns List<Change> containing only user-checked files
            Method getIncludedChangesMethod = ui.getClass().getMethod("getIncludedChanges");
            Object result = getIncludedChangesMethod.invoke(ui);

            if (result instanceof Collection<?> col) {
                List<Change> changes = new ArrayList<>();
                for (Object item : col) {
                    if (item instanceof Change change) {
                        changes.add(change);
                    }
                }
                LOG.debug("Successfully retrieved " + changes.size() + " included changes via reflection");
                return changes;
            }

            return null;
        } catch (NoSuchMethodException e) {
            // Expected on older IDEA versions that don't have this API
            LOG.debug("getIncludedChanges() method not available (older IDEA version): " + e.getMessage());
            return null;
        } catch (Exception e) {
            // Log other reflection errors for debugging
            LOG.debug("Failed to get included changes via reflection: " + e.getMessage());
            return null;
        }
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        boolean enabled = project != null;

        // Check if commit generation feature is enabled in settings
        if (enabled) {
            try {
                enabled = new CodemossSettingsService().getCommitGenerationEnabled();
            } catch (Exception ex) {
                LOG.debug("Failed to check commit generation enabled setting: " + ex.getMessage());
            }
        }

        // Debug: log when update is called
        if (LOG.isDebugEnabled()) {
            LOG.debug("GenerateCommitMessageAction.update called, project=" + (project != null ? project.getName() : "null"));

            // Log available DataKeys
            Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
            Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);

            LOG.debug("Available DataKeys:");
            LOG.debug("  - COMMIT_WORKFLOW_HANDLER: " + (workflowHandler != null ? workflowHandler.getClass().getName() : "null"));
            LOG.debug("  - COMMIT_MESSAGE_CONTROL: " + (messageControl != null ? messageControl.getClass().getName() : "null"));
        }

        // Set localized text
        e.getPresentation().setText(ClaudeCodeGuiBundle.message("action.generateCommitMessage.text"));
        e.getPresentation().setDescription(ClaudeCodeGuiBundle.message("action.generateCommitMessage.description"));
        // Follow the CoDriver tool-icon preference so the commit dialog never shows the
        // orange icon while the monochrome CoDriver icon is enabled.
        e.getPresentation().setIcon(PluginIconProvider.getCurrentPluginIcon());
        e.getPresentation().setEnabledAndVisible(enabled);
    }
}
