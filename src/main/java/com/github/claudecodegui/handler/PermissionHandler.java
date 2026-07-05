package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.interaction.FuturePermissionDecisionTarget;
import com.github.claudecodegui.interaction.SessionPermissionDecisionTarget;
import com.github.claudecodegui.interaction.UserInteractionService;
import com.github.claudecodegui.interaction.UserInteractionType;
import com.github.claudecodegui.notifications.AskUserQuestionReminderToastListener;
import com.github.claudecodegui.notifications.SoundUserInteractionListener;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.SoundNotificationService;
import com.github.claudecodegui.util.SystemNotificationService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
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

    // Lifecycle of all in-flight user interactions (permission / askUserQuestion / planApproval).
    private final UserInteractionService userInteractionService = new UserInteractionService();

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
        // The webview presenter is the consumer of the requested-interaction seam: it owns the
        // window.show* JS so this handler no longer builds it.
        this.userInteractionService.addListener(new WebviewUserInteractionPresenter(context, userInteractionService));
        // #1336: the manual-action sound is just another observer on the same seam. The handler only
        // registers the listener; SoundNotificationService decides when and which sound to play.
        this.userInteractionService.addListener(new SoundUserInteractionListener(
                SoundNotificationService.getInstance()::playManualActionRequiredSound));
        // v0.4.7 AskUserQuestion reminder toast, re-integrated as an observer (not an inline call).
        // Uses the handler context project, matching the v0.4.7 inline call; gating stays in the service.
        this.userInteractionService.addListener(new AskUserQuestionReminderToastListener(
                () -> SystemNotificationService.getInstance().showAskUserQuestionReminderToast(context.getProject())));
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

    /**
     * Show the frontend permission dialog.
     */
    public CompletableFuture<Integer> showFrontendPermissionDialog(String toolName, JsonObject inputs) {
        String channelId = UUID.randomUUID().toString();
        FuturePermissionDecisionTarget target = new FuturePermissionDecisionTarget();
        CompletableFuture<Integer> future = target.future();

        LOG.info("[PERM_SHOW] showFrontendPermissionDialog called: channelId=" + channelId + ", toolName=" + toolName);

        // Registering fires the webview presenter, which shows the dialog.
        userInteractionService.requestPermission(channelId, toolName, inputs, null, null, target);
        LOG.info("[PERM_SHOW] Stored pending request, total pending: "
                + userInteractionService.count(UserInteractionType.PERMISSION));

        scheduleSafetyNet(future, () -> {
            if (userInteractionService.timeout(UserInteractionType.PERMISSION, channelId)) {
                LOG.warn("[PERM_SHOW] Safety-net timeout fired (webview unreachable) for channelId=" + channelId);
            }
        });

        return future;
    }

    /**
     * Show permission request dialog (from PermissionRequest).
     */
    public void showPermissionDialog(PermissionRequest request) {
        LOG.info("[PermissionHandler] 显示权限请求对话框: " + request.getToolName());

        String channelId = request.getChannelId();
        try {
            Gson gson = new Gson();
            JsonObject inputsJson = gson.toJsonTree(request.getInputs()).getAsJsonObject();

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
                // If target window is not found, deny the permission request (nothing registered yet)
                this.context.getSession().handlePermissionDecision(
                    channelId, false, false, "Failed to show permission dialog: window not found");
                notifyPermissionDenied();
                return;
            }

            // Register through the service (session-callback path): same lifecycle, session target.
            // Registering fires the webview presenter, which shows the dialog on targetProject's window.
            userInteractionService.requestPermission(
                channelId, request.getToolName(), inputsJson, request.getSuggestions(), targetProject,
                new SessionPermissionDecisionTarget(context::getSession, channelId, this::notifyPermissionDenied));

        } catch (Exception e) {
            LOG.error("[PermissionHandler] 显示权限弹窗失败: errorClass=" + errorClass(e), e);
            this.context.getSession().handlePermissionDecision(
                channelId, false, false, "Failed to show permission dialog");
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
            LOG.info("[PERM_DECISION] pendingPermissionRequests size before remove: "
                    + userInteractionService.count(UserInteractionType.PERMISSION));

            boolean handled = userInteractionService.answer(
                    UserInteractionType.PERMISSION, channelId, decision);

            if (handled) {
                LOG.info("[PERM_DECISION] Completed pending interaction for channelId=" + channelId);
            } else {
                LOG.warn("[PERM_DECISION] No pending future found for channelId=" + channelId + ", falling back to session handler");
                // Handle permission request from Session
                if (remember) {
                    context.getSession().handlePermissionDecisionAlways(channelId, allow);
                } else {
                    context.getSession().handlePermissionDecision(channelId, allow, false, rejectMessage);
                }
            }

            if (!allow) {
                notifyPermissionDenied();
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
     * Clear all pending permission requests.
     * Called during session switching or history restoration to prevent old requests from interfering with the new session.
     */
    public void clearPendingRequests() {
        LOG.info("[PERM_CLEAR] Clearing all pending permission requests");

        int permissionCount = userInteractionService.count(UserInteractionType.PERMISSION);
        int askUserCount = userInteractionService.count(UserInteractionType.ASK_USER_QUESTION);
        int planCount = userInteractionService.count(UserInteractionType.PLAN_APPROVAL);

        // Resolve every in-flight interaction per its session-change policy. Deny-policy
        // interactions (file-watcher permission / ask / plan) are resolved and dropped;
        // session-callback permissions are kept by policy, so they may remain registered.
        userInteractionService.cancelAllSessionChanged();

        LOG.info("[PERM_CLEAR] Session change processed (pending before: " + permissionCount
                + " permission, " + askUserCount + " askUser, " + planCount + " plan); "
                + userInteractionService.count(UserInteractionType.PERMISSION) + " permission kept by policy");
    }

    /**
     * Show AskUserQuestion dialog (implements PermissionService.AskUserQuestionDialogShower interface).
     */
    public CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questionsData) {
        CompletableFuture<JsonObject> future =
                userInteractionService.requestAskUserQuestion(requestId, questionsData);

        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] Starting showAskUserQuestionDialog");
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] questionCount="
                + (questionsData.has("questions") && questionsData.get("questions").isJsonArray()
                    ? questionsData.getAsJsonArray("questions").size()
                    : 0));

        scheduleSafetyNet(future, () -> {
            if (userInteractionService.timeout(UserInteractionType.ASK_USER_QUESTION, requestId)) {
                LOG.warn("[ASK_USER_QUESTION][SHOW_DIALOG] Safety-net timeout fired (webview unreachable) for requestId=" + requestId);
            }
        });

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

            boolean handled = userInteractionService.answer(
                    UserInteractionType.ASK_USER_QUESTION, requestId, response);

            if (handled) {
                LOG.debug("[ASK_USER_QUESTION][HANDLE_RESPONSE] Completed pending interaction for requestId=" + requestId);
            } else {
                LOG.warn("[ASK_USER_QUESTION][HANDLE_RESPONSE] No pending request found for requestId: " + requestId);
            }
        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][HANDLE_RESPONSE] ERROR: errorClass=" + errorClass(e), e);
        }
    }

    /**
     * Show PlanApproval dialog (implements PermissionService.PlanApprovalDialogShower interface).
     */
    public CompletableFuture<JsonObject> showPlanApprovalDialog(String requestId, JsonObject planData) {
        CompletableFuture<JsonObject> future =
                userInteractionService.requestPlanApproval(requestId, planData);

        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] Starting showPlanApprovalDialog");
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] fieldCount=" + planData.size());

        scheduleSafetyNet(future, () -> {
            if (userInteractionService.timeout(UserInteractionType.PLAN_APPROVAL, requestId)) {
                LOG.warn("[PLAN_APPROVAL][SHOW_DIALOG] Safety-net timeout fired (webview unreachable) for requestId=" + requestId);
            }
        });

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

            boolean handled = userInteractionService.answer(
                    UserInteractionType.PLAN_APPROVAL, requestId, response);

            if (handled) {
                LOG.debug("[PLAN_APPROVAL][HANDLE_RESPONSE] Completed pending interaction for requestId=" + requestId);
            } else {
                LOG.warn("[PLAN_APPROVAL][HANDLE_RESPONSE] No pending request found for requestId: " + requestId);
            }
        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][HANDLE_RESPONSE] ERROR: errorClass=" + errorClass(e), e);
        }
    }
}
