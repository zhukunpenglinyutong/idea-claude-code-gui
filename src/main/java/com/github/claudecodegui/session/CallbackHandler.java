package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Callback handler.
 *
 * <p>Dispatches session callback notifications to one <em>primary</em>
 * {@link ClaudeSession.SessionCallback} (the desktop {@link SessionCallbackAdapter}
 * that drives the WebView) plus zero or more <em>subscribers</em> (e.g. the
 * Remote {@code RemoteEventTap}).
 *
 * <p>Hard guarantees for the fan-out:
 * <ul>
 *   <li>The primary callback still executes exactly once per notification.</li>
 *   <li>Subscribers are add/remove thread-safe ({@link CopyOnWriteArrayList}).</li>
 *   <li>A subscriber (or primary) exception is logged and swallowed — it never
 *       blocks the other consumers. Subscriber A failing does not stop B.</li>
 *   <li>Notification order is stable: primary first, then subscribers in
 *       registration order.</li>
 * </ul>
 *
 * <p>The 33ms {@code StreamDeltaThrottler} lives <em>inside</em>
 * {@link SessionCallbackAdapter}, so subscribers receive the <b>raw</b> deltas —
 * throttling is per-consumer and not shared.
 */
public class CallbackHandler {

    private static final Logger LOG = Logger.getInstance(CallbackHandler.class);

    private volatile ClaudeSession.SessionCallback callback;
    private final CopyOnWriteArrayList<ClaudeSession.SessionCallback> subscribers = new CopyOnWriteArrayList<>();

    public void setCallback(ClaudeSession.SessionCallback callback) {
        this.callback = callback;
    }

    /** Add a non-primary subscriber. No-op if null. */
    public void addSubscriber(ClaudeSession.SessionCallback subscriber) {
        if (subscriber != null) {
            subscribers.addIfAbsent(subscriber);
        }
    }

    /** Remove a subscriber. No-op if null/absent. */
    public void removeSubscriber(ClaudeSession.SessionCallback subscriber) {
        if (subscriber != null) {
            subscribers.remove(subscriber);
        }
    }

    /** Test/diagnostic: subscriber count. */
    public int subscriberCount() {
        return subscribers.size();
    }

    private void runPrimary(String name, java.util.function.Consumer<ClaudeSession.SessionCallback> action) {
        ClaudeSession.SessionCallback primary = callback;
        if (primary != null) {
            try {
                action.accept(primary);
            } catch (Throwable t) {
                LOG.warn("[CallbackHandler] primary " + name + " threw: " + t.getMessage(), t);
            }
        }
    }

    private void runSubscribers(String name, java.util.function.Consumer<ClaudeSession.SessionCallback> action) {
        for (ClaudeSession.SessionCallback s : subscribers) {
            try {
                action.accept(s);
            } catch (Throwable t) {
                LOG.warn("[CallbackHandler] subscriber " + name + " threw: " + t.getMessage(), t);
            }
        }
    }

    private void dispatch(String name, java.util.function.Consumer<ClaudeSession.SessionCallback> action) {
        runPrimary(name, action);
        runSubscribers(name, action);
    }

    // ===== Notification API =====

    public void notifyMessageUpdate(List<ClaudeSession.Message> messages) {
        dispatch("onMessageUpdate", c -> c.onMessageUpdate(messages));
    }

    public void notifyStateChange(boolean busy, boolean loading, String error) {
        dispatch("onStateChange", c -> c.onStateChange(busy, loading, error));
    }

    public void notifyStatusMessage(String message) {
        dispatch("onStatusMessage", c -> c.onStatusMessage(message));
    }

    public void notifySessionIdReceived(String sessionId) {
        dispatch("onSessionIdReceived", c -> c.onSessionIdReceived(sessionId));
    }

    public void notifyPermissionRequested(PermissionRequest request) {
        dispatch("onPermissionRequested", c -> c.onPermissionRequested(request));
    }

    public void notifyThinkingStatusChanged(boolean isThinking) {
        dispatch("onThinkingStatusChanged", c -> c.onThinkingStatusChanged(isThinking));
    }

    public void notifySlashCommandsReceived(List<String> slashCommands) {
        dispatch("onSlashCommandsReceived", c -> c.onSlashCommandsReceived(slashCommands));
    }

    public void notifyNodeLog(String log) {
        dispatch("onNodeLog", c -> c.onNodeLog(log));
    }

    public void notifySummaryReceived(String summary) {
        dispatch("onSummaryReceived", c -> c.onSummaryReceived(summary));
    }

    public void notifyStreamStart() {
        dispatch("onStreamStart", ClaudeSession.SessionCallback::onStreamStart);
    }

    public void notifyStreamEnd() {
        dispatch("onStreamEnd", ClaudeSession.SessionCallback::onStreamEnd);
    }

    public void notifyContentDelta(String delta) {
        dispatch("onContentDelta", c -> c.onContentDelta(delta));
    }

    public void notifyThinkingDelta(String delta) {
        dispatch("onThinkingDelta", c -> c.onThinkingDelta(delta));
    }

    public void notifyBlockReset() {
        dispatch("onBlockReset", ClaudeSession.SessionCallback::onBlockReset);
    }

    public void notifyUsageUpdate(int usedTokens, int maxTokens) {
        dispatch("onUsageUpdate", c -> c.onUsageUpdate(usedTokens, maxTokens));
    }

    public void notifyUserMessageUuidPatched(String content, String uuid) {
        dispatch("onUserMessageUuidPatched", c -> c.onUserMessageUuidPatched(content, uuid));
    }

    public void notifyTaskEvent(String eventJson) {
        dispatch("onTaskEvent", c -> c.onTaskEvent(eventJson));
    }
}
