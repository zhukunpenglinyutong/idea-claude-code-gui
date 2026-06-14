package com.github.claudecodegui.ui.icon;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

/**
 * Applies the effective plugin icon to the CC GUI tool window. The icon decision lives in
 * {@link PluginIconProvider} (CoDriver icon only when the CoDriver theme is active and the
 * toggle is on); this service just pushes it onto the tool window.
 */
public final class ToolWindowIconService {

    private static final Logger LOG = Logger.getInstance(ToolWindowIconService.class);

    private ToolWindowIconService() {
    }

    /**
     * Prime the icon caches from persisted settings and apply the effective icon to the
     * already-created tool window descriptor (called at tool window creation).
     */
    public static void applyConfiguredIcon(@NotNull ToolWindow toolWindow,
                                           @NotNull CodemossSettingsService settingsService) {
        primeCaches(settingsService);
        applyCurrentIcon(toolWindow);
    }

    /** Apply the current effective plugin icon to a concrete tool window. */
    public static void applyCurrentIcon(@NotNull ToolWindow toolWindow) {
        toolWindow.setIcon(PluginIconProvider.getCurrentPluginIcon());
    }

    /** Apply the current effective plugin icon to the project's active tool window instance. */
    public static void applyCurrentIcon(@NotNull Project project) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }
            ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                    .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
            if (toolWindow != null) {
                applyCurrentIcon(toolWindow);
            }
        });
    }

    private static void primeCaches(@NotNull CodemossSettingsService settingsService) {
        try {
            PluginIconProvider.setCoDriverIconEnabledCache(settingsService.getCoDriverToolIconEnabled());
        } catch (Exception e) {
            LOG.warn("[ToolWindowIconService] Failed to read CoDriver tool icon preference", e);
        }
        try {
            PluginIconProvider.setCoDriverThemeActiveCache(settingsService.getCoDriverThemeActive());
        } catch (Exception e) {
            LOG.warn("[ToolWindowIconService] Failed to read CoDriver theme active flag", e);
        }
    }
}
