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

    // ── Content versioning ──
    // updateSequence orders frames ON THE WIRE, but pushes themselves bump it
    // (flush, resequenced pushes), so a frame's sequence says nothing about how
    // NEW its content is: a stream-end flush replaying lastSnapshot can carry a
    // higher sequence than an in-flight alarm push holding strictly newer
    // messages. Comparing sequences alone let stale content clobber the turn's
    // tail — e.g. the final ERROR message appended by onError() after the
    // stream-end flushes grabbed their snapshots was skipped as "stale" while
    // two pre-error snapshots were force-pushed over it, so the webview never
    // saw the usage-limit error at all. contentVersion counts enqueued
    // snapshots; every push carries the version of the content it holds, and
    // the EDT gate compares VERSIONS (see decidePush). All guarded by lock.
    private long contentVersion = 0L;
    /** Version of {@link #pendingMessages}. */
    private long pendingVersion = 0L;
    /** Version of {@link #lastSnapshot}. */
    private long lastSnapshotVersion = 0L;
    /** Highest content version actually delivered to the webview. */
    private long pushedContentVersion = 0L;
    /**
     * Bumped by {@link #resetStreamState()}. Pushes built before a reset are
     * dropped at delivery time, so an old session's snapshot can never be
     * resequenced past the frontend's new-session sequence barrier.
     */
    private long pushEpoch = 0L;

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
            pendingVersion = ++contentVersion;
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
            lastUpdateAtMs = 0L;
            lastPayloadChars = 0;
            // Content versions stay monotonic across sessions on purpose: the
            // next session's enqueues always version above anything pushed so
            // far, and in-flight frames from the old session are dropped by the
            // epoch check regardless of their version.
            ++pushEpoch;
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
        final long snapshotVersion;
        final long epoch;
        synchronized (lock) {
            updateAlarm.cancelAllRequests();
            updateScheduled = false;
            snapshot = pendingMessages != null ? pendingMessages : lastSnapshot;
            snapshotVersion = pendingMessages != null ? pendingVersion : lastSnapshotVersion;
            epoch = pushEpoch;
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

        sendToWebView(snapshot, sequence, snapshotVersion, epoch, afterFlushOnEdt);
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
            final long snapshotVersion;
            final long epoch;
            synchronized (lock) {
                updateScheduled = false;
                lastUpdateAtMs = System.currentTimeMillis();
                snapshot = pendingMessages;
                snapshotVersion = pendingVersion;
                epoch = pushEpoch;
                pendingMessages = null;
                sequence = updateSequence;
            }

            if (callbackTarget.isDisposed()) {
                return;
            }

            if (snapshot != null) {
                sendToWebView(snapshot, sequence, snapshotVersion, epoch, null);
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
            long snapshotVersion,
            long epoch,
            LongConsumer afterSendOnEdt
    ) {
        // Keep the snapshot for potential re-flush after webview reload/recreate.
        // Recorded even if this push is later skipped at the EDT gate: the
        // stream-end flush re-delivers lastSnapshot, which is what guarantees
        // the newest content always lands by the end of the turn.
        synchronized (lock) {
            lastSnapshot = messages;
            lastSnapshotVersion = snapshotVersion;
        }

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            final int payloadChars;
            final long payloadBuildMs;
            final String escapedMessagesJson;
            try {
                long buildStartedAt = System.nanoTime();
                String messagesJson = MessageJsonConverter.convertMessagesToJson(messages);
                payloadChars = messagesJson.length();
                escapedMessagesJson = JsUtils.escapeJs(messagesJson);
                payloadBuildMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - buildStartedAt);

                // FIX: Record payload size for adaptive throttling
                lastPayloadChars = payloadChars;

                if (payloadChars >= LARGE_UPDATE_PAYLOAD_CHARS || payloadBuildMs >= SLOW_PAYLOAD_BUILD_MS) {
                    LOG.info("[WebviewTransport] updateMessages payload chars=" + payloadChars
                            + ", messages=" + messages.size()
                            + ", buildMs=" + payloadBuildMs
                            + ", sequence=" + sequence);
                } else if (LOG.isDebugEnabled()) {
                    LOG.debug("[WebviewTransport] updateMessages payload chars=" + payloadChars
                            + ", messages=" + messages.size()
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
                    if (epoch != pushEpoch) {
                        // Session reset while this frame was in flight. Dropping it
                        // keeps old-session content behind the frontend's new-session
                        // sequence barrier (resequencing would leap over it).
                        if (afterSendOnEdt != null) {
                            afterSendOnEdt.accept(sequence);
                        }
                        return;
                    }
                    // Merge note (upstream c1f8c131): upstream fixed the same
                    // "turn's final snapshot is lost" bug by force-pushing a stale
                    // snapshot with a fresh sequence, restricted to the flush path
                    // (afterSendOnEdt != null) because an outdated ALARM frame
                    // force-pushed that way could overwrite the final one. The
                    // content-version gate below supersedes that: it compares how new
                    // a frame's CONTENT is instead of inferring it from which path
                    // produced it, so an outdated frame is skipped on either path —
                    // and, unlike the sequence-only check, it also refuses a flush
                    // whose content is older than what was already delivered (the
                    // case that dropped the turn's final ERROR message).
                    PushDecision decision = decidePush(
                            snapshotVersion, pushedContentVersion, streamActive, sequence, updateSequence);
                    if (decision == PushDecision.SKIP) {
                        if (snapshotVersion < pushedContentVersion) {
                            LOG.info("[StreamMessageCoalescer] Skipping outdated snapshot push"
                                    + " (contentVersion=" + snapshotVersion
                                    + " < pushed=" + pushedContentVersion
                                    + ", sequence=" + sequence
                                    + ") — the webview already has newer content");
                        }
                        if (afterSendOnEdt != null) {
                            afterSendOnEdt.accept(sequence);
                        }
                        return;
                    }
                    if (decision == PushDecision.PUSH_RESEQUENCED) {
                        pushSequence = ++updateSequence;
                        LOG.info("[StreamMessageCoalescer] Resequencing out-of-order snapshot push"
                                + " after stream end (built sequence=" + sequence
                                + ", pushed=" + pushSequence
                                + ", contentVersion=" + snapshotVersion
                                + ") so the turn's newest content still lands");
                    } else {
                        pushSequence = sequence;
                    }
                    pushedContentVersion = Math.max(pushedContentVersion, snapshotVersion);
                }

                // FIX: Wrap callJavaScript in try-catch so that a JCEF failure
                // (e.g., large payload rejection, disposed browser race) does not
                // prevent afterSendOnEdt from running.  When afterSendOnEdt carries
                // the onStreamEnd signal, failing to run it permanently freezes the UI.
                try {
                    callbackTarget.callJavaScript("updateMessages", escapedMessagesJson, String.valueOf(pushSequence));
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

    // ===== Push gating =====

    /** Outcome of the delivery gate for one serialized snapshot. */
    enum PushDecision {
        /** Do not deliver this frame. */
        SKIP,
        /** Deliver with the sequence it was built with. */
        PUSH,
        /** Deliver, but stamp a fresh (bumped) sequence so the frontend accepts it. */
        PUSH_RESEQUENCED,
    }

    /**
     * Decides whether a serialized snapshot may be delivered to the webview.
     *
     * <p>The webview applies frames last-write-wins by wire sequence, so the
     * invariants are: never deliver content OLDER than what was already
     * delivered, and always deliver the newest content by the end of the turn.
     *
     * <ul>
     *   <li>{@code snapshotVersion < pushedContentVersion} → {@link PushDecision#SKIP}:
     *       the webview already has strictly newer content; delivering this frame
     *       would roll the list back. (This is how a stream-end flush replaying a
     *       pre-error {@code lastSnapshot} used to erase the turn's final ERROR
     *       message — the usage-limit notice — from the webview.)</li>
     *   <li>sequence still current → {@link PushDecision#PUSH} as built.</li>
     *   <li>mid-stream with a stale sequence → {@link PushDecision#SKIP}: the
     *       sequence only advances when newer work was scheduled, and the
     *       stream-end flush re-delivers {@code lastSnapshot} anyway, so nothing
     *       is lost while adaptive throttling stays effective.</li>
     *   <li>after stream end → {@link PushDecision#PUSH_RESEQUENCED}: the frame
     *       holds newest-or-equal content and nothing newer may ever follow, so
     *       it must land even though other pushes overtook its sequence. Equal
     *       versions are deliberately allowed — the webview-recreate re-flush
     *       re-sends content that was already delivered once.</li>
     * </ul>
     */
    static PushDecision decidePush(
            long snapshotVersion,
            long pushedContentVersion,
            boolean streamActive,
            long builtSequence,
            long currentSequence
    ) {
        if (snapshotVersion < pushedContentVersion) {
            return PushDecision.SKIP;
        }
        if (builtSequence == currentSequence) {
            return PushDecision.PUSH;
        }
        return streamActive ? PushDecision.SKIP : PushDecision.PUSH_RESEQUENCED;
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
