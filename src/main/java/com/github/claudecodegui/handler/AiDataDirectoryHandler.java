package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.AiDataDirectoryManager;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.util.concurrency.AppExecutorUtil;

/** Handles safe relocation of the Claude, Codemoss and Codex data directories. */
final class AiDataDirectoryHandler {

    private static final Logger LOG = Logger.getInstance(AiDataDirectoryHandler.class);
    private final HandlerContext context;
    private final AiDataDirectoryManager manager;
    private final Gson gson = new Gson();

    AiDataDirectoryHandler(HandlerContext context) {
        this(context, new AiDataDirectoryManager());
    }

    AiDataDirectoryHandler(HandlerContext context, AiDataDirectoryManager manager) {
        this.context = context;
        this.manager = manager;
    }

    void handleGetStatus() {
        runAsync(() -> {
            try {
                pushStatus(manager.snapshot());
            } catch (Exception error) {
                LOG.warn("Failed to inspect AI data directories: " + error.getMessage(), error);
                pushOperation("status", false, errorCode(error), null);
            }
        });
    }

    void handleChooseTargetRoot() {
        ApplicationManager.getApplication().invokeLater(() -> {
            FileChooserDescriptor descriptor = new FileChooserDescriptor(
                    false, true, false, false, false, false)
                    .withTitle("Choose AI Data Storage Directory");
            FileChooser.chooseFile(descriptor, context.getProject(), null, selected -> {
                JsonObject payload = new JsonObject();
                payload.addProperty("path", selected.getPath());
                pushJson("onAiDataDirectoryRootSelected", payload);
            });
        });
    }

    void handleMigrate(String content) {
        runAsync(() -> {
            try {
                JsonObject request = parseObject(content);
                JsonObject result = manager.migrate(readString(request, "targetRoot"));
                pushOperationResult(result);
            } catch (Exception error) {
                LOG.warn("Failed to migrate AI data directories: " + error.getMessage(), error);
                pushOperation("migrate", false, errorCode(error), safeSnapshot());
            }
        });
    }

    void handleCleanupBackups() {
        runAsync(() -> {
            try {
                pushOperationResult(manager.cleanupBackups());
            } catch (Exception error) {
                LOG.warn("Failed to clean AI data directory backups: " + error.getMessage(), error);
                pushOperation("cleanup", false, errorCode(error), safeSnapshot());
            }
        });
    }

    private JsonObject safeSnapshot() {
        try {
            return manager.snapshot();
        } catch (Exception ignored) {
            return null;
        }
    }

    private void pushOperationResult(JsonObject result) {
        pushJson("onAiDataDirectoryOperation", result);
        if (result.has("status") && result.get("status").isJsonObject()) {
            pushStatus(result.getAsJsonObject("status"));
        }
    }

    private void pushOperation(String operation, boolean success, String error, JsonObject status) {
        JsonObject result = new JsonObject();
        result.addProperty("operation", operation);
        result.addProperty("success", success);
        if (error != null) {
            result.addProperty("error", error);
        }
        if (status != null) {
            result.add("status", status);
        }
        pushOperationResult(result);
    }

    private void pushStatus(JsonObject status) {
        pushJson("updateAiDataDirectoryStatus", status);
    }

    private void pushJson(String callback, JsonObject payload) {
        context.callJavaScript(callback, context.escapeJs(gson.toJson(payload)));
    }

    private static JsonObject parseObject(String content) {
        if (content == null || content.isBlank()) {
            return new JsonObject();
        }
        return JsonParser.parseString(content).getAsJsonObject();
    }

    private static String readString(JsonObject object, String key) {
        return object.has(key) && object.get(key).isJsonPrimitive()
                && object.getAsJsonPrimitive(key).isString()
                ? object.get(key).getAsString() : null;
    }

    private static String errorCode(Exception error) {
        String message = error.getMessage();
        return message != null && message.matches("^[A-Z0-9_]+$")
                ? message : "AI_DATA_DIRECTORY_OPERATION_FAILED";
    }

    private static void runAsync(Runnable task) {
        AppExecutorUtil.getAppExecutorService().execute(task);
    }
}
