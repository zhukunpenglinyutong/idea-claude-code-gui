package com.github.claudecodegui.ui;

import org.junit.Assert;
import org.junit.Test;
import org.cef.browser.CefBrowser;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Unit tests for webview bootstrap generation and page reload behavior.
 */
public class WebviewInitializerTest {

    /**
     * Verifies that the bootstrap script includes every frontend configuration callback.
     */
    @Test
    public void bootstrapIncludesEveryFrontendConfiguration() {
        List<String> scripts = WebviewInitializer.buildConfigurationInjections(
                "{\"editor\":true}",
                "{\"ui\":true}",
                "{\"code\":true}",
                "{\"language\":true}"
        );
        String bootstrap = String.join("\n", scripts);

        Assert.assertTrue(bootstrap.contains("applyIdeaFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyUiFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyCodeFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyIdeaLanguageConfig"));
    }

    /**
     * Verifies that repeated Shift+Escape injection does not register duplicate listeners.
     */
    @Test
    public void shiftEscapeInjectionIsIdempotent() {
        String injection = WebviewInitializer.buildShiftEscInjection("hidePanelQuery();");

        Assert.assertTrue(injection.contains("if (!window.__ccgShiftEscInstalled)"));
        Assert.assertTrue(injection.contains("window.__ccgShiftEscInstalled = true"));
        Assert.assertTrue(injection.contains("hidePanelQuery();"));
    }

    /**
     * Verifies that watchdog soft recovery reloads the existing CefBrowser page.
     */
    @Test
    public void softRecoveryReloadsCurrentCefPage() {
        AtomicInteger reloadCalls = new AtomicInteger();
        CefBrowser cefBrowser = (CefBrowser) Proxy.newProxyInstance(
                CefBrowser.class.getClassLoader(),
                new Class<?>[]{CefBrowser.class},
                (proxy, method, args) -> {
                    if ("reload".equals(method.getName())) {
                        reloadCalls.incrementAndGet();
                    }
                    return null;
                }
        );

        WebviewInitializer.reloadCurrentPage(cefBrowser);

        Assert.assertEquals(1, reloadCalls.get());
    }

    /**
     * Verifies that recovery context is installed before the Java bridge becomes visible.
     */
    @Test
    public void bridgeBootstrapMarksWatchdogRecoveryBeforeInstallingBridge() {
        String script = WebviewInitializer.buildBridgeInjection("query(msg)", true);

        Assert.assertTrue(script.contains("window.__CCGUI_RECOVERY_RELOAD__ = true;"));
        Assert.assertTrue(script.indexOf("__CCGUI_RECOVERY_RELOAD__")
                < script.indexOf("window.sendToJava"));
        Assert.assertTrue(script.contains("query(msg)"));
    }

    /**
     * Verifies that a normal first load is explicitly distinguished from recovery.
     */
    @Test
    public void bridgeBootstrapMarksInitialLoadAsNonRecovery() {
        String script = WebviewInitializer.buildBridgeInjection("query(msg)", false);

        Assert.assertTrue(script.contains("window.__CCGUI_RECOVERY_RELOAD__ = false;"));
    }
}
