package com.github.claudecodegui.notifications;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.CustomStatusBarWidget;
import com.intellij.openapi.wm.StatusBar;
import com.intellij.openapi.wm.StatusBarWidget;
import com.intellij.openapi.wm.StatusBarWidgetFactory;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.openapi.wm.WindowManager;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import com.intellij.openapi.application.ApplicationManager;

import javax.swing.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Minimalist StatusBar widget for Claude AI
 */
public class ClaudeStatusBarWidget implements CustomStatusBarWidget, StatusBarWidget, Disposable {
    private final Project project;
    private StatusBar statusBar;
    private JLabel label;
    private final AtomicReference<String> textRef = new AtomicReference<>("GUI 🤖");
    private final AtomicReference<String> tooltipRef = new AtomicReference<>(ClaudeCodeGuiBundle.message("status.defaultTooltip"));
    private final AtomicLong visibleUntil = new AtomicLong(0);

    // Thread-safe state for display
    private final AtomicReference<String> currentStatus = new AtomicReference<>("ready");
    private final AtomicReference<String> currentTokenInfo = new AtomicReference<>("");
    private final AtomicReference<String> currentModel = new AtomicReference<>("");
    private final AtomicReference<String> currentMode = new AtomicReference<>("default");
    private final AtomicReference<String> currentAgent = new AtomicReference<>("");

    // Timer management for proper resource cleanup
    private Timer hideTimer;

    // Track disposed state to prevent operations after disposal
    private volatile boolean disposed = false;

    public ClaudeStatusBarWidget(Project project) {
        this.project = project;
    }

    @Override
    public @NotNull String ID() {
        return "ClaudeStatusBarWidget";
    }

    @Override
    public @NotNull WidgetPresentation getPresentation() {
        return new WidgetPresentation() {
            @Nullable
            @Override
            public String getTooltipText() {
                return tooltipRef.get();
            }

            @Nullable
            @Override
            public com.intellij.util.Consumer<MouseEvent> getClickConsumer() {
                return null;
            }
        };
    }

    @Override
    public @NotNull JComponent getComponent() {
        if (label == null) {
            label = new JLabel(textRef.get());
            label.setBorder(BorderFactory.createEmptyBorder(0, 4, 0, 4));
            label.setToolTipText(tooltipRef.get());
            label.addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    if (project.isDisposed()) { return; }
                    var toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                    if (toolWindow != null) {
                        toolWindow.activate(null);
                    }
                }
            });
        }
        return label;
    }

    @Override
    public void install(@NotNull StatusBar statusBar) {
        this.statusBar = statusBar;
    }

    @Override
    public void dispose() {
        disposed = true;
        if (hideTimer != null) {
            hideTimer.stop();
            hideTimer = null;
        }
        this.statusBar = null;
    }

    public void updateStatus(String status, String details) {
        this.currentStatus.set(status);
        refreshDisplay(details);
    }

    public void setTokenInfo(String tokenInfo) {
        this.currentTokenInfo.set(tokenInfo);
        refreshDisplay(null);
    }

    public void setModel(String model) {
        this.currentModel.set(model);
        refreshDisplay(null);
    }

    public void setMode(String mode) {
        this.currentMode.set(mode);
        refreshDisplay(null);
    }

    public void setAgent(String agent) {
        this.currentAgent.set(agent);
        refreshDisplay(null);
    }

    private void refreshDisplay(String details) {
        String status = currentStatus.get();
        String model = currentModel.get();
        String mode = currentMode.get();
        String agent = currentAgent.get();
        String tokenInfo = currentTokenInfo.get();

        String icon = switch (status) {
            case "thinking" -> "💭";
            case "generating" -> "✏️";
            case "waiting" -> "⏳";
            case "success" -> "✓";
            case "error" -> "✗";
            default -> "🤖";
        };

        String statusText = "";
        if ("thinking".equals(status)) {
            statusText = ClaudeCodeGuiBundle.message("status.thinking");
        } else if ("generating".equals(status)) {
            statusText = ClaudeCodeGuiBundle.message("status.generating");
        } else if ("waiting".equals(status)) {
            statusText = ClaudeCodeGuiBundle.message("status.waiting");
        } else if ("error".equals(status)) {
            statusText = ClaudeCodeGuiBundle.message("status.error");
        }

        StringBuilder text = new StringBuilder("GUI " + icon);

        // Add Model Info (Shorten names)
        if (model != null && !model.isEmpty()) {
            String shortModel = model;
            if (model.contains("fable")) { shortModel = "Fable"; }
            else if (model.contains("sonnet")) { shortModel = "Sonnet"; }
            else if (model.contains("opus")) { shortModel = "Opus"; }
            else if (model.contains("haiku")) { shortModel = "Haiku"; }
            text.append(" [").append(shortModel).append("]");
        }

        // Add Mode Info
        if (mode != null && !"default".equals(mode)) {
            String modeLabel = switch (mode) {
                case "plan" -> ClaudeCodeGuiBundle.message("status.mode.plan");
                case "acceptEdits" -> ClaudeCodeGuiBundle.message("status.mode.acceptEdits");
                case "auto" -> ClaudeCodeGuiBundle.message("status.mode.auto");
                case "bypassPermissions" -> ClaudeCodeGuiBundle.message("status.mode.bypassPermissions");
                default -> mode;
            };
            text.append(" {").append(modeLabel).append("}");
        }

        if (!statusText.isEmpty()) {
            text.append(" ").append(statusText);
        }

        // Add Token Info
        if (tokenInfo != null && !tokenInfo.isEmpty()) {
            text.append(" ").append(tokenInfo);
        }

        StringBuilder tooltip = new StringBuilder(ClaudeCodeGuiBundle.message("status.tooltip.status", status));
        if (model != null && !model.isEmpty()) {
            tooltip.append(ClaudeCodeGuiBundle.message("status.tooltip.model", model));
        }
        if (mode != null) {
            tooltip.append(ClaudeCodeGuiBundle.message("status.tooltip.mode", mode));
        }
        if (agent != null && !agent.isEmpty()) {
            tooltip.append(ClaudeCodeGuiBundle.message("status.tooltip.agent", agent));
        }
        if (details != null) {
            tooltip.append(ClaudeCodeGuiBundle.message("status.tooltip.details", details));
        }

        updateLabel(text.toString(), tooltip.toString());
    }

    public void show(String text, String tooltip, long durationMs) {
        if (disposed) { return; }
        // Stop any existing timer to prevent resource leaks
        if (hideTimer != null) {
            hideTimer.stop();
        }
        this.visibleUntil.set(System.currentTimeMillis() + durationMs);
        // Temporary override
        updateLabel(text, tooltip);
        hideTimer = new Timer((int) durationMs, e -> hide());
        hideTimer.setRepeats(false);
        hideTimer.start();
    }

    public void hide() {
        if (disposed) { return; }
        if (System.currentTimeMillis() >= visibleUntil.get()) {
            // Revert to standard display
            refreshDisplay(null);
        }
    }

    private void updateLabel(String text, String tooltip) {
        if (disposed) { return; }
        textRef.set(text);
        tooltipRef.set(tooltip);
        if (ApplicationManager.getApplication().isDispatchThread()) {
            updateLabelOnEdt(text, tooltip);
        } else {
            ApplicationManager.getApplication().invokeLater(() -> updateLabelOnEdt(text, tooltip));
        }
    }

    private void updateLabelOnEdt(String text, String tooltip) {
        if (disposed) { return; }
        if (label != null) {
            label.setText(text);
            label.setToolTipText(tooltip);
        }
        if (statusBar != null) { statusBar.updateWidget(ID()); }
    }

    public static class Factory implements StatusBarWidgetFactory {
        @Override
        public @NotNull String getId() {
            return "ClaudeStatusBarWidget";
        }

        @Override
        public @NotNull String getDisplayName() {
            return ClaudeCodeGuiBundle.message("status.widgetName");
        }

        @Override
        public boolean isAvailable(@NotNull Project project) {
            if (project == null) { return false; }
            try {
                return new CodemossSettingsService().getStatusBarWidgetEnabled();
            } catch (Exception e) {
                return true;
            }
        }

        @Override
        public @NotNull StatusBarWidget createWidget(@NotNull Project project) {
            return new ClaudeStatusBarWidget(project);
        }

        @Override
        public void disposeWidget(@NotNull StatusBarWidget widget) {
            widget.dispose();
        }

        @Nullable
        public static ClaudeStatusBarWidget getWidget(@NotNull Project project) {
            StatusBar statusBar = WindowManager.getInstance().getStatusBar(project);
            if (statusBar != null) {
                StatusBarWidget widget = statusBar.getWidget("ClaudeStatusBarWidget");
                if (widget instanceof ClaudeStatusBarWidget) { return (ClaudeStatusBarWidget) widget; }
            }
            return null;
        }
    }
}
