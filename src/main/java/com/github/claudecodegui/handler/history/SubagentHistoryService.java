package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Optional;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Reads Claude Code sidechain subagent logs for display inside Agent cards.
 */
class SubagentHistoryService {

    private static final Logger LOG = Logger.getInstance(SubagentHistoryService.class);
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]+");
    private static final Gson GSON = new Gson();
    private static final int MAX_JSONL_LINES = 50_000;

    private final HandlerContext context;

    SubagentHistoryService(HandlerContext context) {
        this.context = context;
    }

    void handleLoadSubagentSession(String content) {
        JsonObject request = parseRequest(content);
        String sessionId = getString(request, "sessionId");
        String agentId = getString(request, "agentId");
        String toolUseId = getString(request, "toolUseId");
        String description = getString(request, "description");
        int tail = getInt(request, "tail");

        JsonObject response = new JsonObject();
        response.addProperty("toolUseId", toolUseId);
        response.addProperty("agentId", agentId);
        response.addProperty("sessionId", sessionId);

        try {
            validateId("sessionId", sessionId);

            Path file = resolveSubagentFileByBestKey(sessionId, agentId, toolUseId, description);
            if (!Files.exists(file) || !Files.isRegularFile(file)) {
                response.addProperty("success", false);
                response.addProperty("error", "Subagent log not found");
                sendResponse(response);
                return;
            }

            String resolvedAgentId = extractAgentId(file);
            response.addProperty("agentId", resolvedAgentId);

            // Live-progress polls request only the transcript tail: repeatedly
            // serializing and eval'ing multi-MB agent logs in JCEF every few
            // seconds stalls the UI thread (reported as periodic freezes during
            // Workflow/ultracode runs with many parallel agents).
            JsonArray messages;
            boolean truncated = false;
            if (tail > 0) {
                JsonArray tailMessages = readJsonlTail(file, tail);
                messages = tailMessages;
                truncated = tailMessages.size() >= tail;
            } else {
                messages = readJsonl(file);
            }
            response.addProperty("success", true);
            response.addProperty("truncated", truncated);
            response.add("messages", messages);
        } catch (Exception e) {
            LOG.warn("[SubagentHistory] Failed to load subagent log: " + e.getMessage());
            response.addProperty("success", false);
            response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
        }

        sendResponse(response);
    }

    /**
     * Report the live status of a Workflow (ultracode) run.
     *
     * A Workflow's child agents live in
     * {@code <sessionId>/subagents/workflows/<runId>/} — their meta files carry
     * no description or toolUseId, so the regular subagent lookup cannot find
     * them. The run's {@code journal.jsonl} logs a {@code started} and a
     * {@code result} line per agent; this endpoint condenses it into
     * started/done counts plus per-agent previews for the Workflow card.
     */
    void handleLoadWorkflowStatus(String content) {
        JsonObject request = parseRequest(content);
        String sessionId = getString(request, "sessionId");
        String runId = getString(request, "runId");
        String toolUseId = getString(request, "toolUseId");

        JsonObject response = new JsonObject();
        response.addProperty("toolUseId", toolUseId);
        response.addProperty("runId", runId);
        response.addProperty("sessionId", sessionId);

        try {
            validateId("sessionId", sessionId);
            validateId("runId", runId);
            response.addProperty("requestedRunId", runId);

            Path workflowsRoot = Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKey())
                    .resolve(sessionId)
                    .resolve("subagents")
                    .resolve("workflows")
                    .normalize();

            // Foreground runs expose no run id until they finish; "latest"
            // resolves the most recently modified run directory instead.
            Path workflowDir;
            if ("latest".equals(runId)) {
                workflowDir = resolveLatestWorkflowDir(workflowsRoot);
                if (workflowDir == null) {
                    response.addProperty("success", false);
                    response.addProperty("error", "No workflow runs found");
                    sendWorkflowResponse(response);
                    return;
                }
                response.addProperty("runId", workflowDir.getFileName().toString());
            } else {
                workflowDir = workflowsRoot.resolve(runId).normalize();
            }
            Path journal = workflowDir.resolve("journal.jsonl");
            if (!Files.isRegularFile(journal)) {
                response.addProperty("success", false);
                response.addProperty("error", "Workflow journal not found");
                sendWorkflowResponse(response);
                return;
            }

            // agentId -> preview of its result ("" while still running)
            java.util.LinkedHashMap<String, String> agents = new java.util.LinkedHashMap<>();
            try (Stream<String> lines = Files.lines(journal, StandardCharsets.UTF_8)) {
                lines.filter(s -> !s.isBlank()).limit(MAX_JSONL_LINES).forEach(line -> {
                    try {
                        JsonObject entry = JsonParser.parseString(line).getAsJsonObject();
                        String type = getString(entry, "type");
                        String agentId = getString(entry, "agentId");
                        if (agentId == null) {
                            return;
                        }
                        if ("started".equals(type)) {
                            agents.putIfAbsent(agentId, null);
                        } else if ("result".equals(type)) {
                            String preview = entry.has("result") && !entry.get("result").isJsonNull()
                                    ? entry.get("result").toString()
                                    : "";
                            if (preview.length() > 300) {
                                preview = preview.substring(0, 300) + "…";
                            }
                            agents.put(agentId, preview);
                        }
                    } catch (JsonSyntaxException e) {
                        LOG.warn("Skipping malformed workflow journal line: " + e.getMessage());
                    }
                });
            }

            JsonArray agentArray = new JsonArray();
            int done = 0;
            for (var entry : agents.entrySet()) {
                JsonObject agent = new JsonObject();
                agent.addProperty("agentId", entry.getKey());
                boolean finished = entry.getValue() != null;
                agent.addProperty("done", finished);
                if (finished) {
                    done++;
                    agent.addProperty("resultPreview", entry.getValue());
                }
                agentArray.add(agent);
            }

            response.addProperty("success", true);
            response.addProperty("startedCount", agents.size());
            response.addProperty("doneCount", done);
            response.addProperty("updatedAtMs", lastModifiedMillis(journal));
            response.add("agents", agentArray);
        } catch (Exception e) {
            LOG.warn("[SubagentHistory] Failed to load workflow status: " + e.getMessage());
            response.addProperty("success", false);
            response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
        }

        sendWorkflowResponse(response);
    }

    private void sendWorkflowResponse(JsonObject response) {
        String payload = JsUtils.escapeJs(GSON.toJson(response));
        context.callJavaScript("onWorkflowStatusLoaded", payload);
    }

    private Path resolveLatestWorkflowDir(Path workflowsRoot) throws IOException {
        if (!Files.isDirectory(workflowsRoot)) {
            return null;
        }
        try (var stream = Files.list(workflowsRoot)) {
            return stream
                    .filter(Files::isDirectory)
                    .max(Comparator.comparingLong(this::lastModifiedMillis))
                    .orElse(null);
        }
    }

    private JsonObject parseRequest(String content) {
        if (content == null || content.trim().isEmpty()) {
            return new JsonObject();
        }
        return JsonParser.parseString(content).getAsJsonObject();
    }

    private static String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static int getInt(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return 0;
        }
        try {
            return object.get(key).getAsInt();
        } catch (Exception e) {
            return 0;
        }
    }

    private static void validateId(String name, String value) {
        if (value == null || value.isEmpty() || !SAFE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Invalid " + name);
        }
    }

    private Path resolveSubagentFile(String sessionId, String agentId) {
        validateId("agentId", agentId);
        Path projectDir = Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKey());
        return projectDir.resolve(sessionId)
                .resolve("subagents")
                .resolve("agent-" + agentId + ".jsonl")
                .normalize();
    }

    /**
     * Resolve the subagent transcript by the strongest key available:
     * agentId (filename-exact) → toolUseId (unique per spawn, known to the
     * webview from the tool_use block even while the agent is still RUNNING) →
     * description (weakest: distinct spawns may share a description).
     */
    private Path resolveSubagentFileByBestKey(
            String sessionId, String agentId, String toolUseId, String description) throws IOException {
        if (agentId != null && !agentId.isEmpty()) {
            return resolveSubagentFile(sessionId, agentId);
        }
        if (toolUseId != null && !toolUseId.isEmpty()) {
            Path byToolUse = resolveSubagentFileByMetaField(sessionId, "toolUseId", toolUseId);
            if (byToolUse != null && Files.exists(byToolUse)) {
                return byToolUse;
            }
        }
        return resolveSubagentFileByDescription(sessionId, description);
    }

    /**
     * Scan the session's subagent meta files for one whose {@code fieldName}
     * equals {@code expected}; newest wins. Returns null when nothing matches
     * (the caller falls back to the next weaker key).
     */
    private Path resolveSubagentFileByMetaField(String sessionId, String fieldName, String expected) throws IOException {
        if (expected == null || expected.isEmpty() || !SAFE_ID.matcher(expected).matches()) {
            return null; // malformed key — fall back to the next weaker one
        }
        Path subagentsDir = Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKey())
                .resolve(sessionId)
                .resolve("subagents")
                .normalize();
        if (!Files.isDirectory(subagentsDir)) {
            return null;
        }
        try (var stream = Files.list(subagentsDir)) {
            return stream
                    .filter(path -> path.getFileName().toString().endsWith(".meta.json"))
                    .filter(path -> expected.equals(readMetaField(path, fieldName)))
                    .max(Comparator.comparingLong(this::lastModifiedMillis))
                    .map(this::metaToJsonl)
                    .orElse(null);
        }
    }

    private String readMetaField(Path metaFile, String fieldName) {
        try {
            JsonObject meta = JsonParser.parseString(Files.readString(metaFile, StandardCharsets.UTF_8)).getAsJsonObject();
            return getString(meta, fieldName);
        } catch (Exception e) {
            return null;
        }
    }

    private Path resolveSubagentFileByDescription(String sessionId, String description) throws IOException {
        if (description == null || description.isEmpty()) {
            throw new IllegalArgumentException("Missing agentId and description");
        }
        Path subagentsDir = Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKey())
                .resolve(sessionId)
                .resolve("subagents")
                .normalize();
        if (!Files.isDirectory(subagentsDir)) {
            return subagentsDir.resolve("missing.jsonl");
        }

        try (var stream = Files.list(subagentsDir)) {
            Optional<Path> meta = stream
                    .filter(path -> path.getFileName().toString().endsWith(".meta.json"))
                    .filter(path -> description.equals(readMetaField(path, "description")))
                    .max(Comparator.comparingLong(this::lastModifiedMillis));
            return meta.map(this::metaToJsonl).orElse(subagentsDir.resolve("missing.jsonl"));
        }
    }

    private long lastModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private Path metaToJsonl(Path metaFile) {
        String name = metaFile.getFileName().toString().replaceFirst("\\.meta\\.json$", ".jsonl");
        return metaFile.resolveSibling(name);
    }

    private String extractAgentId(Path jsonlFile) {
        String name = jsonlFile.getFileName().toString();
        if (name.startsWith("agent-") && name.endsWith(".jsonl")) {
            return name.substring("agent-".length(), name.length() - ".jsonl".length());
        }
        return null;
    }

    private String projectKey() {
        String rawPath = context.getProject().getBasePath();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String basePath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        if (basePath == null || basePath.isEmpty()) {
            throw new IllegalStateException("Project base path is null");
        }
        return PathUtils.sanitizePath(basePath);
    }

    private JsonArray readJsonl(Path file) throws IOException {
        JsonArray messages = new JsonArray();
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            lines.filter(s -> !s.isBlank())
                    .limit(MAX_JSONL_LINES)
                    .forEach(line -> {
                        try {
                            messages.add(JsonParser.parseString(line));
                        } catch (JsonSyntaxException e) {
                            LOG.warn("Skipping malformed JSONL line in subagent history: " + e.getMessage());
                        }
                    });
        }
        return messages;
    }

    /**
     * Read only the last {@code tail} JSONL records. Raw lines are buffered in a
     * bounded deque and parsed only for the surviving tail, so a multi-MB agent
     * log costs one linear scan and {@code tail} parses instead of a full parse.
     */
    private JsonArray readJsonlTail(Path file, int tail) throws IOException {
        java.util.ArrayDeque<String> window = new java.util.ArrayDeque<>(tail);
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            lines.filter(s -> !s.isBlank())
                    .limit(MAX_JSONL_LINES)
                    .forEach(line -> {
                        if (window.size() == tail) {
                            window.pollFirst();
                        }
                        window.addLast(line);
                    });
        }
        JsonArray messages = new JsonArray();
        for (String line : window) {
            try {
                messages.add(JsonParser.parseString(line));
            } catch (JsonSyntaxException e) {
                LOG.warn("Skipping malformed JSONL line in subagent history tail: " + e.getMessage());
            }
        }
        return messages;
    }

    private void sendResponse(JsonObject response) {
        String payload = JsUtils.escapeJs(GSON.toJson(response));
        context.callJavaScript("onSubagentHistoryLoaded", payload);
    }
}
