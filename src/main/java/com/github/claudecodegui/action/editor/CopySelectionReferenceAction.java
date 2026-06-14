package com.github.claudecodegui.action.editor;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.icon.PluginIconProvider;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * Action that copies the current editor selection as an AI reference string.
 * Uses the shared selection reference builder so clipboard output stays aligned with other editor actions.
 */
public class CopySelectionReferenceAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(CopySelectionReferenceAction.class);

    private final SelectionReferenceBuilder selectionReferenceBuilder;
    private final Consumer<String> clipboardWriter;

    public CopySelectionReferenceAction() {
        this(new SelectionReferenceBuilder(), CopySelectionReferenceAction::writeToClipboard);
    }

    CopySelectionReferenceAction(@NotNull SelectionReferenceBuilder selectionReferenceBuilder,
                                 @NotNull Consumer<String> clipboardWriter) {
        super(
                ClaudeCodeGuiBundle.message("action.copyAiReference.text"),
                ClaudeCodeGuiBundle.message("action.copyAiReference.description"),
                null
        );
        this.selectionReferenceBuilder = Objects.requireNonNull(selectionReferenceBuilder);
        this.clipboardWriter = Objects.requireNonNull(clipboardWriter);
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        try {
            ReadAction
                    .nonBlocking(() -> buildSelectionReference(e))
                    .finishOnUiThread(
                            ModalityState.defaultModalityState(),
                            result -> handleBuildResult(project, result)
                    )
                    .submit(AppExecutorUtil.getAppExecutorService());
        } catch (RuntimeException ex) {
            showError(project, ClaudeCodeGuiBundle.message("action.copyAiReference.copyFailed"));
            LOG.error("Failed to copy selection reference", ex);
        }
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setIcon(PluginIconProvider.getCurrentPluginIcon());
        Editor editor = e.getData(CommonDataKeys.EDITOR);
        e.getPresentation().setEnabledAndVisible(e.getProject() != null && hasSelection(editor));
    }

    @NotNull SelectionReferenceBuilder.Result buildSelectionReference(@NotNull AnActionEvent e) {
        return selectionReferenceBuilder.build(
                e.getData(CommonDataKeys.EDITOR),
                e.getData(CommonDataKeys.VIRTUAL_FILE)
        );
    }

    void handleBuildResult(@Nullable Project project, @NotNull SelectionReferenceBuilder.Result result) {
        if (!result.isSuccess()) {
            SelectionReferenceFailureHandler.showBuildFailure(
                    result,
                    "action.copyAiReference.selectCodeFirst",
                    message -> showInfo(project, message),
                    message -> showError(project, message)
            );
            return;
        }

        try {
            String reference = Objects.requireNonNull(
                    result.getReference(),
                    "Successful result must contain a reference"
            );
            clipboardWriter.accept(reference);
        } catch (RuntimeException ex) {
            LOG.warn("Failed to write selection reference to clipboard", ex);
            showClipboardWriteFailure(project, ClaudeCodeGuiBundle.message("action.copyAiReference.copyFailed"));
        }
    }

    private static void writeToClipboard(@NotNull String content) {
        Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(content), null);
    }

    private static boolean hasSelection(@Nullable Editor editor) {
        if (editor == null) {
            return false;
        }

        SelectionModel selectionModel = editor.getSelectionModel();
        String selectedText = selectionModel.getSelectedText();
        return selectedText != null && !selectedText.isEmpty();
    }

    private void showClipboardWriteFailure(@Nullable Project project, @NotNull String message) {
        showDialog(project, message, ClaudeCodeGuiBundle.message("dialog.error.title"), true);
    }

    private void showError(@Nullable Project project, @NotNull String message) {
        LOG.error(message);
        showDialog(project, message, ClaudeCodeGuiBundle.message("dialog.error.title"), true);
    }

    private void showInfo(@Nullable Project project, @NotNull String message) {
        LOG.info(message);
        showDialog(project, message, ClaudeCodeGuiBundle.message("dialog.info.title"), false);
    }

    private void showDialog(@Nullable Project project,
                            @NotNull String message,
                            @NotNull String title,
                            boolean error) {
        if (project == null) {
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            if (error) {
                com.intellij.openapi.ui.Messages.showErrorDialog(project, message, title);
                return;
            }
            com.intellij.openapi.ui.Messages.showInfoMessage(project, message, title);
        });
    }
}
