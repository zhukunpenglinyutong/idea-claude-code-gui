package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.SessionState;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;

import java.nio.charset.StandardCharsets;

/**
 * Parses and validates the body of {@code PUT .../tabs/{tabId}/mode}
 * (Phase 2C-C §24).
 *
 * <p>Accepted shape: {@code {"mode":"..."}} where {@code mode} must be one of
 * {@link SessionState#VALID_PERMISSION_MODES}. Aliases ("auto", "全自动",
 * "allow_all", ...) are rejected &mdash; the presentation layer may translate
 * for humans, but the API contract keeps source-code semantics.
 *
 * <p>Pure logic (no IntelliJ, no HTTP).
 */
final class RemoteModeRequest {

    private RemoteModeRequest() {
    }

    static final class Result {
        final boolean valid;
        final String mode;
        final RemoteErrors.Code errorCode;
        final String errorMessage;

        private Result(boolean valid, String mode, RemoteErrors.Code code, String message) {
            this.valid = valid;
            this.mode = mode;
            this.errorCode = code;
            this.errorMessage = message;
        }

        static Result ok(String mode) {
            return new Result(true, mode, null, null);
        }

        static Result invalid(RemoteErrors.Code code, String message) {
            return new Result(false, null, code, message);
        }
    }

    static Result parse(byte[] body) {
        if (body == null || body.length == 0) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing mode");
        }
        String text;
        try {
            text = new String(body, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid UTF-8 body");
        }
        if (text.trim().isEmpty()) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing mode");
        }
        JsonObject payload;
        try {
            JsonElement element = new Gson().fromJson(text, JsonElement.class);
            if (element == null || !element.isJsonObject()) {
                return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Request body must be a JSON object");
            }
            payload = element.getAsJsonObject();
        } catch (JsonSyntaxException e) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid JSON");
        }
        if (!payload.has("mode") || payload.get("mode").isJsonNull()) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing mode");
        }
        JsonElement modeEl = payload.get("mode");
        if (!modeEl.isJsonPrimitive() || !modeEl.getAsJsonPrimitive().isString()) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "mode must be a string");
        }
        String mode = modeEl.getAsString();
        if (!SessionState.isValidPermissionMode(mode)) {
            return Result.invalid(RemoteErrors.Code.INVALID_MODE, "Invalid permission mode");
        }
        return Result.ok(mode.trim());
    }
}
