package com.github.claudecodegui.ui;

import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.awt.*;
import java.util.function.Consumer;

/**
 * Error panel builder.
 * Builds error display panels for environment check failures and similar errors.
 */
public class ErrorPanelBuilder {

    private static final Logger LOG = Logger.getInstance(ErrorPanelBuilder.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    /**
     * Builds an error panel with a Node.js path input field.
     * @param title the panel title
     * @param message the error message to display
     * @param currentNodePath the currently detected Node.js path
     * @param onSaveAndRetry callback invoked on save-and-retry (parameter is the user-entered path, may be null or empty)
     * @return the error panel
     */
    public static JPanel build(String title, String message, String currentNodePath, Consumer<String> onSaveAndRetry) {
        JPanel errorPanel = new JPanel(new BorderLayout());
        errorPanel.setBackground(new Color(30, 30, 30));

        // Title
        JLabel titleLabel = new JLabel(title);
        titleLabel.setFont(new Font("SansSerif", Font.BOLD, 16));
        titleLabel.setForeground(Color.WHITE);
        titleLabel.setBorder(BorderFactory.createEmptyBorder(20, 20, 10, 20));

        // Error message area
        JTextArea textArea = new JTextArea(message);
        textArea.setEditable(false);
        textArea.setFont(new Font("Monospaced", Font.PLAIN, 12));
        textArea.setBackground(new Color(40, 40, 40));
        textArea.setForeground(new Color(220, 220, 220));
        textArea.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
        textArea.setLineWrap(true);
        textArea.setWrapStyleWord(true);

        errorPanel.add(titleLabel, BorderLayout.NORTH);
        errorPanel.add(new JScrollPane(textArea), BorderLayout.CENTER);

        // Bottom section: manual Node.js path input
        JPanel bottomPanel = new JPanel();
        bottomPanel.setLayout(new BoxLayout(bottomPanel, BoxLayout.Y_AXIS));
        bottomPanel.setBorder(BorderFactory.createEmptyBorder(10, 20, 20, 20));
        bottomPanel.setBackground(new Color(30, 30, 30));

        JLabel nodeLabel = new JLabel(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.nodePathLabel"));
        nodeLabel.setForeground(Color.WHITE);
        nodeLabel.setAlignmentX(Component.LEFT_ALIGNMENT);

        JTextField nodeField = new JTextField();
        nodeField.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
        nodeField.setAlignmentX(Component.LEFT_ALIGNMENT);

        // Pre-fill with the saved path or the currently detected path
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);
            if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                nodeField.setText(savedNodePath.trim());
            } else if (currentNodePath != null) {
                nodeField.setText(currentNodePath);
            }
        } catch (Exception e) {
            LOG.warn("Failed to preload Node.js path: " + e.getMessage());
        }

        JButton saveAndRetryButton = new JButton(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.saveButton"));
        saveAndRetryButton.setAlignmentX(Component.LEFT_ALIGNMENT);
        saveAndRetryButton.addActionListener(e -> {
            String manualPath = nodeField.getText();
            if (manualPath != null) {
                manualPath = manualPath.trim();
            }
            if (manualPath != null && manualPath.isEmpty()) {
                manualPath = null;
            }
            onSaveAndRetry.accept(manualPath);
        });

        bottomPanel.add(nodeLabel);
        bottomPanel.add(Box.createRigidArea(new Dimension(0, 5)));
        bottomPanel.add(nodeField);
        bottomPanel.add(Box.createRigidArea(new Dimension(0, 10)));
        bottomPanel.add(saveAndRetryButton);

        errorPanel.add(bottomPanel, BorderLayout.SOUTH);

        return errorPanel;
    }

    /**
     * Builds a simple error panel without the Node.js path input field.
     */
    public static JPanel buildSimple(String title, String message) {
        JPanel errorPanel = new JPanel(new BorderLayout());
        errorPanel.setBackground(new Color(30, 30, 30));

        JLabel titleLabel = new JLabel(title);
        titleLabel.setFont(new Font("SansSerif", Font.BOLD, 16));
        titleLabel.setForeground(Color.WHITE);
        titleLabel.setBorder(BorderFactory.createEmptyBorder(20, 20, 10, 20));

        JTextArea textArea = new JTextArea(message);
        textArea.setEditable(false);
        textArea.setFont(new Font("Monospaced", Font.PLAIN, 12));
        textArea.setBackground(new Color(40, 40, 40));
        textArea.setForeground(new Color(220, 220, 220));
        textArea.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
        textArea.setLineWrap(true);
        textArea.setWrapStyleWord(true);

        errorPanel.add(titleLabel, BorderLayout.NORTH);
        errorPanel.add(new JScrollPane(textArea), BorderLayout.CENTER);

        return errorPanel;
    }

    /**
     * Build a centered icon+title+message panel (used for JCEF errors and loading).
     */
    public static JPanel buildCenteredPanel(String icon, String title, String message) {
        return buildCenteredPanel(icon, title, message, null, null);
    }

    /**
     * Build a centered icon+title+message panel with an optional action button.
     */
    public static JPanel buildCenteredPanel(
            String icon,
            String title,
            String message,
            String actionText,
            Runnable action
    ) {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(new Color(30, 30, 30));

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setBackground(new Color(30, 30, 30));
        centerPanel.setBorder(BorderFactory.createEmptyBorder(50, 50, 50, 50));

        JLabel iconLabel = new JLabel(icon);
        iconLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 48));
        iconLabel.setForeground(Color.WHITE);
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

        JLabel titleLabel = new JLabel(title);
        titleLabel.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 18));
        titleLabel.setForeground(Color.WHITE);
        titleLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

        JTextArea messageArea = new JTextArea();
        messageArea.setText(message);
        messageArea.setEditable(false);
        messageArea.setBackground(new Color(45, 45, 45));
        messageArea.setForeground(new Color(200, 200, 200));
        messageArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 13));
        messageArea.setBorder(BorderFactory.createEmptyBorder(15, 15, 15, 15));
        messageArea.setAlignmentX(Component.CENTER_ALIGNMENT);
        messageArea.setMaximumSize(new Dimension(500, 300));

        centerPanel.add(iconLabel);
        centerPanel.add(Box.createVerticalStrut(15));
        centerPanel.add(titleLabel);
        centerPanel.add(Box.createVerticalStrut(20));
        centerPanel.add(messageArea);
        if (actionText != null && action != null) {
            centerPanel.add(Box.createVerticalStrut(16));
            JButton actionButton = new JButton(actionText);
            actionButton.setAlignmentX(Component.CENTER_ALIGNMENT);
            actionButton.addActionListener(event -> action.run());
            centerPanel.add(actionButton);
        }

        panel.add(centerPanel, BorderLayout.CENTER);
        return panel;
    }

    /**
     * Build a loading panel with icon, title, and description.
     */
    public static JPanel buildLoadingPanel(String icon, String title, String description) {
        JPanel panel = new JPanel(new BorderLayout());
        panel.setBackground(new Color(30, 30, 30));

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setBackground(new Color(30, 30, 30));
        centerPanel.setBorder(BorderFactory.createEmptyBorder(100, 50, 100, 50));

        JLabel iconLabel = new JLabel(icon);
        iconLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 48));
        iconLabel.setForeground(Color.WHITE);
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

        JLabel titleLabel = new JLabel(title);
        titleLabel.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 16));
        titleLabel.setForeground(Color.WHITE);
        titleLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        titleLabel.setHorizontalAlignment(SwingConstants.CENTER);

        JLabel descLabel = new JLabel("<html><center>" + description.replace("\n", "<br>") + "</center></html>");
        descLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 12));
        descLabel.setForeground(new Color(180, 180, 180));
        descLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        descLabel.setHorizontalAlignment(SwingConstants.CENTER);

        centerPanel.add(iconLabel);
        centerPanel.add(Box.createVerticalStrut(20));
        centerPanel.add(titleLabel);
        centerPanel.add(Box.createVerticalStrut(10));
        centerPanel.add(descLabel);

        panel.add(centerPanel, BorderLayout.CENTER);
        return panel;
    }
}
