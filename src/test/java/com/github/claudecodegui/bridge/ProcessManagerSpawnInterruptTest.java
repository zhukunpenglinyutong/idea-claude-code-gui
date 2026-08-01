package com.github.claudecodegui.bridge;

import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Provider-abort final closure (PART B): the Codex pre-spawn interrupt race.
 *
 * <p>Proves the {@link ProcessManager} per-channel spawn-vs-interrupt boundary:
 * an interrupt that wins before (or during) spawn rejects the spawn (no Agent work),
 * an interrupt after spawn terminates the registered process, and a pending interrupt
 * is NOT blindly cleared by registration. Uses a {@link FakeProcess} (no real Codex).
 * Latch-based, no {@code sleep}.
 */
public class ProcessManagerSpawnInterruptTest {

    private ProcessManager pm;

    @Before
    public void setUp() {
        pm = new ProcessManager();
    }

    // ── 1. Interrupt before spawn → no Agent work ────────────────────────

    @Test
    public void interruptBeforeSpawn_processDoesNotRunAgentWork() {
        String ch = "codex-turn-1";
        // Pre-spawn interrupt (no process registered yet) is now RECORDED.
        pm.interruptChannel(ch);
        // beginSpawn must reject — abort won before spawn.
        assertFalse("beginSpawn must reject when a pending interrupt exists", pm.beginSpawn(ch));
        // registerProcessChecked must reject — the process is NOT registered.
        FakeProcess p = new FakeProcess();
        assertFalse("registerProcessChecked must reject a pending interrupt",
                pm.registerProcessChecked(ch, p));
        assertNull("rejected process must not be registered", pm.getProcess(ch));
    }

    // ── 2. registerProcessChecked must NOT clear a pending interrupt ─────

    @Test
    public void pendingInterrupt_notClearedByRegister() {
        String ch = "codex-turn-2";
        pm.interruptChannel(ch);
        FakeProcess p = new FakeProcess();
        assertFalse(pm.registerProcessChecked(ch, p)); // rejected, must NOT clear
        assertFalse("pending interrupt must survive a rejected registerProcessChecked",
                pm.beginSpawn(ch));
        // Only clearInterrupt (turn completion) clears it.
        pm.clearInterrupt(ch);
        assertTrue("clearInterrupt must reset for the next turn", pm.beginSpawn(ch));
    }

    // ── 3. Spawn wins → interrupt terminates the registered process ──────

    @Test
    public void spawnWins_interruptTerminatesRegisteredProcess() {
        String ch = "codex-turn-3";
        assertTrue(pm.beginSpawn(ch));
        FakeProcess p = new FakeProcess();
        assertTrue("spawn-wins registerProcessChecked must register", pm.registerProcessChecked(ch, p));
        assertSame("process must be registered", p, pm.getProcess(ch));

        // Interrupt after registration finds the process and removes it.
        pm.interruptChannel(ch);
        assertNull("interrupt must remove the registered process", pm.getProcess(ch));
        assertFalse("interrupt must be recorded", pm.beginSpawn(ch));

        // Next turn after clearInterrupt works.
        pm.clearInterrupt(ch);
        assertTrue(pm.beginSpawn(ch));
    }

    // ── 4. Atomic spawn-vs-interrupt ordering (latch, no sleep) ──────────

    /**
     * beginSpawn passes (no interrupt yet), then the spawn pauses BEFORE
     * registerProcessChecked. interruptChannel lands during the pause. The resume's
     * registerProcessChecked must observe the interrupt (atomic re-check under the
     * per-channel lock) and reject — no check-then-spawn gap.
     */
    @Test
    public void interruptVsSpawn_atomicOrdering() throws Exception {
        String ch = "codex-turn-4";
        assertTrue(pm.beginSpawn(ch)); // no interrupt yet

        CountDownLatch spawnPaused = new CountDownLatch(1);
        CountDownLatch resumeSpawn = new CountDownLatch(1);
        AtomicReference<Boolean> registered = new AtomicReference<>(null);
        AtomicReference<Throwable> err = new AtomicReference<>();

        Thread spawner = new Thread(() -> {
            try {
                spawnPaused.countDown();
                assertTrue(resumeSpawn.await(5, TimeUnit.SECONDS));
                registered.set(pm.registerProcessChecked(ch, new FakeProcess()));
            } catch (Throwable t) {
                err.set(t);
            }
        }, "spawner");

        Thread interrupter = new Thread(() -> {
            try {
                assertTrue(spawnPaused.await(5, TimeUnit.SECONDS));
                pm.interruptChannel(ch); // lands during the spawn pause
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, "interrupter");

        spawner.start();
        interrupter.start();
        interrupter.join(5000);
        resumeSpawn.countDown(); // release the spawn registration AFTER interrupt landed
        spawner.join(5000);

        assertNull("no thread exception", err.get());
        assertEquals("registerProcessChecked must reject (interrupt won during spawn, atomic re-check)",
                Boolean.FALSE, registered.get());
        assertNull("rejected process must not be registered", pm.getProcess(ch));
    }

    // ── 5. Next Codex turn after a prior abort works normally ────────────

    @Test
    public void nextCodexTurn_afterPriorAbortWorksNormally() {
        String ch = "codex-turn-5";
        pm.interruptChannel(ch);       // prior turn abort
        pm.clearInterrupt(ch);         // prior turn completion clears

        assertTrue("next turn beginSpawn must pass", pm.beginSpawn(ch));
        FakeProcess p = new FakeProcess();
        assertTrue("next turn registerProcessChecked must register", pm.registerProcessChecked(ch, p));
        assertSame("next turn process must be registered", p, pm.getProcess(ch));
    }

    /** A no-op Process that never touches the OS; terminate is benign (isAlive=false, fake pid). */
    private static final class FakeProcess extends Process {
        @Override public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public int waitFor() { return 0; }
        @Override public boolean waitFor(long timeout, TimeUnit unit) { return true; }
        @Override public int exitValue() { return 0; }
        @Override public void destroy() { }
        @Override public Process destroyForcibly() { return this; }
        @Override public boolean isAlive() { return false; }
        @Override public long pid() { return 99999999L; } // fake; taskkill (if any) fails harmlessly
    }
}
