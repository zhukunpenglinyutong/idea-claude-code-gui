package com.github.claudecodegui.remote;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;

/**
 * Pure-logic tests for {@link RemoteToolEventTracker} — tool_use/tool_result
 * derivation + deduplication.
 */
public class RemoteToolEventTrackerTest {

    private RemoteToolEventTracker tracker;

    @Before
    public void setUp() {
        tracker = new RemoteToolEventTracker();
    }

    @Test
    public void firstToolUseEmitsStartedOnce() {
        JsonObject raw = assistantRaw(toolUse("t1", "Bash"));
        List<RemoteToolEventTracker.ToolEvent> events = tracker.scan(Collections.singletonList(raw));
        assertEquals(1, events.size());
        assertEquals(RemoteToolEventTracker.ToolEventType.STARTED, events.get(0).type);
        assertEquals("t1", events.get(0).toolUseId);
        assertEquals("Bash", events.get(0).tool);

        // Repeated full-list update — no duplicate.
        assertEquals(0, tracker.scan(Collections.singletonList(raw)).size());
    }

    @Test
    public void toolResultEmitsCompleted() {
        tracker.scan(Collections.singletonList(assistantRaw(toolUse("t1", "Bash"))));
        List<RemoteToolEventTracker.ToolEvent> events =
                tracker.scan(Collections.singletonList(userRaw(toolResult("t1", false))));
        assertEquals(1, events.size());
        assertEquals(RemoteToolEventTracker.ToolEventType.COMPLETED, events.get(0).type);
        // Repeated — idempotent.
        assertEquals(0, tracker.scan(Collections.singletonList(userRaw(toolResult("t1", false)))).size());
    }

    @Test
    public void errorResultEmitsFailed() {
        tracker.scan(Collections.singletonList(assistantRaw(toolUse("t1", "Bash"))));
        List<RemoteToolEventTracker.ToolEvent> events =
                tracker.scan(Collections.singletonList(userRaw(toolResult("t1", true))));
        assertEquals(1, events.size());
        assertEquals(RemoteToolEventTracker.ToolEventType.FAILED, events.get(0).type);
    }

    @Test
    public void differentToolUseIdsIndependent() {
        List<RemoteToolEventTracker.ToolEvent> events = tracker.scan(Arrays.asList(
                assistantRaw(toolUse("t1", "Bash")),
                assistantRaw(toolUse("t2", "Read"))));
        assertEquals(2, events.size());
        assertEquals("t1", events.get(0).toolUseId);
        assertEquals("t2", events.get(1).toolUseId);
    }

    @Test
    public void resultBeforeRepeatedUpdatesRemainsIdempotent() {
        JsonObject use = assistantRaw(toolUse("t1", "Bash"));
        JsonObject result = userRaw(toolResult("t1", false));
        tracker.scan(Collections.singletonList(use));
        tracker.scan(Collections.singletonList(result));
        // A full-list update containing both again must not re-emit.
        assertEquals(0, tracker.scan(Arrays.asList(use, result)).size());
    }

    @Test
    public void resetClearsSeenIds() {
        tracker.scan(Collections.singletonList(assistantRaw(toolUse("t1", "Bash"))));
        tracker.reset();
        List<RemoteToolEventTracker.ToolEvent> events =
                tracker.scan(Collections.singletonList(assistantRaw(toolUse("t1", "Bash"))));
        assertEquals(1, events.size());
        assertEquals(RemoteToolEventTracker.ToolEventType.STARTED, events.get(0).type);
    }

    private static JsonObject toolUse(String id, String name) {
        JsonObject b = new JsonObject();
        b.addProperty("type", "tool_use");
        b.addProperty("id", id);
        b.addProperty("name", name);
        return b;
    }

    private static JsonObject toolResult(String toolUseId, boolean isError) {
        JsonObject b = new JsonObject();
        b.addProperty("type", "tool_result");
        b.addProperty("tool_use_id", toolUseId);
        b.addProperty("is_error", isError);
        return b;
    }

    private static JsonObject assistantRaw(JsonObject block) {
        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        raw.add("message", message);
        return raw;
    }

    private static JsonObject userRaw(JsonObject block) {
        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.add("message", message);
        return raw;
    }
}
