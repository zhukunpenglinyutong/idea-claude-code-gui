package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2C-C.1 pre-launch abort verification: the {@link DaemonBridge} abort flag +
 * {@link DaemonBridge#sendCommandChecked} commit-boundary check.
 *
 * <p>Proves that once {@link DaemonBridge#sendAbort()} has marked the bridge aborted,
 * a subsequent Agent-send commit ({@code sendCommandChecked}) is SKIPPED — the request
 * is never written to the daemon, so no provider Agent turn can begin after the abort.
 * The abort-skip fast path runs BEFORE {@code ensureRunning()}, so these tests exercise
 * the real production method without a live daemon process.
 */
public class DaemonBridgeAbortTest {

    @Test
    public void sendAbort_marksBridgeAborted() {
        DaemonBridge db = newBridge();
        assertFalse(db.isAborted());
        db.sendAbort();
        assertTrue("sendAbort must mark the bridge aborted", db.isAborted());
    }

    @Test
    public void sendCommandChecked_skipsWhenAborted_noProviderWork() throws Exception {
        DaemonBridge db = newBridge();
        db.sendAbort(); // dispose/Desktop-Stop won the pre-launch race

        AtomicBoolean abortCalled = new AtomicBoolean(false);
        AtomicBoolean lineCalled = new AtomicBoolean(false);
        DaemonBridge.DaemonOutputCallback cb = callbackTracker(abortCalled, lineCalled);

        CompletableFuture<Boolean> f = db.sendCommandChecked("claude.send", new JsonObject(), cb);
        Boolean result = f.get(2, TimeUnit.SECONDS);

        assertFalse("aborted sendCommandChecked must complete false (no provider work)", result);
        assertTrue("onAbort must be invoked on the skipped commit", abortCalled.get());
        assertFalse("no daemon output may be produced for a skipped commit", lineCalled.get());
    }

    @Test
    public void clearAbort_resetsFlagForNextTurn() {
        DaemonBridge db = newBridge();
        db.sendAbort();
        assertTrue(db.isAborted());
        db.clearAbort();
        assertFalse("clearAbort must reset the flag so the next turn is not falsely aborted",
                db.isAborted());
    }

    private static DaemonBridge newBridge() {
        // Constructor only stores the dependencies; the abort-flag paths exercised here
        // (sendAbort / isAborted / clearAbort / sendCommandChecked abort-skip) never
        // touch the daemon process, so null deps are safe and no real daemon is started.
        return new DaemonBridge(null, null, null);
    }

    private static DaemonBridge.DaemonOutputCallback callbackTracker(
            AtomicBoolean abortCalled, AtomicBoolean lineCalled) {
        return new DaemonBridge.DaemonOutputCallback() {
            @Override public void onLine(String line) { lineCalled.set(true); }
            @Override public void onStderr(String text) { }
            @Override public void onError(String error) { }
            @Override public void onComplete(boolean success) { }
            @Override public void onAbort() { abortCalled.set(true); }
        };
    }
}
