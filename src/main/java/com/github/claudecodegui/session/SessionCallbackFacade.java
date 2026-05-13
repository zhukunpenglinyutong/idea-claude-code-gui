package com.github.claudecodegui.session;

import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.permission.PermissionRequest;
import com.intellij.openapi.project.Project;

import java.util.List;

/**
 * Centralizes session callback dispatch and session-level notification side effects.
 */
public class SessionCallbackFacade {

    private final Project project;
    private final CallbackHandler callbackHandler = new CallbackHandler();

    public SessionCallbackFacade(Project project) {
        this.project = project;
    }

    public CallbackHandler getCallbackHandler() {
        return callbackHandler;
    }

    public void setCallback(ClaudeSession.SessionCallback callback) {
        callbackHandler.setCallback(callback);
    }

    public void notifyMessageUpdate(List<ClaudeSession.Message> messages) {
        callbackHandler.notifyMessageUpdate(messages);
    }

    public void notifyStateChange(boolean busy, boolean loading, String error) {
        callbackHandler.notifyStateChange(busy, loading, error);
        if (project != null && error != null && !error.isEmpty()) {
            ClaudeNotifier.showError(project, error);
        }
    }

    public void notifyStatusMessage(String message) {
        callbackHandler.notifyStatusMessage(message);
    }

    public void notifySessionIdReceived(String sessionId) {
        callbackHandler.notifySessionIdReceived(sessionId);
    }

    public void notifyPermissionRequested(PermissionRequest request) {
        callbackHandler.notifyPermissionRequested(request);
    }

    public void notifyThinkingStatusChanged(boolean isThinking) {
        callbackHandler.notifyThinkingStatusChanged(isThinking);
    }

    public void notifySlashCommandsReceived(List<String> slashCommands) {
        callbackHandler.notifySlashCommandsReceived(slashCommands);
    }

    public void notifyNodeLog(String log) {
        callbackHandler.notifyNodeLog(log);
    }

    public void notifySummaryReceived(String summary) {
        callbackHandler.notifySummaryReceived(summary);
    }

    public void notifyStreamStart() {
        callbackHandler.notifyStreamStart();
    }

    public void notifyStreamEnd() {
        callbackHandler.notifyStreamEnd();
    }

    public void notifyContentDelta(String delta) {
        callbackHandler.notifyContentDelta(delta);
    }

    public void notifyThinkingDelta(String delta) {
        callbackHandler.notifyThinkingDelta(delta);
    }

    public void notifyUsageUpdate(int usedTokens, int maxTokens) {
        callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
    }

    public void notifyUserMessageUuidPatched(String content, String uuid) {
        callbackHandler.notifyUserMessageUuidPatched(content, uuid);
    }

    public void notifyLimitsUpdate(String json) {
        callbackHandler.notifyLimitsUpdate(json);
    }
}
