package com.github.claudecodegui.ui;

import org.junit.Test;

import javax.swing.JPanel;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for startup/runtime watchdog timing, visibility gating, and recovery budgets.
 */
public class WebviewWatchdogTest {

    /**
     * Verifies that an unready frontend uses the bounded startup timeout.
     * On Linux (Remote Development backends render via OSR) the startup budget
     * is intentionally larger than the post-ready heartbeat timeout, because
     * the first page load legitimately takes about a minute; on desktop
     * platforms it stays tighter than the runtime timeout.
     */
    @Test
    public void usesShortTimeoutBeforeFrontendReady() {
        long startupTimeout = WebviewWatchdog.heartbeatTimeoutMs(false, false);

        assertEquals(startupTimeout, WebviewWatchdog.heartbeatTimeoutMs(false, true));
        if (WebviewWatchdog.isRemoteStartupBudget()) {
            assertTrue(startupTimeout >= WebviewWatchdog.heartbeatTimeoutMs(true, false));
        } else {
            assertTrue(startupTimeout < WebviewWatchdog.heartbeatTimeoutMs(true, false));
        }
    }

    /** Verifies that active streaming only extends the timeout after frontend readiness. */
    @Test
    public void extendsHeartbeatTimeoutOnlyForReadyStreamingWebview() {
        assertTrue(WebviewWatchdog.heartbeatTimeoutMs(true, true)
                > WebviewWatchdog.heartbeatTimeoutMs(true, false));
    }

    /** Verifies that startup recovery uses a shorter cooldown than runtime recovery. */
    @Test
    public void retriesStartupRecoverySoonerThanRuntimeRecovery() {
        assertTrue(WebviewWatchdog.recoveryCooldownMs(false)
                < WebviewWatchdog.recoveryCooldownMs(true));
    }

    /** Verifies that hidden unready tabs stay idle until their panel becomes visible. */
    @Test
    public void pausesStartupMonitoringWhilePanelIsHidden() {
        assertFalse(WebviewWatchdog.shouldMonitor(false, false, false, false));
        assertTrue(WebviewWatchdog.shouldMonitor(false, true, true, false));
    }

    /** Verifies through checkHealth that hidden startup pages do not invoke recovery callbacks. */
    @Test
    public void hiddenHealthCheckDefersRecoveryUntilPanelIsVisible() {
        AtomicLong now = new AtomicLong(1_000L);
        AtomicInteger reloads = new AtomicInteger();
        AtomicInteger recreates = new AtomicInteger();
        ShowingPanel panel = new ShowingPanel(false);
        WebviewWatchdog watchdog = createWatchdog(
                panel, now, reloads, recreates, Runnable::run);
        now.addAndGet(1_000_000L);

        watchdog.checkHealth();
        assertEquals(0, reloads.get());
        assertEquals(0, recreates.get());

        panel.setShowing(true);
        watchdog.checkHealth();
        assertEquals(1, reloads.get());
        assertEquals(0, recreates.get());
    }

    /** Verifies that a cancelled recovery neither consumes budget nor advances reload to recreate. */
    @Test
    public void cancelledRecoveryLeavesFirstVisibleAttemptAsReload() {
        AtomicLong now = new AtomicLong(1_000L);
        AtomicInteger reloads = new AtomicInteger();
        AtomicInteger recreates = new AtomicInteger();
        AtomicInteger queuedCount = new AtomicInteger();
        AtomicReference<Runnable> queuedRecovery = new AtomicReference<>();
        ShowingPanel panel = new ShowingPanel(true);
        WebviewWatchdog watchdog = createWatchdog(
                panel, now, reloads, recreates, recovery -> {
                    queuedCount.incrementAndGet();
                    queuedRecovery.set(recovery);
                });
        now.addAndGet(1_000_000L);

        watchdog.checkHealth();
        watchdog.checkHealth();
        assertEquals(1, queuedCount.get());
        assertTrue(queuedRecovery.get() != null);
        panel.setShowing(false);
        queuedRecovery.get().run();

        assertEquals(0, reloads.get());
        assertEquals(0, recreates.get());

        panel.setShowing(true);
        watchdog.checkHealth();
        assertEquals(2, queuedCount.get());
        queuedRecovery.get().run();

        assertEquals(1, reloads.get());
        assertEquals(0, recreates.get());
        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertFalse(watchdog.tryAcquireRecoveryPermit(false));
    }

    /** Verifies that runtime monitoring follows render visibility rather than editor focus. */
    @Test
    public void pausesRuntimeMonitoringWhenWebviewCannotRenderVisibly() {
        assertTrue(WebviewWatchdog.shouldMonitor(true, true, true, true));
        assertFalse(WebviewWatchdog.shouldMonitor(true, false, true, true));
        assertFalse(WebviewWatchdog.shouldMonitor(true, true, false, true));
        // Editor focus is independent from Webview render health.
        assertTrue(WebviewWatchdog.shouldMonitor(true, true, true, false));
    }

    /** Verifies that repeated startup recovery cannot loop indefinitely. */
    @Test
    public void capsBackgroundStartupRecovery() {
        WebviewWatchdog watchdog = createWatchdog();

        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertFalse(watchdog.tryAcquireRecoveryPermit(false));
    }

    /** Verifies that frontend readiness restores a previously exhausted startup budget. */
    @Test
    public void frontendReadinessRestoresStartupRecoveryBudget() {
        WebviewWatchdog watchdog = exhaustedWatchdog();

        watchdog.markFrontendReady();

        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertFalse(watchdog.tryAcquireRecoveryPermit(false));
    }

    /** Verifies that an ordinary timestamp reset does not bypass the startup retry cap. */
    @Test
    public void timestampResetDoesNotRestoreStartupRecoveryBudget() {
        WebviewWatchdog watchdog = exhaustedWatchdog();

        watchdog.resetTimestamps();

        assertFalse(watchdog.tryAcquireRecoveryPermit(false));
    }

    /** Verifies that explicit tab activation grants a fresh bounded startup retry budget. */
    @Test
    public void tabActivationRestoresStartupRecoveryBudget() {
        WebviewWatchdog watchdog = exhaustedWatchdog();

        watchdog.markTabActivated();

        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertFalse(watchdog.tryAcquireRecoveryPermit(false));
    }

    /** Verifies that ready runtime pages are not constrained by the startup retry budget. */
    @Test
    public void runtimeRecoveryIsNotCappedByStartupBudget() {
        WebviewWatchdog watchdog = createWatchdog();

        for (int attempt = 0; attempt < 10; attempt++) {
            assertTrue(watchdog.tryAcquireRecoveryPermit(true));
        }
    }

    private static WebviewWatchdog exhaustedWatchdog() {
        WebviewWatchdog watchdog = createWatchdog();
        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertTrue(watchdog.tryAcquireRecoveryPermit(false));
        assertFalse(watchdog.tryAcquireRecoveryPermit(false));
        return watchdog;
    }

    private static WebviewWatchdog createWatchdog() {
        return new WebviewWatchdog(
                new javax.swing.JPanel(),
                () -> null,
                () -> { },
                () -> { },
                () -> false,
                () -> false,
                () -> false
        );
    }

    private static WebviewWatchdog createWatchdog(
            JPanel panel,
            AtomicLong now,
            AtomicInteger reloads,
            AtomicInteger recreates,
            Consumer<Runnable> recoveryExecutor
    ) {
        return new WebviewWatchdog(
                panel,
                () -> true,
                reloads::incrementAndGet,
                recreates::incrementAndGet,
                () -> false,
                () -> false,
                () -> false,
                now::get,
                recoveryExecutor
        );
    }

    private static final class ShowingPanel extends JPanel {
        private boolean showing;

        private ShowingPanel(boolean showing) {
            this.showing = showing;
        }

        private void setShowing(boolean showing) {
            this.showing = showing;
        }

        @Override
        public boolean isShowing() {
            return showing;
        }
    }
}
