package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.PermissionModeService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Handles permission mode (bypassPermissions, etc.) get/set operations.
 *
 * <p>Phase 2C-C: the apply/get logic is delegated to the shared
 * {@link PermissionModeService} so the desktop handler and the Remote
 * {@code /mode} endpoint invoke the same business method (no second backend).
 */
public class PermissionModeHandler {

    private static final Logger LOG = Logger.getInstance(PermissionModeHandler.class);

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public PermissionModeHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Get current permission mode and push it to the webview.
     */
    public void handleGetMode() {
        try {
            String currentMode = PermissionModeService.current(context.getSession());

            final String modeToSend = currentMode;
            ApplicationManager.getApplication().invokeLater(() -> {
                this.context.callJavaScript("window.onModeReceived", this.context.escapeJs(modeToSend));
            });
        } catch (Exception e) {
            LOG.error("[PermissionModeHandler] Failed to get mode: " + e.getMessage(), e);
        }
    }

    /**
     * Handle set mode request.
     */
    public void handleSetMode(String content) {
        try {
            String mode = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = this.gson.fromJson(content, JsonObject.class);
                    if (json != null && json.has("mode")) {
                        mode = json.get("mode").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the mode
                }
            }

            if (this.context.getSession() == null) {
                LOG.warn("[PermissionModeHandler] WARNING: Session is null! Cannot set permission mode");
                return;
            }

            String applied = PermissionModeService.apply(
                    this.context.getSession(),
                    this.context.getProject(),
                    mode,
                    this.context.getClaudeSDKBridge(),
                    this.context.getCurrentProvider());
            if (applied == null) {
                LOG.warn("[PermissionModeHandler] Rejected invalid permission mode: " + mode);
            } else {
                LOG.info("[PermissionModeHandler] Applied permission mode: " + applied);
            }
        } catch (Exception e) {
            LOG.error("[PermissionModeHandler] Failed to set mode: " + e.getMessage(), e);
        }
    }
}
