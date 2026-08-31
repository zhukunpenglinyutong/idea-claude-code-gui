package com.github.claudecodegui.service;

import com.intellij.openapi.application.Application;
import org.junit.Test;

import java.lang.reflect.Proxy;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for the EDT-detection logic in
 * {@link GitCommitMessageService#shouldOffloadToBackground(Application)}.
 *
 * <p>Covers the three branches of the defensive AWT fallback documented in
 * PR #1645: no Application (headless), Application that recognises the EDT,
 * and Application that does NOT recognise the thread while AWT does.
 */
public class GitCommitMessageServiceEdtFallbackTest {

    /** Application stub answering isDispatchThread() with a fixed value. */
    private static Application appWithDispatchFlag(final boolean isDispatch) {
        return (Application) Proxy.newProxyInstance(
                GitCommitMessageServiceEdtFallbackTest.class.getClassLoader(),
                new Class<?>[]{Application.class},
                (proxy, method, methodArgs) -> {
                    if ("isDispatchThread".equals(method.getName())) {
                        return isDispatch;
                    }
                    if ("hashCode".equals(method.getName())) {
                        return System.identityHashCode(proxy);
                    }
                    if ("toString".equals(method.getName())) {
                        return "ApplicationStub(isDispatchThread=" + isDispatch + ")";
                    }
                    return null;
                });
    }

    /** Application stub whose isDispatchThread() throws, simulating a broken lookup. */
    private static Application throwingApp() {
        return (Application) Proxy.newProxyInstance(
                GitCommitMessageServiceEdtFallbackTest.class.getClassLoader(),
                new Class<?>[]{Application.class},
                (proxy, method, methodArgs) -> {
                    if ("isDispatchThread".equals(method.getName())) {
                        throw new IllegalStateException("broken application");
                    }
                    return null;
                });
    }

    @Test
    public void nullApplicationStaysInline() {
        // Headless/unit-test environment: no offload, synchronous path.
        assertFalse(GitCommitMessageService.shouldOffloadToBackground(null));
    }

    @Test
    public void intellijRecognisedEdtOffloads() {
        // Primary branch: Application.isDispatchThread() == true.
        assertTrue(GitCommitMessageService.shouldOffloadToBackground(appWithDispatchFlag(true)));
    }

    @Test
    public void backgroundThreadStaysInline() {
        // JUnit worker threads are neither the IntelliJ EDT nor the AWT EDT,
        // so both checks are false and the caller stays inline.
        assertFalse(GitCommitMessageService.shouldOffloadToBackground(appWithDispatchFlag(false)));
    }

    @Test
    public void awtEdtFallsBackToOffload() throws Exception {
        // Defensive fallback branch: the Application says "not my EDT", but we
        // are on the real AWT EDT - the code must still offload. Run the
        // assertion on the AWT EDT via SwingUtilities.invokeAndWait so
        // EventQueue.isDispatchThread() is genuinely true here.
        final boolean[] offloaded = new boolean[1];
        java.awt.EventQueue.invokeAndWait(() ->
                offloaded[0] = GitCommitMessageService.shouldOffloadToBackground(appWithDispatchFlag(false)));
        assertTrue("AWT EDT with non-recognising Application should offload", offloaded[0]);
    }

    @Test
    public void throwingApplicationStaysInline() {
        // Broken Application: the internal try/catch keeps the caller inline.
        assertFalse(GitCommitMessageService.shouldOffloadToBackground(throwingApp()));
    }
}
