package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DaemonBridgeTest {

    // HEARTBEAT_TIMEOUT_MS = 45_000; just over threshold triggers unresponsive
    private static final long JUST_OVER_HEARTBEAT_THRESHOLD = 46_000;
    // ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000; well over for active-request timeout
    private static final long OVER_ACTIVE_REQUEST_THRESHOLD = 190_000;
    // Recent activity within threshold
    private static final long RECENT_ACTIVITY = 5_000;

    @Test
    public void staleHeartbeatWithoutActiveRequestsIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, JUST_OVER_HEARTBEAT_THRESHOLD, 0));
    }

    @Test
    public void activeRequestWithRecentOutputGetsGraceWindow() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, RECENT_ACTIVITY, 1));
    }

    @Test
    public void activeRequestWithNoRecentOutputEventuallyTimesOut() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(OVER_ACTIVE_REQUEST_THRESHOLD, OVER_ACTIVE_REQUEST_THRESHOLD, 1));
    }

    /**
     * Regression: a background_turn daemon event must be forwarded to
     * registered listeners so ClaudeChatWindow can show the "generating
     * response" indicator for a turn the GUI never started (e.g. a background
     * workflow). Previously handleDaemonEvent had no case for it, so the event
     * fell through to default and the indicator never appeared.
     */
    @Test
    public void backgroundTurnEventIsDispatchedToListeners() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        List<String> events = new ArrayList<>();
        List<String> states = new ArrayList<>();
        bridge.addEventListener((event, data) -> {
            events.add(event);
            states.add(data.has("state") ? data.get("state").getAsString() : null);
        });

        JsonObject obj = new JsonObject();
        obj.addProperty("event", "background_turn");
        obj.addProperty("sessionId", "sess-1");
        obj.addProperty("state", "active");
        bridge.handleDaemonEvent(obj);

        assertEquals(1, events.size());
        assertEquals("background_turn", events.get(0));
        assertEquals("active", states.get(0));
    }

    @Test
    public void backgroundTurnWithoutSessionIdIsNotDispatched() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        List<String> events = new ArrayList<>();
        bridge.addEventListener((event, data) -> events.add(event));

        JsonObject obj = new JsonObject();
        obj.addProperty("event", "background_turn");
        obj.addProperty("state", "active"); // no sessionId
        bridge.handleDaemonEvent(obj);

        assertTrue("background_turn without a sessionId must be skipped", events.isEmpty());
    }

    @Test
    public void unknownDaemonEventIsNotDispatched() {
        DaemonBridge bridge = new DaemonBridge(null, null, null);
        List<String> events = new ArrayList<>();
        bridge.addEventListener((event, data) -> events.add(event));

        JsonObject obj = new JsonObject();
        obj.addProperty("event", "totally_unknown_event");
        obj.addProperty("sessionId", "sess-1");
        bridge.handleDaemonEvent(obj);

        assertTrue(events.isEmpty());
    }
}
