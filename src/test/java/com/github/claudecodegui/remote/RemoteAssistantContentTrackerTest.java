package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.ClaudeSession;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;

/**
 * Regression tests for the append-only assistant content contract.
 *
 * <p>Core Freeze Amendment 2026-08-01: a provider may replay the same message
 * content (full {@code X -> X+X}, partial {@code X -> X + prefix-of-X}, or
 * partial {@code X -> X + suffix-of-X}); the tracker must never emit
 * already-emitted text a second time, while genuine continuations in distinct
 * updates must still flow.
 */
public class RemoteAssistantContentTrackerTest {

    private static final String FULL =
            "刚才已经查过了，是的，D 盘有一个 2026.5.7项目规整 文件夹，里面共 52 个项目，"
                    + "主要涵盖短剧运营、AI小说、数据处理等，需要我深入查看某个具体项目的内容吗？";
    private static final String PREFIX_57 = FULL.substring(0, 57);

    private static List<ClaudeSession.Message> history() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "历史消息"));
        return messages;
    }

    private static List<ClaudeSession.Message> withAssistant(
            List<ClaudeSession.Message> base,
            ClaudeSession.Message assistant) {
        List<ClaudeSession.Message> messages = new ArrayList<>(base);
        messages.add(assistant);
        return messages;
    }

    @Test
    public void snapshotThenDeltaReplayOfEmittedPrefixIsDropped() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        List<ClaudeSession.Message> base = history();
        tracker.markBaseline(base);
        ClaudeSession.Message assistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, FULL);
        List<ClaudeSession.Message> snapshot = withAssistant(base, assistant);

        assertEquals(FULL, tracker.consumeSnapshot(snapshot));
        // Provider re-sends the first 57 chars of the same content as a delta.
        assertEquals("", tracker.consumeDelta(PREFIX_57));
        // A second identical full snapshot must not re-emit anything.
        assertEquals("", tracker.consumeSnapshot(snapshot));
    }

    @Test
    public void partialPrefixReplayOnSameMessageIsCollapsedAndLaterExtensionStillEmits() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        List<ClaudeSession.Message> base = history();
        tracker.markBaseline(base);
        ClaudeSession.Message assistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, FULL);
        List<ClaudeSession.Message> snapshot = withAssistant(base, assistant);

        assertEquals(FULL, tracker.consumeSnapshot(snapshot));
        // Same Message object grows by a prefix of its own previous content.
        assistant.content = FULL + PREFIX_57;
        assertEquals("", tracker.consumeSnapshot(snapshot));
        // A genuine later extension on the same message is still emitted.
        assistant.content = FULL + "真实的新内容";
        assertEquals("真实的新内容", tracker.consumeSnapshot(snapshot));
    }

    @Test
    public void exactDoubleReplayIsCollapsed() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        List<ClaudeSession.Message> base = history();
        tracker.markBaseline(base);
        ClaudeSession.Message assistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, FULL);
        List<ClaudeSession.Message> snapshot = withAssistant(base, assistant);

        assertEquals(FULL, tracker.consumeSnapshot(snapshot));
        // [CONTENT] replay appends the same full block to the same Message.
        assistant.content = FULL + FULL;
        assertEquals("", tracker.consumeSnapshot(snapshot));
    }

    @Test
    public void deltaStreamAccumulatesNormallyAndResentPrefixIsDropped() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        tracker.markBaseline(history());

        assertEquals("A", tracker.consumeDelta("A"));
        assertEquals("BC", tracker.consumeDelta("BC"));
        assertEquals("", tracker.consumeDelta("A"));
        assertEquals("D", tracker.consumeDelta("D"));
    }

    @Test
    public void deltaStreamResentSuffixIsDroppedAndLaterContinuationStillEmits() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        tracker.markBaseline(history());

        assertEquals("A", tracker.consumeDelta("A"));
        assertEquals("BC", tracker.consumeDelta("BC"));
        // Provider re-sends the tail of the already-emitted text as a delta.
        assertEquals("", tracker.consumeDelta("BC"));
        assertEquals("D", tracker.consumeDelta("D"));
        assertEquals("", tracker.consumeDelta("BCD"));
        assertEquals("E", tracker.consumeDelta("E"));
    }

    @Test
    public void snapshotSuffixReplayOnSameMessageIsCollapsedAndLaterExtensionStillEmits() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        List<ClaudeSession.Message> base = history();
        tracker.markBaseline(base);
        ClaudeSession.Message assistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, FULL);
        List<ClaudeSession.Message> snapshot = withAssistant(base, assistant);

        assertEquals(FULL, tracker.consumeSnapshot(snapshot));
        // Same Message object grows by a suffix of its own previous content.
        String suffix = FULL.substring(FULL.length() - 23);
        assistant.content = FULL + suffix;
        assertEquals("", tracker.consumeSnapshot(snapshot));
        // A genuine later extension on the same message is still emitted.
        assistant.content = FULL + "真实的新内容";
        assertEquals("真实的新内容", tracker.consumeSnapshot(snapshot));
    }

    @Test
    public void deltaSuffixReplayAcrossSnapshotIdentityIsDropped() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        List<ClaudeSession.Message> base = history();
        tracker.markBaseline(base);
        ClaudeSession.Message assistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, FULL);

        assertEquals(FULL, tracker.consumeSnapshot(withAssistant(base, assistant)));
        // A new Message object carrying only the tail of the emitted text.
        String suffix = FULL.substring(FULL.length() - 23);
        ClaudeSession.Message tailOnly = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, suffix);
        assertEquals("", tracker.consumeSnapshot(withAssistant(base, tailOnly)));
    }

    @Test
    public void divergedDeltaDoesNotPoisonTheBuffer() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        List<ClaudeSession.Message> base = history();
        tracker.markBaseline(base);

        assertEquals("A", tracker.consumeDelta("A"));
        ClaudeSession.Message assistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "AB");
        assertEquals("B", tracker.consumeSnapshot(withAssistant(base, assistant)));
        // Delta "C" would produce observed "AC" which diverges from emitted "AB".
        assertEquals("", tracker.consumeDelta("C"));
        // The buffer is reset, so a fresh continuation is accepted.
        assertEquals("C", tracker.consumeDelta("C"));
    }

    @Test
    public void genuineSameMessageExtensionIsNotDropped() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        List<ClaudeSession.Message> base = history();
        tracker.markBaseline(base);
        ClaudeSession.Message assistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "好的");
        List<ClaudeSession.Message> snapshot = withAssistant(base, assistant);

        assertEquals("好的", tracker.consumeSnapshot(snapshot));
        assistant.content = "好的，继续";
        assertEquals("，继续", tracker.consumeSnapshot(snapshot));
    }

    @Test
    public void baselineMessagesAreNotReplayed() {
        RemoteAssistantContentTracker tracker = new RemoteAssistantContentTracker();
        ClaudeSession.Message oldAssistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "旧回复");
        List<ClaudeSession.Message> baseline = withAssistant(history(), oldAssistant);
        tracker.markBaseline(baseline);

        ClaudeSession.Message newAssistant = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "新回复");
        assertEquals("新回复", tracker.consumeSnapshot(withAssistant(baseline, newAssistant)));
    }
}
