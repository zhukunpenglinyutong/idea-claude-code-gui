package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.permission.InteractionHandle;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.permission.SharedInteractionResolver;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.SystemNotificationService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Permission handler.
 * Handles permission dialog display and decision processing.
 *
 * <p>Pending interactions live in the shared {@link SharedInteractionResolver}
 * (Phase 2C-C), so the desktop dialog path and the Remote gateway resolve the
 * <em>same</em> {@link InteractionHandle} (first-wins). This handler creates the
 * handle (future + channelId + completer) when a dialog is shown; the desktop JS
 * decision path and the Remote HTTP endpoint both complete it via the resolver.
 */
public class PermissionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PermissionHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "permission_decision",
        "ask_user_question_response",
        "plan_approval_response"
    };

    private static int payloadLength(String value) {
        return value == null ? 0 : value.length();
    }

    private static String errorClass(Exception error) {
        return error.getClass().getSimpleName();
    }

    interface CancellableTask {
        void cancel();
    }

    interface SafetyNetScheduler {
        CancellableTask schedule(Runnable task, long delaySeconds);
    }

    private static final SafetyNetScheduler DEFAULT_SAFETY_NET_SCHEDULER = (task, delaySeconds) -> {
        ScheduledFuture<?> scheduledFuture = AppExecutorUtil.getAppScheduledExecutorService()
                .schedule(task, delaySeconds, TimeUnit.SECONDS);
        return () -> scheduledFuture.cancel(false);
    };

    private final SafetyNetScheduler safetyNetScheduler;
    private final SharedInteractionResolver resolver = SharedInteractionResolver.getInstance();

    // Permission denied callback
    public interface PermissionDeniedCallback {
        void onPermissionDenied();
    }

    private PermissionDeniedCallback deniedCallback;

    public PermissionHandler(HandlerContext context) {
        this(context, DEFAULT_SAFETY_NET_SCHEDULER);
    }

    PermissionHandler(HandlerContext context, SafetyNetScheduler safetyNetScheduler) {
        super(context);
        this.safetyNetScheduler = safetyNetScheduler;
    }

    long getSafetyNetTimeoutSeconds() {
        CodemossSettingsService settingsService = context.getSettingsService();
        if (settingsService == null) {
            // Fall back to DEFAULT (not MAX) so a missing settings service doesn't turn the
            // safety net into a one-hour hang for an error that's almost always transient.
            return CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                    + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
        }
        try {
            return settingsService.getPermissionDialogTimeoutSeconds()
                    + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
        } catch (Exception e) {
            LOG.warn("[PERM_SHOW] Failed to read permission dialog timeout for safety net; errorClass="
                    + e.getClass().getSimpleName(), e);
            return CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                    + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
        }
    }

    void scheduleSafetyNet(CompletableFuture<?> future, Runnable timeoutTask) {
        CancellableTask cancellableTask = safetyNetScheduler.schedule(timeoutTask, getSafetyNetTimeoutSeconds());
        future.whenComplete((ignored, error) -> cancellableTask.cancel());
    }

    /**
     * Push a force-close signal to the webview's dialog manager. Used after the
     * Java side has auto-resolved a permission/ask/plan dialog future (e.g.
     * safety-net timeout, Remote resolve, or clearPendingRequests) so the React
     * dialog state cannot stay stuck on a resolved request and silently block
     * every subsequent show*Dialog call.
     *
     * @param fnName       webview function: forceClosePermissionDialog /
     *                     forceCloseAskUserQuestionDialog /
     *                     forceClosePlanApprovalDialog
     * @param targetId     channelId (permission) or requestId (ask/plan);
     *                     null clears every open dialog of that kind.
     */
    private void forceCloseFrontendDialog(String fnName, String targetId) {
        String safeId = targetId == null ? "" : targetId;
        String escapedId = escapeJs(safeId);
        String jsCode = "if (typeof window." + fnName + " === 'function') { "
                + "window." + fnName + "('" + escapedId + "'); }";
        // executeJavaScriptOnEDT already marshals to the EDT and no-ops when the
        // browser is absent, so call it directly. Wrapping it in another
        // invokeLater would both double-post and NPE in unit tests, where
        // ApplicationManager.getApplication() is null.
        context.executeJavaScriptOnEDT(jsCode);
    }

    public void setPermissionDeniedCallback(PermissionDeniedCallback callback) {
        this.deniedCallback = callback;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("permission_decision".equals(type)) {
            LOG.debug("[PERM_DEBUG][BRIDGE_RECV] Received permission_decision from JS");
            LOG.debug("[PERM_DEBUG][BRIDGE_RECV] payloadLength=" + payloadLength(content));
            handlePermissionDecision(content);
            return true;
        } else if ("ask_user_question_response".equals(type)) {
            LOG.debug("[ASK_USER_QUESTION][BRIDGE_RECV] Received ask_user_question_response from JS");
            LOG.debug("[ASK_USER_QUESTION][BRIDGE_RECV] payloadLength=" + payloadLength(content));
            handleAskUserQuestionResponse(content);
            return true;
        } else if ("plan_approval_response".equals(type)) {
            LOG.debug("[PLAN_APPROVAL][BRIDGE_RECV] Received plan_approval_response from JS");
            LOG.debug("[PLAN_APPROVAL][BRIDGE_RECV] payloadLength=" + payloadLength(content));
            handlePlanApprovalResponse(content);
            return true;
        }
        return false;
    }

    private String currentSessionId() {
        try {
            return context.getSession() != null ? context.getSession().getSessionId() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Show the frontend permission dialog.
     */
    public CompletableFuture<Integer> showFrontendPermissionDialog(String requestId, String toolName, JsonObject inputs) {
        String channelId = UUID.randomUUID().toString();
        String sessionId = currentSessionId();
        CompletableFuture<Integer> future = new CompletableFuture<>();

        LOG.info("[PERM_SHOW] showFrontendPermissionDialog called: channelId=" + channelId
                + ", requestId=" + requestId + ", toolName=" + toolName);

        InteractionHandle handle = new InteractionHandle(
                InteractionHandle.Type.PERMISSION, sessionId, requestId, channelId,
                new InteractionHandle.Completer() {
                    @Override
                    public void complete(Object value) {
                        future.complete((Integer) value);
                        forceCloseFrontendDialog("forceClosePermissionDialog", channelId);
                    }
                    @Override
                    public void cancel(String reason) {
                        future.complete(PermissionService.PermissionResponse.DENY.getValue());
                        forceCloseFrontendDialog("forceClosePermissionDialog", channelId);
                    }
                });
        resolver.register(handle);

        try {
            Gson gson = new Gson();
            JsonObject requestData = new JsonObject();
            requestData.addProperty("channelId", channelId);
            requestData.addProperty("toolName", toolName);
            requestData.add("inputs", inputs);

            String requestJson = gson.toJson(requestData);
            String escapedJson = escapeJs(requestJson);

            ApplicationManager.getApplication().invokeLater(() -> {
                LOG.info("[PERM_SHOW] Executing JS to show dialog for channelId=" + channelId);
                String jsCode = "(function retryShowDialog(retries) { " +
                    "  if (window.showPermissionDialog) { " +
                    "    window.showPermissionDialog('" + escapedJson + "'); " +
                    "  } else if (retries > 0) { " +
                    "    setTimeout(function() { retryShowDialog(retries - 1); }, 200); " +
                    "  } else { " +
                    "    console.error('[PERM_DEBUG][JS] FAILED: showPermissionDialog not available!'); " +
                    "  } " +
                    "})(30);";

                context.executeJavaScriptOnEDT(jsCode);
            });

            scheduleSafetyNet(future, () -> {
                if (handle.cancel("timeout")) {
                    LOG.warn("[PERM_SHOW] Safety-net timeout fired (webview unreachable) for channelId=" + channelId);
                    resolver.remove(sessionId, requestId);
                }
            });

        } catch (Exception e) {
            LOG.error("[PERM_SHOW] ERROR: errorClass=" + errorClass(e), e);
            handle.cancel("show-error");
            resolver.remove(sessionId, requestId);
        }

        return future;
    }

    /**
     * Show permission request dialog (from PermissionRequest).
     */
    public void showPermissionDialog(PermissionRequest request) {
        LOG.info("[PermissionHandler] 显示权限请求对话框: " + request.getToolName());

        try {
            Gson gson = new Gson();
            JsonObject requestData = new JsonObject();
            requestData.addProperty("channelId", request.getChannelId());
            requestData.addProperty("toolName", request.getToolName());

            JsonObject inputsJson = gson.toJsonTree(request.getInputs()).getAsJsonObject();
            requestData.add("inputs", inputsJson);

            if (request.getSuggestions() != null) {
                requestData.add("suggestions", request.getSuggestions());
            }

            String requestJson = gson.toJson(requestData);
            String escapedJson = escapeJs(requestJson);

            // Get the project associated with the permission request
            Project targetProject = request.getProject();
            if (targetProject == null) {
                LOG.warn("[PermissionHandler] 警告: PermissionRequest 没有关联的 Project，使用当前 context 的窗口");
                targetProject = this.context.getProject();
            }

            // Get the window instance for the target project
            com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow targetWindow =
                com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow.getChatWindow(targetProject);

            if (targetWindow == null) {
                LOG.error("[PermissionHandler] Error: cannot find window instance for project " + targetProject.getName());
                // If target window is not found, deny the permission request
                this.context.getSession().handlePermissionDecision(
                    request.getChannelId(),
                    false,
                    false,
                    "Failed to show permission dialog: window not found"
                );
                notifyPermissionDenied();
                return;
            }

            // Execute JavaScript in the target window to show the dialog
            String jsCode = "if (window.showPermissionDialog) { " +
                "  window.showPermissionDialog('" + escapedJson + "'); " +
                "}";

            targetWindow.executeJavaScriptCode(jsCode);

        } catch (Exception e) {
            LOG.error("[PermissionHandler] 显示权限弹窗失败: errorClass=" + errorClass(e), e);
            this.context.getSession().handlePermissionDecision(
                request.getChannelId(),
                false,
                false,
                "Failed to show permission dialog"
            );
            notifyPermissionDenied();
        }
    }

    /**
     * Handle permission decision messages from JavaScript.
     */
    private void handlePermissionDecision(String jsonContent) {
        LOG.info("[PERM_DECISION] Received permission decision from JS");
        LOG.debug("[PERM_DEBUG][HANDLE_DECISION] payloadLength=" + payloadLength(jsonContent));
        try {
            Gson gson = new Gson();
            JsonObject decision = gson.fromJson(jsonContent, JsonObject.class);

            String channelId = decision.get("channelId").getAsString();
            boolean allow = decision.get("allow").getAsBoolean();
            boolean remember = decision.get("remember").getAsBoolean();
            String rejectMessage = "";
            if (decision.has("rejectMessage") && !decision.get("rejectMessage").isJsonNull()) {
                rejectMessage = decision.get("rejectMessage").getAsString();
            }

            LOG.info("[PERM_DECISION] channelId=" + channelId + ", allow=" + allow + ", remember=" + remember);

            int responseValue;
            if (allow) {
                responseValue = remember
                        ? PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue()
                        : PermissionService.PermissionResponse.ALLOW.getValue();
            } else {
                responseValue = PermissionService.PermissionResponse.DENY.getValue();
            }

            SharedInteractionResolver.ResolveOutcome outcome =
                    resolver.completePermissionByChannelId(channelId, responseValue);
            if (outcome == SharedInteractionResolver.ResolveOutcome.RESOLVED) {
                LOG.info("[PERM_DECISION] Resolved via shared resolver, value=" + responseValue);
                if (!allow) {
                    notifyPermissionDenied();
                }
            } else {
                // No shared handle for this channelId — fall back to the legacy
                // PermissionManager path (e.g. showPermissionDialog(PermissionRequest)).
                LOG.warn("[PERM_DECISION] No shared handle for channelId=" + channelId
                        + " (outcome=" + outcome + "), falling back to session handler");
                if (remember) {
                    context.getSession().handlePermissionDecisionAlways(channelId, allow);
                } else {
                    context.getSession().handlePermissionDecision(channelId, allow, false, rejectMessage);
                }
                if (!allow) {
                    notifyPermissionDenied();
                }
            }
        } catch (Exception e) {
            LOG.error("[PERM_DECISION] ERROR: errorClass=" + errorClass(e), e);
        }
    }

    /**
     * Notify that permission was denied.
     */
    private void notifyPermissionDenied() {
        if (deniedCallback != null) {
            deniedCallback.onPermissionDenied();
        }
    }

    /**
     * Clear all pending permission/ask/plan requests for this session.
     * Called during session switching or history restoration to prevent old
     * requests from interfering with the new session. Every pending future is
     * resolved immediately with a default-deny payload (Phase 2C-C: routed
     * through the shared resolver so Remote and desktop share one cleanup path).
     */
    public void clearPendingRequests() {
        String sessionId = currentSessionId();
        LOG.info("[PERM_CLEAR] Clearing all pending interaction requests for session=" + sessionId);

        int count = resolver.cancelAllForSession(sessionId, "Session changed");
        LOG.info("[PERM_CLEAR] Cancelled " + count + " pending interaction(s)");
    }

    /**
     * Show AskUserQuestion dialog (implements PermissionService.AskUserQuestionDialogShower interface).
     */
    public CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questionsData) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        String sessionId = currentSessionId();

        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] Starting showAskUserQuestionDialog");
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] requestId=" + requestId);

        InteractionHandle handle = new InteractionHandle(
                InteractionHandle.Type.QUESTION, sessionId, requestId, null,
                new InteractionHandle.Completer() {
                    @Override
                    public void complete(Object value) {
                        future.complete((JsonObject) value);
                        forceCloseFrontendDialog("forceCloseAskUserQuestionDialog", requestId);
                    }
                    @Override
                    public void cancel(String reason) {
                        // null distinguishes "no answer" from an empty answers object — see
                        // PermissionService.handleAskUserQuestion. clearPendingRequests relies on this.
                        future.complete(null);
                        forceCloseFrontendDialog("forceCloseAskUserQuestionDialog", requestId);
                    }
                });
        resolver.register(handle);
        resolver.attachQuestions(sessionId, requestId, questionsData);

        // Remind the user (via the opt-in system toast) that Claude is waiting for an
        // answer. Triggered here — before the JS dialog render — so the toast fires
        // for every AskUserQuestion regardless of whether the webview is reachable.
        try {
            SystemNotificationService.getInstance()
                .showAskUserQuestionReminderToast(context.getProject());
        } catch (Exception e) {
            LOG.warn("[ASK_USER_QUESTION][SHOW_DIALOG] Failed to show reminder toast: " + e.getMessage());
        }

        try {
            Gson gson = new Gson();
            String requestJson = gson.toJson(questionsData);
            String escapedJson = escapeJs(requestJson);

            ApplicationManager.getApplication().invokeLater(() -> {
                String jsCode = "(function retryShowAskUserQuestion(retries) { " +
                    "  if (window.showAskUserQuestionDialog) { " +
                    "    window.showAskUserQuestionDialog('" + escapedJson + "'); " +
                    "  } else if (retries > 0) { " +
                    "    setTimeout(function() { retryShowAskUserQuestion(retries - 1); }, 200); " +
                    "  } else { " +
                    "    console.error('[ASK_USER_QUESTION][JS] FAILED: showAskUserQuestionDialog not available!'); " +
                    "  } " +
                    "})(30);";

                context.executeJavaScriptOnEDT(jsCode);
            });

            scheduleSafetyNet(future, () -> {
                if (handle.cancel("timeout")) {
                    LOG.warn("[ASK_USER_QUESTION][SHOW_DIALOG] Safety-net timeout fired for requestId=" + requestId);
                    resolver.remove(sessionId, requestId);
                }
            });

        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][SHOW_DIALOG] ERROR: errorClass=" + errorClass(e), e);
            handle.cancel("show-error");
            resolver.remove(sessionId, requestId);
        }

        return future;
    }

    /**
     * Handle AskUserQuestion response messages from JavaScript.
     */
    private void handleAskUserQuestionResponse(String jsonContent) {
        LOG.debug("[ASK_USER_QUESTION][HANDLE_RESPONSE] payloadLength=" + payloadLength(jsonContent));
        try {
            Gson gson = new Gson();
            JsonObject response = gson.fromJson(jsonContent, JsonObject.class);

            String requestId = response.get("requestId").getAsString();
            JsonObject answers = response.has("answers") && !response.get("answers").isJsonNull()
                ? response.get("answers").getAsJsonObject()
                : new JsonObject();

            String sessionId = currentSessionId();
            SharedInteractionResolver.ResolveOutcome outcome =
                    resolver.completeAskByRequestId(sessionId, requestId, answers);
            if (outcome != SharedInteractionResolver.ResolveOutcome.RESOLVED) {
                LOG.warn("[ASK_USER_QUESTION][HANDLE_RESPONSE] No shared handle for requestId="
                        + requestId + " (outcome=" + outcome + ")");
            }
        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][HANDLE_RESPONSE] ERROR: errorClass=" + errorClass(e), e);
        }
    }

    /**
     * Show PlanApproval dialog (implements PermissionService.PlanApprovalDialogShower interface).
     */
    public CompletableFuture<JsonObject> showPlanApprovalDialog(String requestId, JsonObject planData) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        String sessionId = currentSessionId();

        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] Starting showPlanApprovalDialog");
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] requestId=" + requestId);

        InteractionHandle handle = new InteractionHandle(
                InteractionHandle.Type.PLAN, sessionId, requestId, null,
                new InteractionHandle.Completer() {
                    @Override
                    public void complete(Object value) {
                        future.complete((JsonObject) value);
                        forceCloseFrontendDialog("forceClosePlanApprovalDialog", requestId);
                    }
                    @Override
                    public void cancel(String reason) {
                        JsonObject rejected = new JsonObject();
                        rejected.addProperty("approved", false);
                        rejected.addProperty("message", reason != null ? reason : "Session changed");
                        future.complete(rejected);
                        forceCloseFrontendDialog("forceClosePlanApprovalDialog", requestId);
                    }
                });
        resolver.register(handle);
        resolver.attachPlan(sessionId, requestId, planData);

        try {
            Gson gson = new Gson();
            String requestJson = gson.toJson(planData);
            String escapedJson = escapeJs(requestJson);

            ApplicationManager.getApplication().invokeLater(() -> {
                String jsCode = "(function retryShowPlanApproval(retries) { " +
                    "  if (window.showPlanApprovalDialog) { " +
                    "    window.showPlanApprovalDialog('" + escapedJson + "'); " +
                    "  } else if (retries > 0) { " +
                    "    setTimeout(function() { retryShowPlanApproval(retries - 1); }, 200); " +
                    "  } else { " +
                    "    console.error('[PLAN_APPROVAL][JS] FAILED: showPlanApprovalDialog not available!'); " +
                    "  } " +
                    "})(30);";

                context.executeJavaScriptOnEDT(jsCode);
            });

            scheduleSafetyNet(future, () -> {
                if (handle.cancel("timeout")) {
                    LOG.warn("[PLAN_APPROVAL][SHOW_DIALOG] Safety-net timeout fired for requestId=" + requestId);
                    resolver.remove(sessionId, requestId);
                }
            });

        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][SHOW_DIALOG] ERROR: errorClass=" + errorClass(e), e);
            handle.cancel("show-error");
            resolver.remove(sessionId, requestId);
        }

        return future;
    }

    /**
     * Handle PlanApproval response messages from JavaScript.
     */
    private void handlePlanApprovalResponse(String jsonContent) {
        LOG.debug("[PLAN_APPROVAL][HANDLE_RESPONSE] payloadLength=" + payloadLength(jsonContent));
        try {
            Gson gson = new Gson();
            JsonObject response = gson.fromJson(jsonContent, JsonObject.class);

            String requestId = response.get("requestId").getAsString();
            boolean approved = response.has("approved") && response.get("approved").getAsBoolean();
            String targetMode = response.has("targetMode") ? response.get("targetMode").getAsString() : "default";

            JsonObject result = new JsonObject();
            result.addProperty("approved", approved);
            result.addProperty("targetMode", targetMode);

            String sessionId = currentSessionId();
            SharedInteractionResolver.ResolveOutcome outcome =
                    resolver.completePlanByRequestId(sessionId, requestId, result);
            if (outcome != SharedInteractionResolver.ResolveOutcome.RESOLVED) {
                LOG.warn("[PLAN_APPROVAL][HANDLE_RESPONSE] No shared handle for requestId="
                        + requestId + " (outcome=" + outcome + ")");
            }
        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][HANDLE_RESPONSE] ERROR: errorClass=" + errorClass(e), e);
        }
    }
}
