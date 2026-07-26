package com.github.claudecodegui.terminal;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.util.SelectionTextUtils;
import com.intellij.openapi.actionSystem.ActionGroup;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.actionSystem.DefaultActionGroup;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.terminal.JBTerminalWidget;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.reflect.Method;
import java.util.Arrays;

public class SendTerminalSelectionToInputAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendTerminalSelectionToInputAction.class);
    static final String ACTION_ID = "ClaudeCodeGUI.SendTerminalSelectionToInputAction";
    static final String TERMINAL_OUTPUT_CONTEXT_MENU = "Terminal.OutputContextMenu";
    static final String TERMINAL_PROMPT_CONTEXT_MENU = "Terminal.PromptContextMenu";
    static final String TERMINAL_REWORKED_CONTEXT_MENU = "Terminal.ReworkedTerminalContextMenu";
    // Coupled to the internal DataKey name used by IntelliJ's reworked terminal (2024.3+).
    // If JetBrains renames this key, the feature degrades silently (returns null).
    private static final com.intellij.openapi.actionSystem.DataKey<Object> TERMINAL_VIEW_DATA_KEY =
            com.intellij.openapi.actionSystem.DataKey.create("TerminalView");

    // Reflective method names for reworked terminal API (not public, may change across IDE versions)
    private static final String METHOD_GET_TEXT_SELECTION_MODEL = "getTextSelectionModel";
    private static final String METHOD_GET_SELECTION = "getSelection";
    private static final String METHOD_GET_START_OFFSET = "getStartOffset";
    private static final String METHOD_GET_END_OFFSET = "getEndOffset";
    private static final String METHOD_GET_OUTPUT_MODELS = "getOutputModels";
    private static final String METHOD_GET_ACTIVE = "getActive";
    private static final String METHOD_GET_VALUE = "getValue";
    private static final String METHOD_GET_TEXT = "getText";
    private static final String TERMINAL_DATA_CONTEXT_UTILS_CLASS = terminalDataContextUtilsClassName();
    private static final String TERMINAL_DATA_CONTEXT_UTILS_INSTANCE = "INSTANCE";
    private static final String METHOD_GET_EDITOR = "getEditor";
    private static final String METHOD_IS_PROMPT_EDITOR = "isPromptEditor";
    private static final String METHOD_IS_OUTPUT_EDITOR = "isOutputEditor";
    private static final String METHOD_IS_ALTERNATE_BUFFER_EDITOR = "isAlternateBufferEditor";

    private static TerminalSelectionProvider selectionProvider = TerminalSelectionProvider.DEFAULT;

    public SendTerminalSelectionToInputAction() {
        super(
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.text"),
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.description"),
                null
        );
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        // Short-circuit: trust the group registration for terminal popup menus
        if (isTerminalPopupPlace(e.getPlace())) {
            e.getPresentation().setEnabledAndVisible(true);
            return;
        }
        // For other contexts (e.g. EditorPopupMenu), check terminal data context safely
        boolean terminalContext = safeHasTerminalWidgetContext(e)
                || safeIsTerminalContext(e)
                || safeHasReworkedTerminalViewContext(e);
        e.getPresentation().setEnabledAndVisible(terminalContext);
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        String selectedText = resolveSelectedText(e);
        if (LOG.isDebugEnabled()) {
            LOG.debug("[TerminalSend] actionPerformed place=" + e.getPlace()
                    + ", project=" + (project == null ? "null" : project.getName())
                    + ", hasTerminalWidget=" + safeHasTerminalWidgetContext(e)
                    + ", editorContext=" + safeIsTerminalContext(e)
                    + ", textResolved=" + (selectedText != null)
                    + ", textLength=" + (selectedText == null ? 0 : selectedText.length()));
        }
        if (project == null || selectedText == null) {
            return;
        }
        SelectionTextUtils.sendToChatWindow(project, selectedText);
    }

    static void setSelectionProvider(@NotNull TerminalSelectionProvider provider) {
        selectionProvider = provider;
    }

    static void resetSelectionProvider() {
        selectionProvider = TerminalSelectionProvider.DEFAULT;
    }

    static @Nullable String resolveSelectedText(@Nullable AnActionEvent e) {
        String rawSelection = selectionProvider.resolveSelection(e);
        if (rawSelection == null && e != null) {
            rawSelection = e.getData(JBTerminalWidget.SELECTED_TEXT_DATA_KEY);
        }
        if (rawSelection == null) {
            rawSelection = resolveReworkedTerminalSelection(e);
        }
        if (rawSelection == null) {
            Editor editor = resolveEditor(e);
            if (editor != null) {
                rawSelection = editor.getSelectionModel().getSelectedText();
            }
        }
        return SelectionTextUtils.normalizeSendableText(rawSelection);
    }

    static boolean isTerminalPopupPlace(@Nullable String place) {
        return TERMINAL_OUTPUT_CONTEXT_MENU.equals(place)
                || TERMINAL_PROMPT_CONTEXT_MENU.equals(place)
                || TERMINAL_REWORKED_CONTEXT_MENU.equals(place);
    }

    static boolean registerForReworkedTerminalContextMenu(@NotNull ActionManager actionManager) {
        synchronized (SendTerminalSelectionToInputAction.class) {
            AnAction action = actionManager.getAction(ACTION_ID);
            if (action == null) {
                LOG.warn("[TerminalSend] Cannot register reworked terminal menu action because the action is missing: " + ACTION_ID);
                return false;
            }

            AnAction groupAction = actionManager.getAction(TERMINAL_REWORKED_CONTEXT_MENU);
            if (!(groupAction instanceof DefaultActionGroup)) {
                if (groupAction instanceof ActionGroup) {
                    LOG.debug("[TerminalSend] Reworked terminal context menu is not a DefaultActionGroup: "
                            + groupAction.getClass().getName());
                }
                return false;
            }

            DefaultActionGroup group = (DefaultActionGroup) groupAction;
            // Use getChildActionsOrStubs() for compatibility with IntelliJ 2023.3+;
            // getChildren(ActionManager) was only added in 2024.2 and triggers NoSuchMethodError on older builds.
            boolean alreadyRegistered = Arrays.stream(group.getChildActionsOrStubs())
                    .map(actionManager::getId)
                    .anyMatch(ACTION_ID::equals);
            if (alreadyRegistered) {
                return false;
            }

            group.add(action, actionManager);
            return true;
        }
    }

    interface TerminalSelectionProvider {

        TerminalSelectionProvider DEFAULT = event -> {
            if (event == null) {
                return null;
            }
            try {
                Editor editor = getTerminalDataContextEditor(event);
                if (editor == null || !isSupportedEditor(editor)) {
                    return null;
                }
                return editor.getSelectionModel().getSelectedText();
            } catch (Exception | LinkageError e) {
                LOG.debug("[TerminalSend] Terminal editor resolution failed in DEFAULT provider", e);
                return null;
            }
        };

        @Nullable
        String resolveSelection(@Nullable AnActionEvent event);
    }

    private static boolean safeIsTerminalContext(@Nullable AnActionEvent event) {
        try {
            Editor editor = resolveEditor(event);
            return editor != null && isSupportedEditor(editor);
        } catch (Exception | LinkageError e) {
            LOG.debug("[TerminalSend] Terminal context check failed", e);
            return false;
        }
    }

    private static boolean safeHasTerminalWidgetContext(@Nullable AnActionEvent event) {
        try {
            if (event == null) {
                return false;
            }
            return event.getData(JBTerminalWidget.TERMINAL_DATA_KEY) != null;
        } catch (Exception | LinkageError e) {
            LOG.debug("[TerminalSend] Terminal widget context check failed", e);
            return false;
        }
    }

    private static boolean safeHasReworkedTerminalViewContext(@Nullable AnActionEvent event) {
        try {
            return resolveTerminalView(event) != null;
        } catch (Exception | LinkageError e) {
            LOG.debug("[TerminalSend] Reworked terminal view context check failed", e);
            return false;
        }
    }

    private static @Nullable Editor resolveEditor(@Nullable AnActionEvent event) {
        if (event == null) {
            return null;
        }
        try {
            Editor editor = getTerminalDataContextEditor(event);
            if (editor != null && isSupportedEditor(editor)) {
                return editor;
            }
        } catch (Exception | LinkageError e) {
            LOG.debug("[TerminalSend] Terminal editor resolution failed, falling back", e);
        }

        try {
            Editor fallbackEditor = event.getData(CommonDataKeys.EDITOR);
            if (fallbackEditor != null && isSupportedEditor(fallbackEditor)) {
                return fallbackEditor;
            }
        } catch (Exception | LinkageError e) {
            LOG.debug("[TerminalSend] Fallback editor check failed", e);
        }
        return null;
    }

    private static @Nullable String resolveReworkedTerminalSelection(@Nullable AnActionEvent event) {
        Object terminalView = resolveTerminalView(event);
        if (terminalView == null) {
            return null;
        }
        try {
            Object selectionModel = invokeMethod(terminalView, METHOD_GET_TEXT_SELECTION_MODEL);
            Object selection = invokeMethod(selectionModel, METHOD_GET_SELECTION);
            if (selection == null) {
                return null;
            }

            Object startOffset = invokeMethod(selection, METHOD_GET_START_OFFSET);
            Object endOffset = invokeMethod(selection, METHOD_GET_END_OFFSET);
            if (startOffset == null || endOffset == null) {
                return null;
            }

            Object outputModels = invokeMethod(terminalView, METHOD_GET_OUTPUT_MODELS);
            Object activeFlow = invokeMethod(outputModels, METHOD_GET_ACTIVE);
            Object outputModel = invokeMethod(activeFlow, METHOD_GET_VALUE);
            Object selectedText = invokeMethod(outputModel, METHOD_GET_TEXT, startOffset, endOffset);
            return selectedText == null ? null : selectedText.toString();
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOG.debug("[TerminalSend] Reworked terminal selection resolution failed", e);
            return null;
        }
    }

    private static @Nullable Object resolveTerminalView(@Nullable AnActionEvent event) {
        if (event == null) {
            return null;
        }
        return event.getData(TERMINAL_VIEW_DATA_KEY);
    }

    private static @Nullable Object invokeMethod(@Nullable Object target, @NotNull String methodName, Object... args)
            throws ReflectiveOperationException {
        if (target == null) {
            return null;
        }
        Method method = findMethod(target.getClass(), methodName, args.length);
        return method.invoke(target, args);
    }

    private static @NotNull Method findMethod(@NotNull Class<?> type, @NotNull String methodName, int parameterCount)
            throws NoSuchMethodException {
        for (Method method : type.getMethods()) {
            if (method.getName().equals(methodName) && method.getParameterCount() == parameterCount) {
                method.setAccessible(true);
                return method;
            }
        }

        Class<?> current = type;
        while (current != null) {
            for (Method method : current.getDeclaredMethods()) {
                if (method.getName().equals(methodName) && method.getParameterCount() == parameterCount) {
                    method.setAccessible(true);
                    return method;
                }
            }
            current = current.getSuperclass();
        }

        throw new NoSuchMethodException(type.getName() + "#" + methodName + "/" + parameterCount);
    }

    private static boolean isSupportedEditor(@NotNull Editor editor) {
        Boolean promptEditor = invokeTerminalDataContextBoolean(METHOD_IS_PROMPT_EDITOR, editor);
        Boolean outputEditor = invokeTerminalDataContextBoolean(METHOD_IS_OUTPUT_EDITOR, editor);
        Boolean alternateBufferEditor = invokeTerminalDataContextBoolean(METHOD_IS_ALTERNATE_BUFFER_EDITOR, editor);
        return Boolean.TRUE.equals(promptEditor)
                || Boolean.TRUE.equals(outputEditor)
                || Boolean.TRUE.equals(alternateBufferEditor);
    }

    private static @Nullable Editor getTerminalDataContextEditor(@NotNull AnActionEvent event) {
        try {
            Object editor = invokeTerminalDataContextMethod(METHOD_GET_EDITOR, event);
            return editor instanceof Editor ? (Editor) editor : null;
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOG.debug("[TerminalSend] Terminal editor resolution failed", e);
            return null;
        }
    }

    private static @Nullable Boolean invokeTerminalDataContextBoolean(@NotNull String methodName, @NotNull Editor editor) {
        try {
            Object result = invokeTerminalDataContextMethod(methodName, editor);
            return result instanceof Boolean ? (Boolean) result : Boolean.FALSE;
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOG.debug("[TerminalSend] Terminal editor predicate " + methodName + " failed", e);
            return Boolean.FALSE;
        }
    }

    private static @Nullable Object invokeTerminalDataContextMethod(@NotNull String methodName, Object... args)
            throws ReflectiveOperationException {
        Class<?> utilsClass = Class.forName(TERMINAL_DATA_CONTEXT_UTILS_CLASS);
        Object instance = utilsClass.getField(TERMINAL_DATA_CONTEXT_UTILS_INSTANCE).get(null);
        return invokeMethod(instance, methodName, args);
    }

    private static @NotNull String terminalDataContextUtilsClassName() {
        return String.join(".", "org", "jetbrains", "plugins", "terminal", "block", "util",
                "TerminalDataContext" + terminalDataContextUtilsSuffix());
    }

    private static @NotNull String terminalDataContextUtilsSuffix() {
        return "Utils";
    }

}
