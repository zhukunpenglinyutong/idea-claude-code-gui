package com.github.claudecodegui.handler.diff;

import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffDialogHints;
import com.intellij.diff.DiffManagerEx;
import com.intellij.diff.chains.SimpleDiffRequestChain;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.contents.DocumentContent;
import com.intellij.diff.editor.ChainDiffVirtualFile;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.diff.util.DiffUserDataKeys;
import com.intellij.diff.util.DiffUserDataKeysEx;
import com.intellij.diff.util.Side;
import com.intellij.icons.AllIcons;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.FileEditorManagerListener;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.fileTypes.FileTypes;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.util.LineSeparatorUtil;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.testFramework.LightVirtualFile;
import com.intellij.util.concurrency.AppExecutorUtil;
import com.intellij.util.concurrency.annotations.RequiresEdt;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.BorderFactory;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JPanel;
import javax.swing.JRootPane;
import java.awt.*;
import java.io.File;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Manager for displaying interactive diff views with Apply/Reject buttons.
 * Based on the official Claude Code JetBrains plugin implementation.
 */
public class InteractiveDiffManager {

    private static final Logger LOG = Logger.getInstance(InteractiveDiffManager.class);

    /** Delay before auto-reject on window close (matches official implementation) */
    private static final long CLOSE_REJECT_DELAY_MS = 600;

    /**
     * Shows an interactive diff view with Apply/Reject buttons.
     *
     * @param project The current project
     * @param request The diff request parameters
     * @return A CompletableFuture that completes with the user's action
     */
    public static CompletableFuture<DiffResult> showInteractiveDiff(
            @NotNull Project project,
            @NotNull InteractiveDiffRequest request
    ) {
        CompletableFuture<DiffResult> resultFuture = new CompletableFuture<>();

        if (project.isDisposed()) {
            resultFuture.complete(DiffResult.reject());
            return resultFuture;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                showInteractiveDiffInternal(project, request, resultFuture);
            } catch (Exception e) {
                LOG.error("Failed to show interactive diff", e);
                resultFuture.complete(DiffResult.reject());
            }
        });

        return resultFuture;
    }

    @RequiresEdt
    private static void showInteractiveDiffInternal(
            @NotNull Project project,
            @NotNull InteractiveDiffRequest request,
            @NotNull CompletableFuture<DiffResult> resultFuture
    ) {
        // A Remote permission decision can win before the EDT opens the review.
        if (resultFuture.isDone()) {
            return;
        }
        // Use the original content from the request (before modifications)
        String originalContent = request.getOriginalContent();
        String newContent = request.getNewFileContents();
        Charset charset = StandardCharsets.UTF_8;
        FileType fileType = null;

        // Try to get file type from the actual file
        VirtualFile actualFile = LocalFileSystem.getInstance()
                .refreshAndFindFileByPath(NodeDetector.toVfsPath(request.getFilePath()));

        if (actualFile != null && actualFile.exists()) {
            try {
                charset = actualFile.getCharset() != null ? actualFile.getCharset() : StandardCharsets.UTF_8;
                fileType = actualFile.getFileType();
            } catch (Exception e) {
                LOG.warn("Failed to read file metadata: " + request.getFilePath(), e);
            }
        }

        // Normalize both contents to LF for consistent diff comparison
        // IntelliJ Document internally uses LF, so this ensures correct diff positioning
        // and prevents every line from showing as changed when original file uses CRLF
        originalContent = LineSeparatorUtil.normalizeToLF(originalContent);
        newContent = LineSeparatorUtil.normalizeToLF(newContent);

        // Detect file type from filename if not already detected
        String fileName = new File(request.getFilePath()).getName();
        if (fileType == null || fileType == FileTypes.UNKNOWN) {
            fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);
        }

        // Create LightVirtualFile for proposed content (new content after modifications)
        LightVirtualFile proposedFile = new LightVirtualFile(fileName, fileType, newContent);
        // Set line separator to LF since content is normalized to LF
        proposedFile.setDetectedLineSeparator("\n");

        // Create diff contents
        DiffContentFactory contentFactory = DiffContentFactory.getInstance();

        // Left side: original content before modifications (read-only)
        DiffContent originalDiffContent = contentFactory.create(project, originalContent, fileType);

        // Right side: proposed content after modifications (editable)
        DocumentContent proposedDiffContent = contentFactory.createDocument(project, proposedFile);
        if (proposedDiffContent == null) {
            DiffContent fallbackContent = contentFactory.create(project, proposedFile);
            if (fallbackContent instanceof DocumentContent) {
                proposedDiffContent = (DocumentContent) fallbackContent;
            } else {
                LOG.error("Failed to create DocumentContent for diff");
                resultFuture.complete(DiffResult.reject());
                return;
            }
        }

        // Create diff request
        String leftTitle = request.isNewFile() ? ClaudeCodeGuiBundle.message("diff.newFileTitle") : ClaudeCodeGuiBundle.message("diff.originalTitle");
        SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                request.getTabName(),
                originalDiffContent,
                proposedDiffContent,
                leftTitle,
                ClaudeCodeGuiBundle.message("diff.proposedTitle")
        );

        // Set read-only flags based on request:
        // Left side (original) is always read-only.
        // Right side (proposed) is read-only when request.isReadOnly() is true
        // (e.g., permission review flow where user can only accept/reject).
        boolean[] readOnly = {true, request.isReadOnly()};
        diffRequest.putUserData(DiffUserDataKeys.FORCE_READ_ONLY_CONTENTS, readOnly);
        diffRequest.putUserData(DiffUserDataKeys.PREFERRED_FOCUS_SIDE, Side.RIGHT);

        // Wrap in chain
        SimpleDiffRequestChain diffRequestChain = new SimpleDiffRequestChain(diffRequest);

        // Create state tracking
        AtomicBoolean actionApplied = new AtomicBoolean(false);
        AtomicReference<ScheduledFuture<?>> rejectFutureRef = new AtomicReference<>();

        // Set up window event listener first (before creating buttons that reference connection)
        MessageBusConnection connection = project.getMessageBus().connect();

        // Desktop buttons close the view themselves. If another first-wins path
        // (Remote decision / abort) completes the same future, close it here.
        resultFuture.whenComplete((result, error) -> {
            if (actionApplied.compareAndSet(false, true)) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    connection.disconnect();
                    cancelPendingRejectTask(rejectFutureRef);
                    closeDiffView(project, diffRequestChain);
                });
            }
        });

        // Create Apply/Reject actions for toolbar (ApplyAlways only for permission review)
        final DocumentContent finalProposedContent = proposedDiffContent;
        boolean isPermissionReview = request.isReadOnly();
        AnAction rejectAction = createRejectAction(actionApplied, resultFuture, connection);
        AnAction applyAction = createApplyAction(actionApplied, resultFuture, finalProposedContent, proposedFile, connection);

        // Add actions to toolbar
        List<AnAction> actions = new ArrayList<>();
        actions.add(rejectAction);
        if (isPermissionReview) {
            actions.add(createApplyAlwaysAction(actionApplied, resultFuture, finalProposedContent, proposedFile, connection, rejectFutureRef, project, diffRequestChain));
        }
        actions.add(applyAction);
        diffRequest.putUserData(DiffUserDataKeysEx.CONTEXT_ACTIONS, actions);

        // Create bottom panel with buttons
        JButton rejectButton = new JButton(ClaudeCodeGuiBundle.message("diff.reject"));
        rejectButton.setIcon(AllIcons.Actions.Cancel);
        rejectButton.setMaximumSize(rejectButton.getPreferredSize());
        rejectButton.addActionListener(e -> {
            if (actionApplied.compareAndSet(false, true)) {
                connection.disconnect();
                cancelPendingRejectTask(rejectFutureRef);
                resultFuture.complete(DiffResult.reject());
                closeDiffView(project, diffRequestChain);
            }
        });

        JButton applyButton = new JButton(ClaudeCodeGuiBundle.message("diff.apply"));
        applyButton.setIcon(AllIcons.Actions.Checked);
        applyButton.setMaximumSize(applyButton.getPreferredSize());
        applyButton.addActionListener(e -> {
            if (actionApplied.compareAndSet(false, true)) {
                connection.disconnect();
                cancelPendingRejectTask(rejectFutureRef);
                String content = getEditedContent(finalProposedContent, proposedFile);
                resultFuture.complete(DiffResult.apply(content));
                closeDiffView(project, diffRequestChain);
            }
        });

        // Create button panel
        JPanel buttonsPanel = new JPanel(new FlowLayout(FlowLayout.CENTER, 10, 0));
        buttonsPanel.add(rejectButton);
        if (isPermissionReview) {
            JButton applyAlwaysButton = new JButton(ClaudeCodeGuiBundle.message("diff.applyAlways"));
            applyAlwaysButton.setIcon(AllIcons.Actions.Checked_selected);
            applyAlwaysButton.setMaximumSize(applyAlwaysButton.getPreferredSize());
            applyAlwaysButton.addActionListener(e -> {
                if (actionApplied.compareAndSet(false, true)) {
                    connection.disconnect();
                    cancelPendingRejectTask(rejectFutureRef);
                    String content = getEditedContent(finalProposedContent, proposedFile);
                    resultFuture.complete(DiffResult.applyAlways(content));
                    closeDiffView(project, diffRequestChain);
                }
            });
            buttonsPanel.add(applyAlwaysButton);
        }
        buttonsPanel.add(applyButton);

        // Create wrapper panel with padding
        JPanel bottomPanel = new JPanel();
        bottomPanel.setLayout(new BoxLayout(bottomPanel, BoxLayout.Y_AXIS));
        bottomPanel.setBorder(BorderFactory.createEmptyBorder(5, 0, 10, 0));
        buttonsPanel.setAlignmentX(Component.CENTER_ALIGNMENT);
        bottomPanel.add(buttonsPanel);

        // Set bottom panel
        diffRequestChain.putUserData(DiffUserDataKeysEx.BOTTOM_PANEL, bottomPanel);

        // Subscribe to file editor events
        connection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, new FileEditorManagerListener() {
            @Override
            public void fileOpened(@NotNull FileEditorManager source, @NotNull VirtualFile file) {
                if (file instanceof ChainDiffVirtualFile) {
                    ChainDiffVirtualFile diffFile = (ChainDiffVirtualFile) file;
                    if (diffFile.getChain() == diffRequestChain) {
                        // Cancel any pending reject task
                        cancelPendingRejectTask(rejectFutureRef);

                        // Focus the Apply button
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                JRootPane rootPane = applyButton.getRootPane();
                                if (rootPane != null) {
                                    rootPane.setDefaultButton(applyButton);
                                    applyButton.requestFocus();
                                }
                            } catch (Exception ex) {
                                LOG.debug("Failed to focus Apply button", ex);
                            }
                        });
                    }
                }
            }

            @Override
            public void fileClosed(@NotNull FileEditorManager source, @NotNull VirtualFile file) {
                if (file instanceof ChainDiffVirtualFile) {
                    ChainDiffVirtualFile diffFile = (ChainDiffVirtualFile) file;
                    if (diffFile.getChain() == diffRequestChain) {
                        // Schedule delayed dismiss (user closed without action, not rejection)
                        ScheduledFuture<?> future = AppExecutorUtil.getAppScheduledExecutorService()
                                .schedule(() -> {
                                    ApplicationManager.getApplication().invokeLater(() -> {
                                        try {
                                            if (actionApplied.compareAndSet(false, true)) {
                                                connection.disconnect();
                                                // DISMISS: User closed window without taking action
                                                // File remains in current state (with pending changes)
                                                resultFuture.complete(DiffResult.dismiss());
                                            }
                                        } catch (Exception ex) {
                                            LOG.debug("Error in dismiss task", ex);
                                        }
                                    });
                                }, CLOSE_REJECT_DELAY_MS, TimeUnit.MILLISECONDS);
                        rejectFutureRef.set(future);
                    }
                }
            }
        });

        // Show the diff
        if (!resultFuture.isDone()) {
            DiffManagerEx.getInstance().showDiffBuiltin(project, diffRequestChain, DiffDialogHints.DEFAULT);
        }

        LOG.info("Interactive diff opened for: " + request.getFilePath());
    }

    /**
     * Cancel any pending reject task.
     */
    private static void cancelPendingRejectTask(AtomicReference<ScheduledFuture<?>> rejectFutureRef) {
        ScheduledFuture<?> pendingFuture = rejectFutureRef.getAndSet(null);
        if (pendingFuture != null && !pendingFuture.isDone()) {
            pendingFuture.cancel(false);
        }
    }

    private static AnAction createRejectAction(
            AtomicBoolean actionApplied,
            CompletableFuture<DiffResult> resultFuture,
            MessageBusConnection connection
    ) {
        return new AnAction(ClaudeCodeGuiBundle.message("diff.reject"), ClaudeCodeGuiBundle.message("diff.reject.description"), AllIcons.Actions.Cancel) {
            @Override
            @RequiresEdt
            public void actionPerformed(@NotNull AnActionEvent e) {
                if (actionApplied.compareAndSet(false, true)) {
                    connection.disconnect();
                    resultFuture.complete(DiffResult.reject());
                }
            }

            @Override
            public @NotNull ActionUpdateThread getActionUpdateThread() {
                return ActionUpdateThread.EDT;
            }
        };
    }

    private static AnAction createApplyAlwaysAction(
            AtomicBoolean actionApplied,
            CompletableFuture<DiffResult> resultFuture,
            DocumentContent proposedContent,
            LightVirtualFile proposedFile,
            MessageBusConnection connection,
            AtomicReference<ScheduledFuture<?>> rejectFutureRef,
            Project project,
            SimpleDiffRequestChain diffRequestChain
    ) {
        return new AnAction(ClaudeCodeGuiBundle.message("diff.applyAlways"), ClaudeCodeGuiBundle.message("diff.applyAlways.description"), AllIcons.Actions.Checked_selected) {
            @Override
            @RequiresEdt
            public void actionPerformed(@NotNull AnActionEvent e) {
                if (actionApplied.compareAndSet(false, true)) {
                    connection.disconnect();
                    cancelPendingRejectTask(rejectFutureRef);
                    String content = getEditedContent(proposedContent, proposedFile);
                    resultFuture.complete(DiffResult.applyAlways(content));
                    closeDiffView(project, diffRequestChain);
                }
            }

            @Override
            public @NotNull ActionUpdateThread getActionUpdateThread() {
                return ActionUpdateThread.EDT;
            }
        };
    }

    private static AnAction createApplyAction(
            AtomicBoolean actionApplied,
            CompletableFuture<DiffResult> resultFuture,
            DocumentContent proposedContent,
            LightVirtualFile proposedFile,
            MessageBusConnection connection
    ) {
        return new AnAction(ClaudeCodeGuiBundle.message("diff.apply"), ClaudeCodeGuiBundle.message("diff.apply.description"), AllIcons.Actions.Checked) {
            @Override
            @RequiresEdt
            public void actionPerformed(@NotNull AnActionEvent e) {
                if (actionApplied.compareAndSet(false, true)) {
                    connection.disconnect();
                    String content = getEditedContent(proposedContent, proposedFile);
                    resultFuture.complete(DiffResult.apply(content));
                }
            }

            @Override
            public @NotNull ActionUpdateThread getActionUpdateThread() {
                return ActionUpdateThread.EDT;
            }
        };
    }

    private static String getEditedContent(
            @Nullable DocumentContent proposedContent,
            @NotNull LightVirtualFile proposedFile
    ) {
        if (proposedContent != null && proposedContent.getDocument() != null) {
            return proposedContent.getDocument().getText();
        }
        return proposedFile.getContent().toString();
    }

    private static void closeDiffView(Project project, SimpleDiffRequestChain chain) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileEditorManager manager = FileEditorManager.getInstance(project);
                for (VirtualFile file : manager.getOpenFiles()) {
                    if (file instanceof ChainDiffVirtualFile) {
                        ChainDiffVirtualFile diffFile = (ChainDiffVirtualFile) file;
                        if (diffFile.getChain() == chain) {
                            manager.closeFile(file);
                            break;
                        }
                    }
                }
            } catch (Exception e) {
                LOG.debug("Failed to close diff view", e);
            }
        });
    }

}
