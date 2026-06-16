package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.util.JsUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.util.Alarm;

import java.util.List;
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
    /** Guards against duplicate onStreamEnd delivery from dual-path dispatch. */
    private volatile boolean streamEndSignalSent = false;

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
        active = false;
        contentDeltaThrottler.dispose();
        thinkingDeltaThrottler.dispose();
        streamEndFallbackAlarm.cancelAllRequests();
    }

    private boolean isInactive() {
        return !active;
    }

    @Override
    public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        if (isInactive()) {
            return;
        }
        streamCoalescer.enqueue(messages);
    }

    @Override
    public void onStateChange(boolean busy, boolean loading, String error) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            // Do not send loading=false during streaming to avoid unexpected loading state resets.
            // State cleanup is handled uniformly by onStreamEnd.
            if (!loading && streamCoalescer.isStreamActive()) {
                LOG.debug("Suppressing showLoading(false) during active streaming");
                return;
            }

            jsTarget.callJavaScript("showLoading", String.valueOf(loading));
            // Show error in status bar only (not as toast) to avoid duplicate notifications.
            // The primary error display is the ERROR message in chat list (from onError path).
            if (error != null && !error.isEmpty()) {
                jsTarget.callJavaScript("updateStatus", JsUtils.escapeJs("Error: " + error));
            }
            if (!busy && !loading) {
                VirtualFileManager.getInstance().asyncRefresh(null);
            }
        });
    }

    @Override
    public void onStatusMessage(String message) {
        if (isInactive() || message == null || message.trim().isEmpty()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("updateStatus", JsUtils.escapeJs(message));
        });
    }

    @Override
    public void onSessionIdReceived(String sessionId) {
        if (isInactive()) {
            return;
        }
        LOG.info("Session ID: " + sessionId);
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("setSessionId", JsUtils.escapeJs(sessionId));
        });
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
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("showThinkingStatus", String.valueOf(isThinking));
            LOG.debug("Thinking status changed: " + isThinking);
        });
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
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("showSummary", JsUtils.escapeJs(summary));
        });
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
        // Cancel any stale fallback alarm from the previous turn to prevent
        // it from firing during the new turn's streaming phase.
        streamEndFallbackAlarm.cancelAllRequests();
        contentDeltaThrottler.reset();
        thinkingDeltaThrottler.reset();
        streamCoalescer.onStreamStart();
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("showLoading", "true");
            jsTarget.callJavaScript("onStreamStart");
            LOG.debug("Stream started - notified frontend with loading=true");
        });
    }

    @Override
    public void onStreamEnd() {
        if (isInactive()) {
            return;
        }
        // Reset the signal guard so this turn's dual-path dispatch can proceed.
        // Thread-safety: this runs on the process reader thread; the callbacks that
        // read/write streamEndSignalSent all run on EDT (via invokeLater or Alarm).
        // The reset happens-before flush() schedules any callbacks, so no race exists.
        streamEndSignalSent = false;

        // Each step is wrapped in safeRun so that a failure in one step
        // (e.g., flushNow throwing due to a disposed throttler, or JCEF
        // rejecting a large payload) does not prevent the critical
        // onStreamEnd signal from reaching the frontend.
        safeRun("contentDeltaThrottler.flushNow", contentDeltaThrottler::flushNow);
        safeRun("thinkingDeltaThrottler.flushNow", thinkingDeltaThrottler::flushNow);
        safeRun("streamCoalescer.onStreamEnd", streamCoalescer::onStreamEnd);

        // ── Dual-path onStreamEnd delivery ──
        //
        // Primary path: chain onStreamEnd inside the flush callback. The callback
        // runs on the EDT *after* the updateMessages JS call has been dispatched,
        // guaranteeing the frontend receives the final message snapshot before the
        // stream-end signal.
        //
        // Fallback path: an independent Alarm fires after 300ms. This covers the
        // scenario where the flush's 3-layer async pipeline fails silently (JCEF
        // large payload rejection, disposed browser, JSON serialization OOM).
        //
        // The frontend's onStreamEnd is idempotent (per-turn guard), so receiving
        // both signals is harmless — only the first takes effect.

        // Primary: ordered delivery via flush callback
        streamCoalescer.flush(sequence -> {
            if (streamEndSignalSent) {
                return;
            }
            streamEndSignalSent = true;
            streamEndFallbackAlarm.cancelAllRequests();
            sendStreamEndToFrontend(sequence);
        });

        // Fallback: independent delivery after timeout
        streamEndFallbackAlarm.cancelAllRequests();
        streamEndFallbackAlarm.addRequest(() -> {
            if (streamEndSignalSent || isInactive()) {
                return;
            }
            streamEndSignalSent = true;
            LOG.warn("Stream end signal delivered via fallback (primary flush callback did not fire within 300ms)");
            sendStreamEndToFrontend(-1);
        }, 300);
    }

    /**
     * Send the onStreamEnd signal and associated cleanup to the frontend.
     * Called from either the primary (flush callback) or fallback (Alarm) path.
     *
     * @param sequence the flush sequence number, or -1 if fired from fallback
     */
    private void sendStreamEndToFrontend(long sequence) {
        if (isInactive()) {
            LOG.debug("Skipping sendStreamEndToFrontend — adapter deactivated (sequence=" + sequence + ")");
            return;
        }
        safeRun("callJavaScript(onStreamEnd)", () ->
                jsTarget.callJavaScript("onStreamEnd", String.valueOf(sequence)));
        safeRun("callJavaScript(showLoading, false)", () ->
                jsTarget.callJavaScript("showLoading", "false"));
        if (streamEndCallback != null) {
            safeRun("streamEndCallback", streamEndCallback);
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
    public void onUsageUpdate(int usedTokens, int maxTokens) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            double percentage = maxTokens > 0 ? (usedTokens * 100.0 / maxTokens) : 0.0;
            String json = String.format("{\"percentage\":%.2f,\"usedTokens\":%d,\"maxTokens\":%d}",
                    percentage, usedTokens, maxTokens);
            jsTarget.callJavaScript("onUsageUpdate", JsUtils.escapeJs(json));
            LOG.debug("Usage update sent to frontend: " + usedTokens + "/" + maxTokens);
        });
    }

    @Override
    public void onLimitsUpdate(String json) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("onUsageLimitsUpdate", JsUtils.escapeJs(json));
            LOG.debug("Limits update sent to frontend");
        });
    }

    @Override
    public void onUserMessageUuidPatched(String content, String uuid) {
        if (isInactive()) {
            return;
        }
        jsTarget.callJavaScript("patchMessageUuid", JsUtils.escapeJs(content), JsUtils.escapeJs(uuid));
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
