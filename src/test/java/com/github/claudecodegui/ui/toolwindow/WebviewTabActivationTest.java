package com.github.claudecodegui.ui.toolwindow;

import org.cef.browser.CefBrowser;
import org.junit.Test;

import javax.swing.JPanel;
import java.awt.Component;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class WebviewTabActivationTest {

    @Test
    public void remapsWindowedNativeSurfaceForAnEmptyTab() {
        List<String> calls = new ArrayList<>();
        int[][] resized = new int[1][];
        RecordingComponent nativeComponent = new RecordingComponent();
        new JPanel().add(nativeComponent);
        nativeComponent.startRecording();
        CefBrowser cefBrowser = createCefBrowser(nativeComponent, calls, resized);
        JPanel browserComponent = new JPanel();
        browserComponent.setSize(640, 480);
        AtomicBoolean frontendRepainted = new AtomicBoolean(false);

        ClaudeChatWindow.refreshActivatedWebview(
                new JPanel(), browserComponent, cefBrowser, false,
                () -> frontendRepainted.set(true));

        assertTrue(nativeComponent.invalidated);
        assertTrue(nativeComponent.repainted);
        assertEquals(Arrays.asList(false, true), nativeComponent.visibilityChanges);
        assertFalse(calls.contains("wasResized"));
        assertTrue(calls.contains("notifyScreenInfoChanged"));
        assertTrue(frontendRepainted.get());
    }

    @Test
    public void usesResizeNotificationOnlyForOsrSurface() {
        List<String> calls = new ArrayList<>();
        int[][] resized = new int[1][];
        RecordingComponent nativeComponent = new RecordingComponent();
        nativeComponent.startRecording();
        CefBrowser cefBrowser = createCefBrowser(nativeComponent, calls, resized);
        JPanel browserComponent = new JPanel();
        browserComponent.setSize(800, 600);
        AtomicBoolean frontendRepainted = new AtomicBoolean(false);

        ClaudeChatWindow.refreshActivatedWebview(
                new JPanel(), browserComponent, cefBrowser, true,
                () -> frontendRepainted.set(true));

        assertArrayEquals(new int[]{800, 600}, resized[0]);
        assertTrue(nativeComponent.visibilityChanges.isEmpty());
        assertTrue(calls.contains("notifyScreenInfoChanged"));
        assertTrue(frontendRepainted.get());
    }

    private static CefBrowser createCefBrowser(
            Component nativeComponent,
            List<String> calls,
            int[][] resized
    ) {
        return (CefBrowser) Proxy.newProxyInstance(
                CefBrowser.class.getClassLoader(),
                new Class<?>[]{CefBrowser.class},
                (proxy, method, args) -> {
                    calls.add(method.getName());
                    if ("getUIComponent".equals(method.getName())) {
                        return nativeComponent;
                    }
                    if ("wasResized".equals(method.getName())) {
                        resized[0] = new int[]{(int) args[0], (int) args[1]};
                    }
                    return defaultValue(method.getReturnType());
                }
        );
    }

    private static Object defaultValue(Class<?> returnType) {
        if (returnType == boolean.class) {
            return false;
        }
        if (returnType == int.class) {
            return 0;
        }
        if (returnType == double.class) {
            return 0.0d;
        }
        return null;
    }

    private static class RecordingComponent extends JPanel {
        private final List<Boolean> visibilityChanges = new ArrayList<>();
        private boolean recording;
        private boolean invalidated;
        private boolean repainted;

        private void startRecording() {
            recording = true;
            visibilityChanges.clear();
            invalidated = false;
            repainted = false;
        }

        @Override
        public void setVisible(boolean visible) {
            super.setVisible(visible);
            if (recording) {
                visibilityChanges.add(visible);
            }
        }

        @Override
        public void invalidate() {
            super.invalidate();
            if (recording) {
                invalidated = true;
            }
        }

        @Override
        public void repaint() {
            super.repaint();
            if (recording) {
                repainted = true;
            }
        }
    }
}
