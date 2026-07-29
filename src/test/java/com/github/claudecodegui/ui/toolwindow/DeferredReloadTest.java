package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link ClaudeChatWindow.DeferredReload} — the coordinator that
 * parks a session_updated reload arriving during an active stream and drains it
 * at stream end.
 *
 * <p>Why this matters: reloading mid-stream runs {@code clearMessages()} on
 * SessionState off the EDT, racing the streaming append and disturbing the live
 * bubble; dropping the reload instead leaves a background-turn answer invisible
 * until the user reopens the session. This coordinator is the fix, so its
 * park / take-and-clear / gate / coalescing / thread-safety semantics are
 * pinned down here.
 */
public class DeferredReloadTest {

    // ── Park + take-and-clear ────────────────────────────────────────────────

    @Test
    public void deferThenTakeReturnsTargetAndClears() {
        ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();
        assertFalse("nothing parked initially", d.hasPending());

        d.defer("session-A");
        assertTrue("defer parks a pending reload", d.hasPending());

        assertEquals("take returns the parked target", "session-A", d.takeIfRunnable(false));
        assertFalse("take clears the parked reload", d.hasPending());
    }

    @Test
    public void secondTakeAfterDrainReturnsNull() {
        ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();
        d.defer("session-A");
        d.takeIfRunnable(false);

        assertNull("a second drain with nothing parked returns null", d.takeIfRunnable(false));
    }

    @Test
    public void takeWithNothingDeferredReturnsNull() {
        ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();
        assertNull("draining an empty coordinator is a no-op", d.takeIfRunnable(false));
    }

    // ── Coalescing (last writer wins) ────────────────────────────────────────

    @Test
    public void overlappingDefersCollapseToLatest() {
        // Several background completions arriving during one stream must collapse
        // into a single reload reflecting the latest JSONL — not a burst of reloads.
        ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();
        d.defer("session-A");
        d.defer("session-B");
        d.defer("session-C");

        assertEquals("last writer wins", "session-C", d.takeIfRunnable(false));
        assertFalse("all coalesced into one drain", d.hasPending());
    }

    // ── Disposed gate ────────────────────────────────────────────────────────

    @Test
    public void takeWhenDisposedReturnsNullButStillClears() {
        // A disposed window must not run the reload — but the parked id must not
        // be left behind either, or a later drain on a reused coordinator could
        // resurrect it.
        ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();
        d.defer("session-A");

        assertNull("disposed window does not run the deferred reload", d.takeIfRunnable(true));
        assertFalse("disposed take still clears the parked reload", d.hasPending());
    }

    @Test
    public void deferAfterDisposedTakeCanStillRunWhenAlive() {
        // Defensive: a fresh defer after a disposed-drain is independent.
        ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();
        d.defer("stale");
        d.takeIfRunnable(true); // disposed → dropped

        d.defer("fresh");
        assertEquals("a new defer is independent of the prior disposed drain",
                "fresh", d.takeIfRunnable(false));
    }

    // ── Thread-safety: concurrent defer/take never loses or duplicates ───────

    @Test
    public void concurrentDeferAndTakeNeverLosesOrDuplicates() throws InterruptedException {
        // Model the real interleave: the daemon event thread defers while the
        // stream-end hook drains. Invariant: every id that is ever taken was
        // deferred, and no id is taken twice. (Coalescing means not every
        // deferred id is taken — that's fine; we assert no phantom/duplicate.)
        final ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();
        final int rounds = 20_000;
        final ConcurrentHashMap<String, Integer> takenCounts = new ConcurrentHashMap<>();
        final AtomicInteger deferSeq = new AtomicInteger();
        final CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(3);

        Runnable deferrer = () -> {
            awaitQuietly(start);
            for (int i = 0; i < rounds; i++) {
                d.defer("s" + deferSeq.incrementAndGet());
            }
        };
        Runnable drainer = () -> {
            awaitQuietly(start);
            for (int i = 0; i < rounds; i++) {
                String t = d.takeIfRunnable(false);
                if (t != null) {
                    takenCounts.merge(t, 1, Integer::sum);
                }
            }
        };

        pool.submit(deferrer);
        pool.submit(deferrer);
        pool.submit(drainer);
        start.countDown();
        pool.shutdown();
        assertTrue("workers finished", pool.awaitTermination(30, TimeUnit.SECONDS));

        // Final drain to flush any last parked id.
        String tail = d.takeIfRunnable(false);
        if (tail != null) {
            takenCounts.merge(tail, 1, Integer::sum);
        }

        // No id taken more than once (atomic take-and-clear).
        for (var e : takenCounts.entrySet()) {
            assertEquals("id " + e.getKey() + " must not be taken twice", Integer.valueOf(1), e.getValue());
        }
        // Every taken id was within the deferred range (no phantom ids).
        int maxDeferred = deferSeq.get();
        for (String id : takenCounts.keySet()) {
            int n = Integer.parseInt(id.substring(1));
            assertTrue("taken id " + id + " must be a real deferred id (<= " + maxDeferred + ")",
                    n >= 1 && n <= maxDeferred);
        }
        assertFalse("coordinator is drained at the end", d.hasPending());
    }

    // ── Safety backstop decision (decideDeferredReloadSafety) ────────────────
    //
    // onStreamEnded is the fast, edge-triggered drain. The backstop covers the
    // hole: a defer that races the stream-end edge, or the LAST fan-out answer
    // with no following stream end, would otherwise leave a parked reload
    // orphaned and the answer invisible forever. These pin the pure decision.

    @Test
    public void safetyDrainsWhenParkedAndStreamIdle() {
        // The orphan-rescue case: something is parked, the stream is no longer
        // active, and no onStreamEnded edge arrived for this defer — drain now.
        assertEquals(ClaudeChatWindow.SafetyDrainAction.DRAIN,
                ClaudeChatWindow.decideDeferredReloadSafety(false, true, false));
    }

    @Test
    public void safetyRechecksWhileStreamStillActive() {
        // Parked but a stream is active: reloading now would race the streaming
        // append, so wait and re-check rather than drain.
        assertEquals(ClaudeChatWindow.SafetyDrainAction.RECHECK_LATER,
                ClaudeChatWindow.decideDeferredReloadSafety(false, true, true));
    }

    @Test
    public void safetyStopsWhenNothingParked() {
        // The fast onStreamEnded path already drained it: nothing to do, and the
        // poll must stop (both idle and still-streaming variants).
        assertEquals(ClaudeChatWindow.SafetyDrainAction.DONE,
                ClaudeChatWindow.decideDeferredReloadSafety(false, false, false));
        assertEquals(ClaudeChatWindow.SafetyDrainAction.DONE,
                ClaudeChatWindow.decideDeferredReloadSafety(false, false, true));
    }

    @Test
    public void safetyStopsWhenDisposedEvenIfParked() {
        // A disposed window must never drive a reload, parked or not.
        assertEquals(ClaudeChatWindow.SafetyDrainAction.DONE,
                ClaudeChatWindow.decideDeferredReloadSafety(true, true, false));
        assertEquals(ClaudeChatWindow.SafetyDrainAction.DONE,
                ClaudeChatWindow.decideDeferredReloadSafety(true, true, true));
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ── shouldDeferSessionReload: the mid-turn reload guard ─────────────────
    //
    // A session_updated reload that runs during an in-flight turn stomps live
    // SessionState (loadFromServer clears + reinjects the JSONL parse, racing
    // the message handler) — observed as a frozen transcript that bulk-updates
    // at turn end. Streaming turns are guarded by the coalescer's streamActive
    // flag, but turns with streaming DISABLED never arm the coalescer, so the
    // guard must also treat SessionState busy/loading as "turn in flight".

    @Test
    public void defersWhileStreamActive() {
        assertTrue(ClaudeChatWindow.shouldDeferSessionReload(true, false, false));
    }

    @Test
    public void defersDuringNonStreamingTurnViaBusyFlag() {
        // Streaming disabled: coalescer never active, busy is the only signal.
        assertTrue(ClaudeChatWindow.shouldDeferSessionReload(false, true, true));
        assertTrue(ClaudeChatWindow.shouldDeferSessionReload(false, true, false));
    }

    @Test
    public void defersWhileLoadingEvenIfNotBusy() {
        assertTrue(ClaudeChatWindow.shouldDeferSessionReload(false, false, true));
    }

    @Test
    public void runsImmediatelyWhenSessionIdle() {
        // Genuine inter-turn background activity must keep reloading live.
        assertFalse(ClaudeChatWindow.shouldDeferSessionReload(false, false, false));
    }

    @Test
    public void nonStreamingTurnParksNudgesAndDrainsOnceAtTurnEnd() {
        ClaudeChatWindow.DeferredReload d = new ClaudeChatWindow.DeferredReload();

        // Nudges arriving mid-turn (busy, no streaming) are parked, last-writer-wins.
        boolean busy = true;
        for (int i = 0; i < 5; i++) {
            if (ClaudeChatWindow.shouldDeferSessionReload(false, busy, busy)) {
                d.defer("session-X");
            }
        }
        assertTrue("nudges parked during the turn", d.hasPending());

        // Turn ends (busy=false): the idle-transition drain runs exactly one reload.
        busy = false;
        assertFalse(ClaudeChatWindow.shouldDeferSessionReload(false, busy, busy));
        assertEquals("session-X", d.takeIfRunnable(false));
        assertNull("drain is one-shot", d.takeIfRunnable(false));
    }
}
