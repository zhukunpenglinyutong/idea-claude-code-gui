package com.github.claudecodegui.permission;

import com.github.claudecodegui.util.WslPathUtil;
import com.github.claudecodegui.handler.diff.DiffResult;
import com.github.claudecodegui.handler.diff.InteractiveDiffManager;
import com.github.claudecodegui.handler.diff.InteractiveDiffRequest;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.util.Computable;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Service for reviewing file-modifying tool calls (Edit, Write) via an interactive diff view.
 * Integrates with the permission system to provide "review-before-write" capability.
 *
 * This service computes the proposed file content from tool inputs, opens an interactive
 * diff view in the IDE, and returns the user's decision (accept/reject) along with the
 * possibly user-edited content.
 */
public class DiffReviewService {

    private static final Logger LOG = Logger.getInstance(DiffReviewService.class);

    /** Tool names that modify files and should trigger diff review */
    private static final Set<String> FILE_MODIFYING_TOOLS = Set.of("Edit", "Write");

    /**
     * A diff review that can be completed either by the desktop controls or by
     * the shared Remote permission resolver. Both paths complete the same
     * underlying diff future, so first completion wins.
     */
    public static final class ReviewHandle {
        private final CompletableFuture<DiffResult> diffFuture;
        private final CompletableFuture<DiffReviewResult> reviewFuture;
        private final String proposedContent;

        ReviewHandle(CompletableFuture<DiffResult> diffFuture,
                     CompletableFuture<DiffReviewResult> reviewFuture,
                     String proposedContent) {
            this.diffFuture = diffFuture;
            this.reviewFuture = reviewFuture;
            this.proposedContent = proposedContent;
        }

        public CompletableFuture<DiffReviewResult> getFuture() {
            return reviewFuture;
        }

        public boolean resolve(boolean allow, boolean alwaysAllow) {
            DiffResult result;
            if (!allow) {
                result = DiffResult.reject();
            } else if (alwaysAllow) {
                result = DiffResult.applyAlways(proposedContent);
            } else {
                result = DiffResult.apply(proposedContent);
            }
            return diffFuture.complete(result);
        }
    }

    /**
     * Check if a tool is a file-modifying tool that should trigger diff review.
     */
    public static boolean isFileModifyingTool(@Nullable String toolName) {
        return toolName != null && FILE_MODIFYING_TOOLS.contains(toolName);
    }

    /**
     * Review a file change by opening an interactive diff view.
     * Reads the original file, computes the proposed content, and opens the diff.
     *
     * @param project  The current project
     * @param toolName The tool name (Edit, Write, etc.)
     * @param inputs   The tool input parameters
     * @return CompletableFuture resolving to the review result, or null if diff review is not possible
     */
    @Nullable
    public static CompletableFuture<DiffReviewResult> reviewFileChange(
            @NotNull Project project,
            @NotNull String toolName,
            @NotNull JsonObject inputs
    ) {
        ReviewHandle handle = reviewFileChangeControllable(project, toolName, inputs);
        return handle != null ? handle.getFuture() : null;
    }

    /**
     * Open a review and retain a control handle for non-desktop resolution.
     */
    @Nullable
    public static ReviewHandle reviewFileChangeControllable(
            @NotNull Project project,
            @NotNull String toolName,
            @NotNull JsonObject inputs
    ) {
        String filePath = extractFilePath(inputs);
        if (filePath == null || filePath.isEmpty()) {
            LOG.warn("DiffReview: No file path found in tool inputs for " + toolName);
            return null;
        }

        // Security: validate file path is within project directory
        String projectBasePath = project.getBasePath();
        if (projectBasePath != null && !WslPathUtil.isPathWithinDirectory(filePath, projectBasePath)) {
            LOG.warn("DiffReview: Security - file path outside project: " + filePath);
            return null;
        }

        LOG.info("DiffReview: Starting review for " + toolName + " on " + filePath);

        try {
            String originalContent = readFileContent(filePath);
            String proposedContent = computeProposedContent(toolName, inputs, originalContent, filePath);

            if (proposedContent == null) {
                LOG.warn("DiffReview: Could not compute proposed content for " + toolName);
                return null;
            }

            boolean isNewFile = (originalContent == null);
            String safeOriginal = originalContent != null ? originalContent : "";

            // Build tab name
            String fileName = new File(filePath).getName();
            String tabName = ClaudeCodeGuiBundle.message("diff.reviewTabName", fileName);

            // Create the diff request (read-only: permission review is preview-only)
            InteractiveDiffRequest request;
            if (isNewFile) {
                request = InteractiveDiffRequest.forReadOnlyNewFile(filePath, proposedContent, tabName);
            } else {
                request = InteractiveDiffRequest.forReadOnlyModifiedFile(filePath, safeOriginal, proposedContent, tabName);
            }

            // Open the interactive diff and map the result
            CompletableFuture<DiffResult> diffFuture = InteractiveDiffManager.showInteractiveDiff(project, request);

            CompletableFuture<DiffReviewResult> reviewFuture = diffFuture.thenApply(diffResult -> {
                if (diffResult.isApplied()) {
                    LOG.info("DiffReview: User accepted changes for " + filePath
                            + (diffResult.isAppliedAlways() ? " (always allow)" : ""));
                    return diffResult.isAppliedAlways()
                            ? DiffReviewResult.acceptedAlways(diffResult.getFinalContent(), filePath)
                            : DiffReviewResult.accepted(diffResult.getFinalContent(), filePath);
                } else {
                    String action = diffResult.isRejected() ? "rejected" : "dismissed";
                    LOG.info("DiffReview: User " + action + " changes for " + filePath);
                    return DiffReviewResult.rejected(filePath);
                }
            });
            return new ReviewHandle(diffFuture, reviewFuture, proposedContent);
        } catch (Exception e) {
            LOG.error("DiffReview: Failed to set up diff review for " + filePath, e);
            return null;
        }
    }

    /**
     * Extract the file path from tool inputs.
     * Supports Edit (file_path), Write (file_path), and NotebookEdit (notebook_path).
     */
    @Nullable
    private static String extractFilePath(@NotNull JsonObject inputs) {
        if (inputs.has("file_path") && !inputs.get("file_path").isJsonNull()) {
            return inputs.get("file_path").getAsString();
        }
        if (inputs.has("notebook_path") && !inputs.get("notebook_path").isJsonNull()) {
            return inputs.get("notebook_path").getAsString();
        }
        if (inputs.has("path") && !inputs.get("path").isJsonNull()) {
            return inputs.get("path").getAsString();
        }
        return null;
    }

    /**
     * Read the content of a file. Returns null if the file does not exist.
     */
    @Nullable
    private static String readFileContent(@NotNull String filePath) {
        return ApplicationManager.getApplication().runReadAction((Computable<String>) () -> {
            try {
                VirtualFile vFile = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(WslPathUtil.toVfsPath(filePath));
                if (vFile != null && vFile.exists() && !vFile.isDirectory()) {
                    Charset charset = vFile.getCharset() != null ? vFile.getCharset() : StandardCharsets.UTF_8;
                    return new String(vFile.contentsToByteArray(), charset);
                }
            } catch (IOException e) {
                LOG.warn("DiffReview: Failed to read file: " + filePath, e);
            }
            return null;
        });
    }

    /**
     * Compute the proposed file content based on tool name and inputs.
     *
     * @param toolName        The tool name
     * @param inputs          The tool input parameters
     * @param originalContent The original file content (null if file doesn't exist)
     * @return The proposed new content, or null if computation fails
     */
    @Nullable
    private static String computeProposedContent(
            @NotNull String toolName,
            @NotNull JsonObject inputs,
            @Nullable String originalContent,
            @NotNull String filePath
    ) {
        switch (toolName) {
            case "Edit":
                return computeEditProposedContent(inputs, originalContent, filePath);
            case "Write":
                return computeWriteProposedContent(inputs);
            default:
                return null;
        }
    }

    /**
     * Compute proposed content for the Edit tool.
     * Replaces old_string with new_string in the original content.
     */
    @Nullable
    private static String computeEditProposedContent(
            @NotNull JsonObject inputs,
            @Nullable String originalContent,
            @NotNull String filePath
    ) {
        if (originalContent == null) {
            LOG.warn("DiffReview: Edit tool called on non-existent file: " + filePath);
            return null;
        }

        String oldString = inputs.has("old_string") && !inputs.get("old_string").isJsonNull()
                ? inputs.get("old_string").getAsString() : null;
        String newString = inputs.has("new_string") && !inputs.get("new_string").isJsonNull()
                ? inputs.get("new_string").getAsString() : null;

        if (oldString == null || newString == null) {
            LOG.warn("DiffReview: Edit tool missing old_string or new_string for " + filePath);
            return null;
        }

        // No-op edit: old and new are identical
        if (oldString.equals(newString)) {
            return originalContent;
        }

        boolean replaceAll = inputs.has("replace_all") && inputs.get("replace_all").getAsBoolean();

        if (!replaceAll) {
            // Try exact match first
            int index = originalContent.indexOf(oldString);
            String effectiveOld = oldString;
            String effectiveNew = newString;

            // Fallback: try line-ending variants (Windows CRLF/LF mismatch)
            if (index < 0) {
                String[] variant = findLineEndingVariant(originalContent, oldString, newString);
                if (variant != null) {
                    effectiveOld = variant[0];
                    effectiveNew = variant[1];
                    index = originalContent.indexOf(effectiveOld);
                    LOG.info("DiffReview: Matched old_string after normalizing " + variant[2]
                            + " for " + filePath);
                }
            }

            if (index >= 0) {
                return originalContent.substring(0, index)
                        + effectiveNew
                        + originalContent.substring(index + effectiveOld.length());
            }

            LOG.warn("DiffReview: old_string not found in file content for " + filePath
                    + " (fileLength=" + originalContent.length()
                    + ", oldStringLength=" + oldString.length() + ")");
            return null;
        }

        // For replace_all: try exact match first
        String result = originalContent.replace(oldString, newString);
        if (!result.equals(originalContent)) {
            return result;
        }

        // Fallback: try line-ending variants to avoid silent no-ops
        String[] variant = findLineEndingVariant(originalContent, oldString, newString);
        if (variant != null) {
            result = originalContent.replace(variant[0], variant[1]);
            if (!result.equals(originalContent)) {
                LOG.info("DiffReview: Matched old_string after normalizing " + variant[2]
                        + " (replace_all) for " + filePath);
                return result;
            }
        }

        LOG.warn("DiffReview: old_string not found in file content for " + filePath
                + " (replace_all, fileLength=" + originalContent.length()
                + ", oldStringLength=" + oldString.length() + ")");
        return null;
    }

    /**
     * Find a line-ending variant of oldString that exists in content.
     * Tries LF->CRLF and CRLF->LF conversions to handle Windows/Unix line ending mismatches.
     *
     * @return [effectiveOld, effectiveNew, variantDescription] if a variant matches, null otherwise
     */
    @Nullable
    private static String[] findLineEndingVariant(
            @NotNull String content, @NotNull String oldString, @NotNull String newString) {
        // Try LF -> CRLF (tool sends LF, file uses CRLF)
        String crlfOld = oldString.replace("\n", "\r\n");
        if (!crlfOld.equals(oldString) && content.contains(crlfOld)) {
            return new String[]{crlfOld, newString.replace("\n", "\r\n"), "LF->CRLF"};
        }
        // Try CRLF -> LF (tool sends CRLF, file uses LF)
        String lfOld = oldString.replace("\r\n", "\n");
        if (!lfOld.equals(oldString) && content.contains(lfOld)) {
            return new String[]{lfOld, newString.replace("\r\n", "\n"), "CRLF->LF"};
        }
        return null;
    }

    /**
     * Compute proposed content for the Write tool.
     * The Write tool provides the complete new file content.
     */
    @Nullable
    private static String computeWriteProposedContent(@NotNull JsonObject inputs) {
        if (inputs.has("content") && !inputs.get("content").isJsonNull()) {
            return inputs.get("content").getAsString();
        }
        LOG.warn("DiffReview: Write tool missing content field");
        return null;
    }
}
