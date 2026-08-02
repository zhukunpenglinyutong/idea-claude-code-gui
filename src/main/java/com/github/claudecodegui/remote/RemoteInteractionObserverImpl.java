package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.PermissionInteractionObserver;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.Map;

/**
 * Bridges {@link PermissionInteractionObserver} notifications (fired at the
 * source-aware {@code PermissionService.dispatch*} hook) into the Remote event
 * stream + {@link RemoteInteractionRegistry}.
 *
 * <p>Source identity is recovered from {@code sessionId}: the active Remote task
 * whose session matches is the source. If none matches, the interaction is
 * desktop-origin and silently ignored (Phase 2C-B §27 — only Remote-origin
 * turns are bound to a taskId).
 *
 * <p>This phase only <em>observes</em>; it never resolves interactions (the
 * desktop dialog / safety-net / clearPendingRequests still drives resolution,
 * which is observed and forwarded as {@code *.resolved}).
 */
final class RemoteInteractionObserverImpl implements PermissionInteractionObserver {

    private static final Logger LOG = Logger.getInstance(RemoteInteractionObserverImpl.class);

    private final RemoteEventBus bus = RemoteEventBus.getInstance();
    private final RemoteTaskRegistry registry = RemoteTaskRegistry.getInstance();
    private final RemoteInteractionRegistry interactions = RemoteInteractionRegistry.getInstance();
    private final SharedInteractionResolver resolver = SharedInteractionResolver.getInstance();

    @Override
    public String resolveInteractionSessionId(Project project, String permissionSessionId) {
        RemoteTask task = findRemoteTask(permissionSessionId);
        return task != null ? task.getSessionId() : null;
    }

    @Override
    public void onPermissionRequested(Project project, String sessionId, String requestId,
                                      String toolName, JsonObject inputs) {
        RemoteTask task = findRemoteTask(sessionId);
        if (task == null) {
            return;
        }
        String projectId = RemoteProjectId.of(project.getBasePath());
        String taskSessionId = task.getSessionId();
        // attachSource must succeed before we publish — a silent miss means
        // Remote resolve will return INTERACTION_MISMATCH later (Phase 2C-C.1 §7).
        if (!resolver.attachSource(taskSessionId, requestId, projectId, task.tabId, task.taskId)) {
            LOG.warn("[RemoteGateway] attachSource MISS: handle not found for session="
                    + taskSessionId + " requestId=" + requestId + " task=" + task.taskId);
            return;
        }
        interactions.register(new RemoteInteraction(
                RemoteInteraction.Type.PERMISSION, requestId, requestId,
                sessionId, projectId, task.tabId, task.taskId, System.currentTimeMillis()));
        task.markWaiting(RemoteTaskState.WAITING_PERMISSION);

        JsonObject payload = new JsonObject();
        payload.addProperty("interactionId", requestId);
        payload.addProperty("requestId", requestId);
        if (toolName != null) {
            payload.addProperty("toolName", toolName);
        }
        payload.add("inputs", deepCap(inputs, RemoteGatewayLimits.MAX_INTERACTION_INPUT_CHARS));
        bus.publishForTask(task, projectId, task.tabId, "permission.requested",
                task.taskId, taskSessionId, payload);
    }

    @Override
    public void onPermissionResolved(String sessionId, String requestId,
                                     boolean allow, boolean alwaysAllow) {
        RemoteInteraction inter = interactions.remove(sessionId, requestId);
        RemoteTask task = resolveTask(inter, sessionId);
        if (task == null) {
            return;
        }
        task.markRunning();
        String decision = allow ? (alwaysAllow ? "ALLOW_ALWAYS" : "ALLOW") : "DENY";
        JsonObject payload = new JsonObject();
        payload.addProperty("interactionId", requestId);
        payload.addProperty("decision", decision);
        bus.publishForTask(task, task.projectId, task.tabId, "permission.resolved",
                task.taskId, task.getSessionId(), payload);
    }

    @Override
    public void onAskUserQuestionRequested(Project project, String sessionId, String requestId,
                                           JsonObject questions) {
        RemoteTask task = findRemoteTask(sessionId);
        if (task == null) {
            return;
        }
        String projectId = RemoteProjectId.of(project.getBasePath());
        String taskSessionId = task.getSessionId();
        if (!resolver.attachSource(taskSessionId, requestId, projectId, task.tabId, task.taskId)) {
            LOG.warn("[RemoteGateway] attachSource MISS for ask: session=" + taskSessionId
                    + " requestId=" + requestId + " task=" + task.taskId);
            return;
        }
        interactions.register(new RemoteInteraction(
                RemoteInteraction.Type.QUESTION, requestId, requestId,
                sessionId, projectId, task.tabId, task.taskId, System.currentTimeMillis()));
        resolver.attachQuestions(taskSessionId, requestId, questions);
        task.markWaiting(RemoteTaskState.WAITING_USER_INPUT);

        JsonObject payload = new JsonObject();
        payload.addProperty("interactionId", requestId);
        payload.addProperty("requestId", requestId);
        payload.addProperty("allowCustomInput", true);
        payload.add("questions", deepCap(questions, RemoteGatewayLimits.MAX_INTERACTION_INPUT_CHARS));
        bus.publishForTask(task, projectId, task.tabId, "question.requested",
                task.taskId, taskSessionId, payload);
    }

    @Override
    public void onAskUserQuestionResolved(String sessionId, String requestId, JsonObject answers) {
        RemoteInteraction inter = interactions.remove(sessionId, requestId);
        RemoteTask task = resolveTask(inter, sessionId);
        if (task == null) {
            return;
        }
        task.markRunning();
        JsonObject payload = new JsonObject();
        payload.addProperty("interactionId", requestId);
        payload.add("answers", deepCap(answers, RemoteGatewayLimits.MAX_INTERACTION_INPUT_CHARS));
        bus.publishForTask(task, task.projectId, task.tabId, "question.resolved",
                task.taskId, task.getSessionId(), payload);
    }

    @Override
    public void onPlanApprovalRequested(Project project, String sessionId, String requestId,
                                        JsonObject planData) {
        RemoteTask task = findRemoteTask(sessionId);
        if (task == null) {
            return;
        }
        String projectId = RemoteProjectId.of(project.getBasePath());
        String taskSessionId = task.getSessionId();
        if (!resolver.attachSource(taskSessionId, requestId, projectId, task.tabId, task.taskId)) {
            LOG.warn("[RemoteGateway] attachSource MISS for plan: session=" + taskSessionId
                    + " requestId=" + requestId + " task=" + task.taskId);
            return;
        }
        interactions.register(new RemoteInteraction(
                RemoteInteraction.Type.PLAN, requestId, requestId,
                sessionId, projectId, task.tabId, task.taskId, System.currentTimeMillis()));
        resolver.attachPlan(taskSessionId, requestId, planData);
        task.markWaiting(RemoteTaskState.WAITING_PLAN_APPROVAL);

        JsonObject payload = new JsonObject();
        payload.addProperty("interactionId", requestId);
        payload.addProperty("requestId", requestId);
        payload.add("plan", deepCap(planData, RemoteGatewayLimits.MAX_INTERACTION_PAYLOAD_CHARS));
        bus.publishForTask(task, projectId, task.tabId, "plan.requested",
                task.taskId, taskSessionId, payload);
    }

    @Override
    public void onPlanApprovalResolved(String sessionId, String requestId,
                                       boolean approved, String targetMode) {
        RemoteInteraction inter = interactions.remove(sessionId, requestId);
        RemoteTask task = resolveTask(inter, sessionId);
        if (task == null) {
            return;
        }
        task.markRunning();
        JsonObject payload = new JsonObject();
        payload.addProperty("interactionId", requestId);
        payload.addProperty("approved", approved);
        if (targetMode != null) {
            payload.addProperty("targetMode", targetMode);
        }
        bus.publishForTask(task, task.projectId, task.tabId, "plan.resolved",
                task.taskId, task.getSessionId(), payload);
    }

    /**
     * Find the active RemoteTask for a permission sessionId. Uses the source
     * mapping (permissionSessionId → tabId) registered at window construction,
     * then looks up the tab's active task — stable across daemon sessionId
     * changes and task transitions on the same tab (Phase 2C-C.0 BUG A fix).
     *
     * <p>Package-private for direct unit testing (lifecycle across multiple tasks).
     */
    RemoteTask findRemoteTask(String permissionSessionId) {
        String tabId = registry.getTabIdForPermissionSession(permissionSessionId);
        if (tabId == null) {
            return null;
        }
        return registry.getActiveByTab(tabId);
    }

    private RemoteTask resolveTask(RemoteInteraction inter, String sessionId) {
        if (inter != null && inter.getSourceTaskId() != null) {
            RemoteTask task = registry.get(inter.getSourceTaskId());
            if (task != null) {
                return task;
            }
        }
        return findRemoteTask(sessionId);
    }

    private static JsonObject deepCap(JsonObject src, int maxValueChars) {
        if (src == null) {
            return new JsonObject();
        }
        return (JsonObject) capElement(src, maxValueChars);
    }

    private static JsonElement capElement(JsonElement el, int max) {
        if (el == null || el.isJsonNull()) {
            return el;
        }
        if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isString()) {
            String s = el.getAsString();
            if (s.length() > max) {
                return new JsonPrimitive(s.substring(0, max) + "...");
            }
            return el;
        }
        if (el.isJsonObject()) {
            JsonObject copy = new JsonObject();
            for (Map.Entry<String, JsonElement> e : el.getAsJsonObject().entrySet()) {
                copy.add(e.getKey(), capElement(e.getValue(), max));
            }
            return copy;
        }
        if (el.isJsonArray()) {
            JsonArray copy = new JsonArray();
            for (JsonElement c : el.getAsJsonArray()) {
                copy.add(capElement(c, max));
            }
            return copy;
        }
        return el;
    }
}
