package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Sends Codex requests through the long-running daemon ({@code codex.send}).
 *
 * <p>The daemon dispatches to {@code handleCodexCommand('send')} inside the
 * warm process, so the node + SDK cold start is paid once instead of per
 * chat message. Output lines carry the same [MESSAGE]/[STREAM_*] tags as the
 * one-shot channel, so {@link CodexSDKBridge#processOutputLine} is reused
 * verbatim.
 */
class CodexDaemonRequestExecutor {

    private final Logger log;
    private final CodexSDKBridge bridge; // for processOutputLine

    CodexDaemonRequestExecutor(Logger log, CodexSDKBridge bridge) {
        this.log = log;
        this.bridge = bridge;
    }

    /**
     * @param params the fully built request payload (message/threadId/env/...)
     *               — the daemon applies {@code params.env} to its process
     *               environment for the duration of the request.
     * @param cleanup invoked exactly once after the turn settles (success,
     *                error or abort) — e.g. temp image deletion.
     */
    CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            String channelId,
            JsonObject params,
            MessageCallback callback,
            Runnable cleanup
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);
            AtomicBoolean wasAborted = new AtomicBoolean(false);
            long startTime = System.currentTimeMillis();

            try {
                try {
                    return runTurn(daemon, channelId, params, callback, result,
                            assistantContent, hadSendError, lastNodeError, wasAborted, startTime);
                } finally {
                    cleanup.run();
                }
            } catch (Exception e) {
                if (!hadSendError.get()) {
                    result.success = false;
                    result.error = e.getMessage();
                    callback.onError(result.error);
                }
                return result;
            }
        });
    }

    private SDKResult runTurn(
            DaemonBridge daemon,
            String channelId,
            JsonObject params,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError,
            AtomicBoolean wasAborted,
            long startTime
    ) throws Exception {
        try {
            log.info("[CodexDaemonExecutor] Sending via daemon: codex.send");

                CompletableFuture<Boolean> cmdFuture = daemon.sendCommand(
                        "codex.send",
                        params,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[UNCAUGHT_ERROR]")
                                        || line.startsWith("[UNHANDLED_REJECTION]")
                                        || line.startsWith("[COMMAND_ERROR]")
                                        || line.startsWith("[STARTUP_ERROR]")
                                        || line.startsWith("[ERROR]")) {
                                    log.warn("[Codex Node ERROR] " + line);
                                    lastNodeError.set(line);
                                }
                                bridge.processOutputLine(
                                        line,
                                        callback,
                                        result,
                                        assistantContent,
                                        hadSendError,
                                        lastNodeError
                                );
                            }

                            @Override
                            public void onStderr(String text) {
                                if (text != null && (text.contains("[SEND_ERROR]")
                                        || text.contains("[DEBUG] Error"))) {
                                    bridge.processOutputLine(
                                            text,
                                            callback,
                                            result,
                                            assistantContent,
                                            hadSendError,
                                            lastNodeError
                                    );
                                    return;
                                }
                                log.debug("[CodexDaemon:stderr] " + text);
                            }

                            @Override
                            public void onError(String error) {
                                if (!hadSendError.get()) {
                                    result.success = false;
                                    result.error = error;
                                }
                            }

                            @Override
                            public void onAbort() {
                                wasAborted.set(true);
                            }

                            @Override
                            public void onComplete(boolean success) {
                            }
                        }
                );

                Boolean success;
                long waitStart = System.currentTimeMillis();
                long lastProgressLogAt = waitStart;
                while (true) {
                    try {
                        success = cmdFuture.get(30, TimeUnit.SECONDS);
                        break;
                    } catch (TimeoutException timeout) {
                        if (!daemon.isAlive()) {
                            throw new RuntimeException("Codex daemon not alive", timeout);
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastProgressLogAt >= 60_000) {
                            long elapsedSec = (now - waitStart) / 1000;
                            log.info("[CodexDaemonExecutor] still running (" + elapsedSec + "s)...");
                            lastProgressLogAt = now;
                        }
                    }
                }

                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();

                if (!hadSendError.get()) {
                    result.success = success != null && success;
                    if (result.success) {
                        callback.onComplete(result);
                    } else if (wasAborted.get()) {
                        long elapsed = System.currentTimeMillis() - startTime;
                        log.info("[CodexDaemonExecutor] aborted by user (" + elapsed + "ms)");
                        result.error = "User interrupted";
                        callback.onComplete(result);
                    } else {
                        String errorMsg = "Codex daemon command failed";
                        String nodeErr = lastNodeError.get();
                        if (nodeErr != null) {
                            errorMsg += "\n\nDetails: " + nodeErr;
                        }
                        if (result.error == null) {
                            result.error = errorMsg;
                        }
                        callback.onError(result.error);
                    }
                } else {
                    callback.onError(result.error != null ? result.error : "Codex send error");
                }

                return result;
            } catch (Exception e) {
                log.debug("[CodexDaemonExecutor] runTurn exception: " + e.getMessage());
                throw e;
            }
        }
}
