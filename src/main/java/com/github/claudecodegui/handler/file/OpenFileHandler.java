package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.util.EditorFileUtils;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.ScrollType;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Computable;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.search.FilenameIndex;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Handles opening files in the editor and opening URLs in the browser.
 */
class OpenFileHandler {

    private static final Logger LOG = Logger.getInstance(OpenFileHandler.class);
    private static final Pattern LINE_INFO_PATTERN = Pattern.compile("^(.*):(\\d+)(?:-(\\d+))?$");
    private static final Pattern SAFE_EXTERNAL_URL_PATTERN =
            Pattern.compile("^(https?|mailto):.*$", Pattern.CASE_INSENSITIVE);

    private final HandlerContext context;

    OpenFileHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Open a file in the editor.
     * Supports file paths with line numbers: file.txt:100 or file.txt:100-200.
     */
    void handleOpenFile(String filePath) {
        LOG.info("Open file request: " + filePath);

        CompletableFuture.runAsync(() -> {
            try {
                LineInfo lineInfo = parseLineInfo(filePath);
                String actualPath = lineInfo.actualPath();
                int lineNumber = lineInfo.lineNumber();
                int endLineNumber = lineInfo.endLineNumber();

                FileResolutionResult resolution = resolveFile(actualPath);

                if (resolution == null) {
                    LOG.warn("File not found: " + actualPath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        context.callJavaScript("addErrorMessage", context.escapeJs("Cannot open file: file does not exist (" + actualPath + ")"));
                    }, ModalityState.nonModal());
                    return;
                }

                // Direct VirtualFile from fuzzy match - skip File conversion
                if (resolution.virtualFile() != null) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (context.getProject().isDisposed() || !resolution.virtualFile().isValid()) {
                            return;
                        }
                        openInEditor(resolution.virtualFile(), lineNumber, endLineNumber);
                        LOG.info("Successfully opened file via fuzzy match: " + filePath);
                    }, ModalityState.nonModal());
                    return;
                }

                // Standard File path resolution
                final File finalFile = resolution.file();
                EditorFileUtils.refreshAndFindFileAsync(finalFile, virtualFile -> {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (context.getProject().isDisposed() || !virtualFile.isValid()) {
                            return;
                        }
                        openInEditor(virtualFile, lineNumber, endLineNumber);
                        LOG.info("Successfully opened file: " + filePath);
                    }, ModalityState.nonModal());
                }, () -> {
                    LOG.error("Failed to get VirtualFile: " + filePath);
                    context.callJavaScript("addErrorMessage", context.escapeJs("Cannot open file: " + filePath));
                });
            } catch (Exception e) {
                LOG.error("Failed to open file: " + e.getMessage(), e);
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    /**
     * Parse line number info from file path.
     */
    static LineInfo parseLineInfo(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return new LineInfo(filePath, -1, -1, false);
        }

        Matcher matcher = LINE_INFO_PATTERN.matcher(filePath);
        if (!matcher.matches()) {
            return new LineInfo(filePath, -1, -1, false);
        }

        String actualPath = matcher.group(1);
        if (actualPath == null || actualPath.isBlank() || actualPath.matches(".*:\\d+$")) {
            return new LineInfo(filePath, -1, -1, false);
        }

        try {
            int lineNumber = Integer.parseInt(matcher.group(2));
            int endLineNumber = matcher.group(3) != null ? Integer.parseInt(matcher.group(3)) : -1;
            if (lineNumber <= 0 || (endLineNumber > 0 && endLineNumber < lineNumber)) {
                return new LineInfo(filePath, -1, -1, false);
            }

            return new LineInfo(actualPath, lineNumber, endLineNumber, true);
        } catch (NumberFormatException e) {
            LOG.warn("Failed to parse line number: " + filePath);
            return new LineInfo(filePath, -1, -1, false);
        }
    }

    /**
     * Resolve file path, handling MSYS paths, relative paths, and fuzzy filename matching.
     * Returns either a direct File path or a VirtualFile from fuzzy matching.
     * Fuzzy matching searches for files by name when the path cannot be resolved directly.
     */
    private FileResolutionResult resolveFile(String actualPath) {
        File directFile = normalizeExistingFile(new File(actualPath));
        if (directFile != null) {
            warnIfOutsideProjectRoot(directFile);
            return new FileResolutionResult(directFile, null);
        }

        String resolvedPath = actualPath;
        if (PlatformUtils.isWindows()) {
            // WSL must be tried before the MSYS conversion below: under MSYS
            // /home/<user> means %USERPROFILE%, under WSL it's a real Linux dir
            // accessible only via \\wsl.localhost\<distro>\home\<user>.
            // Falling through to MSYS would silently rewrite the path to the
            // Windows home, which usually has no such file → "file does not exist".
            String wslUncPath = NodeDetector.convertWslPathToWindowsUnc(actualPath);
            if (wslUncPath != null) {
                File wslFile = normalizeExistingFile(new File(wslUncPath));
                if (wslFile != null) {
                    LOG.info("Resolved WSL path to UNC: " + wslUncPath);
                    warnIfOutsideProjectRoot(wslFile);
                    return new FileResolutionResult(wslFile, null);
                }
            }

            String convertedPath = PathUtils.convertMsysToWindowsPath(actualPath);
            if (!convertedPath.equals(actualPath)) {
                LOG.info("Detected MSYS2 path, converted to Windows path: " + convertedPath);
                File convertedFile = normalizeExistingFile(new File(convertedPath));
                if (convertedFile != null) {
                    warnIfOutsideProjectRoot(convertedFile);
                    return new FileResolutionResult(convertedFile, null);
                }
                resolvedPath = convertedPath;
            }
        }

        File pathCandidate = new File(resolvedPath);
        if (pathCandidate.isAbsolute()) {
            return null;
        }

        for (File baseDirectory : getResolutionBases()) {
            File candidate = normalizeExistingFile(new File(baseDirectory, resolvedPath));
            if (candidate != null) {
                LOG.info("Resolved relative file against " + baseDirectory.getAbsolutePath() + ": " + candidate.getAbsolutePath());
                return new FileResolutionResult(candidate, null);
            }
        }

        // Fallback: fuzzy filename search using IDEA's file index
        VirtualFile fuzzyMatch = resolveFileByFuzzyMatch(actualPath);
        if (fuzzyMatch != null) {
            LOG.info("Resolved file by fuzzy match: " + fuzzyMatch.getPath());
            return new FileResolutionResult(null, fuzzyMatch);
        }

        return null;
    }

    /**
     * Fuzzy file matching: search for files by name in the project scope.
     * Handles cases like "linkify.ts" -> finds "src/utils/linkify.ts".
     * Returns null during dumb mode to avoid IndexNotReadyException.
     */
    private VirtualFile resolveFileByFuzzyMatch(String pathHint) {
        Project project = context.getProject();
        if (project == null || project.isDisposed()) {
            return null;
        }

        // FilenameIndex requires indexes to be ready
        try {
            if (DumbService.isDumb(project)) {
                LOG.info("Fuzzy file match deferred during dumb mode for: " + pathHint);
                return null;
            }
        } catch (IllegalStateException e) {
            LOG.debug("DumbService unavailable for fuzzy match, skipping: " + e.getMessage());
            return null;
        }

        // Extract the filename from the path hint
        String fileName = extractFileName(pathHint);
        if (fileName == null || fileName.isBlank()) {
            return null;
        }

        // Extract path suffix for matching
        String pathSuffix = extractPathSuffix(pathHint);

        // FileEditorManager.getOpenFiles() is EDT-only — collect the open file
        // paths before entering the background read action below (calling it
        // from a read action on a pooled thread would also risk a deadlock:
        // the pooled thread waits for the EDT while holding the read lock the
        // EDT may be waiting on).
        List<String> recentOpenPaths = collectRecentOpenPaths(project);

        // FilenameIndex requires read access
        return ApplicationManager.getApplication().runReadAction((Computable<VirtualFile>) () -> {
            // Search for files with matching name in project scope
            Collection<VirtualFile> matches = FilenameIndex.getVirtualFilesByName(
                fileName,
                GlobalSearchScope.projectScope(project)
            );

            if (matches.isEmpty()) {
                return null;
            }

            // Disambiguate same-named files (e.g. every Django app has models.py)
            // deterministically - see pickBestFuzzyMatchPath for the priority order.
            Map<String, VirtualFile> matchesByPath = new LinkedHashMap<>();
            for (VirtualFile match : matches) {
                matchesByPath.put(match.getPath(), match);
            }
            String bestPath = pickBestFuzzyMatchPath(matchesByPath.keySet(), pathSuffix, recentOpenPaths);
            return bestPath != null ? matchesByPath.get(bestPath) : null;
        });
    }

    /**
     * Collect the paths of files currently open in the editor, most recent first.
     * Used to disambiguate fuzzy matches: the file under discussion in the chat is
     * very likely one the user (or the AI tool window) has open right now.
     *
     * <p>{@link FileEditorManager#getOpenFiles()} must run on the EDT; callers on
     * a background thread are bounced via {@code invokeAndWait}.</p>
     */
    private List<String> collectRecentOpenPaths(Project project) {
        try {
            AtomicReference<VirtualFile[]> openFilesRef = new AtomicReference<>();
            if (ApplicationManager.getApplication().isDispatchThread()) {
                openFilesRef.set(FileEditorManager.getInstance(project).getOpenFiles());
            } else {
                ApplicationManager.getApplication().invokeAndWait(
                        () -> openFilesRef.set(FileEditorManager.getInstance(project).getOpenFiles()));
            }
            VirtualFile[] openFiles = openFilesRef.get();
            if (openFiles == null) {
                return Collections.emptyList();
            }
            List<String> paths = new ArrayList<>(openFiles.length);
            for (VirtualFile openFile : openFiles) {
                paths.add(openFile.getPath());
            }
            return paths;
        } catch (Exception e) {
            LOG.debug("Failed to collect open files for fuzzy match disambiguation: " + e.getMessage());
            return Collections.emptyList();
        }
    }

    /**
     * Pick the best fuzzy-match candidate deterministically. Priority:
     * <ol>
     *   <li>A segment-aligned path-suffix match (unique) - "blog/models.py" only
     *       matches ".../blog/models.py", never ".../myblog/models.py"</li>
     *   <li>A candidate currently open in the editor (most recent first)</li>
     *   <li>Common source-root heuristic (src/, main/)</li>
     *   <li>Shortest path as the final deterministic tiebreaker</li>
     * </ol>
     * Previously the fallback returned whichever candidate the filename index
     * happened to iterate first, which opened arbitrary same-named files (#1682).
     *
     * @param candidatePaths paths of all same-named candidates (unsorted)
     * @param pathSuffix relative path hint from the message (may be null/blank)
     * @param recentOpenPaths editor-open file paths, most recent first (may be empty)
     * @return the best candidate path, or null when candidates is empty
     */
    // VisibleForTesting
    static String pickBestFuzzyMatchPath(Collection<String> candidatePaths, String pathSuffix, List<String> recentOpenPaths) {
        List<String> candidates = new ArrayList<>(candidatePaths);
        if (candidates.isEmpty()) {
            return null;
        }

        // 1. Narrow by segment-aligned path suffix
        if (pathSuffix != null && !pathSuffix.isBlank()) {
            List<String> suffixMatches = new ArrayList<>();
            for (String candidate : candidates) {
                if (isSegmentAlignedSuffixMatch(candidate, pathSuffix)) {
                    suffixMatches.add(candidate);
                }
            }
            if (!suffixMatches.isEmpty()) {
                candidates = suffixMatches;
            }
        }
        if (candidates.size() == 1) {
            return candidates.get(0);
        }

        // 2. Prefer a file currently open in the editor (most recent first)
        for (String recentPath : recentOpenPaths) {
            for (String candidate : candidates) {
                if (candidate.equals(recentPath)) {
                    return candidate;
                }
            }
        }

        // 3./4. Source-root heuristic, then shortest path as deterministic tiebreaker
        String best = null;
        int bestRank = -1;
        for (String candidate : candidates) {
            String normalized = candidate.replace('\\', '/');
            int rank;
            if (normalized.contains("/src/")) {
                rank = 0;
            } else if (normalized.contains("/main/")) {
                rank = 1;
            } else {
                rank = 2;
            }
            if (best == null
                    || rank < bestRank
                    || (rank == bestRank && candidate.length() < best.length())) {
                best = candidate;
                bestRank = rank;
            }
        }
        return best;
    }

    /**
     * Check whether {@code candidatePath} ends with (or contains, on segment
     * boundaries only) the given relative {@code suffix}. Both separators are
     * normalized to '/'.
     *
     * <p>"/project/blog/models.py" matches "blog/models.py";
     * "/project/myblog/models.py" does NOT - the occurrence must start right
     * after a '/' so a directory named "myblog" cannot satisfy "blog".</p>
     */
    // VisibleForTesting
    static boolean isSegmentAlignedSuffixMatch(String candidatePath, String suffix) {
        String candidate = candidatePath.replace('\\', '/');
        String target = suffix.replace('\\', '/');
        if (candidate.equals(target) || candidate.endsWith("/" + target)) {
            return true;
        }
        // Legacy "contains" behavior, restricted to segment-aligned occurrences
        int idx = candidate.indexOf(target);
        while (idx >= 0) {
            int end = idx + target.length();
            boolean startsOnSegment = idx == 0 || candidate.charAt(idx - 1) == '/';
            if (startsOnSegment && end == candidate.length()) {
                return true;
            }
            idx = candidate.indexOf(target, idx + 1);
        }
        return false;
    }

    /**
     * Extract the filename from a path string.
     * "src/utils/linkify.ts" -> "linkify.ts"
     * "linkify.ts" -> "linkify.ts"
     */
    // VisibleForTesting
    static String extractFileName(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }

        // Handle both Unix and Windows path separators
        int lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        if (lastSep >= 0 && lastSep < path.length() - 1) {
            return path.substring(lastSep + 1);
        }

        return path;
    }

    /**
     * Extract the path suffix for matching.
     * "src/utils/linkify.ts" -> "utils/linkify.ts"
     * Used to find files that match the directory structure hint.
     */
    // VisibleForTesting
    static String extractPathSuffix(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }

        // Skip the first directory segment if it's a common root
        String normalized = path.replace('\\', '/');
        String[] segments = normalized.split("/");

        if (segments.length <= 1) {
            return null;
        }

        // Find a meaningful suffix (skip common roots like "src", "main")
        int startIdx = 0;
        if (segments.length > 2) {
            String first = segments[0].toLowerCase();
            if ("src".equals(first) || "main".equals(first) || "java".equals(first) ||
                "kotlin".equals(first) || "webview".equals(first)) {
                startIdx = 1;
            }
        }

        if (startIdx >= segments.length - 1) {
            return null;
        }

        StringBuilder suffix = new StringBuilder();
        for (int i = startIdx; i < segments.length; i++) {
            if (suffix.length() > 0) {
                suffix.append('/');
            }
            suffix.append(segments[i]);
        }

        return suffix.toString();
    }

    private List<File> getResolutionBases() {
        LinkedHashSet<String> basePaths = new LinkedHashSet<>();

        if (context.getSession() != null) {
            String sessionCwd = context.getSession().getCwd();
            if (sessionCwd != null && !sessionCwd.isBlank()) {
                basePaths.add(sessionCwd);
            }
        }

        String customWorkingDirectory = resolveCustomWorkingDirectory();
        if (customWorkingDirectory != null) {
            basePaths.add(customWorkingDirectory);
        }

        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath != null && !projectBasePath.isBlank()) {
            basePaths.add(projectBasePath);
        }

        List<File> bases = new ArrayList<>();
        for (String basePath : basePaths) {
            File directory = normalizeExistingDirectory(basePath);
            if (directory != null) {
                bases.add(directory);
            }
        }
        return bases;
    }

    private String resolveCustomWorkingDirectory() {
        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath == null || projectBasePath.isBlank()) {
            return null;
        }

        try {
            String customWorkingDir = context.getSettingsService().getCustomWorkingDirectory(projectBasePath);
            if (customWorkingDir == null || customWorkingDir.isBlank()) {
                return null;
            }

            File workingDirectory = new File(customWorkingDir);
            if (!workingDirectory.isAbsolute()) {
                workingDirectory = new File(projectBasePath, customWorkingDir);
            }

            File canonicalDirectory = normalizeExistingDirectory(workingDirectory.getPath());
            return canonicalDirectory != null ? canonicalDirectory.getAbsolutePath() : null;
        } catch (Exception e) {
            LOG.warn("Failed to resolve custom working directory: " + e.getMessage());
            return null;
        }
    }

    private File normalizeExistingDirectory(String path) {
        if (path == null || path.isBlank()) {
            return null;
        }

        try {
            File directory = new File(path).getCanonicalFile();
            return directory.exists() && directory.isDirectory() ? directory : null;
        } catch (IOException e) {
            File directory = new File(path).getAbsoluteFile();
            return directory.exists() && directory.isDirectory() ? directory : null;
        }
    }

    private File normalizeExistingFile(File candidate) {
        try {
            File canonicalFile = candidate.getCanonicalFile();
            return canonicalFile.exists() && canonicalFile.isFile() ? canonicalFile : null;
        } catch (IOException e) {
            File absoluteFile = candidate.getAbsoluteFile();
            return absoluteFile.exists() && absoluteFile.isFile() ? absoluteFile : null;
        }
    }

    /**
     * Log a warning when an absolute path resolves outside the current project root.
     * Non-breaking: the file is still opened, but the audit trail records the access.
     */
    private void warnIfOutsideProjectRoot(File resolvedFile) {
        try {
            Project project = context.getProject();
            if (project == null || project.isDisposed()) {
                return;
            }
            String basePath = project.getBasePath();
            if (basePath == null || basePath.isBlank()) {
                return;
            }
            Path projectRoot = Paths.get(basePath).toAbsolutePath().normalize();
            Path resolvedPath = resolvedFile.toPath().toAbsolutePath().normalize();
            if (!resolvedPath.startsWith(projectRoot)) {
                LOG.warn("Opening file outside project root: " + resolvedPath);
            }
        } catch (Exception e) {
            // Best-effort audit logging; never block file open on warning failures.
            LOG.debug("Failed to evaluate project root scope: " + e.getMessage());
        }
    }

    /**
     * Open a virtual file in the editor, optionally navigating to a line range.
     */
    private void openInEditor(VirtualFile virtualFile, int lineNumber, int endLineNumber) {
        Project project = context.getProject();
        if (project == null || project.isDisposed()) {
            return;
        }

        if (lineNumber <= 0) {
            FileEditorManager.getInstance(project).openFile(virtualFile, true);
            return;
        }

        OpenFileDescriptor descriptor = new OpenFileDescriptor(project, virtualFile);
        Editor editor = FileEditorManager.getInstance(project).openTextEditor(descriptor, true);

        if (editor == null) {
            LOG.warn("Cannot open text editor: " + virtualFile.getPath());
            FileEditorManager.getInstance(project).openFile(virtualFile, true);
            return;
        }

        int lineCount = editor.getDocument().getLineCount();
        if (lineCount <= 0) {
            LOG.warn("File is empty, cannot navigate to line " + lineNumber);
            return;
        }

        int zeroBasedLine = Math.min(Math.max(0, lineNumber - 1), lineCount - 1);
        int startOffset = editor.getDocument().getLineStartOffset(zeroBasedLine);
        editor.getCaretModel().moveToOffset(startOffset);

        if (endLineNumber >= lineNumber) {
            int zeroBasedEndLine = Math.min(endLineNumber - 1, lineCount - 1);
            int endOffset = editor.getDocument().getLineEndOffset(zeroBasedEndLine);
            editor.getSelectionModel().setSelection(startOffset, endOffset);
        } else {
            editor.getSelectionModel().removeSelection();
        }

        editor.getScrollingModel().scrollToCaret(ScrollType.CENTER);
    }

    /**
     * Open the browser.
     */
    void handleOpenBrowser(String url) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                BrowserUtil.browse(url);
            } catch (Exception e) {
                LOG.error("Cannot open browser: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Open a URL in the system default browser, bypassing the IDE's embedded
     * JCEF preview. Used for external docs whose SPA pages render blank inside
     * JCEF (e.g. npm package pages behind Cloudflare). The platform's
     * BrowserUtil follows the IDE setting (which may pick the embedded
     * preview), so shell out to the OS "open URL" command instead.
     */
    void handleOpenBrowserExternal(String url) {
        if (url == null || url.isBlank()) {
            return;
        }
        // The webview gates this bridge event too, but any script in the
        // webview context can post it — re-validate server-side so a crafted
        // file:///javascript: URL never reaches the OS protocol handler.
        if (!isSafeExternalUrl(url)) {
            LOG.warn("Refusing to open external URL with disallowed scheme: " + url);
            return;
        }
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String[] command = PlatformUtils.isWindows()
                        ? new String[]{"rundll32", "url.dll,FileProtocolHandler", url}
                        : PlatformUtils.isMac()
                        ? new String[]{"open", url}
                        : new String[]{"xdg-open", url};
                new ProcessBuilder(command).start();
            } catch (Exception e) {
                LOG.error("Cannot open external browser: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    try {
                        BrowserUtil.browse(url);
                    } catch (Exception fallbackError) {
                        LOG.error("Fallback browse failed: " + fallbackError.getMessage(), fallbackError);
                    }
                });
            }
        });
    }

    /**
     * Allowlist of URL schemes that may be handed to the OS "open URL" command.
     * Mirrors {@code SAFE_BROWSER_PROTOCOLS} in webview/src/utils/bridge.ts.
     */
    static boolean isSafeExternalUrl(String url) {
        return url != null && SAFE_EXTERNAL_URL_PATTERN.matcher(url).matches();
    }

    /**
     * Build a fallback display path when the file cannot be found on disk.
     * For absolute paths, relativize against project root if possible.
     * For relative paths, prepend the session cwd (relative to project root)
     * so that sub-directory-relative paths become project-root-relative.
     */
    private String buildFallbackDisplayPath(String actualPath) {
        if (actualPath == null || actualPath.isBlank()) {
            return null;
        }

        if (isAbsoluteLikePath(actualPath)) {
            String normalizedPath = PlatformUtils.isWindows()
                ? PathUtils.convertMsysToWindowsPath(actualPath)
                : actualPath;
            return relativizeToProjectRoot(normalizedPath);
        }

        return relativizeFallbackRelativePath(actualPath);
    }

    /**
     * Resolve a file path to a project-root-relative display path without opening it.
     * Returns null if the path is outside the project root or cannot be resolved safely.
     */
    String resolveDisplayPath(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return null;
        }

        LineInfo lineInfo = parseLineInfo(filePath);
        String actualPath = lineInfo.actualPath();

        if (actualPath.contains(".." + File.separator) || actualPath.contains("../") || actualPath.contains("..\\")) {
            return buildFallbackDisplayPath(actualPath);
        }

        FileResolutionResult resolution = resolveFile(actualPath);
        if (resolution == null) {
            // Even when the file cannot be found on disk, try to produce a
            // project-root-relative display path so the tooltip shows the full
            // context instead of a bare sub-directory relative path.
            String fallback = buildFallbackDisplayPath(actualPath);
            return fallback;
        }

        String absolutePath;
        if (resolution.virtualFile() != null) {
            VirtualFile vf = resolution.virtualFile();
            if (!vf.isValid()) {
                return null;
            }
            absolutePath = vf.getPath();
        } else {
            absolutePath = resolution.file().getAbsolutePath();
        }

        return relativizeToProjectRoot(absolutePath);
    }

    private boolean isAbsoluteLikePath(String path) {
        return new File(path).isAbsolute()
            || path.startsWith("/")
            || path.startsWith("\\\\")
            || path.startsWith("//")
            || path.matches("^[A-Za-z]:[\\\\/].*");
    }

    /**
     * Builds a tooltip display path from a relative input path.
     *
     * <p>Resolution rules:
     * <ul>
     *   <li>Path stays inside the project root → project-relative path with
     *       forward slashes (e.g. {@code "src/Main.java"}).</li>
     *   <li>Path resolves outside the project root (e.g. {@code "../" }
     *       traversal) → canonical absolute path. This is a local IDE plugin
     *       and the path is not sensitive in the user's own session.</li>
     *   <li>No project / session context or canonicalization failure →
     *       {@code null}.</li>
     * </ul>
     *
     * <p>Note: {@link File#getCanonicalFile()} resolves symbolic links, so the
     * returned path may point to a different physical location than the input.
     */
    private String relativizeFallbackRelativePath(String relativePath) {
        try {
            Project project = context.getProject();
            if (project == null) {
                return null;
            }

            String basePath = project.getBasePath();
            if (basePath == null || basePath.isBlank()) {
                return null;
            }

            Path projectRoot = new File(NodeDetector.toVfsPath(basePath)).getCanonicalFile().toPath();
            Path baseDirectory = projectRoot;
            if (context.getSession() != null) {
                String sessionCwd = context.getSession().getCwd();
                if (sessionCwd != null && !sessionCwd.isBlank()) {
                    Path sessionPath = new File(NodeDetector.toVfsPath(sessionCwd)).getCanonicalFile().toPath();
                    if (sessionPath.startsWith(projectRoot)) {
                        baseDirectory = sessionPath;
                    }
                }
            }

            Path displayPath = baseDirectory.resolve(relativePath).normalize();
            if (displayPath.startsWith(projectRoot)) {
                return projectRoot.relativize(displayPath).toString().replace('\\', '/');
            }
            // Outside project root — surface the absolute path. See Javadoc.
            return displayPath.toString().replace('\\', '/');
        } catch (Exception e) {
            LOG.debug("Failed to build fallback tooltip path: " + e.getMessage());
            return null;
        }
    }

    /**
     * Builds a tooltip display path from an absolute input path.
     *
     * <p>Resolution rules:
     * <ul>
     *   <li>Absolute path resolves inside the project root → project-relative
     *       path with forward slashes (or {@code "."} if the path is the
     *       project root itself).</li>
     *   <li>Absolute path resolves outside the project root, or no project
     *       context is available → canonical absolute path. Surfacing the
     *       absolute path keeps the tooltip useful for cross-repo file
     *       references; this is a local IDE plugin and the path is not
     *       sensitive in the user's own session.</li>
     *   <li>Input is {@code null}/blank or canonicalization fails →
     *       {@code null}.</li>
     * </ul>
     *
     * <p>Note: {@link File#getCanonicalFile()} resolves symbolic links, so the
     * returned path may point to a different physical location than the input.
     */
    private String relativizeToProjectRoot(String absolutePath) {
        if (absolutePath == null || absolutePath.isBlank()) {
            return null;
        }

        Project project = context.getProject();
        String basePath = project != null ? project.getBasePath() : null;

        try {
            String vfsAbsolute = NodeDetector.toVfsPath(absolutePath);
            Path resolvedPath = new File(vfsAbsolute).getCanonicalFile().toPath();
            if (basePath != null && !basePath.isBlank()) {
                String vfsBase = NodeDetector.toVfsPath(basePath);
                Path projectRoot = new File(vfsBase).getCanonicalFile().toPath();
                if (resolvedPath.startsWith(projectRoot)) {
                    Path relativePath = projectRoot.relativize(resolvedPath);
                    String displayPath = relativePath.toString().replace('\\', '/');
                    return displayPath.isBlank() ? "." : displayPath;
                }
            }
            return resolvedPath.toString().replace('\\', '/');
        } catch (Exception e) {
            LOG.debug("Failed to relativize tooltip path: " + e.getMessage());
            return null;
        }
    }

    /**
     * Result of file resolution: either a File path or a VirtualFile from fuzzy matching.
     * At most one of the two fields will be non-null.
     */
    record FileResolutionResult(File file, VirtualFile virtualFile) {
    }

    record LineInfo(String actualPath, int lineNumber, int endLineNumber, boolean hasLineInfo) {
    }
}
