package com.github.claudecodegui.action.editor;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.ui.icon.PluginIconProvider;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.popup.JBPopup;
import com.intellij.openapi.ui.popup.JBPopupFactory;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBTextField;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;

import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;

import javax.swing.*;
import java.awt.*;
import java.awt.event.KeyEvent;
import java.awt.event.KeyAdapter;
import java.util.Deque;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Quick Fix with Claude - Áp dụng các thay đổi thông minh dựa trên PSI context
 */
public class QuickFixWithClaudeAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(QuickFixWithClaudeAction.class);

    // UI Constants
    private static final int NAV_BUTTON_WIDTH = 28;
    private static final int NAV_BUTTON_HEIGHT = 14;
    private static final int NAV_BUTTON_FONT_SIZE = 8;
    private static final int INPUT_FIELD_WIDTH = 400;
    private static final int INPUT_FIELD_HEIGHT = 28;

    // History configuration
    private static final int MAX_HISTORY_SIZE = 20;
    private static final Deque<String> INPUT_HISTORY = new ConcurrentLinkedDeque<>();

    public QuickFixWithClaudeAction() {
        super(
            ClaudeCodeGuiBundle.message("action.quickFixWithClaude.text"),
            ClaudeCodeGuiBundle.message("action.quickFixWithClaude.description"),
            null
        );
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        Editor editor = e.getData(CommonDataKeys.EDITOR);
        if (project == null || editor == null) {
            return;
        }

        showQuickFixInput(project, editor);
    }

    private void showQuickFixInput(@NotNull Project project, @NotNull Editor editor) {
        // Use local variables for thread safety (each popup invocation has its own state)
        final AtomicInteger historyIndex = new AtomicInteger(-1);
        final AtomicReference<String> currentInput = new AtomicReference<>("");

        JPanel panel = new JPanel(new BorderLayout(0, 4));
        panel.setBorder(JBUI.Borders.empty(8));

        JBLabel label = new JBLabel(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.dialogLabel"));
        label.setBorder(JBUI.Borders.emptyBottom(4));
        panel.add(label, BorderLayout.NORTH);

        // Input panel with text field and navigation buttons
        JPanel inputPanel = new JPanel(new BorderLayout(4, 0));

        // Left panel with history navigation buttons
        JPanel navPanel = new JPanel(new GridLayout(2, 1, 0, 2));

        JButton historyUpButton = new JButton("▲");
        historyUpButton.setToolTipText(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.historyUpTooltip"));
        historyUpButton.setPreferredSize(new Dimension(NAV_BUTTON_WIDTH, NAV_BUTTON_HEIGHT));
        historyUpButton.setFont(new Font("SansSerif", Font.PLAIN, NAV_BUTTON_FONT_SIZE));

        JButton historyDownButton = new JButton("▼");
        historyDownButton.setToolTipText(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.historyDownTooltip"));
        historyDownButton.setPreferredSize(new Dimension(NAV_BUTTON_WIDTH, NAV_BUTTON_HEIGHT));
        historyDownButton.setFont(new Font("SansSerif", Font.PLAIN, NAV_BUTTON_FONT_SIZE));

        navPanel.add(historyUpButton);
        navPanel.add(historyDownButton);

        // Right panel with action buttons
        JPanel actionPanel = new JPanel(new GridLayout(2, 1, 0, 2));

        JButton submitButton = new JButton(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.submit"));
        submitButton.setToolTipText(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.submitTooltip"));

        JButton cancelButton = new JButton(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.cancel"));
        cancelButton.setToolTipText(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.cancelTooltip"));

        actionPanel.add(submitButton);
        actionPanel.add(cancelButton);

        // Center: text field - prefill with most recent history
        JBTextField textField = new JBTextField();
        textField.setPreferredSize(new Dimension(INPUT_FIELD_WIDTH, INPUT_FIELD_HEIGHT));

        // Prefill with the most recent input from history (thread-safe access)
        String firstEntry = INPUT_HISTORY.peekFirst();
        if (firstEntry != null) {
            textField.setText(firstEntry);
            // Select all text so user can easily type to replace
            textField.selectAll();
            // Set historyIndex to 0 since we're showing the first item
            historyIndex.set(0);
        }

        inputPanel.add(navPanel, BorderLayout.WEST);
        inputPanel.add(textField, BorderLayout.CENTER);
        inputPanel.add(actionPanel, BorderLayout.EAST);

        panel.add(inputPanel, BorderLayout.CENTER);

        JBPopup popup = JBPopupFactory.getInstance()
                .createComponentPopupBuilder(panel, textField)
                .setRequestFocus(true)
                .setFocusable(true)
                .setResizable(true)
                .setMovable(true)
                .setTitle(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.dialogTitle"))
                .createPopup();

        // Submit action
        Runnable submitAction = () -> {
            String prompt = textField.getText().trim();
            if (!prompt.isEmpty()) {
                // Thread-safe history management with bounded size
                INPUT_HISTORY.remove(prompt); // Remove duplicates
                INPUT_HISTORY.addFirst(prompt); // Add to front
                // Trim to max size
                while (INPUT_HISTORY.size() > MAX_HISTORY_SIZE) {
                    INPUT_HISTORY.removeLast();
                }
                popup.closeOk(null);
                executeQuickFix(project, editor, prompt);
            }
        };

        // Cancel action
        Runnable cancelAction = popup::cancel;

        // History navigation actions (using local state arrays for thread safety)
        // IMPORTANT: Get array snapshot first, then use its length to avoid race conditions
        Runnable historyUpAction = () -> {
            String[] historyArray = INPUT_HISTORY.toArray(new String[0]);
            int size = historyArray.length;
            if (size > 0 && historyIndex.get() < size - 1) {
                if (historyIndex.get() == -1) {
                    currentInput.set(textField.getText());
                }
                int idx = historyIndex.incrementAndGet();
                if (idx < historyArray.length) {
                    textField.setText(historyArray[idx]);
                }
            }
        };

        Runnable historyDownAction = () -> {
            String[] historyArray = INPUT_HISTORY.toArray(new String[0]);
            int idx = historyIndex.get();
            if (idx > 0 && idx < historyArray.length) {
                int newIdx = historyIndex.decrementAndGet();
                textField.setText(historyArray[newIdx]);
            } else if (idx == 0) {
                historyIndex.set(-1);
                textField.setText(currentInput.get());
            }
        };

        // Button click handlers
        submitButton.addActionListener(e -> submitAction.run());
        cancelButton.addActionListener(e -> cancelAction.run());
        historyUpButton.addActionListener(e -> historyUpAction.run());
        historyDownButton.addActionListener(e -> historyDownAction.run());

        // Key listener for ENTER, ESC, and arrow keys for history navigation
        textField.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.VK_ENTER) {
                    submitAction.run();
                    e.consume();
                } else if (e.getKeyCode() == KeyEvent.VK_ESCAPE) {
                    cancelAction.run();
                    e.consume();
                } else if (e.getKeyCode() == KeyEvent.VK_UP) {
                    historyUpAction.run();
                    e.consume();
                } else if (e.getKeyCode() == KeyEvent.VK_DOWN) {
                    historyDownAction.run();
                    e.consume();
                }
            }
        });

        popup.showInBestPositionFor(editor);
    }

    private void executeQuickFix(@NotNull Project project, @NotNull Editor editor, @NotNull String userPrompt) {
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("quickfix.toolWindowNotFound"));
            return;
        }

        // Show progress in status bar
        ClaudeNotifier.setWaiting(project);

        // 1. Create a new "Secondary" chat window specifically for this Quick Fix
        ClaudeChatWindow quickFixWindow = new ClaudeChatWindow(project, true);

        // 2. Add as a new tab in the tool window with "AIN" naming format
        ContentFactory contentFactory = ContentFactory.getInstance();
        String tabName = ClaudeSDKToolWindow.getNextTabName(toolWindow);
        Content content = contentFactory.createContent(quickFixWindow.getContent(), tabName, false);
        content.setCloseable(true);
        quickFixWindow.setParentContent(content);
        toolWindow.getContentManager().addContent(content);
        toolWindow.getContentManager().setSelectedContent(content);
        toolWindow.show(null);

        // 3. Send message and handle response for Diff View
        quickFixWindow.sendQuickFixMessage(userPrompt, true, new MessageCallback() {
            @Override
            public void onMessage(String type, String content) {}

            @Override
            public void onError(String error) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("quickfix.failed", error));
                    ClaudeNotifier.clearStatus(project);
                });
            }

            @Override
            public void onComplete(SDKResult result) {
                com.github.claudecodegui.service.QuickFixService.handleAIResponse(project, editor, result.finalResult);
            }
        });
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setIcon(PluginIconProvider.getCurrentPluginIcon());
        e.getPresentation().setEnabledAndVisible(true);
    }
}
