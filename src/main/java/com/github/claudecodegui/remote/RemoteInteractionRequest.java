package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.session.SessionState;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;

import java.nio.charset.StandardCharsets;

/**
 * Parses and validates the bodies of the three Remote interaction-control
 * endpoints (Phase 2C-C §7, §8, §12, §14).
 *
 * <p>Pure logic (no IntelliJ, no HTTP). Parse failures never echo the body in
 * the error message. Semantic validation that an answer matches the original
 * question set is deferred to {@code RemoteControlHandler} (it needs the
 * interaction's recorded request payload).
 *
 * <p>Contracts:
 * <ul>
 *   <li><b>Permission</b>: {@code {"taskId":"...","decision":"ALLOW"|"ALLOW_ALWAYS"|"DENY"}}
 *       &mdash; decision uses the source-code enum names, never aliases (§8).</li>
 *   <li><b>AskUserQuestion</b>: {@code {"taskId":"...","answers":{...}}}
 *       &mdash; answers is a JSON object keyed by question text (§12).</li>
 *   <li><b>Plan</b>: {@code {"taskId":"...","approved":bool,"targetMode":"..."}}
 *       &mdash; targetMode (optional, defaults to "default") must be a valid
 *       permission mode (§14).</li>
 * </ul>
 */
final class RemoteInteractionRequest {

    private RemoteInteractionRequest() {
    }

    // ── Permission decision ────────────────────────────────────────────

    static final class PermissionResult {
        final boolean valid;
        final String taskId;
        final int responseValue;
        final RemoteErrors.Code errorCode;
        final String errorMessage;

        private PermissionResult(boolean valid, String taskId, int responseValue,
                                 RemoteErrors.Code code, String message) {
            this.valid = valid;
            this.taskId = taskId;
            this.responseValue = responseValue;
            this.errorCode = code;
            this.errorMessage = message;
        }

        static PermissionResult ok(String taskId, int responseValue) {
            return new PermissionResult(true, taskId, responseValue, null, null);
        }

        static PermissionResult invalid(RemoteErrors.Code code, String message) {
            return new PermissionResult(false, null, 0, code, message);
        }
    }

    static PermissionResult parsePermission(byte[] body) {
        JsonObject payload = parseObject(body);
        if (payload == null) {
            return PermissionResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid JSON body");
        }
        String taskId = readNonEmptyString(payload, "taskId");
        if (taskId == null) {
            return PermissionResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing taskId");
        }
        String decision = readNonEmptyString(payload, "decision");
        if (decision == null) {
            return PermissionResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing decision");
        }
        int responseValue;
        switch (decision) {
            case "ALLOW":
                responseValue = PermissionService.PermissionResponse.ALLOW.getValue();
                break;
            case "ALLOW_ALWAYS":
                responseValue = PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue();
                break;
            case "DENY":
                responseValue = PermissionService.PermissionResponse.DENY.getValue();
                break;
            default:
                return PermissionResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid decision");
        }
        return PermissionResult.ok(taskId, responseValue);
    }

    // ── AskUserQuestion answer ─────────────────────────────────────────

    static final class AskResult {
        final boolean valid;
        final String taskId;
        final JsonObject answers;
        final RemoteErrors.Code errorCode;
        final String errorMessage;

        private AskResult(boolean valid, String taskId, JsonObject answers,
                          RemoteErrors.Code code, String message) {
            this.valid = valid;
            this.taskId = taskId;
            this.answers = answers;
            this.errorCode = code;
            this.errorMessage = message;
        }

        static AskResult ok(String taskId, JsonObject answers) {
            return new AskResult(true, taskId, answers, null, null);
        }

        static AskResult invalid(RemoteErrors.Code code, String message) {
            return new AskResult(false, null, null, code, message);
        }
    }

    static AskResult parseAsk(byte[] body) {
        JsonObject payload = parseObject(body);
        if (payload == null) {
            return AskResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid JSON body");
        }
        String taskId = readNonEmptyString(payload, "taskId");
        if (taskId == null) {
            return AskResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing taskId");
        }
        if (!payload.has("answers") || payload.get("answers").isJsonNull()) {
            return AskResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing answers");
        }
        JsonElement answersEl = payload.get("answers");
        if (!answersEl.isJsonObject()) {
            return AskResult.invalid(RemoteErrors.Code.BAD_REQUEST, "answers must be a JSON object");
        }
        JsonObject answers = answersEl.getAsJsonObject();
        if (answers.size() > RemoteGatewayLimits.MAX_ANSWER_COUNT) {
            return AskResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Too many answers");
        }
        return AskResult.ok(taskId, answers);
    }

    // ── Plan decision ──────────────────────────────────────────────────

    static final class PlanResult {
        final boolean valid;
        final String taskId;
        final boolean approved;
        final String targetMode;
        final RemoteErrors.Code errorCode;
        final String errorMessage;

        private PlanResult(boolean valid, String taskId, boolean approved, String targetMode,
                           RemoteErrors.Code code, String message) {
            this.valid = valid;
            this.taskId = taskId;
            this.approved = approved;
            this.targetMode = targetMode;
            this.errorCode = code;
            this.errorMessage = message;
        }

        static PlanResult ok(String taskId, boolean approved, String targetMode) {
            return new PlanResult(true, taskId, approved, targetMode, null, null);
        }

        static PlanResult invalid(RemoteErrors.Code code, String message) {
            return new PlanResult(false, null, false, null, code, message);
        }
    }

    static PlanResult parsePlan(byte[] body) {
        JsonObject payload = parseObject(body);
        if (payload == null) {
            return PlanResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid JSON body");
        }
        String taskId = readNonEmptyString(payload, "taskId");
        if (taskId == null) {
            return PlanResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing taskId");
        }
        if (!payload.has("approved") || payload.get("approved").isJsonNull()) {
            return PlanResult.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing approved");
        }
        JsonElement approvedEl = payload.get("approved");
        if (!approvedEl.isJsonPrimitive() || !approvedEl.getAsJsonPrimitive().isBoolean()) {
            return PlanResult.invalid(RemoteErrors.Code.BAD_REQUEST, "approved must be a boolean");
        }
        boolean approved = approvedEl.getAsBoolean();
        String targetMode = "default";
        if (payload.has("targetMode") && !payload.get("targetMode").isJsonNull()) {
            JsonElement modeEl = payload.get("targetMode");
            if (!modeEl.isJsonPrimitive() || !modeEl.getAsJsonPrimitive().isString()) {
                return PlanResult.invalid(RemoteErrors.Code.BAD_REQUEST, "targetMode must be a string");
            }
            targetMode = modeEl.getAsString();
            if (!SessionState.isValidPermissionMode(targetMode)) {
                return PlanResult.invalid(RemoteErrors.Code.INVALID_MODE, "Invalid targetMode");
            }
        }
        return PlanResult.ok(taskId, approved, targetMode);
    }

    // ── helpers ────────────────────────────────────────────────────────

    private static JsonObject parseObject(byte[] body) {
        if (body == null || body.length == 0) {
            return null;
        }
        String text;
        try {
            text = new String(body, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
        if (text.trim().isEmpty()) {
            return null;
        }
        try {
            JsonElement element = new Gson().fromJson(text, JsonElement.class);
            if (element == null || !element.isJsonObject()) {
                return null;
            }
            return element.getAsJsonObject();
        } catch (JsonSyntaxException e) {
            return null;
        }
    }

    private static String readNonEmptyString(JsonObject payload, String field) {
        if (!payload.has(field) || payload.get(field).isJsonNull()) {
            return null;
        }
        JsonElement el = payload.get(field);
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) {
            return null;
        }
        String value = el.getAsString();
        return (value == null || value.trim().isEmpty()) ? null : value;
    }
}
