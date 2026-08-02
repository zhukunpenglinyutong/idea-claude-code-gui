package com.github.claudecodegui.remote;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Phase 2C-C.1 pre-launch abort verification — integration of the
 * {@link RemoteGatewayGeneration} start boundary with the real
 * {@link DaemonBridge} commit-boundary abort guard.
 *
 * <p>Models the shutdown race: a Remote dispatch crosses the real start boundary
 * (gen.tryStartTurn), then the async send continuation is paused BEFORE the provider
 * commit. Gateway dispose runs (gen.beginClosing + db.sendAbort). The send resumes and
 * reaches the real {@link DaemonBridge#sendCommandChecked} commit, which observes the
 * abort and SKIPS — no provider Agent work begins after the shutdown abort.
 *
 * <p>Uses real production objects (RemoteGatewayGeneration + DaemonBridge.sendAbort /
 * sendCommandChecked) with Latch synchronization — no {@code sleep}, no boolean stand-in
 * for the commit (the commit IS the real sendCommandChecked). The non-aborted commit
 * path requires a live daemon process and is covered by the existing
 * {@code ClaudeSDKBridgeRefactorTest} (AbortingDaemonBridge) for the abort-after-commit
 * case plus the audit in the closure report.
 */
public class RemotePreLaunchAbortTest {

    @Test
    public void disposeDuringSendWindow_sendCommandCheckedSkipsProviderWork() throws Exception {
        RemoteGatewayGeneration gen = new RemoteGatewayGeneration(1);
        DaemonBridge db = new DaemonBridge(null, null, null);

        CountDownLatch startCrossed = new CountDownLatch(1);
        CountDownLatch disposeDone = new CountDownLatch(1);
        AtomicReference<Throwable> err = new AtomicReference<>();
        AtomicBoolean abortCalled = new AtomicBoolean(false);
        AtomicReference<Boolean> sendResult = new AtomicReference<>();

        DaemonBridge.DaemonOutputCallback cb = new DaemonBridge.DaemonOutputCallback() {
            @Override public void onLine(String line) { }
            @Override public void onStderr(String text) { }
            @Override public void onError(String error) { }
            @Override public void onComplete(boolean success) { }
            @Override public void onAbort() { abortCalled.set(true); }
        };

        Thread chat = new Thread(() -> {
            try {
                // Cross the real start boundary (register task under gen.startLock).
                boolean startWon = gen.tryStartTurn(() -> { /* task registered, visible to abort */ });
                assertTrue("start must win (dispose hasn't begun)", startWon);
                startCrossed.countDown();
                // Async send continuation pauses BEFORE the provider commit — the window
                // between send() returning and sendMessageToProvider reaching sendCommandChecked.
                assertTrue("resume after dispose", disposeDone.await(5, TimeUnit.SECONDS));
                // Provider commit — the REAL production method:
                CompletableFuture<Boolean> f = db.sendCommandChecked("claude.send", new JsonObject(), cb);
                sendResult.set(f.get(2, TimeUnit.SECONDS));
            } catch (Throwable t) {
                err.set(t);
            }
        }, "chat");

        Thread dispose = new Thread(() -> {
            try {
                assertTrue("wait for start boundary", startCrossed.await(5, TimeUnit.SECONDS));
                gen.beginClosing(); // mark generation closing — no new turn may start
                db.sendAbort();      // dispose aborts the session (sets bridge aborted)
            } catch (Throwable t) {
                err.set(t);
            }
        }, "dispose");

        chat.start();
        dispose.start();
        dispose.join(5000);
        disposeDone.countDown(); // release the send continuation AFTER dispose aborted
        chat.join(5000);

        assertNull("no thread exception", err.get());
        assertTrue("bridge must be aborted by dispose", db.isAborted());
        assertFalse("provider commit MUST be skipped — no Agent work after shutdown abort",
                sendResult.get());
        assertTrue("onAbort must be invoked on the skipped commit", abortCalled.get());
    }
}
