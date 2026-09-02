package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.util.JsUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.util.Alarm;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/**
 * Named implementation of ClaudeSession.SessionCallback.
 * Replaces the large anonymous inner class in setupSessionCallbacks().
 * Delegates streaming events to StreamMessageCoalescer and UI events to JavaScript callbacks.
 */
public class SessionCallbackAdapter implements ClaudeSession.SessionCallback {

    private static final Logger LOG = Logger.getInstance(SessionCallbackAdapter.class);
    /** Throttle interval targeting ~30fps to balance responsiveness with UI thread load. */
    private static final int DELTA_THROTTLE_MS = 33;
    private static final int STREAM_END_FALLBACK_DELAY_MS = 5_000;

    /**
     * Callback interface for JavaScript calls from session events.
     */
    public interface JsTarget {
        void callJavaScript(String functionName, String... args);
    }

    private final StreamMessageCoalescer streamCoalescer;
    private final JsTarget jsTarget;
    private final PermissionHandler permissionHandler;
    private final BooleanSupplier slashCommandsFetchedSupplier;
    private final Runnable streamEndCallback;
    private final StreamDeltaThrottler contentDeltaThrottler;
    private final StreamDeltaThrottler thinkingDeltaThrottler;
    private final Alarm streamEndFallbackAlarm;
    private volatile boolean active = true;
    /** Lock making deactivate() atomic with onMessageUpdate()'s active-check-then-enqueue. */
    private final Object lifecycleLock = new Object();
    private final AtomicBoolean streamEndStarted = new AtomicBoolean();
    private final AtomicBoolean streamEndSignalSent = new AtomicBoolean();
    private final AtomicLong streamGeneration = new AtomicLong();
    private final AtomicReference<String> lastSessionId = new AtomicReference<>();

    public SessionCallbackAdapter(
            StreamMessageCoalescer streamCoalescer,
            JsTarget jsTarget,
            PermissionHandler permissionHandler,
            BooleanSupplier slashCommandsFetchedSupplier,
            Runnable streamEndCallback
    ) {
        this.streamCoalescer = streamCoalescer;
        this.jsTarget = jsTarget;
        this.permissionHandler = permissionHandler;
        this.slashCommandsFetchedSupplier = slashCommandsFetchedSupplier;
        this.streamEndCallback = streamEndCallback;
        this.contentDeltaThrottler = new StreamDeltaThrottler(
                DELTA_THROTTLE_MS,
                delta -> {
                    if (!isInactive()) {
                        jsTarget.callJavaScript("onContentDelta", JsUtils.escapeJs(delta));
                    }
                }
        );
        this.thinkingDeltaThrottler = new StreamDeltaThrottler(
                DELTA_THROTTLE_MS,
                delta -> {
                    if (!isInactive()) {
                        jsTarget.callJavaScript("onThinkingDelta", JsUtils.escapeJs(delta));
                    }
                }
        );
        this.streamEndFallbackAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    }

    public void deactivate() {
        synchronized (lifecycleLock) {
            active = false;
        }
        contentDeltaThrottler.dispose();
        thinkingDeltaThrottler.dispose();
        streamEndFallbackAlarm.cancelAllRequests();
    }

    private boolean isInactive() {
        return !active;
    }

    @Override
    public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        // Atomic vs deactivate(): a stale-session reload landing mid-transition
        // must not enqueue with a post-barrier sequence and resurrect the cleared list.
        synchronized (lifecycleLock) {
            if (!active) {
                return;
            }
            streamCoalescer.enqueue(messages);
        }
    }

    @Override
    public void onStateChange(boolean busy, boolean loading, String error) {
        if (isInactive()) {
            return;
        }
        // The webview queue owns JS-thread marshalling; only the VFS refresh needs the EDT.
        if (!loading && streamCoalescer.isStreamActive()) {
            LOG.debug("Suppressing showLoading(false) during active streaming");
            return;
        }
        jsTarget.callJavaScript("showLoading", String.valueOf(loading));
        // Show error in status bar only (not as toast) to avoid duplicate notifications.
        if (error != null && !error.isEmpty()) {
            jsTarget.callJavaScript("updateStatus", JsUtils.escapeJs("Error: " + error));
        }
        if (!busy && !loading) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (!isInactive()) {
                    VirtualFileManager.getInstance().asyncRefresh(null);
                }
            });
        }
    }

    @Override
    public void onStatusMessage(String message) {
        if (isInactive() || message == null || message.trim().isEmpty()) {
            return;
        }
        jsTarget.callJavaScript("updateStatus", JsUtils.escapeJs(message));
    }

    @Override
    public void onSessionIdReceived(String sessionId) {
        if (isInactive() || sessionId == null || sessionId.trim().isEmpty()) {
            return;
        }
        // Atomic check-and-record: concurrent emissions of the same id are
        // forwarded exactly once.
        if (sessionId.equals(lastSessionId.getAndSet(sessionId))) {
            return;
        }
        LOG.info("Session ID: " + sessionId);
        jsTarget.callJavaScript("setSessionId", JsUtils.escapeJs(sessionId));
    }

    @Override
    public void onPermissionRequested(PermissionRequest request) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            permissionHandler.showPermissionDialog(request);
        });
    }

    @Override
    public void onThinkingStatusChanged(boolean isThinking) {
        if (isInactive()) {
            return;
        }
        jsTarget.callJavaScript("showThinkingStatus", String.valueOf(isThinking));
        LOG.debug("Thinking status changed: " + isThinking);
    }

    @Override
    public void onSlashCommandsReceived(List<String> slashCommands) {
        // No longer send old-format (string array) commands to the frontend.
        // Reasons:
        // 1. The full command list (with descriptions) was already fetched from getSlashCommands() during init.
        // 2. The commands received here are in old format (names only, no descriptions).
        // 3. Sending to frontend would overwrite the full command list, losing descriptions.
        int incomingCount = slashCommands != null ? slashCommands.size() : 0;
        LOG.debug("onSlashCommandsReceived called (old format, ignored). incoming=" + incomingCount);

        if (slashCommands != null && !slashCommands.isEmpty() && !slashCommandsFetchedSupplier.getAsBoolean()) {
            LOG.debug("Received " + incomingCount + " slash commands (old format), but keeping existing commands with descriptions");
        }
    }

    @Override
    public void onSummaryReceived(String summary) {
        LOG.debug("Summary received: " + (summary != null ? summary.substring(0, Math.min(50, summary.length())) : "null"));
        if (isInactive() || summary == null || summary.trim().isEmpty()) {
            return;
        }
        jsTarget.callJavaScript("showSummary", JsUtils.escapeJs(summary));
    }

    @Override
    public void onNodeLog(String log) {
        LOG.debug("Node log: " + (log != null ? log.substring(0, Math.min(100, log.length())) : "null"));
    }

    // ===== Streaming callback methods =====

    @Override
    public void onStreamStart() {
        if (isInactive()) {
            return;
        }
        streamEndFallbackAlarm.cancelAllRequests();
        streamEndStarted.set(false);
        streamEndSignalSent.set(false);
        streamGeneration.incrementAndGet();
        contentDeltaThrottler.reset();
        thinkingDeltaThrottler.reset();
        // The queue preserves this lifecycle edge ahead of all following deltas.
        jsTarget.callJavaScript("showLoading", "true");
        jsTarget.callJavaScript("onStreamStart");
        streamCoalescer.onStreamStart();
        LOG.debug("Stream started - notified frontend with loading=true");
    }

    @Override
    public void onStreamEnd() {
        if (isInactive() || !streamEndStarted.compareAndSet(false, true)) {
            return;
        }
        final long generation = streamGeneration.get();

        safeRun("contentDeltaThrottler.flushNow", contentDeltaThrottler::flushNow);
        safeRun("thinkingDeltaThrottler.flushNow", thinkingDeltaThrottler::flushNow);

        streamCoalescer.flush(sequence -> {
            if (generation != streamGeneration.get()
                    || !streamEndSignalSent.compareAndSet(false, true)) {
                return;
            }
            streamEndFallbackAlarm.cancelAllRequests();
            sendStreamEndToFrontend(sequence, generation);
        });
        safeRun("streamCoalescer.onStreamEnd", streamCoalescer::onStreamEnd);

        streamEndFallbackAlarm.cancelAllRequests();
        scheduleStreamEndFallback(generation);
    }

    private void scheduleStreamEndFallback(long generation) {
        streamEndFallbackAlarm.addRequest(() -> {
            if (generation != streamGeneration.get()
                    || streamEndSignalSent.get()
                    || isInactive()) {
                return;
            }
            if (streamCoalescer.isSnapshotBuildPending()) {
                scheduleStreamEndFallback(generation);
                return;
            }
            if (!streamEndSignalSent.compareAndSet(false, true)) {
                return;
            }
            LOG.warn("Stream end signal delivered via fallback after snapshot serialization stalled");
            sendStreamEndToFrontend(-1L, generation);
        }, STREAM_END_FALLBACK_DELAY_MS);
    }

    /**
     * Send the stream-end signal after the final snapshot has entered the webview queue.
     *
     * @param sequence final snapshot sequence, or -1 when the fallback is used
     * @param generation stream generation that owns the signal
     */
    private void sendStreamEndToFrontend(long sequence, long generation) {
        if (isInactive() || generation != streamGeneration.get()) {
            LOG.debug("Skipping stale stream-end signal (sequence=" + sequence + ")");
            return;
        }
        safeRun("callJavaScript(onStreamEnd)", () ->
                jsTarget.callJavaScript("onStreamEnd", String.valueOf(sequence)));
        safeRun("callJavaScript(showLoading, false)", () ->
                jsTarget.callJavaScript("showLoading", "false"));
        if (streamEndCallback != null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (generation == streamGeneration.get() && !isInactive()) {
                    safeRun("streamEndCallback", streamEndCallback);
                }
            });
        }
        LOG.debug("Stream ended - notified frontend (sequence=" + sequence + ")");
    }

    private static void safeRun(String label, Runnable action) {
        try {
            action.run();
        } catch (Exception e) {
            LOG.warn(label + " failed: " + e.getMessage(), e);
        }
    }

    @Override
    public void onContentDelta(String delta) {
        if (isInactive()) {
            return;
        }
        contentDeltaThrottler.append(delta);
    }

    @Override
    public void onThinkingDelta(String delta) {
        if (isInactive()) {
            return;
        }
        thinkingDeltaThrottler.append(delta);
    }

    @Override
    public void onBlockReset() {
        if (isInactive()) {
            return;
        }
        // Flush BEFORE resetting: block boundaries now fire mid-response (one per
        // content-block edge, not just per tool-loop turn), so deltas buffered in
        // the throttlers belong to the ending block. reset() alone would silently
        // drop them and force the frontend to fall back to updateMessages snapshots.
        contentDeltaThrottler.flushNow();
        thinkingDeltaThrottler.flushNow();
        contentDeltaThrottler.reset();
        thinkingDeltaThrottler.reset();
        jsTarget.callJavaScript("onBlockReset");
        LOG.debug("Block reset sent to frontend - streaming refs cleared");
    }

    @Override
    public void onUsageUpdate(int usedTokens, int maxTokens) {
        if (isInactive()) {
            return;
        }
        int safeUsedTokens = normalizeUsageValue(usedTokens);
        int safeMaxTokens = normalizeUsageValue(maxTokens);
        double percentage = calculateUsagePercentage(safeUsedTokens, safeMaxTokens);
        String json = String.format("{\"percentage\":%.2f,\"usedTokens\":%d,\"maxTokens\":%d}",
                percentage, safeUsedTokens, safeMaxTokens);
        jsTarget.callJavaScript("onUsageUpdate", JsUtils.escapeJs(json));
        LOG.debug("Usage update sent to frontend: " + safeUsedTokens + "/" + safeMaxTokens);
    }

    /**
     * Keep usage counters non-negative before they cross the JavaScript bridge.
     * Malformed or incomplete SDK usage payloads must not produce negative values
     * in the context tooltip.
     */
    static int normalizeUsageValue(int value) {
        return Math.max(0, value);
    }

    /**
     * Calculate a bounded usage percentage for the context indicator.
     */
    static double calculateUsagePercentage(int usedTokens, int maxTokens) {
        if (maxTokens <= 0) {
            return 0.0;
        }
        double percentage = usedTokens * 100.0 / maxTokens;
        return Math.max(0.0, Math.min(100.0, percentage));
    }

    @Override
    public void onUserMessageUuidPatched(String content, String uuid) {
        if (isInactive()) {
            return;
        }
        jsTarget.callJavaScript("patchMessageUuid", JsUtils.escapeJs(content), JsUtils.escapeJs(uuid));
    }

    @Override
    public void onTaskEvent(String eventJson) {
        if (isInactive() || eventJson == null || eventJson.trim().isEmpty()) {
            return;
        }
        jsTarget.callJavaScript("onTaskEvent", JsUtils.escapeJs(eventJson));
    }

    @Override
    public void onClaudeHistoryPageInfo(String sessionId, int fromTurn, int totalTurns, boolean hasMore) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            String json = String.format(
                "{\"sessionId\":\"%s\",\"fromTurn\":%d,\"totalTurns\":%d,\"hasMore\":%b}",
                JsUtils.escapeJs(sessionId), fromTurn, totalTurns, hasMore
            );
            jsTarget.callJavaScript("claudeHistoryPageInfo", JsUtils.escapeJs(json));
        });
    }

    /**
     * Dispose internal resources. Call when the parent window is disposed.
     */
    public void dispose() {
        deactivate();
        try {
            streamEndFallbackAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose streamEndFallbackAlarm: " + e.getMessage());
        }
    }
}
