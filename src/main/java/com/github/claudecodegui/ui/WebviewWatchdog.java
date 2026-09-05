package com.github.claudecodegui.ui;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.swing.*;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Webview render watchdog for JCEF stall/black-screen recovery.
 * Monitors heartbeat signals from the webview and triggers reload or recreate
 * when the webview becomes unresponsive.
 */
public class WebviewWatchdog {

    private static final Logger LOG = Logger.getInstance(WebviewWatchdog.class);

    private static final long HEARTBEAT_TIMEOUT_MS = 45_000L;
    private static final long WATCHDOG_INTERVAL_MS = 10_000L;
    private static final long RECOVERY_COOLDOWN_MS = 60_000L;
    // Remote Development backends render via Linux/OSR JCEF, whose first page
    // load (CEF cold start + the ~10MB single-file webview) takes ~60s on
    // typical hosts. A 15s startup budget reloads the page mid-load and adds
    // ~40s of restart churn per reconnect (observed 2026-09), so the pre-ready
    // budget is platform-adaptive: tight 15s locally, 150s where OSR applies.
    // Frontend readiness exits the startup phase as soon as the page finishes.
    private static final long STARTUP_READY_TIMEOUT_MS = PlatformUtils.isLinux() ? 150_000L : 15_000L;
    private static final long STARTUP_RECOVERY_COOLDOWN_MS = 15_000L;
    private static final int MAX_STARTUP_RECOVERY_ATTEMPTS = 2;

    private volatile long lastHeartbeatAtMs;
    private volatile long lastRafAtMs;
    private volatile String lastVisibility = null;
    private volatile Boolean lastHasFocus = null;
    private volatile int stallCount = 0;
    private volatile long lastRecoveryAtMs = 0L;
    private volatile ScheduledFuture<?> watchdogFuture = null;
    private final AtomicBoolean recoveryPending = new AtomicBoolean();
    private final AtomicInteger startupRecoveryAttempts = new AtomicInteger();

    private final JPanel mainPanel;
    private final BooleanSupplier browserAvailableCheck;
    private final Runnable onReloadWebview;
    private final Runnable onRecreateWebview;
    private final DisposedCheck disposedCheck;

    /**
     * Provides access to the current browser instance.
     */
    public interface BrowserProvider {
        JBCefBrowser getBrowser();
    }

    /**
     * Checks if the parent component has been disposed.
     */
    public interface DisposedCheck {
        boolean isDisposed();
    }

    /**
     * Checks if the backend is currently streaming.
     * During active streaming, JCEF IPC saturation is expected and reloading
     * the webview would destroy React state while the backend continues working.
     */
    public interface StreamActiveCheck {
        boolean isStreamActive();
    }

    public interface ReadyCheck {
        boolean isFrontendReady();
    }

    // Extended timeout during active streaming — IPC saturation is expected
    // when pushing large message payloads.  Reloading would destroy React state
    // and the backend would continue pushing to a blank page.
    private static final long STREAMING_HEARTBEAT_TIMEOUT_MS = 180_000L; // 3 minutes

    private final StreamActiveCheck streamActiveCheck;
    private final ReadyCheck readyCheck;
    private final LongSupplier currentTimeMillis;
    private final Consumer<Runnable> recoveryExecutor;

    public WebviewWatchdog(
            JPanel mainPanel,
            BrowserProvider browserProvider,
            Runnable onReloadWebview,
            Runnable onRecreateWebview,
            DisposedCheck disposedCheck,
            StreamActiveCheck streamActiveCheck,
            ReadyCheck readyCheck
    ) {
        this(
                mainPanel,
                () -> browserProvider.getBrowser() != null,
                onReloadWebview,
                onRecreateWebview,
                disposedCheck,
                streamActiveCheck,
                readyCheck,
                System::currentTimeMillis,
                runnable -> ApplicationManager.getApplication().invokeLater(runnable)
        );
    }

    WebviewWatchdog(
            JPanel mainPanel,
            BooleanSupplier browserAvailableCheck,
            Runnable onReloadWebview,
            Runnable onRecreateWebview,
            DisposedCheck disposedCheck,
            StreamActiveCheck streamActiveCheck,
            ReadyCheck readyCheck,
            LongSupplier currentTimeMillis,
            Consumer<Runnable> recoveryExecutor
    ) {
        this.mainPanel = mainPanel;
        this.browserAvailableCheck = browserAvailableCheck;
        this.onReloadWebview = onReloadWebview;
        this.onRecreateWebview = onRecreateWebview;
        this.disposedCheck = disposedCheck;
        this.streamActiveCheck = streamActiveCheck;
        this.readyCheck = readyCheck;
        this.currentTimeMillis = currentTimeMillis;
        this.recoveryExecutor = recoveryExecutor;
        long now = currentTimeMillis.getAsLong();
        this.lastHeartbeatAtMs = now;
        this.lastRafAtMs = now;
    }

    /**
     * Start the watchdog scheduler.
     */
    public void start() {
        if (watchdogFuture != null) {
            return;
        }

        watchdogFuture = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> {
            try {
                checkHealth();
            } catch (Exception e) {
                LOG.debug("[WebviewWatchdog] Unexpected error: " + e.getMessage(), e);
            }
        }, WATCHDOG_INTERVAL_MS, WATCHDOG_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * Stop the watchdog scheduler.
     */
    public void stop() {
        if (watchdogFuture != null) {
            watchdogFuture.cancel(true);
            watchdogFuture = null;
        }
    }

    /**
     * Handle a heartbeat message from the webview.
     */
    public void handleHeartbeat(String content) {
        long now = currentTimeMillis.getAsLong();
        lastHeartbeatAtMs = now;

        if (content == null || content.isEmpty()) {
            lastRafAtMs = now;
            lastVisibility = null;
            lastHasFocus = null;
            return;
        }

        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            if (json != null) {
                if (json.has("raf")) {
                    lastRafAtMs = json.get("raf").getAsLong();
                } else {
                    lastRafAtMs = now;
                }
                if (json.has("visibility")) {
                    lastVisibility = json.get("visibility").getAsString();
                }
                if (json.has("focus")) {
                    lastHasFocus = json.get("focus").getAsBoolean();
                }
            }
        } catch (Exception ignored) {
            // Non-JSON heartbeat payload (backward compatibility)
            lastRafAtMs = now;
        }
    }

    /**
     * Reset heartbeat timestamps (e.g., after a recovery action).
     */
    public void resetTimestamps() {
        long now = currentTimeMillis.getAsLong();
        lastHeartbeatAtMs = now;
        lastRafAtMs = now;
        lastVisibility = null;
        lastHasFocus = null;
    }

    public void markFrontendReady() {
        resetTimestamps();
        resetRecoveryState();
    }

    /** Give an activated tab one heartbeat window before evaluating stale metadata. */
    public void markTabActivated() {
        resetTimestamps();
        resetRecoveryState();
    }

    void checkHealth() {
        if (disposedCheck.isDisposed()) { return; }
        boolean frontendReady = readyCheck.isFrontendReady();

        long now = currentTimeMillis.getAsLong();
        long heartbeatAgeMs = now - lastHeartbeatAtMs;
        long rafAgeMs = now - lastRafAtMs;

        boolean visible = lastVisibility == null || "visible".equals(lastVisibility);
        boolean focused = lastHasFocus == null || lastHasFocus;
        if (!shouldMonitor(frontendReady, mainPanel.isShowing(), visible, focused)) {
            return;
        }

        long recoveryCooldownMs = recoveryCooldownMs(frontendReady);
        if (now - lastRecoveryAtMs < recoveryCooldownMs) {
            return;
        }

        // During active streaming, JCEF IPC saturation is expected with large payloads.
        // Use a much longer timeout to avoid destroying React state unnecessarily.
        // Reloading during streaming causes "fake death": backend continues working
        // but the webview shows empty content because streaming state is lost.
        boolean streaming = streamActiveCheck.isStreamActive();
        long effectiveTimeoutMs = heartbeatTimeoutMs(frontendReady, streaming);

        boolean stalled = heartbeatAgeMs > effectiveTimeoutMs || rafAgeMs > effectiveTimeoutMs;
        if (!stalled) {
            stallCount = 0;
            return;
        }

        scheduleRecoveryCheck();
    }

    boolean tryAcquireRecoveryPermit(boolean frontendReady) {
        if (frontendReady) {
            return true;
        }

        while (true) {
            int attempts = startupRecoveryAttempts.get();
            if (attempts >= MAX_STARTUP_RECOVERY_ATTEMPTS) {
                return false;
            }
            if (startupRecoveryAttempts.compareAndSet(attempts, attempts + 1)) {
                return true;
            }
        }
    }

    private void resetRecoveryState() {
        stallCount = 0;
        lastRecoveryAtMs = 0L;
        startupRecoveryAttempts.set(0);
    }

    static long heartbeatTimeoutMs(boolean frontendReady, boolean streaming) {
        if (!frontendReady) {
            return STARTUP_READY_TIMEOUT_MS;
        }
        return streaming ? STREAMING_HEARTBEAT_TIMEOUT_MS : HEARTBEAT_TIMEOUT_MS;
    }

    /** Whether the pre-ready startup budget uses the extended remote/OSR value. */
    static boolean isRemoteStartupBudget() {
        return PlatformUtils.isLinux();
    }

    static long recoveryCooldownMs(boolean frontendReady) {
        return frontendReady ? RECOVERY_COOLDOWN_MS : STARTUP_RECOVERY_COOLDOWN_MS;
    }

    static boolean shouldMonitor(boolean frontendReady,
                                 boolean panelShowing,
                                 boolean pageVisible,
                                 boolean pageFocused) {
        // A hidden JCEF page cannot advance requestAnimationFrame or complete
        // frontend startup reliably. Treat visibility as a lifecycle gate for
        // both startup and runtime health checks; tab activation resets the
        // timestamps before monitoring resumes.
        // Editor focus is independent from webview render health.
        return panelShowing && pageVisible;
    }

    private void scheduleRecoveryCheck() {
        if (!recoveryPending.compareAndSet(false, true)) {
            return;
        }
        try {
            recoveryExecutor.accept(() -> {
                try {
                    executeRecoveryIfStillRequired();
                } finally {
                    recoveryPending.set(false);
                }
            });
        } catch (RuntimeException e) {
            recoveryPending.set(false);
            throw e;
        }
    }

    private void executeRecoveryIfStillRequired() {
        if (disposedCheck.isDisposed()) { return; }
        boolean frontendReady = readyCheck.isFrontendReady();
        boolean visible = lastVisibility == null || "visible".equals(lastVisibility);
        boolean focused = lastHasFocus == null || lastHasFocus;
        if (!shouldMonitor(frontendReady, mainPanel.isShowing(), visible, focused)) {
            return;
        }

        long now = currentTimeMillis.getAsLong();
        if (now - lastRecoveryAtMs < recoveryCooldownMs(frontendReady)) {
            return;
        }
        long heartbeatAgeMs = now - lastHeartbeatAtMs;
        long rafAgeMs = now - lastRafAtMs;
        long effectiveTimeoutMs = heartbeatTimeoutMs(
                frontendReady, streamActiveCheck.isStreamActive());
        if (heartbeatAgeMs <= effectiveTimeoutMs && rafAgeMs <= effectiveTimeoutMs) {
            stallCount = 0;
            return;
        }
        if (!tryAcquireRecoveryPermit(frontendReady)) { return; }

        stallCount += 1;
        String reason = "frontendReady=" + frontendReady
                + ", heartbeatAgeMs=" + heartbeatAgeMs + ", rafAgeMs=" + rafAgeMs;
        LOG.warn("[WebviewWatchdog] Webview appears stalled (" + stallCount
                + "), attempting recovery. " + reason);

        lastRecoveryAtMs = now;
        lastHeartbeatAtMs = now;
        lastRafAtMs = now;

        if (stallCount <= 1 && browserAvailableCheck.getAsBoolean()) {
            onReloadWebview.run();
        } else {
            onRecreateWebview.run();
            stallCount = 0;
        }

        if (!frontendReady && startupRecoveryAttempts.get() == MAX_STARTUP_RECOVERY_ATTEMPTS) {
            LOG.warn("[WebviewWatchdog] Startup recovery limit reached; "
                    + "waiting for frontend readiness or tab activation before retrying");
        }
    }
}
