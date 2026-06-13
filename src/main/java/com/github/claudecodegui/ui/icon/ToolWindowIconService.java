package com.github.claudecodegui.ui.icon;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.IconLoader;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

import javax.swing.Icon;

/**
 * Apply the user-selected tool window icon without coupling settings UI code to the tool window factory.
 */
public final class ToolWindowIconService {

    private static final Logger LOG = Logger.getInstance(ToolWindowIconService.class);
    private static final String DEFAULT_ICON_PATH = "/icons/cc-gui-icon.svg";
    private static final String CODRIVER_ICON_PATH = "/icons/codriver-tool-icon.svg";

    private ToolWindowIconService() {
    }

    /**
     * Apply the persisted icon preference to the already-created tool window descriptor.
     */
    public static void applyConfiguredIcon(@NotNull ToolWindow toolWindow,
                                           @NotNull CodemossSettingsService settingsService) {
        applyIcon(toolWindow, readCoDriverIconPreference(settingsService));
    }

    /**
     * Apply the persisted icon preference to the project's active tool window instance.
     */
    public static void applyConfiguredIcon(@NotNull Project project,
                                           @NotNull CodemossSettingsService settingsService) {
        applyIcon(project, readCoDriverIconPreference(settingsService));
    }

    /**
     * Apply the requested icon to the project's active tool window instance.
     */
    public static void applyIcon(@NotNull Project project, boolean coDriverIconEnabled) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }

            ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                    .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
            if (toolWindow != null) {
                applyIcon(toolWindow, coDriverIconEnabled);
            }
        });
    }

    /**
     * Apply the requested icon to a concrete tool window.
     */
    public static void applyIcon(@NotNull ToolWindow toolWindow, boolean coDriverIconEnabled) {
        toolWindow.setIcon(loadIcon(coDriverIconEnabled));
    }

    private static boolean readCoDriverIconPreference(@NotNull CodemossSettingsService settingsService) {
        try {
            return settingsService.getCoDriverToolIconEnabled();
        } catch (Exception e) {
            LOG.warn("[ToolWindowIconService] Failed to read CoDriver tool icon preference; using CoDriver icon", e);
            return true;
        }
    }

    private static Icon loadIcon(boolean coDriverIconEnabled) {
        String path = coDriverIconEnabled ? CODRIVER_ICON_PATH : DEFAULT_ICON_PATH;
        return IconLoader.getIcon(path, ToolWindowIconService.class);
    }
}
