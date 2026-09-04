package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Handles persistence of a user-provided Codex CLI executable path.
 *
 * <p>When set, the Codex SDK is told to spawn this binary instead of its
 * bundled CLI via {@code codexPathOverride}. Persisted in
 * {@link PropertiesComponent} under {@link #CODEX_CLI_PATH_PROPERTY_KEY};
 * mirrors {@link ClaudeCliPathHandler}.
 */
public class CodexCliPathHandler {

    private static final Logger LOG = Logger.getInstance(CodexCliPathHandler.class);

    public static final String CODEX_CLI_PATH_PROPERTY_KEY = "codex.code.cli.path";

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public CodexCliPathHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Get the configured Codex CLI path (empty string when unset).
     */
    public void handleGetCodexCliPath() {
        CompletableFuture.runAsync(() -> {
            try {
                String saved = PropertiesComponent.getInstance().getValue(CODEX_CLI_PATH_PROPERTY_KEY);
                String pathToSend = (saved != null) ? saved.trim() : "";

                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("path", pathToSend);
                    context.callJavaScript("window.updateCodexCliPath", context.escapeJs(gson.toJson(response)));
                });
            } catch (Exception e) {
                LOG.error("[CodexCliPathHandler] Failed to get Codex CLI path: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("Failed to load Codex CLI path: " + e.getMessage()))
                );
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[CodexCliPathHandler] Unexpected error in handleGetCodexCliPath: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Persist a custom Codex CLI path. Validates that the path points at an
     * existing file (when non-empty). No daemon restart is needed because
     * Codex spawns per-message (unlike Claude's persistent daemon).
     */
    public void handleSetCodexCliPath(String content) {
        String parsedPath = null;
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
                parsedPath = json.get("path").getAsString();
            }
        } catch (Exception e) {
            LOG.error("[CodexCliPathHandler] Failed to parse set_codex_cli_path content: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("Failed to save Codex CLI path: " + e.getMessage()))
            );
            return;
        }
        final String pathArg = (parsedPath != null) ? parsedPath.trim() : null;

        CompletableFuture.runAsync(() -> {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String finalPath = "";
                boolean success = false;
                String failureMsg = null;

                if (pathArg == null || pathArg.isEmpty()) {
                    props.unsetValue(CODEX_CLI_PATH_PROPERTY_KEY);
                    LOG.info("[CodexCliPathHandler] Cleared custom Codex CLI path");
                    success = true;
                } else {
                    failureMsg = validateCliPath(new File(pathArg), pathArg);
                    if (failureMsg == null) {
                        props.setValue(CODEX_CLI_PATH_PROPERTY_KEY, pathArg);
                        finalPath = pathArg;
                        success = true;
                        LOG.info("[CodexCliPathHandler] Saved custom Codex CLI path: " + pathArg);
                    }
                }

                final boolean successFlag = success;
                final String failureMsgFinal = failureMsg;
                final String finalPathToSend = finalPath;
                // On failure, echo back what the user typed so the input keeps their
                // entry instead of being blanked; on success, reflect the persisted value.
                final String pathToEcho = successFlag
                        ? finalPathToSend
                        : (pathArg != null ? pathArg : "");

                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("path", pathToEcho);
                    context.callJavaScript("window.updateCodexCliPath", context.escapeJs(gson.toJson(response)));

                    if (successFlag) {
                        String msg = finalPathToSend.isEmpty()
                            ? "Codex CLI path cleared, using bundled SDK"
                            : "Codex CLI path saved: " + finalPathToSend;
                        context.callJavaScript("window.showSwitchSuccess", context.escapeJs(msg));
                    } else {
                        String msg = failureMsgFinal != null ? failureMsgFinal : "Invalid Codex CLI path";
                        context.callJavaScript("window.showError", context.escapeJs(msg));
                    }
                });
            } catch (Exception e) {
                LOG.error("[CodexCliPathHandler] Failed to set Codex CLI path: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("Failed to save Codex CLI path: " + e.getMessage()))
                );
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[CodexCliPathHandler] Unexpected error in handleSetCodexCliPath: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Validates a candidate Codex CLI path. Returns {@code null} when the path is a
     * usable executable file, otherwise a human-readable reason. Extracted as a pure
     * static method so the validation branches can be unit-tested without booting the
     * IntelliJ platform (the handler itself depends on {@link PropertiesComponent}).
     */
    static String validateCliPath(File f, String rawPath) {
        if (!f.exists()) {
            return "File does not exist: " + rawPath;
        }
        if (f.isDirectory()) {
            return "Path is a directory, expected an executable file: " + rawPath;
        }
        if (!f.canExecute()) {
            return "File is not executable (check permissions): " + rawPath;
        }
        return null;
    }
}
