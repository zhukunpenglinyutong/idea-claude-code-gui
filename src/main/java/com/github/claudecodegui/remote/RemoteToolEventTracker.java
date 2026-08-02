package com.github.claudecodegui.remote;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Derives {@code tool.started}/{@code tool.completed}/{@code tool.failed}
 * events from {@code onMessageUpdate} raw message blocks, with per-tool-use-id
 * deduplication.
 *
 * <p>The desktop callback layer has no explicit tool lifecycle states (see
 * Phase 2C-A §5) — a tool's progress is inferred from the presence of
 * {@code tool_use} and {@code tool_result} blocks. This tracker remembers which
 * ids it has already emitted so repeated full-list {@code message_update}s do
 * not produce duplicate events.
 *
 * <p>Pure logic (operates on {@link JsonObject} raws) — testable without the
 * IntelliJ platform.
 */
public final class RemoteToolEventTracker {

    public enum ToolEventType { STARTED, COMPLETED, FAILED }

    public static final class ToolEvent {
        public final ToolEventType type;
        public final String toolUseId;
        public final String tool;

        public ToolEvent(ToolEventType type, String toolUseId, String tool) {
            this.type = type;
            this.toolUseId = toolUseId;
            this.tool = tool;
        }
    }

    private final Set<String> seenToolUse = ConcurrentHashMap.newKeySet();
    private final Set<String> seenToolResult = ConcurrentHashMap.newKeySet();

    /**
     * Scan a full message list's raw blocks and return only the <em>new</em>
     * tool events (first sighting of each tool_use_id / tool_result).
     */
    public List<ToolEvent> scan(List<JsonObject> raws) {
        List<ToolEvent> out = new ArrayList<>();
        if (raws == null) {
            return out;
        }
        for (JsonObject raw : raws) {
            scanOne(raw, out);
        }
        return out;
    }

    private void scanOne(JsonObject raw, List<ToolEvent> out) {
        if (raw == null) {
            return;
        }
        JsonElement messageEl = raw.get("message");
        if (messageEl == null || !messageEl.isJsonObject()) {
            return;
        }
        JsonElement contentEl = messageEl.getAsJsonObject().get("content");
        if (contentEl == null || !contentEl.isJsonArray()) {
            return;
        }
        JsonArray blocks = contentEl.getAsJsonArray();
        for (JsonElement be : blocks) {
            if (!be.isJsonObject()) {
                continue;
            }
            JsonObject block = be.getAsJsonObject();
            String type = jsonStr(block, "type");
            if ("tool_use".equals(type)) {
                String id = jsonStr(block, "id");
                if (id == null || id.isEmpty()) {
                    id = jsonStr(block, "tool_use_id");
                }
                if (id != null && !id.isEmpty() && seenToolUse.add(id)) {
                    out.add(new ToolEvent(ToolEventType.STARTED, id, jsonStr(block, "name")));
                }
            } else if ("tool_result".equals(type)) {
                String id = jsonStr(block, "tool_use_id");
                if (id == null || id.isEmpty()) {
                    id = jsonStr(block, "id");
                }
                if (id != null && !id.isEmpty() && seenToolResult.add(id)) {
                    boolean isError = block.has("is_error") && block.get("is_error").getAsBoolean();
                    out.add(new ToolEvent(
                            isError ? ToolEventType.FAILED : ToolEventType.COMPLETED, id, null));
                }
            }
        }
    }

    private static String jsonStr(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        return obj.get(key).getAsString();
    }

    /**
     * Pre-populate the seen sets from a snapshot of the current session history
     * so historical tool blocks are not replayed as new events when a fresh
     * RemoteTask's first {@code onMessageUpdate} delivers the full message list
     * (Phase 2C-C.0 BUG B fix).
     *
     * <p>Called after task creation but before the tap is installed, so the very
     * first onMessageUpdate (which includes every message the session already
     * holds) skips blocks that belong to any previous turn.
     */
    public void markSeen(List<JsonObject> raws) {
        if (raws == null) {
            return;
        }
        for (JsonObject raw : raws) {
            markSeenInRaw(raw);
        }
    }

    private void markSeenInRaw(JsonObject raw) {
        if (raw == null) {
            return;
        }
        JsonElement messageEl = raw.get("message");
        if (messageEl == null || !messageEl.isJsonObject()) {
            return;
        }
        JsonElement contentEl = messageEl.getAsJsonObject().get("content");
        if (contentEl == null || !contentEl.isJsonArray()) {
            return;
        }
        JsonArray blocks = contentEl.getAsJsonArray();
        for (JsonElement be : blocks) {
            if (!be.isJsonObject()) {
                continue;
            }
            JsonObject block = be.getAsJsonObject();
            String type = jsonStr(block, "type");
            if ("tool_use".equals(type)) {
                String id = jsonStr(block, "id");
                if (id == null || id.isEmpty()) {
                    id = jsonStr(block, "tool_use_id");
                }
                if (id != null && !id.isEmpty()) {
                    seenToolUse.add(id);
                }
            } else if ("tool_result".equals(type)) {
                String id = jsonStr(block, "tool_use_id");
                if (id == null || id.isEmpty()) {
                    id = jsonStr(block, "id");
                }
                if (id != null && !id.isEmpty()) {
                    seenToolResult.add(id);
                }
            }
        }
    }

    public void reset() {
        seenToolUse.clear();
        seenToolResult.clear();
    }

    public int seenUseCount() {
        return seenToolUse.size();
    }

    public int seenResultCount() {
        return seenToolResult.size();
    }
}
