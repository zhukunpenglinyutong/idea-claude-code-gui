package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.MessageJsonConverter;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.Alarm;

import java.util.List;
import java.util.function.LongConsumer;

/**
 * Coalesces streaming message updates to throttle webview pushes.
 * Batches rapid onMessageUpdate callbacks into periodic UI refreshes
 * to avoid overwhelming the JCEF browser.
 */
public class StreamMessageCoalescer {

    private static final Logger LOG = Logger.getInstance(StreamMessageCoalescer.class);
    private static final int UPDATE_INTERVAL_MS = 50;
    private static final int LARGE_UPDATE_PAYLOAD_CHARS = 150_000;
    private static final long SLOW_PAYLOAD_BUILD_MS = 25L;

    // FIX: Adaptive throttling to prevent JCEF IPC saturation during long streams.
    // When the full message JSON is large, V8 must parse the entire string literal
    // on every executeJavaScript call.  At 50ms intervals with 200KB+ payloads,
    // the renderer thread falls behind and enters a death spiral where IPC messages
    // pile up and ALL JavaScript calls (including onContentDelta) are blocked.
    //
    // Strategy: during active streaming, scale the coalescing interval based on the
    // last observed payload size.  Content updates still arrive via onContentDelta
    // (tiny payloads, <1KB), so the user sees streaming text.  Only the full message
    // list refresh (updateMessages) is throttled.
    private static final int LARGE_PAYLOAD_THRESHOLD = 100_000;   // 100KB
    private static final int MEDIUM_INTERVAL_MS = 500;             // 100-200KB
    private static final int LARGE_INTERVAL_MS = 2_000;            // 200-500KB
    private static final int XLARGE_INTERVAL_MS = 5_000;           // >500KB
    private static final int LONG_CONVERSATION_THRESHOLD = 300;
    private static final int LONG_CONVERSATION_TAIL_SIZE = 180;

    // During streaming, delta channel (onContentDelta/onThinkingDelta) provides
    // real-time character-by-character updates.  updateMessages carries authoritative
    // raw blocks (tool_use, tool_result, etc.) and is the ONLY channel that can
    // surface structural changes to the frontend.  Keep this minimum tight so that
    // newly-arrived tool_use / tool_result blocks show up promptly instead of
    // appearing to "stick" at the bottom while the user waits for an answer.
    // The adaptive thresholds above will still scale up for large payloads.
    private static final int STREAMING_MIN_INTERVAL_MS = 150;

    // FIX: Heartbeat interval during streaming.  During tool execution phases
    // (command execution, file operations, etc.), no content deltas or message
    // updates arrive from the SDK.  Without a heartbeat, the frontend stall
    // watchdog may falsely trigger and prematurely end the streaming state.
    // This lightweight signal keeps the frontend watchdog alive.
    private static final int HEARTBEAT_INTERVAL_MS = 10_000;       // 10s

    private final Object lock = new Object();
    private final Alarm updateAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    private final Alarm heartbeatAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    private volatile boolean streamActive = false;
    private volatile boolean updateScheduled = false;
    private volatile long lastUpdateAtMs = 0L;
    private volatile long updateSequence = 0L;
    // Written from the pooled thread in sendToWebView, read from EDT/schedulePush via
    // effectiveIntervalMs().  Volatile guarantees visibility but not atomicity with the
    // lock-protected fields.  This is intentional: a one-cycle stale read only means the
    // interval adapts one push later — acceptable for a best-effort throttling heuristic.
    private volatile int lastPayloadChars = 0;
    private volatile List<ClaudeSession.Message> pendingMessages = null;
    private volatile List<ClaudeSession.Message> lastSnapshot = null;
    private volatile List<ClaudeSession.Message> lastDeliveredSnapshot = null;

    private final JsCallbackTarget callbackTarget;

    /**
     * Callback interface to push data to the webview.
     */
    public interface JsCallbackTarget {
        void callJavaScript(String functionName, String... args);
        JBCefBrowser getBrowser();
        boolean isDisposed();
        HandlerContext getHandlerContext();

        /**
         * Fired when the stream transitions to inactive (end of a turn's
         * streaming segment). Lets the host run work that was deferred while the
         * stream was active — e.g. a session_updated reload held back so it does
         * not disturb the streaming bubble or race SessionState mutations.
         * Default no-op so existing targets need not implement it.
         */
        default void onStreamEnded() {}
    }

    record MessageTransport(
            List<ClaudeSession.Message> messages,
            int baseIndex,
            boolean tailUpdate
    ) {}

    public StreamMessageCoalescer(JsCallbackTarget callbackTarget) {
        this.callbackTarget = callbackTarget;
    }

    /**
     * Enqueue a message update for coalesced delivery.
     */
    public void enqueue(List<ClaudeSession.Message> messages) {
        if (callbackTarget.isDisposed()) {
            return;
        }
        // Defensive copy: the caller's list may be mutated on another thread,
        // so we snapshot it here to guarantee a consistent read in sendToWebView.
        final List<ClaudeSession.Message> snapshot = List.copyOf(messages);
        synchronized (lock) {
            pendingMessages = snapshot;
        }
        schedulePush();
        // Restart heartbeat timer: real data just arrived, so the next heartbeat
        // should fire HEARTBEAT_INTERVAL_MS from now, not from the last heartbeat.
        if (streamActive) {
            startHeartbeat();
        }
    }

    /**
     * Notify that a stream has started.
     */
    public void onStreamStart() {
        synchronized (lock) {
            streamActive = true;
        }
        startHeartbeat();
    }

    /**
     * Notify that a stream has ended.
     */
    public void onStreamEnd() {
        heartbeatAlarm.cancelAllRequests();
        synchronized (lock) {
            streamActive = false;
            lastPayloadChars = 0;  // Reset so post-stream flush uses normal interval
        }
        // Notify the host that the stream went inactive, so it can drain work
        // deferred during streaming (e.g. a background session_updated reload).
        // Done outside the lock: the host may synchronously schedule EDT work,
        // and holding `lock` across a foreign callback risks lock-ordering issues.
        callbackTarget.onStreamEnded();
    }

    /**
     * Reset stream state (e.g., on new session creation).
     *
     * @return the post-reset update sequence, to be forwarded to the frontend as
     *     a "sequence barrier". Any stale updateMessages from the previous
     *     session that were already dispatched to JS (and are queued in the JCEF
     *     IPC channel) carry a strictly smaller sequence, so the frontend's
     *     {@code __minAcceptedUpdateSequence} guard rejects them. This closes the
     *     race where a delayed old snapshot repopulates a list that "new session"
     *     just cleared.
     */
    public long resetStreamState() {
        updateAlarm.cancelAllRequests();
        heartbeatAlarm.cancelAllRequests();
        synchronized (lock) {
            streamActive = false;
            updateScheduled = false;
            pendingMessages = null;
            lastSnapshot = null;
            lastDeliveredSnapshot = null;
            lastUpdateAtMs = 0L;
            lastPayloadChars = 0;
            return ++updateSequence;
        }
    }

    public boolean isStreamActive() {
        return streamActive;
    }

    /**
     * Flush any pending messages immediately and optionally run a callback afterwards.
     */
    public void flush(LongConsumer afterFlushOnEdt) {
        if (callbackTarget.isDisposed()) {
            return;
        }

        final List<ClaudeSession.Message> snapshot;
        final long sequence;
        synchronized (lock) {
            updateAlarm.cancelAllRequests();
            updateScheduled = false;
            snapshot = pendingMessages != null ? pendingMessages : lastSnapshot;
            pendingMessages = null;
            sequence = ++updateSequence;
        }

        if (snapshot == null) {
            if (afterFlushOnEdt != null) {
                final long finalSequence = sequence;
                ApplicationManager.getApplication().invokeLater(() -> afterFlushOnEdt.accept(finalSequence));
            }
            return;
        }

        sendToWebView(snapshot, sequence, afterFlushOnEdt);
    }

    /**
     * Dispose internal resources.
     */
    public void dispose() {
        try {
            updateAlarm.cancelAllRequests();
            updateAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose stream message update alarm: " + e.getMessage());
        }
        try {
            heartbeatAlarm.cancelAllRequests();
            heartbeatAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose heartbeat alarm: " + e.getMessage());
        }
    }

    /**
     * Compute the effective coalescing interval.  During streaming, scale the
     * interval based on the last observed payload size to prevent JCEF overload.
     */
    private int effectiveIntervalMs() {
        if (!streamActive) {
            return UPDATE_INTERVAL_MS;
        }
        int chars = lastPayloadChars;
        int interval;
        if (chars > 500_000) {
            interval = XLARGE_INTERVAL_MS;
        } else if (chars > 200_000) {
            interval = LARGE_INTERVAL_MS;
        } else if (chars > LARGE_PAYLOAD_THRESHOLD) {
            interval = MEDIUM_INTERVAL_MS;
        } else {
            return STREAMING_MIN_INTERVAL_MS;
        }
        if (LOG.isDebugEnabled()) {
            LOG.debug("[AdaptiveThrottle] payload=" + chars + " chars → interval=" + interval + "ms");
        }
        return interval;
    }

    private void schedulePush() {
        if (callbackTarget.isDisposed()) {
            return;
        }

        final int delayMs;
        synchronized (lock) {
            if (updateScheduled) {
                return;
            }
            int intervalMs = effectiveIntervalMs();
            long elapsed = System.currentTimeMillis() - lastUpdateAtMs;
            delayMs = (int) Math.max(0L, intervalMs - elapsed);
            updateScheduled = true;
            ++updateSequence;
        }

        updateAlarm.addRequest(() -> {
            final List<ClaudeSession.Message> snapshot;
            final long sequence;
            synchronized (lock) {
                updateScheduled = false;
                lastUpdateAtMs = System.currentTimeMillis();
                snapshot = pendingMessages;
                pendingMessages = null;
                sequence = updateSequence;
            }

            if (callbackTarget.isDisposed()) {
                return;
            }

            if (snapshot != null) {
                sendToWebView(snapshot, sequence, null);
            }

            boolean hasPending;
            synchronized (lock) {
                hasPending = pendingMessages != null;
            }
            if (hasPending && !callbackTarget.isDisposed()) {
                schedulePush();
            }
        }, delayMs);
    }

    private void sendToWebView(
            List<ClaudeSession.Message> messages,
            long sequence,
            LongConsumer afterSendOnEdt
    ) {
        // Keep the snapshot for potential re-flush after webview reload/recreate.
        // Only a snapshot actually dispatched to the WebView can prove whether
        // the omitted prefix is stable enough for an indexed tail update.
        final List<ClaudeSession.Message> deliveredSnapshot;
        synchronized (lock) {
            deliveredSnapshot = lastDeliveredSnapshot;
            lastSnapshot = messages;
        }

        MessageTransport transport = selectMessageTransport(messages, deliveredSnapshot);
        final boolean tailUpdate = transport.tailUpdate();
        final int tailBaseIndex = transport.baseIndex();
        final List<ClaudeSession.Message> transportMessages = transport.messages();

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            final int payloadChars;
            final long payloadBuildMs;
            final String escapedMessagesJson;
            try {
                long buildStartedAt = System.nanoTime();
                String messagesJson = MessageJsonConverter.convertMessagesToJson(transportMessages);
                payloadChars = messagesJson.length();
                escapedMessagesJson = JsUtils.escapeJs(messagesJson);
                payloadBuildMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - buildStartedAt);

                // FIX: Record payload size for adaptive throttling
                lastPayloadChars = payloadChars;

                if (payloadChars >= LARGE_UPDATE_PAYLOAD_CHARS || payloadBuildMs >= SLOW_PAYLOAD_BUILD_MS) {
                    LOG.info("[WebviewTransport] updateMessages payload chars=" + payloadChars
                            + ", messages=" + messages.size()
                            + ", transportedMessages=" + transportMessages.size()
                            + ", tailBaseIndex=" + tailBaseIndex
                            + ", buildMs=" + payloadBuildMs
                            + ", sequence=" + sequence);
                } else if (LOG.isDebugEnabled()) {
                    LOG.debug("[WebviewTransport] updateMessages payload chars=" + payloadChars
                            + ", messages=" + messages.size()
                            + ", transportedMessages=" + transportMessages.size()
                            + ", buildMs=" + payloadBuildMs
                            + ", sequence=" + sequence);
                }
            } catch (Exception e) {
                LOG.warn("Failed to serialize messages for streaming update: " + e.getMessage(), e);
                if (afterSendOnEdt != null) {
                    final long finalSequence = sequence;
                    ApplicationManager.getApplication().invokeLater(() -> afterSendOnEdt.accept(finalSequence));
                }
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                if (callbackTarget.isDisposed()) {
                    // FIX: Still run afterSendOnEdt even when disposed, so that
                    // onStreamEnd/showLoading(false) callbacks execute and clear
                    // streaming state. Without this, a dispose race leaves the
                    // frontend permanently stuck in "responding" state.
                    if (afterSendOnEdt != null) {
                        afterSendOnEdt.accept(sequence);
                    }
                    return;
                }

                final long pushSequence;
                synchronized (lock) {
                    if (sequence != updateSequence) {
                        // Stale snapshot: a newer one is pending or was just pushed,
                        // so normally we skip this push. Force-push ONLY on the flush
                        // path (afterSendOnEdt != null) - that is the onStreamEnd flush
                        // carrying the turn's FINAL snapshot, and when a late enqueue
                        // has advanced updateSequence past it, no newer snapshot will
                        // compensate, so the turn's tail content would be lost for good.
                        // The alarm path (afterSendOnEdt == null) holds a possibly
                        // outdated snapshot; force-pushing it would advance the sequence
                        // and let a stale frame overwrite the final one once its
                        // (large-payload-delayed) invokeLater lands after the flush.
                        // Advancing the sequence on force-push keeps the frontend's
                        // minAcceptedUpdateSequence barrier accepting the frame.
                        if (streamActive || afterSendOnEdt == null) {
                            if (afterSendOnEdt != null) {
                                afterSendOnEdt.accept(sequence);
                            }
                            return;
                        }
                        pushSequence = ++updateSequence;
                        LOG.info("[StreamMessageCoalescer] Force-pushing stale final snapshot after"
                                + " stream end (stale sequence=" + sequence
                                + ", pushed=" + pushSequence
                                + ") to avoid losing the turn's final content");
                    } else {
                        pushSequence = sequence;
                    }
                }

                // FIX: Wrap callJavaScript in try-catch so that a JCEF failure
                // (e.g., large payload rejection, disposed browser race) does not
                // prevent afterSendOnEdt from running.  When afterSendOnEdt carries
                // the onStreamEnd signal, failing to run it permanently freezes the UI.
                try {
                    if (tailUpdate) {
                        callbackTarget.callJavaScript(
                                "updateMessageTail",
                                escapedMessagesJson,
                                String.valueOf(tailBaseIndex),
                                String.valueOf(pushSequence));
                    } else {
                        callbackTarget.callJavaScript("updateMessages", escapedMessagesJson, String.valueOf(pushSequence));
                    }
                    synchronized (lock) {
                        if (pushSequence == updateSequence) {
                            lastDeliveredSnapshot = messages;
                        }
                    }
                    MessageJsonConverter.pushUsageUpdateFromMessages(
                            messages,
                            callbackTarget.getHandlerContext(),
                            callbackTarget.getBrowser(),
                            callbackTarget.isDisposed()
                    );
                } catch (Exception e) {
                    LOG.warn("Failed to push updateMessages to webview (payload chars="
                            + escapedMessagesJson.length() + "): " + e.getMessage(), e);
                }

                if (afterSendOnEdt != null) {
                    afterSendOnEdt.accept(pushSequence);
                }
            });
        });
    }

    static MessageTransport selectMessageTransport(List<ClaudeSession.Message> messages,
                                                    List<ClaudeSession.Message> previousMessages) {
        boolean longConversation = messages.size() > LONG_CONVERSATION_THRESHOLD;
        int candidateBaseIndex = longConversation
                ? Math.max(0, messages.size() - LONG_CONVERSATION_TAIL_SIZE) : 0;
        boolean stablePrefix = previousMessages != null
                && (messages.size() >= previousMessages.size()
                && hasSamePrefix(previousMessages, messages, candidateBaseIndex));
        boolean tailUpdate = longConversation && stablePrefix;
        int baseIndex = tailUpdate ? candidateBaseIndex : 0;
        List<ClaudeSession.Message> transportMessages = tailUpdate
                ? List.copyOf(messages.subList(baseIndex, messages.size())) : messages;
        return new MessageTransport(transportMessages, baseIndex, tailUpdate);
    }

    private static boolean hasSamePrefix(List<ClaudeSession.Message> previousMessages,
                                         List<ClaudeSession.Message> messages,
                                         int prefixLength) {
        if (previousMessages.size() < prefixLength) {
            return false;
        }
        for (int i = 0; i < prefixLength; i++) {
            if (previousMessages.get(i) != messages.get(i)) {
                return false;
            }
        }
        return true;
    }

    // ===== Streaming heartbeat =====

    /**
     * Start (or restart) the periodic heartbeat during streaming.
     * Sends a lightweight JS signal to the frontend to prevent the stall
     * watchdog from falsely triggering during tool execution phases where
     * no content deltas or message updates arrive from the SDK.
     */
    private void startHeartbeat() {
        heartbeatAlarm.cancelAllRequests();
        scheduleHeartbeat();
    }

    private void scheduleHeartbeat() {
        if (!streamActive || callbackTarget.isDisposed()) {
            return;
        }
        heartbeatAlarm.addRequest(() -> {
            if (!streamActive || callbackTarget.isDisposed()) {
                return;
            }
            try {
                callbackTarget.callJavaScript("onStreamingHeartbeat");
                if (LOG.isDebugEnabled()) {
                    LOG.debug("[Heartbeat] Sent streaming heartbeat to frontend");
                }
            } catch (Exception e) {
                LOG.warn("[Heartbeat] Failed to send heartbeat: " + e.getMessage());
            }
            // Schedule next heartbeat
            scheduleHeartbeat();
        }, HEARTBEAT_INTERVAL_MS);
    }
}
