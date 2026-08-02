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

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Collects an immutable snapshot of every live CC GUI tab for a project.
 *
 * <p>Tab UI state ({@link ContentManager#getSelectedContent()},
 * {@link ContentManager#getIndexOfContent(com.intellij.ui.content.Content)}) and
 * the non-volatile {@code busy}/{@code loading} fields on {@link SessionState}
 * are documented as EDT/single-thread access. This collector therefore runs the
 * snapshot read on the EDT and hands the resulting immutable list back to the
 * HTTP worker for JSON serialization. Network IO never runs on the EDT.
 *
 * <p>The EDT read is bounded by {@link #EDT_TIMEOUT_SECONDS}; if the EDT is
 * busy (e.g. a modal dialog is open) the handler returns an empty list rather
 * than hanging the HTTP client or freezing the IDE.
 *
 * <p>Reading the static maps in {@link ClaudeSDKToolWindow} does NOT force the
 * ToolWindow to be created; if the user has not opened CC GUI, the result is
 * simply an empty tab list.
 */
final class RemoteTabCollector {

    private static final Logger LOG = Logger.getInstance(RemoteTabCollector.class);

    private static final long EDT_TIMEOUT_SECONDS = 5;

    private RemoteTabCollector() {
    }

    /**
     * @return immutable snapshots of all live tabs for the project; empty if
     *         the EDT read times out or no tabs exist
     */
    static List<RemoteTabSnapshot> collect(Project project) {
        if (project == null || project.isDisposed()) {
            return new ArrayList<>();
        }

        List<RemoteTabSnapshot> snapshots;
        if (ApplicationManager.getApplication().isDispatchThread()) {
            snapshots = collectOnEdt(project);
        } else {
            CompletableFuture<List<RemoteTabSnapshot>> future = new CompletableFuture<>();
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    future.complete(collectOnEdt(project));
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            });
            try {
                snapshots = future.get(EDT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            } catch (TimeoutException e) {
                LOG.warn("[RemoteGateway] EDT tab snapshot timed out after " + EDT_TIMEOUT_SECONDS + "s; returning empty list");
                snapshots = new ArrayList<>();
            } catch (Throwable t) {
                LOG.warn("[RemoteGateway] EDT tab snapshot failed: " + t.getMessage(), t);
                snapshots = new ArrayList<>();
            }
        }
        return snapshots;
    }

    private static List<RemoteTabSnapshot> collectOnEdt(Project project) {
        // Read action keeps the project's PSI/VFS consistent while we touch
        // session state; it is cheap and avoids read-lock asserts.
        return ApplicationManager.getApplication().runReadAction(
                (Computable<List<RemoteTabSnapshot>>) () -> doCollect(project));
    }

    private static List<RemoteTabSnapshot> doCollect(Project project) {
        List<RemoteTabSnapshot> out = new ArrayList<>();
        Set<ClaudeChatWindow> windows;
        try {
            windows = ClaudeSDKToolWindow.getAllChatWindowsForProject(project);
        } catch (Throwable t) {
            LOG.warn("[RemoteGateway] Failed to enumerate chat windows: " + t.getMessage());
            return out;
        }
        if (windows == null || windows.isEmpty()) {
            return out;
        }

        RemoteTabRegistry registry = RemoteTabRegistry.getInstance();
        for (ClaudeChatWindow window : windows) {
            RemoteTabSnapshot snapshot = snapshotWindow(window, registry);
            if (snapshot != null) {
                out.add(snapshot);
            }
        }
        // Stable order by tab index so the list is deterministic for clients.
        out.sort((a, b) -> Integer.compare(a.getIndex(), b.getIndex()));
        return out;
    }

    private static RemoteTabSnapshot snapshotWindow(ClaudeChatWindow window, RemoteTabRegistry registry) {
        if (window == null || window.isDisposed()) {
            return null;
        }
        try {
            String tabId = registry.tabIdFor(window);
            if (tabId == null) {
                return null;
            }

            // selected/index come from the ContentManager (UI state). Detached
            // windows have no parentContent -> index=-1, selected=false.
            int index = -1;
            boolean selected = false;
            Content content = window.getParentContent();
            if (content != null) {
                ContentManager cm = content.getManager();
                if (cm != null) {
                    if (cm.getIndexOfContent(content) < 0) {
                        // The tab's content was removed from its manager: the
                        // tab is closed, so it is not a live target. Detached
                        // windows keep parentContent == null and remain live.
                        return null;
                    }
                    index = cm.getIndexOfContent(content);
                    selected = cm.getSelectedContent() == content;
                }
            }

            String sessionId = null;
            String provider = null;
            String model = null;
            String cwd = null;
            boolean busy = false;
            ClaudeSession session = window.getSession();
            if (session == null) {
                // Mirror RemoteTabResolver: a window whose session is gone (e.g.
                // its tab was closed) is not a live target. Without this the
                // binding re-verify reports the target as existing while sends
                // fail, leaving the UI stuck on BOUND_OTHER_TAB (E2E-P2-010).
                return null;
            }
            if (session != null) {
                SessionState state = session.getState();
                if (state != null) {
                    sessionId = state.getSessionId();
                    provider = state.getProvider();
                    model = state.getModel();
                    cwd = state.getCwd();
                    busy = state.isBusy();
                }
            }

            return new RemoteTabSnapshot(tabId, index, selected, sessionId, provider, model, cwd, busy);
        } catch (Throwable t) {
            // One failing window must not break the whole listing.
            LOG.warn("[RemoteGateway] Failed to snapshot tab: " + t.getMessage());
            return null;
        }
    }
}
