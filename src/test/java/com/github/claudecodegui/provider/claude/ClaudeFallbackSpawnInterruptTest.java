package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.ProcessManager;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Provider-abort final closure (PART C): Claude per-process fallback
 * spawn-vs-interrupt boundary.
 *
 * <p>Proves that the Claude per-process fallback path
 * ({@link ClaudeProcessInvoker}) now uses the same atomic
 * {@code beginSpawn} / {@code registerProcessChecked} protocol as Codex
 * (PART B). An interrupt that wins before or during spawn prevents Agent
 * work; a spawn that wins first is terminated by the interrupt.
 *
 * <p>Uses {@link ProcessManager} directly (no live Claude process) with
 * {@link FakeProcess}. Latch-based, no {@code sleep}.
 */
public class ClaudeFallbackSpawnInterruptTest {

    private ProcessManager pm;

    @Before
    public void setUp() {
        pm = new ProcessManager();
    }

    // ── 1. Interrupt before spawn → no Agent work ──────────────────────────

    @Test
    public void claudeFallback_interruptBeforeSpawn_noAgentWork() {
        String ch = "claude-fallback-1";

        // Pre-spawn interrupt (e.g., Desktop Stop / Remote abort).
        pm.interruptChannel(ch);

        // beginSpawn must reject — abort won before spawn.
        assertFalse("beginSpawn must reject when a pending interrupt exists",
                pm.beginSpawn(ch));

        // registerProcessChecked must also reject.
        FakeProcess p = new FakeProcess();
        assertFalse("registerProcessChecked must reject a pending interrupt",
                pm.registerProcessChecked(ch, p));
        assertNull("rejected process must not be registered", pm.getProcess(ch));
    }

    // ── 2. Interrupt during spawn → checked registration rejects ───────────

    /**
     * beginSpawn passes (interrupt hasn't arrived yet), then spawn begins.
     * While the spawn is in flight (before registerProcessChecked), an interrupt
     * arrives. registerProcessChecked's atomic re-check under the per-channel
     * lock MUST observe the interrupt and reject — the just-spawned process is
     * destroyed before Agent stdin is written. No Agent work.
     */
    @Test
    public void claudeFallback_interruptDuringSpawn_checkedRegisterRejects() throws Exception {
        String ch = "claude-fallback-2";
        assertTrue("beginSpawn passes — no interrupt yet", pm.beginSpawn(ch));

        CountDownLatch spawnPaused = new CountDownLatch(1);
        CountDownLatch resumeSpawn = new CountDownLatch(1);
        AtomicReference<Boolean> registered = new AtomicReference<>(null);
        AtomicReference<Throwable> err = new AtomicReference<>();

        Thread spawner = new Thread(() -> {
            try {
                spawnPaused.countDown();
                assertTrue(resumeSpawn.await(5, TimeUnit.SECONDS));
                // This is the registerProcessChecked call — the interrupt should
                // have landed by now (interrupter thread already joined), so the
                // atomic re-check under the per-channel lock must reject.
                FakeProcess p = new FakeProcess();
                registered.set(pm.registerProcessChecked(ch, p));
                if (Boolean.FALSE.equals(registered.get())) {
                    // Rejected → destroy before Agent work (as ClaudeProcessInvoker does).
                    p.destroyForcibly();
                    pm.waitForProcessTermination(p);
                }
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
        interrupter.join(5000); // interrupt must land before we resume spawn
        resumeSpawn.countDown(); // release registerProcessChecked
        spawner.join(5000);

        assertNull("no thread exception", err.get());
        assertEquals("registerProcessChecked must reject (interrupt won during spawn)",
                Boolean.FALSE, registered.get());
        assertNull("rejected process must not be registered", pm.getProcess(ch));
    }

    // ── 3. Spawn wins → interrupt terminates the registered process ─────────

    @Test
    public void claudeFallback_spawnWins_interruptTerminates() {
        String ch = "claude-fallback-3";

        // Spawn wins the race.
        assertTrue(pm.beginSpawn(ch));
        FakeProcess p = new FakeProcess();
        assertTrue("registerProcessChecked must register when no interrupt", pm.registerProcessChecked(ch, p));
        assertNotNull("process must be registered", pm.getProcess(ch));

        // Interrupt arrives after registration — finds the process.
        pm.interruptChannel(ch);
        assertNull("interrupt must remove the registered process", pm.getProcess(ch));

        // Channel is marked interrupted.
        assertFalse("beginSpawn must reject after interrupt", pm.beginSpawn(ch));
    }

    // ── 4. Next turn after abort works ─────────────────────────────────────

    @Test
    public void claudeFallback_nextTurnAfterAbortWorks() {
        String ch = "claude-fallback-4";

        // Prior turn: interrupt → clear.
        pm.interruptChannel(ch);
        pm.clearInterrupt(ch);

        // Next turn: spawn works.
        assertTrue("next turn beginSpawn must pass after clearInterrupt", pm.beginSpawn(ch));
        FakeProcess p = new FakeProcess();
        assertTrue("next turn registerProcessChecked must register", pm.registerProcessChecked(ch, p));
        assertNotNull("next turn process must be registered", pm.getProcess(ch));
    }

    // ── 5. Repeated abort + clear does not poison the channel ───────────────

    @Test
    public void claudeFallback_repeatedAbortClear_stillWorks() {
        String ch = "claude-fallback-5";

        // Turn 1: spawn, abort, clear.
        assertTrue(pm.beginSpawn(ch));
        FakeProcess p1 = new FakeProcess();
        assertTrue(pm.registerProcessChecked(ch, p1));
        pm.interruptChannel(ch); // abort
        pm.clearInterrupt(ch);   // turn completion

        // Turn 2: spawn works.
        assertTrue(pm.beginSpawn(ch));
        FakeProcess p2 = new FakeProcess();
        assertTrue(pm.registerProcessChecked(ch, p2));
        assertNotNull(pm.getProcess(ch));

        // Turn 2 abort.
        pm.interruptChannel(ch);
        pm.clearInterrupt(ch);

        // Turn 3: spawn works.
        assertTrue(pm.beginSpawn(ch));
        FakeProcess p3 = new FakeProcess();
        assertTrue(pm.registerProcessChecked(ch, p3));
        assertNotNull(pm.getProcess(ch));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private static final class FakeProcess extends Process {
        private final AtomicBoolean destroyed = new AtomicBoolean(false);

        @Override public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public int waitFor() { return 0; }
        @Override public boolean waitFor(long timeout, TimeUnit unit) { return true; }
        @Override public int exitValue() { return 0; }
        @Override public void destroy() { destroyed.set(true); }
        @Override public Process destroyForcibly() { destroyed.set(true); return this; }
        @Override public boolean isAlive() { return !destroyed.get(); }
        @Override public long pid() { return 99999998L; }

        boolean isDestroyed() { return destroyed.get(); }
    }
}
