package com.github.claudecodegui.provider.minimax;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.HistoryPathMatcher;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads MiniMax Code (mcode) session history from its on-disk v2 layout.
 *
 * <p>Layout (mcode 0.2.x):
 * {@code ~/.minimax/v2/sessions/YYYY/MM/DD/&lt;HH-mm-ss-ms&gt;-session_&lt;base64&gt;/}
 * containing {@code snapshot.json} (record + displayMessages) plus
 * {@code display.jsonl} (event log fallback).
 *
 * <p>{@code snapshot.json} shape:
 * <pre>
 * {
 *   "record": {
 *     "sessionId": "mvs_...", "workspaceDir": "...", "title": "...",
 *     "createdAtMs": 1, "updatedAtMs": 2, "effectiveModel": "minimax/MiniMax-M3"
 *   },
 *   "displayMessages": [
 *     {"msg_id":"umsg_1","role":"user","msg_type":1,"msg_content":"...","timestamp":1},
 *     {"msg_id":"...","role":"assistant","msg_content":"...","thinking_content":"...",
 *      "tool_calls":[{"tool_name":"bash","tool_call_id":"...","tool_call_status":2,
 *                    "tool_call_args":"{...}","tool_call_result_data":"{...}"}]}
 *   ]
 * }
 * </pre>
 *
 * <p>Path matching is case-insensitive and normalizes {@code \} → {@code /} for Windows.
 */
public class MiniMaxHistoryReader {

    private static final Logger LOG = Logger.getInstance(MiniMaxHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;

    private final Gson gson;
    private final Path minimaxHome;
    private final Path sessionsRoot;

    public MiniMaxHistoryReader() {
        this(defaultMiniMaxHome(), new Gson());
    }

    MiniMaxHistoryReader(Path minimaxHome, Gson gson) {
        this.minimaxHome = minimaxHome;
        this.sessionsRoot = minimaxHome.resolve(Paths.get("v2", "sessions"));
        this.gson = gson;
    }

    private static Path defaultMiniMaxHome() {
        String home = NodeDetector.resolveHomeForFileOps();
        String override = firstNonBlank(
                System.getenv("MINIMAX_CODE_HOME"),
                System.getenv("MINIMAX_HOME")
        );
        if (override != null) {
            return Paths.get(override.trim());
        }
        return Paths.get(home, ".minimax");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "minimax";
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            result.put("provider", "minimax");
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            result.put("total", totalMessages);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[MiniMaxHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read MiniMax sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    public List<SessionInfo> listSessionsForProject(String projectPath) throws IOException {
        List<SessionInfo> all = listAllSessions();
        if (projectPath == null || projectPath.trim().isEmpty()) {
            return all;
        }
        List<SessionInfo> filtered = new ArrayList<>();
        for (SessionInfo session : all) {
            if (session.cwd != null && pathsMatch(session.cwd, projectPath)) {
                filtered.add(session);
            }
        }
        filtered.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return filtered;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        if (!Files.isDirectory(sessionsRoot)) {
            LOG.info("[MiniMaxHistoryReader] Sessions root missing: " + sessionsRoot);
            return sessions;
        }
        // v2/sessions/YYYY/MM/DD/<session-dir>
        try (DirectoryStream<Path> years = Files.newDirectoryStream(sessionsRoot)) {
            for (Path year : years) {
                if (!Files.isDirectory(year)) {
                    continue;
                }
                try (DirectoryStream<Path> months = Files.newDirectoryStream(year)) {
                    for (Path month : months) {
                        if (!Files.isDirectory(month)) {
                            continue;
                        }
                        try (DirectoryStream<Path> days = Files.newDirectoryStream(month)) {
                            for (Path day : days) {
                                if (!Files.isDirectory(day)) {
                                    continue;
                                }
                                collectSessionDirs(day, sessions);
                            }
                        }
                    }
                }
            }
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private void collectSessionDirs(Path dayDir, List<SessionInfo> out) {
        try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(dayDir)) {
            for (Path sessionDir : sessionDirs) {
                if (!Files.isDirectory(sessionDir)) {
                    continue;
                }
                SessionInfo info = readSessionSummary(sessionDir);
                if (info != null) {
                    out.add(info);
                }
            }
        } catch (IOException e) {
            LOG.warn("[MiniMaxHistoryReader] Failed to scan " + dayDir + ": " + e.getMessage());
        }
    }

    private SessionInfo readSessionSummary(Path sessionDir) {
        try {
            Path snapshotPath = sessionDir.resolve("snapshot.json");
            if (!Files.isRegularFile(snapshotPath)) {
                return null;
            }
            JsonObject snapshot = JsonParser
                    .parseString(Files.readString(snapshotPath, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            JsonObject record = snapshot.has("record") && snapshot.get("record").isJsonObject()
                    ? snapshot.getAsJsonObject("record") : null;
            if (record == null) {
                return null;
            }
            String sessionId = text(record, "sessionId");
            if (sessionId == null || sessionId.isBlank()) {
                return null;
            }

            SessionInfo info = new SessionInfo();
            info.sessionId = sessionId;
            info.cwd = text(record, "workspaceDir");
            info.title = truncate(firstNonBlank(
                    text(record, "title"),
                    deriveTitleFromSnapshot(snapshot)
            ), MAX_TITLE_CHARS);
            info.firstTimestamp = longVal(record, "createdAtMs", 0L);
            info.lastTimestamp = longVal(record, "updatedAtMs", info.firstTimestamp);
            if (info.lastTimestamp <= 0) {
                try {
                    info.lastTimestamp = Files.getLastModifiedTime(snapshotPath).toMillis();
                } catch (IOException ignored) {
                }
            }

            JsonArray displayMessages = snapshot.has("displayMessages")
                    && snapshot.get("displayMessages").isJsonArray()
                    ? snapshot.getAsJsonArray("displayMessages") : null;
            info.messageCount = displayMessages != null ? displayMessages.size() : 0;

            info.fileSize = Files.size(snapshotPath);
            Path displayPath = sessionDir.resolve("display.jsonl");
            if (Files.isRegularFile(displayPath)) {
                info.fileSize += Files.size(displayPath);
            }
            return info;
        } catch (Exception e) {
            LOG.warn("[MiniMaxHistoryReader] Failed to read session summary " + sessionDir + ": " + e.getMessage());
            return null;
        }
    }

    private static String deriveTitleFromSnapshot(JsonObject snapshot) {
        JsonArray messages = snapshot.has("displayMessages")
                && snapshot.get("displayMessages").isJsonArray()
                ? snapshot.getAsJsonArray("displayMessages") : null;
        if (messages == null) {
            return "";
        }
        for (JsonElement el : messages) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject msg = el.getAsJsonObject();
            if ("user".equals(text(msg, "role"))) {
                String content = text(msg, "msg_content");
                if (content != null && !content.isBlank()) {
                    return content;
                }
            }
        }
        return "";
    }

    /**
     * Loads one session's messages as Claude-shaped JSON objects.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        Path sessionDir = resolveSessionDir(sessionId, cwd);
        if (sessionDir == null) {
            return new ArrayList<>();
        }

        // Preferred source: snapshot.json displayMessages.
        Path snapshotPath = sessionDir.resolve("snapshot.json");
        if (Files.isRegularFile(snapshotPath)) {
            try {
                JsonObject snapshot = JsonParser
                        .parseString(Files.readString(snapshotPath, StandardCharsets.UTF_8))
                        .getAsJsonObject();
                if (snapshot.has("displayMessages")
                        && snapshot.get("displayMessages").isJsonArray()
                        && snapshot.getAsJsonArray("displayMessages").size() > 0) {
                    return buildMessages(snapshot.getAsJsonArray("displayMessages"));
                }
            } catch (Exception e) {
                LOG.warn("[MiniMaxHistoryReader] Failed to parse snapshot.json, falling back to display.jsonl: "
                        + e.getMessage());
            }
        }

        // Fallback: replay display.jsonl events, deduplicating upserts by msg_id.
        Path displayPath = sessionDir.resolve("display.jsonl");
        if (Files.isRegularFile(displayPath)) {
            return parseDisplayJsonl(displayPath);
        }
        return new ArrayList<>();
    }

    private Path resolveSessionDir(String sessionId, String cwd) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            return null;
        }
        String wanted = sessionId.trim();
        Path best = null;
        if (!Files.isDirectory(sessionsRoot)) {
            return null;
        }
        // Session dirs are dated mcode-internal names; match by the sessionId
        // inside snapshot.json instead of guessing the dir naming scheme.
        try (DirectoryStream<Path> years = Files.newDirectoryStream(sessionsRoot)) {
            for (Path year : years) {
                if (!Files.isDirectory(year)) {
                    continue;
                }
                try (DirectoryStream<Path> months = Files.newDirectoryStream(year)) {
                    for (Path month : months) {
                        if (!Files.isDirectory(month)) {
                            continue;
                        }
                        try (DirectoryStream<Path> days = Files.newDirectoryStream(month)) {
                            for (Path day : days) {
                                if (!Files.isDirectory(day)) {
                                    continue;
                                }
                                try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(day)) {
                                    for (Path sessionDir : sessionDirs) {
                                        if (!Files.isDirectory(sessionDir)) {
                                            continue;
                                        }
                                        // Read snapshot.json once per dir — the record
                                        // carries both the id and the workspace.
                                        JsonObject record = readSessionRecord(sessionDir);
                                        if (record == null || !wanted.equals(text(record, "sessionId"))) {
                                            continue;
                                        }
                                        // Prefer a session whose workspace matches cwd.
                                        if (cwd != null && !cwd.isBlank()) {
                                            String ws = text(record, "workspaceDir");
                                            if (ws != null && pathsMatch(ws, cwd)) {
                                                return sessionDir;
                                            }
                                        }
                                        if (best == null) {
                                            best = sessionDir;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return best;
    }

    /**
     * Reads the {@code record} object from a session's snapshot.json, or null
     * when the snapshot is missing or malformed.
     */
    private static JsonObject readSessionRecord(Path sessionDir) {
        try {
            Path snapshotPath = sessionDir.resolve("snapshot.json");
            if (!Files.isRegularFile(snapshotPath)) {
                return null;
            }
            JsonObject snapshot = JsonParser
                    .parseString(Files.readString(snapshotPath, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            return snapshot.has("record") && snapshot.get("record").isJsonObject()
                    ? snapshot.getAsJsonObject("record") : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Converts mcode displayMessages into Claude-shaped messages:
     * user text, assistant thinking / text, tool_use, and tool_result.
     */
    private static List<JsonObject> buildMessages(JsonArray displayMessages) {
        List<JsonObject> messages = new ArrayList<>();
        int counter = 0;
        for (JsonElement el : displayMessages) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject msg = el.getAsJsonObject();
            String role = text(msg, "role");
            if ("user".equals(role)) {
                String content = text(msg, "msg_content");
                if (content == null || content.isBlank()) {
                    continue;
                }
                counter++;
                messages.add(buildUserTextMessage(content, "minimax-user-" + counter));
            } else if ("assistant".equals(role)) {
                String thinking = text(msg, "thinking_content");
                if (thinking != null && !thinking.isBlank()) {
                    counter++;
                    messages.add(buildAssistantThinkingMessage(thinking, "minimax-think-" + counter));
                }
                String content = text(msg, "msg_content");
                if (content != null && !content.isBlank()) {
                    counter++;
                    messages.add(buildAssistantTextMessage(content, "minimax-text-" + counter));
                }
                if (msg.has("tool_calls") && msg.get("tool_calls").isJsonArray()) {
                    for (JsonElement callEl : msg.getAsJsonArray("tool_calls")) {
                        if (!callEl.isJsonObject()) {
                            continue;
                        }
                        JsonObject call = callEl.getAsJsonObject();
                        String callId = firstNonBlank(text(call, "tool_call_id"),
                                text(call, "toolCallId"));
                        if (callId == null || callId.isBlank()) {
                            callId = "minimax-tool-" + (++counter);
                        }
                        String name = firstNonBlank(text(call, "tool_name"), text(call, "toolName"));
                        if (name == null || name.isBlank()) {
                            name = "tool";
                        }
                        JsonObject input = parseJsonObject(text(call, "tool_call_args"));
                        messages.add(buildToolUseMessage(callId, name, input));

                        String resultData = firstNonBlank(text(call, "tool_call_result_data"),
                                text(call, "toolCallResultData"));
                        String resultText = extractToolResultText(resultData);
                        if (!resultText.isBlank()) {
                            messages.add(buildToolResultMessage(
                                    callId, truncate(resultText, MAX_TOOL_RESULT_CHARS),
                                    isErrorResult(resultData)));
                        }
                    }
                }
            }
        }
        return messages;
    }

    /**
     * Fallback parser for display.jsonl: keeps the latest display_upserted
     * event per msg_id (upserts may re-emit updated tool results).
     */
    private List<JsonObject> parseDisplayJsonl(Path displayPath) throws IOException {
        // LinkedHashMap: the stable timestamp sort below keeps first-seen
        // (file) order for messages sharing a timestamp.
        Map<String, JsonObject> latestById = new LinkedHashMap<>();
        Map<String, Long> seqById = new HashMap<>();
        List<String> lines = Files.readAllLines(displayPath, StandardCharsets.UTF_8);
        for (String line : lines) {
            line = line.trim();
            if (line.isEmpty()) {
                continue;
            }
            JsonObject obj;
            try {
                obj = JsonParser.parseString(line).getAsJsonObject();
            } catch (Exception e) {
                continue;
            }
            if (!"message.display_upserted".equals(text(obj, "kind"))) {
                continue;
            }
            String msgId = text(obj, "msgId");
            if (msgId == null || msgId.isBlank()) {
                continue;
            }
            long seq = longVal(obj, "seq", -1L);
            Long prev = seqById.get(msgId);
            if (prev == null || seq >= prev) {
                seqById.put(msgId, seq);
                JsonObject message = obj.has("message") && obj.get("message").isJsonObject()
                        ? obj.getAsJsonObject("message") : null;
                if (message != null) {
                    latestById.put(msgId, message);
                }
            }
        }
        JsonArray ordered = new JsonArray();
        latestById.entrySet().stream()
                .sorted(Map.Entry.comparingByValue(
                        Comparator.comparingLong((JsonObject m) -> longVal(m, "timestamp", 0L))))
                .forEach(entry -> ordered.add(entry.getValue()));
        return buildMessages(ordered);
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        Path sessionDir = resolveSessionDir(sessionId, projectPath);
        if (sessionDir == null) {
            return false;
        }
        deleteRecursively(sessionDir);
        Path parent = sessionDir.getParent();
        pruneEmptyDirs(parent, 3);
        return true;
    }

    private static void pruneEmptyDirs(Path dir, int depth) {
        if (dir == null || depth <= 0) {
            return;
        }
        try {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
                if (stream.iterator().hasNext()) {
                    return;
                }
            }
            Files.deleteIfExists(dir);
            pruneEmptyDirs(dir.getParent(), depth - 1);
        } catch (IOException ignored) {
        }
    }

    private static void deleteRecursively(Path root) throws IOException {
        // NOFOLLOW_LINKS: a (crafted) symlink inside a session dir must be
        // deleted as a link, never recursed into — otherwise the contents of
        // the directory it points at would be wiped along with the session.
        if (root == null || !Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(root)) {
                for (Path child : stream) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(root);
    }

    // ------------------------------------------------------------------
    // Message builders (Claude-shaped, same as KimiHistoryReader)
    // ------------------------------------------------------------------

    private static JsonObject buildUserTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildAssistantTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildAssistantThinkingMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "thinking");
        block.addProperty("thinking", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildToolUseMessage(String id, String name, JsonObject input) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", name);
        block.add("input", input != null ? input : new JsonObject());
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildToolResultMessage(String toolUseId, String contentText, boolean isError) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("is_error", isError);
        block.addProperty("content", contentText != null ? contentText : "");
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    /**
     * mcode tool results are JSON strings like
     * {@code {"content":[{"type":"text","text":"..."}]}}.
     */
    private static String extractToolResultText(String resultData) {
        if (resultData == null || resultData.isBlank()) {
            return "";
        }
        JsonObject obj = parseJsonObject(resultData);
        if (obj == null) {
            return resultData;
        }
        if (obj.has("content") && obj.get("content").isJsonArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonElement el : obj.getAsJsonArray("content")) {
                if (el.isJsonPrimitive()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(el.getAsString());
                    continue;
                }
                if (!el.isJsonObject()) {
                    continue;
                }
                String t = text(el.getAsJsonObject(), "text");
                if (t != null && !t.isEmpty()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(t);
                }
            }
            if (sb.length() > 0) {
                return sb.toString();
            }
        }
        if (obj.has("error") && !obj.get("error").isJsonNull()) {
            JsonElement err = obj.get("error");
            return err.isJsonPrimitive() ? err.getAsString() : err.toString();
        }
        return obj.toString();
    }

    /**
     * Structured error check: only a non-null top-level {@code "error"} field
     * marks the result as failed. A raw substring match would false-positive
     * on tool output that merely quotes JSON containing the word "error".
     */
    private static boolean isErrorResult(String resultData) {
        JsonObject obj = parseJsonObject(resultData);
        return obj != null && obj.has("error") && !obj.get("error").isJsonNull();
    }

    private static JsonObject parseJsonObject(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            JsonElement el = JsonParser.parseString(raw);
            return el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    static String normalizePath(String path) {
        return HistoryPathMatcher.normalize(path);
    }

    static boolean pathsMatch(String sessionCwd, String projectPath) {
        return HistoryPathMatcher.matches(sessionCwd, projectPath);
    }

    static boolean isSafeSessionId(String sessionId) {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return false;
        }
        String trimmed = sessionId.trim();
        if (trimmed.equals(".") || trimmed.contains("..")
                || trimmed.contains("/") || trimmed.contains("\\")) {
            return false;
        }
        return trimmed.matches("^[A-Za-z0-9._-]+$");
    }

    private static String text(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(key);
        return el.isJsonPrimitive() ? el.getAsString() : null;
    }

    private static long longVal(JsonObject obj, String key, long fallback) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return fallback;
        }
        try {
            return obj.get(key).getAsLong();
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static String truncate(String value, int maxChars) {
        if (value == null) {
            return "";
        }
        return value.length() <= maxChars ? value : value.substring(0, maxChars) + "…";
    }
}
