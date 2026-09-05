package com.github.claudecodegui.provider.codebuddy;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.HistoryPathMatcher;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/** Reads CodeBuddy's project JSONL transcripts from ~/.codebuddy/projects. */
public class CodeBuddyHistoryReader {

    private static final Logger LOG = Logger.getInstance(CodeBuddyHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private final Gson gson;
    private final Path projectsRoot;

    public CodeBuddyHistoryReader() {
        this(defaultProjectsRoot(), new Gson());
    }

    CodeBuddyHistoryReader(Path projectsRoot, Gson gson) {
        this.projectsRoot = projectsRoot;
        this.gson = gson;
    }

    private static Path defaultProjectsRoot() {
        String home = NodeDetector.resolveHomeForFileOps();
        String configured = System.getenv("CODEBUDDY_HOME");
        Path root = configured != null && !configured.isBlank()
                ? Paths.get(configured.trim()) : Paths.get(home, ".codebuddy");
        return root.resolve("projects");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "codebuddy";
        public String model;
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("provider", "codebuddy");
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            result.put("total", sessions.stream().mapToInt(s -> s.messageCount).sum());
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.warn("[CodeBuddyHistoryReader] Failed to list sessions: " + e.getMessage());
            Map<String, Object> result = new HashMap<>();
            result.put("success", false);
            result.put("provider", "codebuddy");
            result.put("sessions", List.of());
            result.put("error", e.getMessage());
            return gson.toJson(result);
        }
    }

    public List<SessionInfo> listSessionsForProject(String projectPath) throws IOException {
        List<SessionInfo> sessions = listAllSessions();
        if (projectPath == null || projectPath.isBlank()) {
            return sessions;
        }
        sessions.removeIf(s -> s.cwd == null || !HistoryPathMatcher.matches(s.cwd, projectPath));
        return sessions;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        if (!Files.isDirectory(projectsRoot)) {
            return sessions;
        }
        try (Stream<Path> paths = Files.walk(projectsRoot)) {
            paths.filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(".jsonl"))
                    .forEach(path -> {
                        try {
                            SessionInfo info = readSummary(path);
                            if (info != null) {
                                sessions.add(info);
                            }
                        } catch (Exception e) {
                            LOG.debug("[CodeBuddyHistoryReader] Skipping " + path + ": " + e.getMessage());
                        }
                    });
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        Path file = findSessionFile(sessionId, cwd);
        if (file == null) {
            return List.of();
        }
        return parseMessages(file, sessionId);
    }

    public boolean deleteSession(String sessionId, String cwd) throws IOException {
        Path file = findSessionFile(sessionId, cwd);
        return file != null && Files.deleteIfExists(file);
    }

    private SessionInfo readSummary(Path file) throws IOException {
        String id = null;
        String cwd = null;
        String model = null;
        String title = null;
        int count = 0;
        long first = 0L;
        long last = fileTime(file);
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                JsonObject obj = parseObject(line);
                if (obj == null) {
                    continue;
                }
                id = firstNonBlank(id, text(obj, "session_id"), text(obj, "sessionId"), text(obj, "session_uuid"));
                cwd = firstNonBlank(cwd, text(obj, "cwd"), text(obj, "working_directory"), text(obj, "project_path"));
                model = firstNonBlank(model, text(obj, "model"), nestedText(obj, "message", "model"));
                long timestamp = timestamp(obj);
                if (timestamp > 0) {
                    if (first == 0) {
                        first = timestamp;
                    }
                    last = Math.max(last, timestamp);
                }
                String type = text(obj, "type");
                JsonObject message = object(obj, "message");
                String role = firstNonBlank(text(obj, "role"), message != null ? text(message, "role") : null);
                if ("user".equals(role) || "assistant".equals(role)) {
                    count++;
                    if (title == null && "user".equals(role)) {
                        title = extractText(message != null ? message.get("content") : obj.get("content"));
                    }
                } else if ("user".equals(type) || "assistant".equals(type)) {
                    count++;
                    if (title == null && "user".equals(type)) {
                        title = extractText(message != null ? message.get("content") : obj.get("content"));
                    }
                }
            }
        }
        if (id == null || id.isBlank() || count == 0) {
            return null;
        }
        SessionInfo info = new SessionInfo();
        info.sessionId = id;
        info.cwd = cwd;
        info.title = truncate(title != null ? title : "CodeBuddy session " + id, MAX_TITLE_CHARS);
        info.messageCount = count;
        info.firstTimestamp = first;
        info.lastTimestamp = last;
        info.fileSize = Files.size(file);
        info.model = model;
        return info;
    }

    private List<JsonObject> parseMessages(Path file, String sessionId) throws IOException {
        List<JsonObject> messages = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                JsonObject obj = parseObject(line);
                if (obj == null) {
                    continue;
                }
                String recordId = firstNonBlank(text(obj, "session_id"), text(obj, "sessionId"), text(obj, "session_uuid"));
                if (recordId != null && sessionId != null && !sessionId.equals(recordId)) {
                    continue;
                }
                String type = text(obj, "type");
                JsonObject message = object(obj, "message");
                String role = firstNonBlank(text(obj, "role"), message != null ? text(message, "role") : null);
                if (!"user".equals(role) && !"assistant".equals(role)
                        && !"user".equals(type) && !"assistant".equals(type)) {
                    continue;
                }
                if (message == null) {
                    message = new JsonObject();
                    message.addProperty("role", role != null ? role : type);
                    if (obj.has("content")) {
                        message.add("content", obj.get("content"));
                    }
                }
                JsonObject normalized = new JsonObject();
                normalized.addProperty("type", role != null ? role : type);
                normalized.add("message", message.deepCopy());
                if (obj.has("uuid")) {
                    normalized.add("uuid", obj.get("uuid"));
                }
                if (obj.has("timestamp")) {
                    normalized.add("timestamp", obj.get("timestamp"));
                }
                messages.add(normalized);
            }
        }
        return messages;
    }

    private Path findSessionFile(String sessionId, String cwd) throws IOException {
        if (sessionId == null || sessionId.isBlank() || !Files.isDirectory(projectsRoot)) {
            return null;
        }
        try (Stream<Path> paths = Files.walk(projectsRoot)) {
            Iterator<Path> iterator = paths.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".jsonl")).iterator();
            while (iterator.hasNext()) {
                Path path = iterator.next();
                if (matchesSessionFile(path, sessionId, cwd)) {
                    return path;
                }
            }
        }
        return null;
    }

    /** Match session metadata without loading an entire transcript into memory. */
    private boolean matchesSessionFile(Path path, String sessionId, String cwd) throws IOException {
        boolean sessionMatched = false;
        boolean cwdMatched = cwd == null || cwd.isBlank();
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                JsonObject obj = parseObject(line);
                if (obj == null) {
                    continue;
                }
                String recordId = firstNonBlank(
                        text(obj, "session_id"), text(obj, "sessionId"), text(obj, "session_uuid"));
                if (sessionId.equals(recordId)) {
                    sessionMatched = true;
                }
                String recordCwd = firstNonBlank(
                        text(obj, "cwd"), text(obj, "working_directory"), text(obj, "project_path"));
                if (!cwdMatched && recordCwd != null && HistoryPathMatcher.matches(recordCwd, cwd)) {
                    cwdMatched = true;
                }
                if (sessionMatched && cwdMatched) {
                    return true;
                }
            }
        }
        return false;
    }

    private static JsonObject parseObject(String line) {
        try {
            JsonElement value = JsonParser.parseString(line);
            return value.isJsonObject() ? value.getAsJsonObject() : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static JsonObject object(JsonObject obj, String key) {
        return obj != null && obj.has(key) && obj.get(key).isJsonObject() ? obj.getAsJsonObject(key) : null;
    }

    private static String nestedText(JsonObject obj, String parent, String key) {
        JsonObject nested = object(obj, parent);
        return nested != null ? text(nested, key) : null;
    }

    private static String text(JsonObject obj, String key) {
        try { return obj != null && obj.has(key) && !obj.get(key).isJsonNull() ? obj.get(key).getAsString() : null; }
        catch (Exception ignored) { return null; }
    }

    private static long timestamp(JsonObject obj) {
        String value = firstNonBlank(text(obj, "timestamp"), text(obj, "created_at"), text(obj, "createdAt"));
        if (value == null) {
            return 0L;
        }
        try {
            return Long.parseLong(value);
        } catch (Exception ignored) {
            // Try the ISO-8601 representation below.
        }
        try {
            return Instant.parse(value).toEpochMilli();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static long fileTime(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ignored) {
            return 0L;
        }
    }

    private static String extractText(JsonElement content) {
        if (content == null || content.isJsonNull()) {
            return "";
        }
        if (content.isJsonPrimitive()) {
            return content.getAsString();
        }
        if (!content.isJsonArray()) {
            return "";
        }
        StringBuilder result = new StringBuilder();
        for (JsonElement item : content.getAsJsonArray()) {
            if (item.isJsonPrimitive()) {
                result.append(item.getAsString());
            } else if (item.isJsonObject()) {
                String value = text(item.getAsJsonObject(), "text");
                if (value != null) {
                    result.append(value);
                }
            }
        }
        return result.toString();
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return null;
    }

    private static String truncate(String value, int max) {
        String text = value != null ? value.trim() : "";
        return text.length() <= max ? text : text.substring(0, max) + "…";
    }
}
