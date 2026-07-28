package com.github.claudecodegui.ui;

import org.junit.Assert;
import org.junit.Test;

import javax.swing.JButton;
import javax.swing.JPanel;
import java.awt.Component;
import java.awt.Container;
import java.util.concurrent.atomic.AtomicInteger;

public class ErrorPanelBuilderTest {

    @Test
    public void centeredPanelActionButtonInvokesCallback() {
        AtomicInteger invocations = new AtomicInteger();
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
                "!",
                "JCEF disabled",
                "Enable it and restart",
                "Enable JCEF",
                invocations::incrementAndGet
        );

        JButton button = findButton(panel);
        Assert.assertNotNull(button);
        Assert.assertEquals("Enable JCEF", button.getText());

        button.doClick();

        Assert.assertEquals(1, invocations.get());
    }

    private static JButton findButton(Container container) {
        for (Component component : container.getComponents()) {
            if (component instanceof JButton) {
                return (JButton) component;
            }
            if (component instanceof Container) {
                JButton nestedButton = findButton((Container) component);
                if (nestedButton != null) {
                    return nestedButton;
                }
            }
        }
        return null;
    }
}
