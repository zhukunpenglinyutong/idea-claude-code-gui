package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link CallbackHandler} fan-out: primary callback still
 * runs once, subscribers receive raw events, subscriber exceptions are isolated,
 * and ordering is stable.
 */
public class CallbackHandlerFanOutTest {

    private CallbackHandler handler;
    private CountingCallback primary;
    private CountingCallback subA;
    private CountingCallback subB;

    @Before
    public void setUp() {
        handler = new CallbackHandler();
        primary = new CountingCallback("primary");
        subA = new CountingCallback("subA");
        subB = new CountingCallback("subB");
        handler.setCallback(primary);
    }

    @Test
    public void primaryReceivesOnce() {
        handler.notifyContentDelta("hello");
        assertEquals(1, primary.contentDeltaCount);
        assertEquals("hello", primary.lastContentDelta);
    }

    @Test
    public void subscriberReceivesEvent() {
        handler.addSubscriber(subA);
        handler.notifyContentDelta("hi");
        assertEquals(1, primary.contentDeltaCount);
        assertEquals(1, subA.contentDeltaCount);
        assertEquals("hi", subA.lastContentDelta);
    }

    @Test
    public void multipleSubscribersAllReceive() {
        handler.addSubscriber(subA);
        handler.addSubscriber(subB);
        handler.notifyContentDelta("x");
        assertEquals(1, primary.contentDeltaCount);
        assertEquals(1, subA.contentDeltaCount);
        assertEquals(1, subB.contentDeltaCount);
    }

    @Test
    public void removeSubscriberStopsEvents() {
        handler.addSubscriber(subA);
        handler.removeSubscriber(subA);
        handler.notifyContentDelta("x");
        assertEquals(1, primary.contentDeltaCount);
        assertEquals(0, subA.contentDeltaCount);
    }

    @Test
    public void subscriberExceptionDoesNotStopPrimary() {
        handler.addSubscriber(new ThrowingCallback());
        handler.addSubscriber(subB);
        handler.notifyContentDelta("x");
        // primary and subB still received despite the throwing subscriber in between
        assertEquals(1, primary.contentDeltaCount);
        assertEquals(1, subB.contentDeltaCount);
    }

    @Test
    public void subscriberAExceptionDoesNotStopSubscriberB() {
        handler.addSubscriber(new ThrowingCallback());
        handler.addSubscriber(subB);
        handler.notifyContentDelta("x");
        assertEquals(1, subB.contentDeltaCount);
    }

    @Test
    public void contentDeltaRemainsRaw() {
        handler.addSubscriber(subA);
        String raw = "Remote 测试通过，现在执行全量测试。";
        handler.notifyContentDelta(raw);
        assertEquals(raw, subA.lastContentDelta);
        assertEquals(raw, primary.lastContentDelta);
    }

    @Test
    public void thinkingDeltaRemainsRawForSubscribers() {
        // The 33ms throttler lives in SessionCallbackAdapter, NOT here, so
        // subscribers must receive the raw thinking delta.
        handler.addSubscriber(subA);
        handler.notifyThinkingDelta("secret reasoning");
        assertEquals("secret reasoning", subA.lastThinkingDelta);
        assertEquals("secret reasoning", primary.lastThinkingDelta);
    }

    @Test
    public void orderingPrimaryBeforeSubscriber() {
        handler.addSubscriber(subA);
        handler.notifyContentDelta("z");
        // primary's count was incremented before subA's (stable order)
        assertTrue(primary.contentDeltaCount >= 1);
        assertEquals(1, subA.contentDeltaCount);
        // Use a shared ordered list to assert exact ordering
        List<String> order = new ArrayList<>();
        CountingCallback ordPrimary = new CountingCallback("primary") {
            @Override
            public void onContentDelta(String delta) {
                order.add("primary");
            }
        };
        CountingCallback ordSub = new CountingCallback("sub") {
            @Override
            public void onContentDelta(String delta) {
                order.add("sub");
            }
        };
        CallbackHandler h2 = new CallbackHandler();
        h2.setCallback(ordPrimary);
        h2.addSubscriber(ordSub);
        h2.notifyContentDelta("z");
        assertEquals(List.of("primary", "sub"), order);
    }

    @Test
    public void subscriberCountReflectsAddRemove() {
        assertEquals(0, handler.subscriberCount());
        handler.addSubscriber(subA);
        assertEquals(1, handler.subscriberCount());
        handler.addSubscriber(subA); // dedupe
        assertEquals(1, handler.subscriberCount());
        handler.removeSubscriber(subA);
        assertEquals(0, handler.subscriberCount());
    }

    /** Minimal SessionCallback stub that counts the events under test. */
    static class CountingCallback implements ClaudeSession.SessionCallback {
        final String name;
        int contentDeltaCount = 0;
        int thinkingDeltaCount = 0;
        String lastContentDelta;
        String lastThinkingDelta;

        CountingCallback(String name) {
            this.name = name;
        }

        @Override
        public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
        }

        @Override
        public void onPermissionRequested(PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
        }

        @Override
        public void onNodeLog(String log) {
        }

        @Override
        public void onSummaryReceived(String summary) {
        }

        @Override
        public void onContentDelta(String delta) {
            contentDeltaCount++;
            lastContentDelta = delta;
        }

        @Override
        public void onThinkingDelta(String delta) {
            thinkingDeltaCount++;
            lastThinkingDelta = delta;
        }
    }

    /** A subscriber that throws on every callback — must not poison siblings. */
    static class ThrowingCallback implements ClaudeSession.SessionCallback {
        @Override
        public void onMessageUpdate(List<ClaudeSession.Message> messages) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onPermissionRequested(PermissionRequest request) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onNodeLog(String log) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onSummaryReceived(String summary) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onContentDelta(String delta) {
            throw new RuntimeException("boom");
        }

        @Override
        public void onThinkingDelta(String delta) {
            throw new RuntimeException("boom");
        }
    }
}
