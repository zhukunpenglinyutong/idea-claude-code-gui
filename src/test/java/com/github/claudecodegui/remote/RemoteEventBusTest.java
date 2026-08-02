package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteEventBus} / {@link RemoteEventSubscriber}.
 */
public class RemoteEventBusTest {

    @Before
    public void setUp() {
        RemoteEventBus.getInstance().clearForTest();
    }

    private void publish(String tabId, String event, long id) {
        RemoteEvent e = new RemoteEvent(id, event, id, "pid", tabId, "task", "sess", new JsonObject());
        // route directly via a subscriber-less publish would be a no-op, so use
        // the public publish API which also assigns ids; for deterministic ids
        // we instead offer a pre-built event to subscribers through the bus.
        // The bus.publish generates its own id; for ordering tests we rely on
        // publication order, not exact ids.
        RemoteEventBus.getInstance().publish("pid", tabId, event, "task", "sess", new JsonObject());
    }

    @Test
    public void subscribeAndPublish() throws InterruptedException {
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe("tab1");
        RemoteEventBus.getInstance().publish("pid", "tab1", "task.started", "task", "sess", new JsonObject());
        RemoteEvent e = sub.poll(500);
        assertEquals("task.started", e.getEvent());
        assertEquals("tab1", e.getTabId());
    }

    @Test
    public void multipleSubscribersAllReceive() throws InterruptedException {
        RemoteEventSubscriber a = RemoteEventBus.getInstance().subscribe("tab1");
        RemoteEventSubscriber b = RemoteEventBus.getInstance().subscribe("tab1");
        RemoteEventBus.getInstance().publish("pid", "tab1", "task.started", "task", "sess", new JsonObject());
        assertEquals("task.started", a.poll(500).getEvent());
        assertEquals("task.started", b.poll(500).getEvent());
    }

    @Test
    public void unsubscribeStopsDelivery() throws InterruptedException {
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe("tab1");
        RemoteEventBus.getInstance().unsubscribe(sub);
        RemoteEventBus.getInstance().publish("pid", "tab1", "task.started", "task", "sess", new JsonObject());
        assertNull(sub.poll(200));
        assertTrue(sub.isClosed());
    }

    @Test
    public void eventOrderPreserved() throws InterruptedException {
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe("tab1");
        for (int i = 0; i < 5; i++) {
            RemoteEventBus.getInstance().publish("pid", "tab1", "e" + i, "task", "sess", new JsonObject());
        }
        for (int i = 0; i < 5; i++) {
            assertEquals("e" + i, sub.poll(500).getEvent());
        }
    }

    @Test
    public void boundedQueueOverflowMarksSubscriber() throws InterruptedException {
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe("tab1");
        // Fill the queue without draining.
        for (int i = 0; i < RemoteGatewayLimits.MAX_EVENTS_PER_SUBSCRIBER + 5; i++) {
            RemoteEventBus.getInstance().publish("pid", "tab1", "e" + i, "task", "sess", new JsonObject());
        }
        assertTrue("subscriber must be marked overflowed", sub.isOverflowed());
    }

    @Test
    public void noSubscribersIsNoOp() {
        // Publishing to a tab with no subscribers must not throw.
        RemoteEventBus.getInstance().publish("pid", "tabX", "e", "task", "sess", new JsonObject());
        assertEquals(0, RemoteEventBus.getInstance().subscriberCount("tabX"));
    }

    @Test
    public void onlyMatchingTabReceives() throws InterruptedException {
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe("tab1");
        RemoteEventBus.getInstance().publish("pid", "tab2", "e", "task", "sess", new JsonObject());
        assertNull(sub.poll(200));
        assertFalse(sub.isClosed());
    }
}
