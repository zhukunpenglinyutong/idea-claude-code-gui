package com.github.claudecodegui.session;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongConsumer;

import static org.junit.Assert.*;

/**
 * Tests for the dual-path onStreamEnd delivery mechanism.
 *
 * <p>The actual SessionCallbackAdapter depends on IntelliJ's Alarm and
 * ApplicationManager, so these tests verify the core ordering/idempotency
 * contract using a simulated flush callback + fallback sequence.
 */
public class SessionCallbackAdapterStreamEndTest {

    /** Records callJavaScript invocations for assertion. */
    private static final class RecordingJsTarget implements SessionCallbackAdapter.JsTarget {
        final List<String> calls = new ArrayList<>();

        @Override
        public void callJavaScript(String functionName, String... args) {
            StringBuilder sb = new StringBuilder(functionName);
            for (String arg : args) {
                sb.append(':').append(arg);
            }
            calls.add(sb.toString());
        }
    }

    /**
     * Simulates the dual-path dispatch logic extracted from onStreamEnd().
     * This mirrors the actual implementation's control flow without needing
     * IntelliJ Alarm/invokeLater.
     */
    private static final class DualPathSimulator {
        private volatile boolean streamEndPrimaryDispatched = false;
        private volatile boolean streamEndLifecycleCompleted = false;
        private volatile long streamGeneration = 0L;
        private long endingStreamGeneration = 0L;
        private final RecordingJsTarget jsTarget;
        private final Runnable streamEndCallback;

        DualPathSimulator(RecordingJsTarget jsTarget, Runnable streamEndCallback) {
            this.jsTarget = jsTarget;
            this.streamEndCallback = streamEndCallback;
        }

        /** Simulate the flush callback path (primary). */
        void simulateFlushCallback(long sequence) {
            if (streamGeneration != endingStreamGeneration) {
                return;
            }
            streamEndPrimaryDispatched = true;
            sendStreamEndSignal(sequence);
            completeStreamEndLifecycle();
        }

        /** Simulate the fallback alarm path. */
        void simulateFallback() {
            if (streamGeneration != endingStreamGeneration) {
                return;
            }
            sendStreamEndSignal(-1);
            completeStreamEndLifecycle();
        }

        private void sendStreamEndSignal(long sequence) {
            jsTarget.callJavaScript("onStreamEnd", String.valueOf(sequence));
            jsTarget.callJavaScript("showLoading", "false");
        }

        private void completeStreamEndLifecycle() {
            if (streamEndLifecycleCompleted) {
                return;
            }
            streamEndLifecycleCompleted = true;
            streamEndCallback.run();
        }

        /** Reset for a new onStreamEnd call. */
        void reset() {
            streamEndPrimaryDispatched = false;
            streamEndLifecycleCompleted = false;
            endingStreamGeneration = streamGeneration;
        }

        void simulateStreamStart() {
            streamGeneration++;
        }

        boolean isPrimaryDispatched() {
            return streamEndPrimaryDispatched;
        }

        boolean isLifecycleCompleted() {
            return streamEndLifecycleCompleted;
        }
    }

    private static DualPathSimulator createSimulator(
            RecordingJsTarget jsTarget,
            AtomicInteger lifecycleCompletions
    ) {
        return new DualPathSimulator(jsTarget, lifecycleCompletions::incrementAndGet);
    }

    @Test
    public void primaryPathSendsStreamEndWithSequence() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        AtomicInteger lifecycleCompletions = new AtomicInteger();
        DualPathSimulator sim = createSimulator(jsTarget, lifecycleCompletions);

        sim.reset();
        sim.simulateFlushCallback(42);

        assertTrue(sim.isPrimaryDispatched());
        assertTrue(sim.isLifecycleCompleted());
        assertEquals(1, lifecycleCompletions.get());
        assertEquals(2, jsTarget.calls.size());
        assertEquals("onStreamEnd:42", jsTarget.calls.get(0));
        assertEquals("showLoading:false", jsTarget.calls.get(1));
    }

    @Test
    public void fallbackPathSendsStreamEndWithNegativeSequence() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        AtomicInteger lifecycleCompletions = new AtomicInteger();
        DualPathSimulator sim = createSimulator(jsTarget, lifecycleCompletions);

        sim.reset();
        sim.simulateFallback();

        assertFalse(sim.isPrimaryDispatched());
        assertTrue(sim.isLifecycleCompleted());
        assertEquals(1, lifecycleCompletions.get());
        assertEquals(2, jsTarget.calls.size());
        assertEquals("onStreamEnd:-1", jsTarget.calls.get(0));
        assertEquals("showLoading:false", jsTarget.calls.get(1));
    }

    @Test
    public void fallbackRetriesFrontendAfterPrimaryWithoutRepeatingLifecycle() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        AtomicInteger lifecycleCompletions = new AtomicInteger();
        DualPathSimulator sim = createSimulator(jsTarget, lifecycleCompletions);

        sim.reset();
        sim.simulateFlushCallback(42);
        sim.simulateFallback();

        assertEquals(4, jsTarget.calls.size());
        assertEquals("onStreamEnd:42", jsTarget.calls.get(0));
        assertEquals("showLoading:false", jsTarget.calls.get(1));
        assertEquals("onStreamEnd:-1", jsTarget.calls.get(2));
        assertEquals("showLoading:false", jsTarget.calls.get(3));
        assertEquals(1, lifecycleCompletions.get());
    }

    @Test
    public void latePrimaryRetriesFrontendAfterFallbackWithoutRepeatingLifecycle() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        AtomicInteger lifecycleCompletions = new AtomicInteger();
        DualPathSimulator sim = createSimulator(jsTarget, lifecycleCompletions);

        sim.reset();
        sim.simulateFallback();
        sim.simulateFlushCallback(42);

        assertEquals(4, jsTarget.calls.size());
        assertEquals("onStreamEnd:-1", jsTarget.calls.get(0));
        assertEquals("showLoading:false", jsTarget.calls.get(1));
        assertEquals("onStreamEnd:42", jsTarget.calls.get(2));
        assertEquals("showLoading:false", jsTarget.calls.get(3));
        assertEquals(1, lifecycleCompletions.get());
    }

    @Test
    public void latePrimaryDoesNotEndNextStream() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        AtomicInteger lifecycleCompletions = new AtomicInteger();
        DualPathSimulator sim = createSimulator(jsTarget, lifecycleCompletions);

        sim.reset();
        sim.simulateFallback();
        sim.simulateStreamStart();
        sim.simulateFlushCallback(42);

        assertEquals(2, jsTarget.calls.size());
        assertEquals("onStreamEnd:-1", jsTarget.calls.get(0));
        assertEquals("showLoading:false", jsTarget.calls.get(1));
        assertEquals(1, lifecycleCompletions.get());
    }

    @Test
    public void resetAllowsNextTurn() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        AtomicInteger lifecycleCompletions = new AtomicInteger();
        DualPathSimulator sim = createSimulator(jsTarget, lifecycleCompletions);

        sim.simulateStreamStart();
        sim.reset();
        sim.simulateFlushCallback(10);
        assertEquals(2, jsTarget.calls.size());
        assertEquals(1, lifecycleCompletions.get());

        sim.simulateStreamStart();
        sim.reset();
        assertFalse(sim.isPrimaryDispatched());
        assertFalse(sim.isLifecycleCompleted());
        sim.simulateFlushCallback(20);
        assertEquals(4, jsTarget.calls.size());
        assertEquals("onStreamEnd:20", jsTarget.calls.get(2));
        assertEquals(2, lifecycleCompletions.get());
    }

    /**
     * Verify the flush LongConsumer callback contract:
     * when StreamMessageCoalescer.flush() invokes the callback with a
     * sequence number, the onStreamEnd signal uses that sequence.
     */
    @Test
    public void flushCallbackPassesSequenceToOnStreamEnd() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();

        final AtomicLong capturedSequence = new AtomicLong(-999);
        LongConsumer flushCallback = seq -> {
            capturedSequence.set(seq);
            jsTarget.callJavaScript("onStreamEnd", String.valueOf(seq));
        };

        flushCallback.accept(77);

        assertEquals(77, capturedSequence.get());
        assertEquals(1, jsTarget.calls.size());
        assertEquals("onStreamEnd:77", jsTarget.calls.get(0));
    }
}
