package com.github.claudecodegui.remote;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link RemoteToolEventTracker#markSeen} — the baseline snapshot
 * that prevents historical tool blocks from being replayed as new-task events
 * (Phase 2C-C.0 BUG B fix).
 */
public class RemoteToolEventTrackerBaselineTest {

    private static JsonObject toolUseRaw(String id, String name) {
        JsonObject raw = new JsonObject();
        JsonObject message = new JsonObject();
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        if (name != null) {
            block.addProperty("name", name);
        }
        content.add(block);
        message.add("content", content);
        raw.add("message", message);
        return raw;
    }

    private static JsonObject toolResultRaw(String id, boolean isError) {
        JsonObject raw = new JsonObject();
        JsonObject message = new JsonObject();
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", id);
        block.addProperty("is_error", isError);
        content.add(block);
        message.add("content", content);
        raw.add("message", message);
        return raw;
    }

    @Test
    public void baselinePreventsHistoricalToolEvents() {
        RemoteToolEventTracker tracker = new RemoteToolEventTracker();

        // Simulate session history: turn old had tools A and B.
        List<JsonObject> history = Arrays.asList(
                toolUseRaw("call_A", "bash"),
                toolResultRaw("call_A", false),
                toolUseRaw("call_B", "read"),
                toolResultRaw("call_B", true)  // failed
        );
        tracker.markSeen(history);

        // First onMessageUpdate delivers the full history → no events.
        List<RemoteToolEventTracker.ToolEvent> events = tracker.scan(history);
        assertTrue("historical tool blocks must produce zero events after baseline",
                events.isEmpty());
    }

    @Test
    public void newToolAfterBaselineEmitsEvents() {
        RemoteToolEventTracker tracker = new RemoteToolEventTracker();

        List<JsonObject> history = Arrays.asList(
                toolUseRaw("call_A", "bash"),
                toolResultRaw("call_A", false)
        );
        tracker.markSeen(history);

        // Now the current turn adds a new tool C.
        List<JsonObject> withNew = new ArrayList<>(history);
        withNew.add(toolUseRaw("call_C", "write"));
        withNew.add(toolResultRaw("call_C", false));

        List<RemoteToolEventTracker.ToolEvent> events = tracker.scan(withNew);
        assertEquals("only the new tool C must emit events", 2, events.size());
        assertEquals(RemoteToolEventTracker.ToolEventType.STARTED, events.get(0).type);
        assertEquals("call_C", events.get(0).toolUseId);
        assertEquals(RemoteToolEventTracker.ToolEventType.COMPLETED, events.get(1).type);
        assertEquals("call_C", events.get(1).toolUseId);
    }

    @Test
    public void fullHistoryReplayAfterBaselineStillOnlyEmitsNew() {
        RemoteToolEventTracker tracker = new RemoteToolEventTracker();

        // Baseline: history contains A (use+result), B (use only, no result).
        List<JsonObject> baseline = Arrays.asList(
                toolUseRaw("call_A", "bash"),
                toolResultRaw("call_A", false),
                toolUseRaw("call_B", "read")
        );
        tracker.markSeen(baseline);

        // Later, onMessageUpdate delivers full history PLUS new tool C use.
        List<JsonObject> withNew = new ArrayList<>(baseline);
        withNew.add(toolUseRaw("call_C", "write"));

        List<RemoteToolEventTracker.ToolEvent> events = tracker.scan(withNew);
        assertEquals("only C started", 1, events.size());
        assertEquals("call_C.start", "call_C", events.get(0).toolUseId);
        assertEquals(RemoteToolEventTracker.ToolEventType.STARTED, events.get(0).type);

        // Later update: full history + C result + B result (late).
        List<JsonObject> later = new ArrayList<>(baseline);
        later.add(toolUseRaw("call_C", "write"));
        later.add(toolResultRaw("call_C", false));
        later.add(toolResultRaw("call_B", false));

        List<RemoteToolEventTracker.ToolEvent> events2 = tracker.scan(later);
        assertEquals("C result + B result (B was historical, still gets result)",
                2, events2.size());
        // C result comes first (order in list), B result comes after.
        assertEquals("call_C", events2.get(0).toolUseId);
        assertEquals(RemoteToolEventTracker.ToolEventType.COMPLETED, events2.get(0).type);
        assertEquals("call_B", events2.get(1).toolUseId);
        assertEquals(RemoteToolEventTracker.ToolEventType.COMPLETED, events2.get(1).type);
    }

    @Test
    public void noBaselineEmitsAllAsExpected() {
        // Without baseline, all tool blocks are new → standard behavior.
        RemoteToolEventTracker tracker = new RemoteToolEventTracker();

        List<JsonObject> all = Arrays.asList(
                toolUseRaw("call_A", "bash"),
                toolResultRaw("call_A", false)
        );
        List<RemoteToolEventTracker.ToolEvent> events = tracker.scan(all);
        assertEquals(2, events.size());
        assertEquals("call_A", events.get(0).toolUseId);
        assertEquals(RemoteToolEventTracker.ToolEventType.STARTED, events.get(0).type);
    }

    @Test
    public void markSeenIsIdempotent() {
        RemoteToolEventTracker tracker = new RemoteToolEventTracker();
        List<JsonObject> history = Collections.singletonList(
                toolUseRaw("call_A", "bash"));
        tracker.markSeen(history);
        tracker.markSeen(history);  // no-op, no exception

        List<RemoteToolEventTracker.ToolEvent> events = tracker.scan(history);
        assertTrue(events.isEmpty());
    }

    @Test
    public void markSeenWithNullRawsDoesNotThrow() {
        RemoteToolEventTracker tracker = new RemoteToolEventTracker();
        tracker.markSeen(null);  // must not throw
        assertEquals(0, tracker.seenUseCount());
    }
}
