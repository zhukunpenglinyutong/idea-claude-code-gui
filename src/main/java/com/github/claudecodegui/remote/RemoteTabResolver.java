package com.github.claudecodegui.remote;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Computable;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;

import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Resolves a {@code tabId} to its live {@link ClaudeChatWindow}/{@link ClaudeSession}
 * on the EDT, bounded by a timeout.
 *
 * <p>Resolution walks {@link ClaudeSDKToolWindow#getAllChatWindowsForProject} and
 * matches {@link RemoteTabRegistry#tabIdFor(ClaudeChatWindow)} against the request
 * tabId — never the selected tab, never an index. The non-volatile
 * {@code busy}/{@code loading} fields on {@link SessionState} are documented as
 * EDT/single-thread access, so the busy read happens here on the EDT alongside
 * the resolution.
 *
 * <p>The EDT work is bounded by {@link #EDT_TIMEOUT_SECONDS}; on timeout the
 * caller returns 500 and no reservation is made.
 */
final class RemoteTabResolver {

    private static final Logger LOG = Logger.getInstance(RemoteTabResolver.class);

    private static final long EDT_TIMEOUT_SECONDS = 5;

    private RemoteTabResolver() {
    }

    enum Status { FOUND, NOT_FOUND, TIMEOUT }

    static final class ResolveResult {
        final Status status;
        final ClaudeChatWindow window;
        final ClaudeSession session;
        final String sessionId;
        final boolean busy;

        private ResolveResult(Status status, ClaudeChatWindow window,
                              ClaudeSession session, String sessionId, boolean busy) {
            this.status = status;
            this.window = window;
            this.session = session;
            this.sessionId = sessionId;
            this.busy = busy;
        }

        static ResolveResult notFound() {
            return new ResolveResult(Status.NOT_FOUND, null, null, null, false);
        }

        static ResolveResult timeout() {
            return new ResolveResult(Status.TIMEOUT, null, null, null, false);
        }

        static ResolveResult found(ClaudeChatWindow window, ClaudeSession session,
                                   String sessionId, boolean busy) {
            return new ResolveResult(Status.FOUND, window, session, sessionId, busy);
        }
    }

    /**
     * Resolve the live window for {@code tabId} within {@code project}.
     *
     * @return a result; status is {@link Status#TIMEOUT} if the EDT read did not
     *         complete in time, {@link Status#NOT_FOUND} if no live window matches
     */
    static ResolveResult resolve(Project project, String tabId) {
        if (project == null || project.isDisposed() || tabId == null || tabId.isEmpty()) {
            return ResolveResult.notFound();
        }

        if (ApplicationManager.getApplication().isDispatchThread()) {
            return resolveOnEdt(project, tabId);
        }

        CompletableFuture<ResolveResult> future = new CompletableFuture<>();
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                future.complete(resolveOnEdt(project, tabId));
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
        });
        try {
            return future.get(EDT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            LOG.warn("[RemoteGateway] EDT tab resolution timed out after " + EDT_TIMEOUT_SECONDS + "s");
            return ResolveResult.timeout();
        } catch (Throwable t) {
            LOG.warn("[RemoteGateway] EDT tab resolution failed: " + t.getMessage(), t);
            return ResolveResult.timeout();
        }
    }

    private static ResolveResult resolveOnEdt(Project project, String tabId) {
        return ApplicationManager.getApplication().runReadAction(
                (Computable<ResolveResult>) () -> doResolve(project, tabId));
    }

    private static ResolveResult doResolve(Project project, String tabId) {
        Set<ClaudeChatWindow> windows;
        try {
            windows = ClaudeSDKToolWindow.getAllChatWindowsForProject(project);
        } catch (Throwable t) {
            LOG.warn("[RemoteGateway] Failed to enumerate chat windows: " + t.getMessage());
            return ResolveResult.notFound();
        }
        if (windows == null || windows.isEmpty()) {
            return ResolveResult.notFound();
        }

        RemoteTabRegistry registry = RemoteTabRegistry.getInstance();
        for (ClaudeChatWindow window : windows) {
            if (window == null || window.isDisposed()) {
                continue;
            }
            String candidate;
            try {
                candidate = registry.tabIdFor(window);
            } catch (Throwable t) {
                continue;
            }
            if (!tabId.equals(candidate)) {
                continue;
            }

            try {
                Content content = window.getParentContent();
                if (content != null) {
                    ContentManager cm = content.getManager();
                    if (cm != null && cm.getIndexOfContent(content) < 0) {
                        // Mirror RemoteTabCollector: a closed tab (content
                        // detached from its manager) must not resolve, so the
                        // binding re-verify and the send path agree (E2E-P2-010).
                        return ResolveResult.notFound();
                    }
                }
                ClaudeSession session = window.getSession();
                if (session == null) {
                    return ResolveResult.notFound();
                }
                SessionState state = session.getState();
                String sessionId = null;
                boolean busy = false;
                if (state != null) {
                    sessionId = state.getSessionId();
                    busy = state.isBusy() || state.isLoading();
                }
                return ResolveResult.found(window, session, sessionId, busy);
            } catch (Throwable t) {
                LOG.warn("[RemoteGateway] Failed to read tab state: " + t.getMessage());
                return ResolveResult.notFound();
            }
        }
        return ResolveResult.notFound();
    }
}
