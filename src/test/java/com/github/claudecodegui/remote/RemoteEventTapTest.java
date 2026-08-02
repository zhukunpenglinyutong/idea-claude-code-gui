package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionTurnGate;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link RemoteEventTap}: thinking content never reaches the SSE bus,
 * content deltas are coalesced into {@code assistant.content}, tool blocks
 * produce {@code tool.*} events, and an error state marks failure.
 */
public class RemoteEventTapTest {

    private static final String PROJECT_ID = "pid";
    private static final String TAB_ID = "tab1";

    @Before
    public void setUp() {
        RemoteEventBus.getInstance().clearForTest();
        RemoteTaskRegistry.getInstance().clearForTest();
    }

    private RemoteTask registerTask() {
        SessionTurnGate.Lease lease = new SessionTurnGate().acquire();
        AtomicLong clock = new AtomicLong(1L);
        RemoteDeltaFlushScheduler noopScheduler = new RemoteDeltaFlushScheduler() {
            @Override
            public void schedule(Runnable runnable, long delayMs) {
                // no-op
            }

            @Override
            public void cancel() {
                // no-op
            }
        };
        RemoteTask task = RemoteTask.create(UUID.randomUUID().toString(), PROJECT_ID, TAB_ID,
                "sess1", "claude", lease, RemoteEventBus.getInstance(),
                noopScheduler, clock::get, RemoteEventBus.getInstance().currentGeneration());
        assertTrue(RemoteTaskRegistry.getInstance().register(task));
        return task;
    }

    private RemoteEventTap newTap() {
        return RemoteEventTap.forTest(PROJECT_ID, TAB_ID,
                RemoteEventBus.getInstance(), RemoteTaskRegistry.getInstance());
    }

    @Test
    public void thinkingDeltaNeverPublished() throws InterruptedException {
        registerTask();
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        tap.onThinkingDelta("secret reasoning that must not leak");
        tap.onThinkingStatusChanged(true);

        // thinking_status is allowed (structured, no body), but no thinking_delta body event.
        RemoteEvent status = sub.poll(500);
        assertEquals("assistant.thinking_status", status.getEvent());
        assertNull(sub.poll(200)); // no thinking content event
    }

    @Test
    public void contentDeltaPublishedAsAssistantContent() throws InterruptedException {
        registerTask();
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        // Sentence terminator triggers an immediate coalescer flush.
        tap.onContentDelta("Remote 测试通过。");
        RemoteEvent e = sub.poll(500);
        assertEquals("assistant.content", e.getEvent());
    }

    @Test
    public void fullAssistantSnapshotPublishedWhenProviderHasNoContentDelta() throws InterruptedException {
        RemoteTask task = registerTask();
        ClaudeSession.Message historical = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "old response");
        task.assistantContentTracker.markBaseline(Collections.singletonList(historical));
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        ClaudeSession.Message user = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "new request");
        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "REMOTE_OK");
        tap.onMessageUpdate(List.of(historical, user, assistant));
        task.coalescer.flush();

        RemoteEvent event = sub.poll(500);
        assertEquals("assistant.content", event.getEvent());
        assertTrue(event.toEnvelopeJson().contains("REMOTE_OK"));
        assertTrue(!event.toEnvelopeJson().contains("old response"));
    }

    @Test
    public void snapshotAndContentDeltaDoNotPublishDuplicateAssistantText() throws InterruptedException {
        RemoteTask task = registerTask();
        task.assistantContentTracker.markBaseline(Collections.emptyList());
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "Hello.");
        tap.onMessageUpdate(Collections.singletonList(assistant));
        RemoteEvent first = sub.poll(500);
        assertEquals("assistant.content", first.getEvent());

        tap.onContentDelta("Hel");
        tap.onContentDelta("lo.");
        task.coalescer.flush();
        assertNull("snapshot plus replayed deltas must emit text only once", sub.poll(200));
    }

    @Test
    public void contentDeltaReplayAfterSnapshotBlockResetIsNotDuplicated() throws InterruptedException {
        RemoteTask task = registerTask();
        task.assistantContentTracker.markBaseline(Collections.emptyList());
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "SSE_FIXED_731");
        tap.onMessageUpdate(Collections.singletonList(assistant));
        task.coalescer.flush();
        assertEquals("assistant.content", sub.poll(500).getEvent());

        tap.onBlockReset();
        tap.onContentDelta("SSE_FIXED_");
        tap.onContentDelta("731");
        task.coalescer.flush();
        assertNull("snapshot plus post-reset delta replay must emit text only once", sub.poll(200));
    }

    @Test
    public void completeMessageThenRepeatedContentBlockOnSameMessageIsNotDuplicated() throws InterruptedException {
        RemoteTask task = registerTask();
        task.assistantContentTracker.markBaseline(Collections.emptyList());
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        ClaudeSession.Message assistant = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "SSE_ONCE_731");
        tap.onMessageUpdate(Collections.singletonList(assistant));
        task.coalescer.flush();
        RemoteEvent first = sub.poll(500);
        assertEquals("assistant.content", first.getEvent());

        // Real non-streaming order: [MESSAGE] provided the full text, then
        // [CONTENT] appends that same block to the same in-memory Message.
        assistant.content = "SSE_ONCE_731SSE_ONCE_731";
        tap.onMessageUpdate(Collections.singletonList(assistant));
        task.coalescer.flush();
        assertNull("same-object complete block replay must not duplicate SSE text", sub.poll(200));
    }

    @Test
    public void toolUseEmitsToolStarted() throws InterruptedException {
        registerTask();
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        JsonObject raw = assistantRaw(toolUse("t1", "Bash"));
        ClaudeSession.Message msg = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "", raw);
        tap.onMessageUpdate(Collections.singletonList(msg));

        RemoteEvent e = sub.poll(500);
        assertEquals("tool.started", e.getEvent());
    }

    @Test
    public void streamStartEmitsStreamStarted() throws InterruptedException {
        registerTask();
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        tap.onStreamStart();
        RemoteEvent e = sub.poll(500);
        assertEquals("stream.started", e.getEvent());
    }

    @Test
    public void errorStateMarksFailureObserved() {
        RemoteTask task = registerTask();
        RemoteEventTap tap = newTap();
        tap.onStateChange(false, false, "something went wrong");
        assertTrue(task.isFailureObserved());
    }

    @Test
    public void desktopTurnWithNoActiveTaskEmitsNothing() throws InterruptedException {
        // No task registered → tap must stay silent (desktop-origin turn).
        RemoteEventTap tap = newTap();
        RemoteEventSubscriber sub = RemoteEventBus.getInstance().subscribe(TAB_ID);

        tap.onContentDelta("hello.");
        tap.onStreamStart();
        assertNull(sub.poll(200));
    }

    private static JsonObject toolUse(String id, String name) {
        JsonObject b = new JsonObject();
        b.addProperty("type", "tool_use");
        b.addProperty("id", id);
        b.addProperty("name", name);
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
}
