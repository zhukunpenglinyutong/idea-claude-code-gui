package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.PermissionModeService;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

/**
 * Phase 2C-C control endpoints: interaction resolution (permission / ask /
 * plan), task abort, and permission-mode get/set.
 *
 * <p>Every endpoint resolves the live tab via {@link RemoteTabResolver} (EDT,
 * bounded) and then operates on the <em>real</em> {@link ClaudeSession} /
 * pending interaction / Remote task &mdash; never a second backend. Interaction
 * resolution and mode apply are delegated to {@link SharedInteractionResolver}
 * and {@link PermissionModeService} respectively, the same objects the desktop
 * path uses.
 *
 * <p>Logging never records answer/plan/permission payloads &mdash; only
 * identity (projectId/tabId/taskId/interactionId) and outcome (Phase 2C-C §30).
 */
final class RemoteControlHandler {

    private static final Logger LOG = Logger.getInstance(RemoteControlHandler.class);

    private final SharedInteractionResolver resolver = SharedInteractionResolver.getInstance();
    private final RemoteTaskRegistry taskRegistry = RemoteTaskRegistry.getInstance();
    private final RemoteEventBus bus = RemoteEventBus.getInstance();

    /** Outcome of a control endpoint, ready for the router to write. */
    static final class Outcome {
        final int status;
        final String body;

        private Outcome(int status, String body) {
            this.status = status;
            this.body = body;
        }

        static Outcome json(int status, JsonObject obj) {
            return new Outcome(status, obj.toString());
        }

        static Outcome error(RemoteErrors.Code code) {
            return new Outcome(code.status(), RemoteErrors.body(code));
        }

        static Outcome error(RemoteErrors.Code code, String message) {
            return new Outcome(code.status(), RemoteErrors.body(code, message));
        }
    }

    // ── Permission decision ────────────────────────────────────────────

    Outcome decidePermission(Project project, String projectId, String tabId,
                             String interactionId, byte[] body) {
        RemoteInteractionRequest.PermissionResult parsed = RemoteInteractionRequest.parsePermission(body);
        if (!parsed.valid) {
            return Outcome.error(parsed.errorCode, parsed.errorMessage);
        }
        RemoteTabResolver.ResolveResult r = RemoteTabResolver.resolve(project, tabId);
        Outcome tabError = tabResolutionError(r, RemoteErrors.Code.INTERACTION_NOT_FOUND);
        if (tabError != null) {
            return tabError;
        }
        SharedInteractionResolver.ResolveOutcome out = resolver.resolvePermission(
                r.sessionId, interactionId, projectId, tabId, parsed.taskId, parsed.responseValue);
        logResolve("permission", projectId, tabId, parsed.taskId, interactionId, out);
        return resolveOutcomeToHttp(out, interactionId);
    }

    // ── AskUserQuestion answer ─────────────────────────────────────────

    Outcome answerQuestion(Project project, String projectId, String tabId,
                           String interactionId, byte[] body) {
        RemoteInteractionRequest.AskResult parsed = RemoteInteractionRequest.parseAsk(body);
        if (!parsed.valid) {
            return Outcome.error(parsed.errorCode, parsed.errorMessage);
        }
        RemoteTabResolver.ResolveResult r = RemoteTabResolver.resolve(project, tabId);
        Outcome tabError = tabResolutionError(r, RemoteErrors.Code.INTERACTION_NOT_FOUND);
        if (tabError != null) {
            return tabError;
        }
        // Semantic validation against the recorded question set (§13).
        InteractionHandle handle = resolver.get(r.sessionId, interactionId);
        if (handle != null && handle.getType() == InteractionHandle.Type.QUESTION) {
            String validationError = validateAnswers(handle.getQuestionsData(), parsed.answers);
            if (validationError != null) {
                return Outcome.error(RemoteErrors.Code.BAD_REQUEST, validationError);
            }
        }
        // If handle is null or wrong type, defer to resolveAsk for the canonical
        // NOT_FOUND / TYPE_MISMATCH response.
        SharedInteractionResolver.ResolveOutcome out = resolver.resolveAsk(
                r.sessionId, interactionId, projectId, tabId, parsed.taskId, parsed.answers);
        logResolve("question", projectId, tabId, parsed.taskId, interactionId, out);
        return resolveOutcomeToHttp(out, interactionId);
    }

    // ── Plan decision ──────────────────────────────────────────────────

    Outcome decidePlan(Project project, String projectId, String tabId,
                       String interactionId, byte[] body) {
        RemoteInteractionRequest.PlanResult parsed = RemoteInteractionRequest.parsePlan(body);
        if (!parsed.valid) {
            return Outcome.error(parsed.errorCode, parsed.errorMessage);
        }
        RemoteTabResolver.ResolveResult r = RemoteTabResolver.resolve(project, tabId);
        Outcome tabError = tabResolutionError(r, RemoteErrors.Code.INTERACTION_NOT_FOUND);
        if (tabError != null) {
            return tabError;
        }
        JsonObject result = new JsonObject();
        result.addProperty("approved", parsed.approved);
        result.addProperty("targetMode", parsed.targetMode);
        SharedInteractionResolver.ResolveOutcome out = resolver.resolvePlan(
                r.sessionId, interactionId, projectId, tabId, parsed.taskId, result);
        logResolve("plan", projectId, tabId, parsed.taskId, interactionId, out);
        return resolveOutcomeToHttp(out, interactionId);
    }

    // ── Abort ──────────────────────────────────────────────────────────

    Outcome abortTask(Project project, String projectId, String tabId, String taskId) {
        RemoteTask task = taskRegistry.get(taskId);
        if (task == null
                || !eq(task.projectId, projectId)
                || !eq(task.tabId, tabId)) {
            // Don't leak whether the task exists for another project/tab.
            return Outcome.error(RemoteErrors.Code.TASK_NOT_FOUND);
        }
        if (task.getState().isTerminal()) {
            return Outcome.error(RemoteErrors.Code.TASK_NOT_ACTIVE);
        }

        boolean first = task.markAbortRequestedFirstTime();
        if (first) {
            JsonObject payload = new JsonObject();
            payload.addProperty("state", "aborting");
            bus.publishForTask(task, task.projectId, task.tabId, "task.abort_requested",
                    task.taskId, task.getSessionId(), payload);

            // Interrupt the real session. The shared interrupt observer (fired by
            // interrupt()) cancels the task's pending interactions; it will no-op
            // the abort mark since we already won the CAS above.
            RemoteTabResolver.ResolveResult r = RemoteTabResolver.resolve(project, tabId);
            if (r.status == RemoteTabResolver.Status.FOUND && r.session != null) {
                try {
                    r.session.interrupt();
                } catch (Throwable t) {
                    LOG.warn("[RemoteGateway] interrupt during abort threw: " + t.getMessage(), t);
                }
            }
        }

        // Defensive: ensure pending interactions are cancelled even if the observer
        // did not fire. Idempotent — already-cancelled handles are a no-op.
        try {
            resolver.cancelAllForSession(task.getSessionId(), "aborted");
        } catch (Throwable t) {
            LOG.debug("[RemoteGateway] cancelAllForSession during abort: " + t.getMessage());
        }

        JsonObject body = new JsonObject();
        body.addProperty("taskId", taskId);
        body.addProperty("status", first ? "aborting" : "abort_already_requested");
        LOG.info("[RemoteGateway] abort task=" + taskId + " first=" + first);
        return Outcome.json(202, body);
    }

    // ── Permission mode ────────────────────────────────────────────────

    Outcome getMode(Project project, String projectId, String tabId) {
        RemoteTabResolver.ResolveResult r = RemoteTabResolver.resolve(project, tabId);
        Outcome tabError = tabResolutionError(r, RemoteErrors.Code.NOT_FOUND);
        if (tabError != null) {
            return tabError;
        }
        String mode = PermissionModeService.current(r.session);
        JsonObject body = modeBody(projectId, tabId, r.sessionId, mode);
        return Outcome.json(200, body);
    }

    Outcome setMode(Project project, String projectId, String tabId, byte[] bodyBytes) {
        RemoteModeRequest.Result parsed = RemoteModeRequest.parse(bodyBytes);
        if (!parsed.valid) {
            return Outcome.error(parsed.errorCode, parsed.errorMessage);
        }
        RemoteTabResolver.ResolveResult r = RemoteTabResolver.resolve(project, tabId);
        Outcome tabError = tabResolutionError(r, RemoteErrors.Code.NOT_FOUND);
        if (tabError != null) {
            return tabError;
        }
        if (r.session == null || r.window == null) {
            return Outcome.error(RemoteErrors.Code.NOT_FOUND, "Tab not found");
        }
        ClaudeSDKBridge bridge = null;
        try {
            bridge = r.window.getClaudeSDKBridge();
        } catch (Throwable t) {
            LOG.debug("[RemoteGateway] getClaudeSDKBridge: " + t.getMessage());
        }
        String provider = null;
        try {
            provider = r.session.getProvider();
        } catch (Throwable t) {
            LOG.debug("[RemoteGateway] getProvider: " + t.getMessage());
        }
        String applied = PermissionModeService.apply(r.session, project, parsed.mode, bridge, provider);
        if (applied == null) {
            return Outcome.error(RemoteErrors.Code.INVALID_MODE, "Invalid permission mode");
        }
        // Sync the desktop webview mode selector so a Remote mode change is
        // immediately reflected in the desktop UI (Phase 2C-C §26).
        notifyWebViewMode(r.window, applied);
        LOG.info("[RemoteGateway] mode set project=" + projectId + " tab=" + tabId + " mode=" + applied);
        JsonObject body = modeBody(projectId, tabId, r.sessionId, applied);
        return Outcome.json(200, body);
    }

    // ── helpers ────────────────────────────────────────────────────────

    /**
     * Map a tab-resolution result to an error outcome, or null if the tab was
     * found. {@code notFoundCode} is the endpoint-specific 404 code (tab vs
     * interaction).
     */
    private static Outcome tabResolutionError(RemoteTabResolver.ResolveResult r,
                                              RemoteErrors.Code notFoundCode) {
        if (r.status == RemoteTabResolver.Status.NOT_FOUND) {
            return Outcome.error(notFoundCode, "Tab not found");
        }
        if (r.status == RemoteTabResolver.Status.TIMEOUT) {
            return Outcome.error(RemoteErrors.Code.INTERNAL_ERROR, "Tab resolution timed out");
        }
        if (r.sessionId == null) {
            return Outcome.error(notFoundCode, "No active session");
        }
        return null;
    }

    private static Outcome resolveOutcomeToHttp(SharedInteractionResolver.ResolveOutcome out, String interactionId) {
        switch (out) {
            case RESOLVED:
                JsonObject body = new JsonObject();
                body.addProperty("interactionId", interactionId);
                body.addProperty("resolved", true);
                return Outcome.json(200, body);
            case ALREADY_RESOLVED:
                return Outcome.error(RemoteErrors.Code.INTERACTION_ALREADY_RESOLVED);
            case TYPE_MISMATCH:
                return Outcome.error(RemoteErrors.Code.INTERACTION_TYPE_MISMATCH);
            case MISMATCH:
                return Outcome.error(RemoteErrors.Code.INTERACTION_MISMATCH);
            case NOT_FOUND:
            default:
                return Outcome.error(RemoteErrors.Code.INTERACTION_NOT_FOUND);
        }
    }

    private void logResolve(String kind, String projectId, String tabId, String taskId,
                            String interactionId, SharedInteractionResolver.ResolveOutcome out) {
        LOG.info("[RemoteGateway] resolve " + kind + " project=" + projectId + " tab=" + tabId
                + " task=" + taskId + " interaction=" + interactionId + " outcome=" + out);
    }

    private static JsonObject modeBody(String projectId, String tabId, String sessionId, String mode) {
        JsonObject body = new JsonObject();
        body.addProperty("projectId", projectId);
        body.addProperty("tabId", tabId);
        if (sessionId != null) {
            body.addProperty("sessionId", sessionId);
        }
        body.addProperty("mode", mode);
        body.add("validModes", validModesArray());
        return body;
    }

    private static JsonArray validModesArray() {
        // Fixed order for a stable client contract (VALID_PERMISSION_MODES is a HashSet).
        JsonArray arr = new JsonArray();
        arr.add("default");
        arr.add("plan");
        arr.add("acceptEdits");
        arr.add("autoEdit");
        arr.add("bypassPermissions");
        return arr;
    }

    private static void notifyWebViewMode(ClaudeChatWindow window, String mode) {
        if (window == null || mode == null) {
            return;
        }
        // mode comes from VALID_PERMISSION_MODES (alphanumeric only); safe to inline.
        String js = "if (typeof window.onModeReceived === 'function') { "
                + "window.onModeReceived('" + mode + "'); }";
        try {
            window.executeJavaScriptCode(js);
        } catch (Throwable t) {
            LOG.debug("[RemoteGateway] webview mode notify failed: " + t.getMessage());
        }
    }

    /**
     * Validate an answers object against the recorded question set
     * (Phase 2C-C §13). Returns null if valid, or a stable error message.
     */
    static String validateAnswers(JsonObject questionsData, JsonObject answers) {
        if (answers == null) {
            return "Missing answers";
        }
        if (answers.size() > RemoteGatewayLimits.MAX_ANSWER_COUNT) {
            return "Too many answers";
        }
        // Build questionText -> multiSelect from the recorded payload.
        java.util.Map<String, Boolean> questionMap = new java.util.HashMap<>();
        int totalChars = 0;
        if (questionsData != null && questionsData.has("questions")
                && questionsData.get("questions").isJsonArray()) {
            for (JsonElement q : questionsData.getAsJsonArray("questions")) {
                if (!q.isJsonObject()) {
                    continue;
                }
                JsonObject qo = q.getAsJsonObject();
                String text = qo.has("question") && qo.get("question").isJsonPrimitive()
                        ? qo.get("question").getAsString() : null;
                if (text == null || text.isEmpty()) {
                    continue;
                }
                boolean multi = qo.has("multiSelect") && qo.get("multiSelect").isJsonPrimitive()
                        && qo.get("multiSelect").getAsBoolean();
                questionMap.put(text, multi);
            }
        }

        for (java.util.Map.Entry<String, JsonElement> entry : answers.entrySet()) {
            String key = entry.getKey();
            if (!questionMap.containsKey(key)) {
                return "Unknown question: " + key;
            }
            boolean multi = questionMap.get(key);
            JsonElement val = entry.getValue();
            if (val == null || val.isJsonNull()) {
                return "Answer for '" + key + "' must not be null";
            }
            if (multi) {
                if (!val.isJsonArray()) {
                    return "Answer for '" + key + "' must be a string array";
                }
                for (JsonElement item : val.getAsJsonArray()) {
                    if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()) {
                        return "Answer for '" + key + "' must be a string array";
                    }
                    int len = item.getAsString().length();
                    if (len > RemoteGatewayLimits.MAX_CUSTOM_INPUT_LENGTH) {
                        return "Answer too long for '" + key + "'";
                    }
                    totalChars += len;
                }
            } else {
                if (!val.isJsonPrimitive() || !val.getAsJsonPrimitive().isString()) {
                    return "Answer for '" + key + "' must be a string";
                }
                int len = val.getAsString().length();
                if (len > RemoteGatewayLimits.MAX_CUSTOM_INPUT_LENGTH) {
                    return "Answer too long for '" + key + "'";
                }
                totalChars += len;
            }
            if (totalChars > RemoteGatewayLimits.MAX_TOTAL_ANSWER_CHARS) {
                return "Total answer size too large";
            }
        }
        return null;
    }

    private static boolean eq(String a, String b) {
        return a != null ? a.equals(b) : b == null;
    }
}
