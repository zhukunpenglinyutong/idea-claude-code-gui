package com.github.claudecodegui.ui.detached;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Manager for tracking detached chat windows across all projects.
 * Uses project base path as key instead of Project instance to avoid memory leaks
 * when Project objects are not properly disposed.
 */
public class DetachedWindowManager {

    private static final Logger LOG = Logger.getInstance(DetachedWindowManager.class);

    /**
     * Map of projectKey (basePath) -> (SessionId -> DetachedChatFrame)
     */
    private static final Map<String, Map<String, DetachedChatFrame>> detachedWindows =
            new ConcurrentHashMap<>();
    private static final AtomicLong PENDING_WINDOW_IDS = new AtomicLong();

    private static String projectKey(@NotNull Project project) {
        String basePath = project.getBasePath();
        return basePath != null ? basePath : project.getName();
    }

    /**
     * Register a detached window for tracking.
     *
     * @param project   The project
     * @param sessionId The session ID of the chat window
     * @param frame     The detached frame
     */
    public static void registerDetached(@NotNull Project project,
                                        @Nullable String sessionId,
                                        @NotNull DetachedChatFrame frame) {
        String key = projectKey(project);
        String windowKey = sessionId == null || sessionId.isBlank()
                ? "pending-" + PENDING_WINDOW_IDS.incrementAndGet() : sessionId;
        detachedWindows
                .computeIfAbsent(key, k -> new ConcurrentHashMap<>())
                .put(windowKey, frame);

        LOG.info(String.format("[DetachedWindowManager] Registered detached window: project=%s, sessionId=%s, name=%s",
                project.getName(), windowKey, frame.getOriginalTabName()));
    }

    /**
     * Unregister a detached window.
     *
     * @param project   The project
     * @param sessionId The session ID
     */
    public static void unregisterDetached(@NotNull Project project, @NotNull String sessionId) {
        String key = projectKey(project);
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(key);
        if (projectWindows != null) {
            DetachedChatFrame removed = projectWindows.remove(sessionId);
            if (removed != null) {
                LOG.info(String.format("[DetachedWindowManager] Unregistered detached window: project=%s, sessionId=%s, name=%s",
                        project.getName(), sessionId, removed.getOriginalTabName()));
            }

            // Clean up empty project map
            if (projectWindows.isEmpty()) {
                detachedWindows.remove(key);
            }
        }
    }

    public static void unregisterDetached(@NotNull Project project, @NotNull DetachedChatFrame frame) {
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(projectKey(project));
        if (projectWindows == null) {
            return;
        }
        for (Map.Entry<String, DetachedChatFrame> entry : projectWindows.entrySet()) {
            projectWindows.remove(entry.getKey(), frame);
        }
        if (projectWindows.isEmpty()) {
            detachedWindows.remove(projectKey(project), projectWindows);
        }
    }

    /**
     * Check if a session is currently detached.
     *
     * @param project   The project
     * @param sessionId The session ID
     * @return true if detached, false otherwise
     */
    public static boolean isDetached(@NotNull Project project, @NotNull String sessionId) {
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(projectKey(project));
        return projectWindows != null && projectWindows.containsKey(sessionId);
    }

    /**
     * Get a detached frame by session ID.
     *
     * @param project   The project
     * @param sessionId The session ID
     * @return The detached frame, or null if not found
     */
    @Nullable
    public static DetachedChatFrame getDetachedFrame(@NotNull Project project, @NotNull String sessionId) {
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(projectKey(project));
        return projectWindows != null ? projectWindows.get(sessionId) : null;
    }

    @Nullable
    public static DetachedChatFrame getDetachedFrame(
            @NotNull Project project,
            @NotNull ClaudeChatWindow chatWindow) {
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(projectKey(project));
        if (projectWindows == null) {
            return null;
        }
        for (DetachedChatFrame frame : projectWindows.values()) {
            if (frame.getChatWindow() == chatWindow) {
                return frame;
            }
        }
        return null;
    }

    /**
     * Get the number of detached windows for a project.
     *
     * @param project The project
     * @return The number of detached windows
     */
    public static int getDetachedWindowCount(@NotNull Project project) {
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(projectKey(project));
        return projectWindows != null ? projectWindows.size() : 0;
    }

    /**
     * Dispose all detached windows for a project.
     * This should be called when a project is closing.
     *
     * @param project The project
     */
    public static void disposeAllDetached(@NotNull Project project) {
        String key = projectKey(project);
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.remove(key);
        if (projectWindows != null && !projectWindows.isEmpty()) {
            LOG.info(String.format("[DetachedWindowManager] Disposing %d detached windows for project: %s",
                    projectWindows.size(), project.getName()));

            for (Map.Entry<String, DetachedChatFrame> entry : projectWindows.entrySet()) {
                try {
                    DetachedChatFrame frame = entry.getValue();
                    LOG.info(String.format("[DetachedWindowManager] Disposing detached window: sessionId=%s, name=%s",
                            entry.getKey(), frame.getOriginalTabName()));

                    // Dispose the chat window resources (Node.js processes, browser, session, etc.)
                    ClaudeChatWindow chatWindow = frame.getChatWindow();
                    if (chatWindow != null && !chatWindow.isDisposed()) {
                        chatWindow.dispose();
                    }

                    // Dispose the JFrame
                    frame.dispose();
                } catch (Exception e) {
                    LOG.error("[DetachedWindowManager] Error disposing detached window: " + entry.getKey(), e);
                }
            }

            projectWindows.clear();
        }
    }

    /**
     * Get all detached windows for a project.
     *
     * @param project The project
     * @return Map of SessionId -> DetachedChatFrame, or empty map if none
     */
    @NotNull
    public static Map<String, DetachedChatFrame> getDetachedWindows(@NotNull Project project) {
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(projectKey(project));
        return projectWindows != null ? new ConcurrentHashMap<>(projectWindows) : new ConcurrentHashMap<>();
    }

    /**
     * Collect all ClaudeChatWindow instances from detached windows for a project.
     *
     * @param project The project
     * @return a set of ClaudeChatWindow instances in detached windows for the project
     */
    @NotNull
    public static Set<ClaudeChatWindow> getAllDetachedChatWindows(@NotNull Project project) {
        Set<ClaudeChatWindow> windows = new HashSet<>();
        Map<String, DetachedChatFrame> projectWindows = detachedWindows.get(projectKey(project));
        if (projectWindows == null) {
            return windows;
        }
        for (DetachedChatFrame frame : projectWindows.values()) {
            ClaudeChatWindow chatWindow = frame.getChatWindow();
            if (chatWindow != null) {
                windows.add(chatWindow);
            }
        }
        return windows;
    }

    /**
     * Collect all ClaudeChatWindow instances from detached windows across all projects.
     * Used by the shutdown hook to ensure all Node.js processes are cleaned up.
     *
     * @return a set of all ClaudeChatWindow instances in detached windows
     */
    @NotNull
    public static Set<ClaudeChatWindow> getAllDetachedChatWindows() {
        Set<ClaudeChatWindow> windows = new HashSet<>();
        for (Map<String, DetachedChatFrame> projectWindows : detachedWindows.values()) {
            for (DetachedChatFrame frame : projectWindows.values()) {
                ClaudeChatWindow chatWindow = frame.getChatWindow();
                if (chatWindow != null) {
                    windows.add(chatWindow);
                }
            }
        }
        return windows;
    }

    /**
     * Dispose all detached windows across all projects.
     * This should be called when the plugin is unloading.
     */
    public static void disposeAll() {
        LOG.info("[DetachedWindowManager] Disposing all detached windows across all projects");

        // Take a snapshot of keys to avoid concurrent modification
        Set<String> keys = new HashSet<>(detachedWindows.keySet());
        for (String key : keys) {
            try {
                Map<String, DetachedChatFrame> projectWindows = detachedWindows.remove(key);
                if (projectWindows != null && !projectWindows.isEmpty()) {
                    for (Map.Entry<String, DetachedChatFrame> entry : projectWindows.entrySet()) {
                        try {
                            DetachedChatFrame frame = entry.getValue();
                            ClaudeChatWindow chatWindow = frame.getChatWindow();
                            if (chatWindow != null && !chatWindow.isDisposed()) {
                                chatWindow.dispose();
                            }
                            frame.dispose();
                        } catch (Exception e) {
                            LOG.error("[DetachedWindowManager] Error disposing detached window: " + entry.getKey(), e);
                        }
                    }
                    projectWindows.clear();
                }
            } catch (Exception e) {
                LOG.error("[DetachedWindowManager] Error disposing detached windows for key: " + key, e);
            }
        }
    }
}
