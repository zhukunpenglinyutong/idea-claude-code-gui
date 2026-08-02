package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.CallbackHandler;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Long-lived {@link com.github.claudecodegui.session.ClaudeSession.SessionCallback}
 * subscriber installed on a session's {@link CallbackHandler} to stream Remote
 * events.
 *
 * <p>Installed once per session (idempotent via a weak set of handlers); stays
 * for the session's lifetime. It looks up the active Remote task by {@code tabId}
 * on each callback — if none (a desktop-origin turn), it does nothing (Phase 2C-B
 * §27: only Remote-origin turns are bound to a taskId).
 *
 * <p>Receives <b>raw</b> content/thinking deltas (the 33ms throttler is inside
 * {@code SessionCallbackAdapter} and not shared). Thinking deltas are never
 * published — only the structured {@code assistant.thinking_status} is emitted.
 */
final class RemoteEventTap implements ClaudeSession.SessionCallback {

    private static final Set<CallbackHandler> INSTALLED =
            Collections.newSetFromMap(new WeakHashMap<>());

    private final String projectId;
    private final String tabId;
    private final RemoteEventBus bus;
    private final RemoteTaskRegistry registry;

    private RemoteEventTap(String projectId, String tabId,
                           RemoteEventBus bus, RemoteTaskRegistry registry) {
        this.projectId = projectId;
        this.tabId = tabId;
        this.bus = bus;
        this.registry = registry;
    }

    /** Package-private for direct unit testing (bypasses install/CallbackHandler). */
    static RemoteEventTap forTest(String projectId, String tabId,
                                 RemoteEventBus bus, RemoteTaskRegistry registry) {
        return new RemoteEventTap(projectId, tabId, bus, registry);
    }

    /**
     * Install a tap on {@code session}'s {@link CallbackHandler} if one is not
     * already installed. Idempotent; safe to call per dispatch.
     */
    static void install(ClaudeSession session, String projectId, String tabId,
                        RemoteEventBus bus, RemoteTaskRegistry registry) {
        if (session == null) {
            return;
        }
        CallbackHandler handler = session.getCallbackHandler();
        if (handler == null) {
            return;
        }
        synchronized (INSTALLED) {
            if (INSTALLED.contains(handler)) {
                return;
            }
            INSTALLED.add(handler);
        }
        handler.addSubscriber(new RemoteEventTap(projectId, tabId, bus, registry));
    }

    private RemoteTask activeTask() {
        return registry.getActiveByTab(tabId);
    }

    private void publish(String event, RemoteTask task, JsonObject payload) {
        if (task == null) {
            return;
        }
        bus.publishForTask(task, projectId, tabId, event, task.taskId,
                task.getSessionId(), payload);
    }

    @Override
    public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        RemoteTask task = activeTask();
        if (task == null || messages == null) {
            return;
        }
        String assistantDelta = task.assistantContentTracker.consumeSnapshot(messages);
        if (!assistantDelta.isEmpty()) {
            task.coalescer.append(assistantDelta);
        }
        List<JsonObject> raws = new ArrayList<>();
        for (ClaudeSession.Message m : messages) {
            if (m != null && m.raw != null) {
                raws.add(m.raw);
            }
        }
        List<RemoteToolEventTracker.ToolEvent> events = task.toolTracker.scan(raws);
        for (RemoteToolEventTracker.ToolEvent te : events) {
            JsonObject payload = new JsonObject();
            payload.addProperty("toolUseId", te.toolUseId);
            if (te.tool != null) {
                payload.addProperty("tool", te.tool);
            }
            String eventName;
            switch (te.type) {
                case STARTED:
                    eventName = "tool.started";
                    break;
                case COMPLETED:
                    eventName = "tool.completed";
                    break;
                case FAILED:
                default:
                    eventName = "tool.failed";
                    break;
            }
            publish(eventName, task, payload);
        }
    }

    @Override
    public void onStateChange(boolean busy, boolean loading, String error) {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        if (error != null && !error.isEmpty()) {
            task.markFailureObserved();
        }
    }

    @Override
    public void onSessionIdReceived(String sessionId) {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        registry.indexSession(task.taskId, sessionId);
    }

    @Override
    public void onThinkingStatusChanged(boolean isThinking) {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        JsonObject payload = new JsonObject();
        payload.addProperty("active", isThinking);
        publish("assistant.thinking_status", task, payload);
    }

    @Override
    public void onStreamStart() {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        task.markRunning();
        publish("stream.started", task, new JsonObject());
    }

    @Override
    public void onStreamEnd() {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        task.coalescer.flush();
        publish("stream.ended", task, new JsonObject());
    }

    @Override
    public void onBlockReset() {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        task.coalescer.flush();
    }

    @Override
    public void onContentDelta(String delta) {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        String assistantDelta = task.assistantContentTracker.consumeDelta(delta);
        if (!assistantDelta.isEmpty()) {
            task.coalescer.append(assistantDelta);
        }
    }

    /** Thinking deltas are NEVER published to the SSE stream. */
    @Override
    public void onThinkingDelta(String delta) {
        // intentionally filtered — see Phase 2C-B §9
    }

    @Override
    public void onUsageUpdate(int usedTokens, int maxTokens) {
        RemoteTask task = activeTask();
        if (task == null) {
            return;
        }
        JsonObject payload = new JsonObject();
        payload.addProperty("usedTokens", usedTokens);
        payload.addProperty("maxTokens", maxTokens);
        publish("usage.updated", task, payload);
    }

    @Override
    public void onTaskEvent(String eventJson) {
        RemoteTask task = activeTask();
        if (task == null || eventJson == null) {
            return;
        }
        JsonObject payload = new JsonObject();
        String capped = eventJson.length() > RemoteGatewayLimits.MAX_INTERACTION_PAYLOAD_CHARS
                ? eventJson.substring(0, RemoteGatewayLimits.MAX_INTERACTION_PAYLOAD_CHARS)
                : eventJson;
        payload.addProperty("raw", capped);
        publish("task_event", task, payload);
    }

    // ----- callbacks intentionally ignored by Remote -----

    @Override
    public void onStatusMessage(String message) {
        // not streamed
    }

    @Override
    public void onSlashCommandsReceived(List<String> slashCommands) {
        // not streamed
    }

    @Override
    public void onNodeLog(String log) {
        // not streamed
    }

    @Override
    public void onSummaryReceived(String summary) {
        // not streamed
    }

    @Override
    public void onPermissionRequested(com.github.claudecodegui.permission.PermissionRequest request) {
        // permission is observed via PermissionService source-aware hook, not here
    }

    @Override
    public void onUserMessageUuidPatched(String content, String uuid) {
        // not streamed
    }
}
