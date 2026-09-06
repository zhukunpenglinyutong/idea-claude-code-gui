package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Handles native auto approval, full auto, and other permission mode get/set operations.
 */
public class PermissionModeHandler {

    private static final Logger LOG = Logger.getInstance(PermissionModeHandler.class);

    static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public PermissionModeHandler(HandlerContext context) {
        this.context = context;
    }

    private String normalizeModeForCurrentProvider(String mode) {
        String normalized = mode == null ? "default" : mode.trim();
        String provider = this.context.getCurrentProvider();
        if (provider == null || provider.isEmpty()) {
            provider = HandlerContext.DEFAULT_PROVIDER;
        }
        if ("autoEdit".equals(normalized)) {
            normalized = "omp".equals(provider) ? "default" : "acceptEdits";
        }
        if ("auto".equals(normalized) && !"claude".equals(provider) && !"codex".equals(provider)) {
            return "default";
        }
        return normalized;
    }

    /**
     * Get current permission mode.
     */
    public void handleGetMode() {
        try {
            String currentMode = "default";  // Default value (prompt on each tool call)

            // Prefer getting from session first
            if (this.context.getSession() != null) {
                String sessionMode = this.context.getSession().getPermissionMode();
                if (sessionMode != null && !sessionMode.trim().isEmpty()) {
                    currentMode = sessionMode;
                }
            } else {
                // If session does not exist, load from persistent storage
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
                if (savedMode != null && !savedMode.trim().isEmpty()) {
                    // Keep the raw trimmed value here — the legacy autoEdit alias
                    // and per-provider fallbacks are all handled by the shared
                    // normalizeModeForCurrentProvider below, so read and write
                    // paths map the same stored value to the same effective mode.
                    currentMode = savedMode.trim();
                }
            }

            currentMode = normalizeModeForCurrentProvider(currentMode);
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
                    if (json.has("mode")) {
                        mode = json.get("mode").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the mode
                }
            }

            mode = normalizeModeForCurrentProvider(mode);

            // Check if session exists
            if (this.context.getSession() != null) {
                this.context.getSession().setPermissionMode(mode);
                String effectiveMode = this.context.getSession().getPermissionMode();
                if (effectiveMode == null || effectiveMode.isEmpty()) {
                    effectiveMode = "default";
                    this.context.getSession().setPermissionMode(effectiveMode);
                }

                // Save permission mode to persistent storage
                PropertiesComponent props = PropertiesComponent.getInstance();
                props.setValue(PERMISSION_MODE_PROPERTY_KEY, effectiveMode);
                LOG.info("Saved permission mode to settings: " + effectiveMode);
                com.github.claudecodegui.notifications.ClaudeNotifier.setMode(this.context.getProject(), effectiveMode);

                // Push the new mode to the live runtime so it takes effect on the
                // next tool call in the current turn, mirroring the TUI's instant
                // mode switch instead of waiting for the next user message.
                pushPermissionModeLive(effectiveMode);
            } else {
                LOG.warn("[PermissionModeHandler] WARNING: Session is null! Cannot set permission mode");
            }
        } catch (Exception e) {
            LOG.error("[PermissionModeHandler] Failed to set mode: " + e.getMessage(), e);
        }
    }

    /**
     * Notify the live AI Bridge runtime of a mode change so it applies
     * immediately to the in-progress conversation.
     */
    private void pushPermissionModeLive(String mode) {
        try {
            String provider = this.context.getCurrentProvider();
            if (provider == null || provider.isEmpty()) {
                provider = com.github.claudecodegui.handler.core.HandlerContext.DEFAULT_PROVIDER;
            }

            // Only the Claude persistent runtime supports hot-swapping the mode
            // on a live query today; Codex rebuilds thread options per turn.
            // TODO: implement live permission-mode switch for the Codex provider
            // (verify whether the Codex SDK supports reconfiguring approvalPolicy
            // / sandbox on an active thread without recreating it).
            if (!"claude".equals(provider)) {
                return;
            }

            com.github.claudecodegui.session.ClaudeSession session = this.context.getSession();
            if (session == null) {
                return;
            }
            String sessionId = session.getSessionId();
            String epoch = session.getRuntimeSessionEpoch();

            this.context.getClaudeSDKBridge().setPermissionModeLive(sessionId, epoch, mode)
                    .exceptionally(ex -> {
                        LOG.warn("[PermissionModeHandler] Live mode push failed: " + ex.getMessage());
                        return null;
                    });
        } catch (Exception e) {
            LOG.warn("[PermissionModeHandler] Live mode push skipped: " + e.getMessage());
        }
    }
}
