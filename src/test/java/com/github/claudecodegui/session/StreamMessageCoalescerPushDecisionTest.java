package com.github.claudecodegui.session;

import org.junit.Test;

import static com.github.claudecodegui.session.StreamMessageCoalescer.PushDecision;
import static com.github.claudecodegui.session.StreamMessageCoalescer.decidePush;
import static org.junit.Assert.assertEquals;

/**
 * Tests for the snapshot delivery gate ({@link StreamMessageCoalescer#decidePush}).
 *
 * <p>Regression background (real session, idea.log 2026-07-20 16:08:00): a turn
 * ended with a usage-limit error. onError() appends the ERROR message AFTER
 * notifyStreamEnd(), so the two stream-end flushes grabbed pre-error snapshots
 * (225 messages) while the error snapshot (226 messages) rode the alarm path.
 * The old sequence-only gate skipped the error snapshot as "stale" and
 * force-pushed both pre-error snapshots over it — the webview never saw the
 * usage-limit error, so nothing rendered and auto-resume had nothing to arm on.
 */
public class StreamMessageCoalescerPushDecisionTest {

    @Test
    public void newestContentOnAlarmPathLandsAfterStreamEnd() {
        // The 226-message error snapshot: content version 11 (newest), built at
        // sequence 315, arriving after stream-end flushes advanced the counter
        // to 317. It MUST be delivered, with a bumped sequence.
        assertEquals(
                PushDecision.PUSH_RESEQUENCED,
                decidePush(/* snapshotVersion */ 11, /* pushedContentVersion */ 10,
                        /* streamActive */ false, /* builtSequence */ 315, /* currentSequence */ 317));
    }

    @Test
    public void outdatedFlushReplayNeverRollsBackDeliveredContent() {
        // The pre-error 225-message flush replay (content version 10) arriving
        // after the error snapshot (version 11) was delivered: skipped, on both
        // the flush and alarm paths, stale sequence or not.
        assertEquals(
                PushDecision.SKIP,
                decidePush(10, 11, false, 314, 318));
        assertEquals(
                PushDecision.SKIP,
                decidePush(10, 11, false, 318, 318));
        assertEquals(
                PushDecision.SKIP,
                decidePush(10, 11, true, 314, 318));
    }

    @Test
    public void currentSequencePushesAsBuilt() {
        assertEquals(
                PushDecision.PUSH,
                decidePush(11, 10, false, 315, 315));
        assertEquals(
                PushDecision.PUSH,
                decidePush(11, 10, true, 315, 315));
    }

    @Test
    public void midStreamStaleFrameIsThrottledAway() {
        // During streaming a stale-sequence frame is dropped even when it holds
        // the newest content so far: the sequence only advanced because newer
        // work was scheduled, and the stream-end flush re-delivers lastSnapshot,
        // so the turn's tail cannot be lost.
        assertEquals(
                PushDecision.SKIP,
                decidePush(11, 10, true, 315, 316));
    }

    @Test
    public void equalVersionRepushIsAllowedAfterStreamEnd() {
        // The webview-recreate re-flush resends lastSnapshot, whose version was
        // already delivered once. Equal version must pass the gate.
        assertEquals(
                PushDecision.PUSH_RESEQUENCED,
                decidePush(10, 10, false, 320, 322));
    }

    @Test
    public void olderContentIsSkippedRegardlessOfEveryOtherFlag() {
        for (boolean streaming : new boolean[]{false, true}) {
            for (long built : new long[]{5, 7}) {
                assertEquals(
                        "version 3 vs pushed 4, streaming=" + streaming + ", built=" + built,
                        PushDecision.SKIP,
                        decidePush(3, 4, streaming, built, 7));
            }
        }
    }
}
