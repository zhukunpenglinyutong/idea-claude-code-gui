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

            Path file = agentId != null && !agentId.isEmpty()
                    ? resolveSubagentFile(sessionId, agentId)
                    : resolveSubagentFileByDescription(sessionId, description);
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
                    .filter(path -> description.equals(readDescription(path)))
                    .max(Comparator.comparingLong(this::lastModifiedMillis));
            return meta.map(this::metaToJsonl).orElse(subagentsDir.resolve("missing.jsonl"));
        }
    }

    private String readDescription(Path metaFile) {
        try {
            JsonObject meta = JsonParser.parseString(Files.readString(metaFile, StandardCharsets.UTF_8)).getAsJsonObject();
            return getString(meta, "description");
        } catch (Exception e) {
            return null;
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
