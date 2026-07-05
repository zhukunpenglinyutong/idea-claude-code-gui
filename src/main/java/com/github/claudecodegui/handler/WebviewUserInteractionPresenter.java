package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.interaction.PendingUserInteraction;
import com.github.claudecodegui.interaction.UserInteractionListener;
import com.github.claudecodegui.interaction.UserInteractionService;
import com.github.claudecodegui.interaction.UserInteractionType;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.Set;

/**
 * Shows a requested {@link PendingUserInteraction} in the webview.
 *
 * <p>Registered as a {@link UserInteractionListener} on the {@link UserInteractionService}, this is
 * the consumer of the {@code userInteractionRequested} seam: it owns the {@code window.show*} JS so
 * {@code PermissionHandler} no longer builds it. Interactions without a target project go to the
 * current window with a retry wrapper (the frontend bridge may not be ready yet); the
 * session-callback permission carries a project and goes to that project's window directly.
 *
 * <p>Any failure to present resolves the interaction via {@link UserInteractionService#dialogFailed}
 * (which routes through the interaction's own deny payload), so the issuing agent never hangs.
 */
public final class WebviewUserInteractionPresenter implements UserInteractionListener {

    private static final Logger LOG = Logger.getInstance(WebviewUserInteractionPresenter.class);
    private static final Gson GSON = new Gson();

    private final HandlerContext context;
    private final UserInteractionService service;

    public WebviewUserInteractionPresenter(HandlerContext context, UserInteractionService service) {
        this.context = context;
        this.service = service;
    }

    @Override
    public void userInteractionRequested(PendingUserInteraction interaction) {
        try {
            String escapedJson = context.escapeJs(GSON.toJson(interaction.toFrontendPayload()));
            String functionName = interaction.frontendFunctionName();
            Project project = interaction.targetProject();

            if (project == null) {
                // Current window: the frontend function may not be registered yet, so retry.
                context.executeJavaScriptOnEDT(retryScript(functionName, escapedJson));
                return;
            }

            ClaudeChatWindow window = ClaudeSDKToolWindow.getChatWindow(project);
            if (window == null) {
                LOG.warn("[Presenter] No chat window for project " + project.getName()
                        + "; failing " + interaction.type() + " " + interaction.id());
                service.dialogFailed(interaction.type(), interaction.id());
                return;
            }
            window.executeJavaScriptCode(simpleScript(functionName, escapedJson));

        } catch (Exception e) {
            LOG.warn("[Presenter] Failed to present " + interaction.type() + " " + interaction.id()
                    + ": " + e.getClass().getSimpleName(), e);
            service.dialogFailed(interaction.type(), interaction.id());
        }
    }

    /**
     * A single interaction timed out: force-close its still-open webview dialog by id so the React
     * dialog queue can drain (issue #1360).
     */
    @Override
    public void userInteractionTimedOut(PendingUserInteraction interaction) {
        forceClose(interaction.type(), interaction.id());
    }

    /**
     * Session change drained some interaction types: force-close all open webview dialogs of those
     * types (empty id = "close every dialog of this kind", matching v0.4.7).
     */
    @Override
    public void userInteractionsClearedBySessionChange(Set<UserInteractionType> drainedTypes) {
        for (UserInteractionType type : drainedTypes) {
            forceClose(type, "");
        }
    }

    private void forceClose(UserInteractionType type, String targetId) {
        String functionName = forceCloseFunctionName(type);
        if (functionName == null) {
            return;
        }
        // Mirrors v0.4.7's forceCloseFrontendDialog: no-op in the webview if the function is absent.
        context.executeJavaScriptOnEDT("if (typeof window." + functionName + " === 'function') { "
                + "window." + functionName + "('" + context.escapeJs(targetId) + "'); }");
    }

    private static String forceCloseFunctionName(UserInteractionType type) {
        switch (type) {
            case PERMISSION:
                return "forceClosePermissionDialog";
            case ASK_USER_QUESTION:
                return "forceCloseAskUserQuestionDialog";
            case PLAN_APPROVAL:
                return "forceClosePlanApprovalDialog";
            default:
                return null;
        }
    }

    private static String retryScript(String functionName, String escapedJson) {
        return "(function retryShowDialog(retries) { "
                + "  if (window." + functionName + ") { "
                + "    window." + functionName + "('" + escapedJson + "'); "
                + "  } else if (retries > 0) { "
                + "    setTimeout(function() { retryShowDialog(retries - 1); }, 200); "
                + "  } else { "
                + "    console.error('[JS] FAILED: " + functionName + " not available!'); "
                + "  } "
                + "})(30);";
    }

    private static String simpleScript(String functionName, String escapedJson) {
        return "if (window." + functionName + ") { window." + functionName + "('" + escapedJson + "'); }";
    }
}
