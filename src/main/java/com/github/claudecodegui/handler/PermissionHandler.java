package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.interaction.PendingAskUserQuestionInteraction;
import com.github.claudecodegui.interaction.PendingPermissionInteraction;
import com.github.claudecodegui.interaction.PendingPlanApprovalInteraction;
import com.github.claudecodegui.interaction.PendingUserInteractions;
import com.github.claudecodegui.interaction.UserInteractionType;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.settings.CodemossSettingsService;
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

    // Registry of all in-flight user interactions (permission / askUserQuestion / planApproval).
    private final PendingUserInteractions pendingInteractions = new PendingUserInteractions();

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
        PendingPermissionInteraction interaction = new PendingPermissionInteraction(channelId);
        CompletableFuture<Integer> future = interaction.future();

        LOG.info("[PERM_SHOW] showFrontendPermissionDialog called: channelId=" + channelId + ", toolName=" + toolName);

        pendingInteractions.register(interaction);
        LOG.info("[PERM_SHOW] Stored pending request, total pending: "
                + pendingInteractions.count(UserInteractionType.PERMISSION));

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
                if (future.complete(PermissionService.PermissionResponse.DENY.getValue())) {
                    LOG.warn("[PERM_SHOW] Safety-net timeout fired (webview unreachable) for channelId=" + channelId);
                    pendingInteractions.removePermission(channelId);
                }
            });

        } catch (Exception e) {
            LOG.error("[PERM_SHOW] ERROR: errorClass=" + errorClass(e), e);
            pendingInteractions.removePermission(channelId);
            future.complete(PermissionService.PermissionResponse.DENY.getValue());
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
            LOG.info("[PERM_DECISION] pendingPermissionRequests size before remove: "
                    + pendingInteractions.count(UserInteractionType.PERMISSION));

            PendingPermissionInteraction pendingInteraction = pendingInteractions.removePermission(channelId);

            if (pendingInteraction != null) {
                LOG.info("[PERM_DECISION] Found pending future, completing with allow=" + allow);
                int responseValue;
                if (allow) {
                    responseValue = remember ?
                        PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue() :
                        PermissionService.PermissionResponse.ALLOW.getValue();
                } else {
                    responseValue = PermissionService.PermissionResponse.DENY.getValue();
                }
                pendingInteraction.complete(responseValue);
                LOG.info("[PERM_DECISION] Future completed with value=" + responseValue);

                if (!allow) {
                    notifyPermissionDenied();
                }
            } else {
                LOG.warn("[PERM_DECISION] No pending future found for channelId=" + channelId + ", falling back to session handler");
                // Handle permission request from Session
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
     * Clear all pending permission requests.
     * Called during session switching or history restoration to prevent old requests from interfering with the new session.
     */
    public void clearPendingRequests() {
        LOG.info("[PERM_CLEAR] Clearing all pending permission requests");

        int permissionCount = pendingInteractions.count(UserInteractionType.PERMISSION);
        int askUserCount = pendingInteractions.count(UserInteractionType.ASK_USER_QUESTION);
        int planCount = pendingInteractions.count(UserInteractionType.PLAN_APPROVAL);

        // Resolve every in-flight interaction with its session-changed payload and drain the registry.
        pendingInteractions.cancelAllSessionChanged();

        LOG.info("[PERM_CLEAR] Cleared: " + permissionCount + " permission, " +
                 askUserCount + " askUser, " + planCount + " plan requests");
    }

    /**
     * Show AskUserQuestion dialog (implements PermissionService.AskUserQuestionDialogShower interface).
     */
    public CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questionsData) {
        PendingAskUserQuestionInteraction interaction = new PendingAskUserQuestionInteraction(requestId);
        CompletableFuture<JsonObject> future = interaction.future();

        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] Starting showAskUserQuestionDialog");
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] questionCount="
                + (questionsData.has("questions") && questionsData.get("questions").isJsonArray()
                    ? questionsData.getAsJsonArray("questions").size()
                    : 0));

        pendingInteractions.register(interaction);

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
                if (future.complete(new JsonObject())) {
                    LOG.warn("[ASK_USER_QUESTION][SHOW_DIALOG] Safety-net timeout fired (webview unreachable) for requestId=" + requestId);
                    pendingInteractions.removeAskUserQuestion(requestId);
                }
            });

        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][SHOW_DIALOG] ERROR: errorClass=" + errorClass(e), e);
            pendingInteractions.removeAskUserQuestion(requestId);
            future.complete(new JsonObject());
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

            PendingAskUserQuestionInteraction pendingInteraction =
                    pendingInteractions.removeAskUserQuestion(requestId);

            if (pendingInteraction != null) {
                LOG.debug("[ASK_USER_QUESTION][HANDLE_RESPONSE] Completing future with answerCount=" + answers.size());
                pendingInteraction.complete(answers);
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
        PendingPlanApprovalInteraction interaction = new PendingPlanApprovalInteraction(requestId);
        CompletableFuture<JsonObject> future = interaction.future();

        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] Starting showPlanApprovalDialog");
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] fieldCount=" + planData.size());

        pendingInteractions.register(interaction);

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
                JsonObject timeoutResponse = new JsonObject();
                timeoutResponse.addProperty("approved", false);
                timeoutResponse.addProperty("targetMode", "default");
                timeoutResponse.addProperty("message", "Plan approval timed out");
                if (future.complete(timeoutResponse)) {
                    LOG.warn("[PLAN_APPROVAL][SHOW_DIALOG] Safety-net timeout fired (webview unreachable) for requestId=" + requestId);
                    pendingInteractions.removePlanApproval(requestId);
                }
            });

        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][SHOW_DIALOG] ERROR: errorClass=" + errorClass(e), e);
            pendingInteractions.removePlanApproval(requestId);
            JsonObject errorResponse = new JsonObject();
            errorResponse.addProperty("approved", false);
            errorResponse.addProperty("targetMode", "default");
            errorResponse.addProperty("message", "Error showing plan approval dialog");
            future.complete(errorResponse);
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

            PendingPlanApprovalInteraction pendingInteraction =
                    pendingInteractions.removePlanApproval(requestId);

            if (pendingInteraction != null) {
                JsonObject result = new JsonObject();
                result.addProperty("approved", approved);
                result.addProperty("targetMode", targetMode);
                LOG.debug("[PLAN_APPROVAL][HANDLE_RESPONSE] Completing future: approved=" + approved + ", targetMode=" + targetMode);
                pendingInteraction.complete(result);
            } else {
                LOG.warn("[PLAN_APPROVAL][HANDLE_RESPONSE] No pending request found for requestId: " + requestId);
            }
        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][HANDLE_RESPONSE] ERROR: errorClass=" + errorClass(e), e);
        }
    }
}
