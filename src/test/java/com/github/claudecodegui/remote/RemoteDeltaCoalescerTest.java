package com.github.claudecodegui.remote;

import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteDeltaCoalescer} with an injected fake
 * scheduler/clock — no real timers.
 */
public class RemoteDeltaCoalescerTest {

    private static final long MAX_WAIT = 600;
    private static final int MAX_CHUNK = 1000;

    private FakeScheduler scheduler;
    private AtomicLong clock;
    private List<String> flushed;
    private RemoteDeltaCoalescer coalescer;

    @Before
    public void setUp() {
        scheduler = new FakeScheduler();
        clock = new AtomicLong(1000L);
        flushed = new ArrayList<>();
        coalescer = new RemoteDeltaCoalescer(scheduler, clock::get, MAX_WAIT, MAX_CHUNK, flushed::add);
    }

    @Test
    public void simpleAppendAndManualFlush() {
        coalescer.append("hello");
        assertTrue(flushed.isEmpty());
        coalescer.flush();
        assertEquals(List.of("hello"), flushed);
    }

    @Test
    public void sentencePunctuationFlushes() {
        coalescer.append("Remote 测试通过。");
        assertEquals(List.of("Remote 测试通过。"), flushed);
        coalescer.flush();
        assertEquals(1, flushed.size());
    }

    @Test
    public void englishSentenceEndFlushes() {
        coalescer.append("Running tests.");
        assertEquals(List.of("Running tests."), flushed);
    }

    @Test
    public void newlineFlushes() {
        coalescer.append("line one\n");
        assertEquals(List.of("line one\n"), flushed);
    }

    @Test
    public void maxChunkFlushes() {
        // Reaching the chunk cap triggers an immediate flush of all pending.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < MAX_CHUNK; i++) {
            sb.append('a');
        }
        coalescer.append(sb.toString());
        assertEquals(1, flushed.size());
        assertEquals(MAX_CHUNK, flushed.get(0).length());
    }

    @Test
    public void appendPastMaxChunkFlushesEverythingPending() {
        // A single huge delta is flushed in one chunk (no splitting) — the cap
        // guarantees a flush, not a fixed chunk size.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < MAX_CHUNK + 50; i++) {
            sb.append('a');
        }
        coalescer.append(sb.toString());
        assertEquals(1, flushed.size());
        assertEquals(MAX_CHUNK + 50, flushed.get(0).length());
    }

    @Test
    public void timeBasedFlush() {
        coalescer.append("partial");
        assertTrue(flushed.isEmpty());
        assertTrue(scheduler.pending != null); // a flush was scheduled
        clock.addAndGet(MAX_WAIT + 1);
        scheduler.runPending();
        assertEquals(List.of("partial"), flushed);
    }

    @Test
    public void multipleAppendsCoalesceUntilFlush() {
        coalescer.append("foo ");
        coalescer.append("bar ");
        coalescer.append("baz");
        assertTrue(flushed.isEmpty());
        coalescer.flush();
        assertEquals(List.of("foo bar baz"), flushed);
    }

    @Test
    public void differentCoalescersDoNotCrossContent() {
        List<String> other = new ArrayList<>();
        RemoteDeltaCoalescer c2 = new RemoteDeltaCoalescer(scheduler, clock::get, MAX_WAIT, MAX_CHUNK, other::add);
        coalescer.append("mine");
        c2.append("yours");
        coalescer.flush();
        c2.flush();
        assertEquals(List.of("mine"), flushed);
        assertEquals(List.of("yours"), other);
    }

    @Test
    public void disposeStopsFurtherFlushes() {
        coalescer.append("x");
        coalescer.dispose();
        coalescer.flush();
        assertTrue(flushed.isEmpty());
    }

    @Test
    public void appendAfterDisposeIsNoOp() {
        coalescer.dispose();
        coalescer.append("late");
        coalescer.flush();
        assertTrue(flushed.isEmpty());
    }

    static class FakeScheduler implements RemoteDeltaFlushScheduler {
        Runnable pending;
        long delay;

        @Override
        public void schedule(Runnable runnable, long delayMs) {
            cancel();
            pending = runnable;
            delay = delayMs;
        }

        @Override
        public void cancel() {
            pending = null;
        }

        void runPending() {
            Runnable r = pending;
            pending = null;
            if (r != null) {
                r.run();
            }
        }
    }
}
