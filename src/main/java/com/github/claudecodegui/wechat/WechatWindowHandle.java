package com.github.claudecodegui.wechat;

import com.github.claudecodegui.remote.RemoteProjectId;
import com.github.claudecodegui.remote.RemoteTabRegistry;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;

/**
 * Minimal per-window view for the WeChat connection feature.
 *
 * Identity is resolved from the owning {@link ClaudeChatWindow}; the webview
 * never supplies projectId/tabId.
 */
public interface WechatWindowHandle {
    String projectId();

    String tabId();

    boolean isDisposed();

    void callJavaScript(String functionName, String json);

    final class Impl implements WechatWindowHandle {
        private final ClaudeChatWindow window;

        public Impl(ClaudeChatWindow window) {
            this.window = window;
        }

        @Override
        public String projectId() {
            return RemoteProjectId.of(window.getProject().getBasePath());
        }

        @Override
        public String tabId() {
            return RemoteTabRegistry.getInstance().tabIdFor(window);
        }

        @Override
        public boolean isDisposed() {
            return window.isDisposed();
        }

        @Override
        public void callJavaScript(String functionName, String json) {
            window.callJavaScript(functionName, json);
        }
    }
}
