package com.github.claudecodegui.action.console;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.icon.PluginIconProvider;
import com.github.claudecodegui.util.SelectionTextUtils;
import com.intellij.execution.impl.ConsoleViewImpl;
import com.intellij.execution.ui.ConsoleView;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.LangDataKeys;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.reflect.Method;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

public class SendConsoleSelectionToInputAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendConsoleSelectionToInputAction.class);

    // Cache reflective Method lookup to avoid repeated getMethod() on EDT hot path.
    // Uses Optional to safely cache "not found" results (ConcurrentHashMap doesn't allow null values).
    private static final Map<Class<?>, Optional<Method>> EDITOR_METHOD_CACHE = new ConcurrentHashMap<>();

    public SendConsoleSelectionToInputAction() {
        super(
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.text"),
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.description"),
                null
        );
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setIcon(PluginIconProvider.getCurrentPluginIcon());
        e.getPresentation().setEnabledAndVisible(resolveSelectedText(e) != null);
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        String selectedText = resolveSelectedText(e);
        if (project == null || selectedText == null) {
            return;
        }
        SelectionTextUtils.sendToChatWindow(project, selectedText);
    }

    private static @Nullable String resolveSelectedText(@NotNull AnActionEvent e) {
        return resolveSelectedText(e.getData(LangDataKeys.CONSOLE_VIEW));
    }

    static @Nullable String resolveSelectedText(@Nullable Object consoleView) {
        Editor editor = findEditor(consoleView);
        if (editor == null) {
            return null;
        }
        return SelectionTextUtils.normalizeSendableText(editor.getSelectionModel().getSelectedText());
    }

    private static @Nullable Editor findEditor(@Nullable Object consoleView) {
        if (consoleView == null) {
            return null;
        }
        if (consoleView instanceof ConsoleViewImpl) {
            return ((ConsoleViewImpl) consoleView).getEditor();
        }
        if (consoleView instanceof ConsoleView) {
            return invokeGetEditor(consoleView);
        }
        return null;
    }

    private static @Nullable Editor invokeGetEditor(@NotNull Object consoleView) {
        Class<?> clazz = consoleView.getClass();
        try {
            Optional<Method> cached = EDITOR_METHOD_CACHE.computeIfAbsent(clazz, cls -> {
                try {
                    Method m = cls.getMethod("getEditor");
                    if (!Editor.class.isAssignableFrom(m.getReturnType())) {
                        return Optional.empty();
                    }
                    return Optional.of(m);
                } catch (NoSuchMethodException e) {
                    return Optional.empty();
                }
            });
            if (!cached.isPresent()) {
                return null;
            }
            Object result = cached.get().invoke(consoleView);
            if (result instanceof Editor) {
                return (Editor) result;
            }
        } catch (ReflectiveOperationException e) {
            LOG.debug("Failed to invoke getEditor() via reflection on " + clazz.getName(), e);
        }
        return null;
    }
}
