package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Service for deleting session history files and related data.
 */
class HistoryDeleteService {

    private static final Logger LOG = Logger.getInstance(HistoryDeleteService.class);
    private static final Gson GSON = new Gson();

    // Reject anything outside [A-Za-z0-9._-] to defeat path-traversal payloads such as "../foo"
    // before they reach Path.resolve. Session IDs in both providers are alphanumeric/UUID style.
    private static final Pattern SESSION_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._-]+$");

    static boolean isValidSessionId(String sessionId) {
        return sessionId != null && SESSION_ID_PATTERN.matcher(sessionId).matches();
    }

    private final HandlerContext context;
    private final NodeJsServiceCaller nodeJsServiceCaller;
    private final HistoryLoadService historyLoadService;

    HistoryDeleteService(HandlerContext context, NodeJsServiceCaller nodeJsServiceCaller, HistoryLoadService historyLoadService) {
        this.context = context;
        this.nodeJsServiceCaller = nodeJsServiceCaller;
        this.historyLoadService = historyLoadService;
    }

    /**
     * Delete session history files.
     * Deletes the .jsonl file for the specified sessionId and related agent-xxx.jsonl files.
     */
    void handleDeleteSession(String sessionId, String currentProvider) {
        if (!isValidSessionId(sessionId)) {
            LOG.warn("[HistoryHandler] Delete session rejected: invalid sessionId");
            return;
        }
        quiesceActiveSessionForDeletion(
                context.getSession(), Collections.singleton(sessionId), currentProvider)
                .thenRunAsync(() -> {
                    try {
                        LOG.info("[HistoryHandler] ========== Delete session start ==========");
                        LOG.info("[HistoryHandler] SessionId: " + sessionId + ", Provider: " + currentProvider);

                        DeleteResult result = deleteSessionFiles(sessionId, currentProvider);

                        LOG.info("[HistoryHandler] Delete completed - Main file: " + (result.mainDeleted ? "deleted" : "not found") + ", Agent files: " + result.agentFilesDeleted);

                        if (result.mainDeleted) {
                            cleanupSessionMetadata(sessionId);
                        }
                        cleanupCache(currentProvider);

                        LOG.info("[HistoryHandler] Reloading history data...");
                        historyLoadService.handleLoadHistoryData(currentProvider);

                    } catch (Exception e) {
                        LOG.error("[HistoryHandler] Delete session failed: " + e.getMessage(), e);
                    }
                }).exceptionally(ex -> {
                    handleQuiesceFailure("deletion", currentProvider, ex);
                    return null;
                });
    }

    /**
     * Batch delete session history files in one backend request.
     */
    void handleDeleteSessions(String content, String currentProvider) {
        List<String> sessionIds = parseSessionIds(content);
        if (sessionIds.isEmpty()) {
            LOG.warn("[HistoryHandler] Batch delete failed: empty sessionIds");
            return;
        }

        quiesceActiveSessionForDeletion(context.getSession(), sessionIds, currentProvider)
                .thenRunAsync(() -> {
                    try {
                        LOG.info("[HistoryHandler] ========== Batch delete sessions start ==========");
                        LOG.info("[HistoryHandler] SessionIds: " + GSON.toJson(sessionIds) + ", Provider: " + currentProvider);

                        int mainDeletedCount = 0;
                        int agentFilesDeletedCount = 0;

                        if ("codex".equals(currentProvider)) {
                            CodexBatchDeleteResult result = deleteCodexSessions(sessionIds);
                            mainDeletedCount = result.deletedSessionIds.size();
                            for (String sessionId : result.deletedSessionIds) {
                                cleanupSessionMetadata(sessionId);
                            }
                            LOG.info("[HistoryHandler] Deleted Codex rollout files: " + result.deletedFileCount);
                        } else {
                            for (String sessionId : sessionIds) {
                                try {
                                    DeleteResult result = deleteSessionFiles(sessionId, currentProvider);
                                    if (result.mainDeleted) {
                                        mainDeletedCount++;
                                        cleanupSessionMetadata(sessionId);
                                    }
                                    agentFilesDeletedCount += result.agentFilesDeleted;
                                } catch (Exception e) {
                                    LOG.error("[HistoryHandler] Batch delete single session failed: " + sessionId + " - " + e.getMessage(), e);
                                }
                            }
                        }

                        cleanupCache(currentProvider);

                        LOG.info("[HistoryHandler] Batch delete completed - Main files: " + mainDeletedCount + "/" + sessionIds.size()
                                + ", Agent files: " + agentFilesDeletedCount);
                        LOG.info("[HistoryHandler] Reloading history data...");
                        historyLoadService.handleLoadHistoryData(currentProvider);
                    } catch (Exception e) {
                        LOG.error("[HistoryHandler] Batch delete sessions failed: " + e.getMessage(), e);
                    }
                }).exceptionally(ex -> {
                    handleQuiesceFailure("batch deletion", currentProvider, ex);
                    return null;
                });
    }

    private void handleQuiesceFailure(String action, String currentProvider, Throwable error) {
        LOG.warn("[HistoryHandler] Failed to stop active session before " + action
                + ": " + error.getMessage(), error);
        try {
            historyLoadService.handleLoadHistoryData(currentProvider);
        } catch (Exception reloadError) {
            LOG.warn("[HistoryHandler] Failed to restore history after aborted " + action
                    + ": " + reloadError.getMessage(), reloadError);
        }
    }

    static CompletableFuture<Void> quiesceActiveSessionForDeletion(
            ClaudeSession session,
            Collection<String> sessionIds,
            String currentProvider
    ) {
        if (session == null || sessionIds == null || sessionIds.isEmpty()) {
            return CompletableFuture.completedFuture(null);
        }
        String activeSessionId = session.getSessionId();
        if (activeSessionId == null
                || !sessionIds.contains(activeSessionId)
                || !Objects.equals(session.getProvider(), currentProvider)) {
            return CompletableFuture.completedFuture(null);
        }
        return session.interrupt();
    }

    static List<String> parseSessionIds(String content) {
        LinkedHashSet<String> sessionIds = new LinkedHashSet<>();
        if (content == null || content.trim().isEmpty()) {
            return new ArrayList<>();
        }

        try {
            JsonElement parsed = JsonParser.parseString(content);
            if (parsed.isJsonArray()) {
                collectSessionIds(parsed.getAsJsonArray(), sessionIds);
            } else if (parsed.isJsonObject()) {
                JsonObject object = parsed.getAsJsonObject();
                JsonElement sessionIdsElement = object.get("sessionIds");
                if (sessionIdsElement != null && sessionIdsElement.isJsonArray()) {
                    collectSessionIds(sessionIdsElement.getAsJsonArray(), sessionIds);
                }
            }
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] Batch delete sessionIds parse failed: " + e.getMessage());
        }

        return new ArrayList<>(sessionIds);
    }

    private static void collectSessionIds(JsonArray array, LinkedHashSet<String> sessionIds) {
        for (JsonElement element : array) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                continue;
            }

            String sessionId = element.getAsString().trim();
            if (sessionId.isEmpty()) {
                continue;
            }
            if (!isValidSessionId(sessionId)) {
                LOG.warn("[HistoryHandler] Batch delete ignored invalid sessionId");
                continue;
            }
            sessionIds.add(sessionId);
        }
    }

    private DeleteResult deleteSessionFiles(String sessionId, String currentProvider) throws java.io.IOException {
        if (!isValidSessionId(sessionId)) {
            LOG.warn("[HistoryHandler] Delete session rejected: invalid sessionId");
            return new DeleteResult(false, 0);
        }
        if ("codex".equals(currentProvider)) {
            return new DeleteResult(deleteCodexSession(sessionId), 0);
        }

        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        if (projectPath == null) {
            LOG.warn("[HistoryHandler] Project base path is null, cannot delete Claude session");
            return new DeleteResult(false, 0);
        }

        int[] result = deleteClaudeSession(sessionId, projectPath);
        return new DeleteResult(result[0] == 1, result[1]);
    }

    private boolean deleteCodexSession(String sessionId) throws java.io.IOException {
        return deleteCodexSessions(Collections.singleton(sessionId)).deletedSessionIds.contains(sessionId);
    }

    private CodexBatchDeleteResult deleteCodexSessions(Collection<String> sessionIds) throws java.io.IOException {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        Path sessionDir = Paths.get(homeDir, ".codex", "sessions");

        if (!Files.exists(sessionDir)) {
            LOG.error("[HistoryHandler] Codex session directory not found: " + sessionDir);
            return new CodexBatchDeleteResult(Collections.emptySet(), 0);
        }

        Map<String, List<Path>> matchesBySession = findCodexSessionFiles(sessionDir, sessionIds);
        Map<Path, LinkedHashSet<String>> ownersByPath = new LinkedHashMap<>();
        for (Map.Entry<String, List<Path>> entry : matchesBySession.entrySet()) {
            for (Path path : entry.getValue()) {
                ownersByPath.computeIfAbsent(path, ignored -> new LinkedHashSet<>()).add(entry.getKey());
            }
        }

        LinkedHashSet<String> deletedSessionIds = new LinkedHashSet<>();
        LinkedHashSet<Path> failedPaths = new LinkedHashSet<>();
        int deletedFileCount = 0;
        for (Map.Entry<Path, LinkedHashSet<String>> entry : ownersByPath.entrySet()) {
            Path sessionFile = entry.getKey();
            try {
                if (Files.deleteIfExists(sessionFile)) {
                    LOG.info("[HistoryHandler] Deleted Codex session file: " + sessionFile);
                    deletedFileCount++;
                }
            } catch (Exception e) {
                failedPaths.add(sessionFile);
                LOG.error("[HistoryHandler] Failed to delete Codex session file: " + sessionFile + " - " + e.getMessage(), e);
            }
        }
        for (Map.Entry<String, List<Path>> entry : matchesBySession.entrySet()) {
            if (isCodexSessionDeletionComplete(entry.getValue(), failedPaths)) {
                deletedSessionIds.add(entry.getKey());
            }
        }
        return new CodexBatchDeleteResult(deletedSessionIds, deletedFileCount);
    }

    static boolean isCodexSessionDeletionComplete(
            Collection<Path> matchedPaths,
            Collection<Path> failedPaths
    ) {
        return matchedPaths != null
                && !matchedPaths.isEmpty()
                && Collections.disjoint(matchedPaths, failedPaths);
    }

    /**
     * Find the requested Codex rollout and every descendant subagent rollout.
     * Subagents use their own UUID in the filename and link back to the displayed
     * parent conversation through session_meta.source.subagent.thread_spawn.parent_thread_id.
     */
    static List<Path> findCodexSessionFiles(Path sessionDir, String sessionId) throws java.io.IOException {
        Map<String, List<Path>> matches = findCodexSessionFiles(
                sessionDir, Collections.singleton(sessionId));
        return matches.getOrDefault(sessionId, Collections.emptyList());
    }

    static Map<String, List<Path>> findCodexSessionFiles(
            Path sessionDir,
            Collection<String> sessionIds
    ) throws java.io.IOException {
        List<CodexSessionFile> candidates;
        try (Stream<Path> paths = Files.walk(sessionDir)) {
            candidates = paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .map(path -> new CodexSessionFile(path, readCodexSessionLink(path)))
                    .collect(Collectors.toList());
        }

        Map<String, List<Path>> matches = new LinkedHashMap<>();
        for (String sessionId : sessionIds) {
            if (sessionId != null && !matches.containsKey(sessionId)) {
                matches.put(sessionId, findCodexSessionFiles(candidates, sessionId));
            }
        }
        return matches;
    }

    private static List<Path> findCodexSessionFiles(List<CodexSessionFile> candidates, String sessionId) {
        LinkedHashSet<String> matchedSessionIds = new LinkedHashSet<>();
        matchedSessionIds.add(sessionId);
        LinkedHashSet<Path> matchedFiles = new LinkedHashSet<>();

        boolean changed;
        do {
            changed = false;
            for (CodexSessionFile candidate : candidates) {
                if (matchedFiles.contains(candidate.path)) {
                    continue;
                }

                CodexSessionLink link = candidate.link;
                boolean directFileMatch = isCodexSessionFileMatch(candidate.path, sessionId);
                boolean sessionMatch = link.sessionId != null && matchedSessionIds.contains(link.sessionId);
                boolean parentMatch = link.parentThreadId != null
                        && matchedSessionIds.contains(link.parentThreadId);
                if (!directFileMatch && !sessionMatch && !parentMatch) {
                    continue;
                }

                matchedFiles.add(candidate.path);
                changed = true;
                if ((sessionMatch || parentMatch) && link.sessionId != null) {
                    matchedSessionIds.add(link.sessionId);
                }
            }
        } while (changed);

        return new ArrayList<>(matchedFiles);
    }

    private static CodexSessionLink readCodexSessionLink(Path path) {
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String firstLine = reader.readLine();
            if (firstLine == null || firstLine.isEmpty()) {
                return CodexSessionLink.EMPTY;
            }

            JsonElement parsed = JsonParser.parseString(firstLine);
            if (!parsed.isJsonObject()) {
                return CodexSessionLink.EMPTY;
            }
            JsonObject root = parsed.getAsJsonObject();
            if (!"session_meta".equals(getJsonString(root, "type"))) {
                return CodexSessionLink.EMPTY;
            }

            JsonObject payload = getJsonObject(root, "payload");
            String rolloutSessionId = getJsonString(payload, "id");
            JsonObject source = getJsonObject(payload, "source");
            JsonObject subagent = getJsonObject(source, "subagent");
            JsonObject threadSpawn = getJsonObject(subagent, "thread_spawn");
            String parentThreadId = getJsonString(threadSpawn, "parent_thread_id");
            return new CodexSessionLink(rolloutSessionId, parentThreadId);
        } catch (Exception e) {
            LOG.debug("[HistoryHandler] Failed to parse Codex session metadata: " + path.getFileName(), e);
            return CodexSessionLink.EMPTY;
        }
    }

    private static JsonObject getJsonObject(JsonObject parent, String field) {
        if (parent == null) {
            return null;
        }
        JsonElement element = parent.get(field);
        return element != null && element.isJsonObject() ? element.getAsJsonObject() : null;
    }

    private static String getJsonString(JsonObject parent, String field) {
        if (parent == null) {
            return null;
        }
        JsonElement element = parent.get(field);
        return element != null && element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()
                ? element.getAsString()
                : null;
    }

    /**
     * Match Codex rollout filenames whose UUID suffix equals the session ID.
     * Real format: rollout-{ISO timestamp}-{sessionId}.jsonl, so we anchor to "-{sessionId}.jsonl"
     * to avoid removing neighbouring sessions whose UUIDs share a substring.
     */
    static boolean isCodexSessionFileMatch(Path path, String sessionId) {
        if (path == null || sessionId == null || sessionId.isEmpty()) {
            return false;
        }
        String fileName = path.getFileName().toString();
        return fileName.endsWith("-" + sessionId + ".jsonl");
    }

    /**
     * @return int[2]: [mainDeleted(0/1), agentFilesDeleted]
     */
    private int[] deleteClaudeSession(String sessionId, String projectPath) throws java.io.IOException {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        Path claudeDir = Paths.get(homeDir, ".claude");
        Path projectsDir = claudeDir.resolve("projects");
        String sanitizedPath = PathUtils.sanitizePath(projectPath);
        Path sessionDir = projectsDir.resolve(sanitizedPath);

        if (!Files.exists(sessionDir)) {
            LOG.error("[HistoryHandler] Claude project directory not found: " + sessionDir);
            return new int[]{0, 0};
        }

        boolean mainDeleted = false;
        int agentFilesDeleted = 0;

        // Delete main session file
        Path mainSessionFile = sessionDir.resolve(sessionId + ".jsonl").normalize();
        if (!mainSessionFile.startsWith(sessionDir.normalize())) {
            LOG.warn("[HistoryHandler] Refused out-of-bounds path: " + mainSessionFile);
            return new int[]{0, 0};
        }
        if (Files.exists(mainSessionFile)) {
            Files.delete(mainSessionFile);
            LOG.info("[HistoryHandler] Deleted main session file: " + mainSessionFile.getFileName());
            mainDeleted = true;
        } else {
            LOG.warn("[HistoryHandler] Main session file not found: " + mainSessionFile.getFileName());
        }

        // Delete related agent files
        try (Stream<Path> stream = Files.list(sessionDir)) {
            List<Path> agentFiles = stream
                    .filter(path -> {
                        String filename = path.getFileName().toString();
                        return filename.startsWith("agent-") && filename.endsWith(".jsonl")
                                && isAgentFileRelatedToSession(path, sessionId);
                    })
                    .collect(Collectors.toList());

            for (Path agentFile : agentFiles) {
                try {
                    Files.delete(agentFile);
                    LOG.info("[HistoryHandler] Deleted related agent file: " + agentFile.getFileName());
                    agentFilesDeleted++;
                } catch (Exception e) {
                    LOG.error("[HistoryHandler] Failed to delete agent file: " + agentFile.getFileName() + " - " + e.getMessage(), e);
                }
            }
        }

        return new int[]{mainDeleted ? 1 : 0, agentFilesDeleted};
    }

    private void cleanupSessionMetadata(String sessionId) {
        try {
            nodeJsServiceCaller.callNodeJsFavoritesService("removeFavorite", sessionId);
            nodeJsServiceCaller.callNodeJsDeleteTitle(sessionId);
            LOG.info("[HistoryHandler] Cleaned up session metadata");
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] Failed to clean up metadata (does not affect deletion): " + e.getMessage());
        }
    }

    private void cleanupCache(String currentProvider) {
        try {
            String rawPath2 = context.resolveEffectiveWorkingDirectory();
            String nodePath2 = NodeDetector.getInstance().getCachedNodePath();
            String projectPath = NodeDetector.isWslPath(nodePath2) ? NodeDetector.convertToWslPath(rawPath2) : rawPath2;
            if ("codex".equals(currentProvider)) {
                SessionIndexCache.getInstance().clearAllCodexCache();
                SessionIndexManager.getInstance().clearAllCodexIndex();
            } else if (projectPath != null) {
                SessionIndexCache.getInstance().clearProject(projectPath);
                SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
            }
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] Failed to clean up cache (does not affect deletion): " + e.getMessage());
        }
    }

    /**
     * Check if an agent file belongs to the specified session.
     */
    private boolean isAgentFileRelatedToSession(Path agentFilePath, String sessionId) {
        try (BufferedReader reader = Files.newBufferedReader(agentFilePath, StandardCharsets.UTF_8)) {
            String line;
            int lineCount = 0;
            // Only read the first 20 lines for performance
            while ((line = reader.readLine()) != null && lineCount < 20) {
                if (line.contains("\"sessionId\":\"" + sessionId + "\"") ||
                            line.contains("\"parentSessionId\":\"" + sessionId + "\"")) {
                    LOG.debug("[HistoryHandler] Agent file " + agentFilePath.getFileName() + " belongs to session " + sessionId);
                    return true;
                }
                lineCount++;
            }
            LOG.debug("[HistoryHandler] Agent file " + agentFilePath.getFileName() + " does not belong to session " + sessionId);
            return false;
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] Failed to read agent file " + agentFilePath.getFileName() + ": " + e.getMessage());
            return false;
        }
    }

    private static class DeleteResult {
        private final boolean mainDeleted;
        private final int agentFilesDeleted;

        private DeleteResult(boolean mainDeleted, int agentFilesDeleted) {
            this.mainDeleted = mainDeleted;
            this.agentFilesDeleted = agentFilesDeleted;
        }
    }

    private static class CodexSessionFile {
        private final Path path;
        private final CodexSessionLink link;

        private CodexSessionFile(Path path, CodexSessionLink link) {
            this.path = path;
            this.link = link;
        }
    }

    private static class CodexSessionLink {
        private static final CodexSessionLink EMPTY = new CodexSessionLink(null, null);

        private final String sessionId;
        private final String parentThreadId;

        private CodexSessionLink(String sessionId, String parentThreadId) {
            this.sessionId = sessionId;
            this.parentThreadId = parentThreadId;
        }
    }

    private static class CodexBatchDeleteResult {
        private final Collection<String> deletedSessionIds;
        private final int deletedFileCount;

        private CodexBatchDeleteResult(Collection<String> deletedSessionIds, int deletedFileCount) {
            this.deletedSessionIds = deletedSessionIds;
            this.deletedFileCount = deletedFileCount;
        }
    }
}
