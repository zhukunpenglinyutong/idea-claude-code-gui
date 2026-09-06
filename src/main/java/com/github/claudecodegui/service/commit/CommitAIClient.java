package com.github.claudecodegui.service.commit;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Generates commit messages via a dedicated, session-less Node.js one-shot
 * process ({@code ai-bridge/services/commit-message.js}), mirroring the
 * prompt-enhancer feature.
 *
 * <p>Why a separate process instead of the chat daemon's {@code sendMessage}:
 * {@code sendMessage} registers a persisted session, so every commit generation
 * would show up in the chat history. The {@code commit-message.js} script calls
 * the Claude Agent SDK {@code query()} (or Codex {@code startThread}) directly
 * with {@code maxTurns=1} and never resumes/persists a session — so generating a
 * commit message leaves <b>no trace in the history</b>. It also streams
 * {@code [CONTENT_DELTA]} tokens so the commit box renders incrementally.
 */
public class CommitAIClient {

    public static final String PROVIDER_CLAUDE = "claude";
    public static final String PROVIDER_CODEX = "codex";
    public static final String PROVIDER_GROK = "grok";
    public static final String PROVIDER_KIMI = "kimi";
    public static final String PROVIDER_OPENCODE = "opencode";
    public static final String PROVIDER_PI = "pi";
    public static final String PROVIDER_OMP = "omp";
    public static final String PROVIDER_MINIMAX = "minimax";

    private static final Logger LOG = Logger.getInstance(CommitAIClient.class);
    private static final Gson GSON = new Gson();

    private static final String COMMIT_SCRIPT = "services/commit-message.js";
    private static final long TIMEOUT_SECONDS = 90;
    private static final long READER_DRAIN_SECONDS = 5;

    private final Project project;

    /** The in-flight child process, for cancellation. */
    private volatile Process currentProcess;
    private volatile String currentChannelId;

    // Streaming preview state (per request).
    private final StringBuilder streamed = new StringBuilder();
    private volatile String latestPreview = "";
    private volatile boolean progressScheduled = false;

    public CommitAIClient(@Nullable Project project) {
        this.project = project;
    }

    /**
     * Run the commit-message script for the resolved provider + model.
     *
     * @param provider claude / codex / grok / kimi / opencode / pi
     * @param model    resolved model id (may be null → SDK/CLI default)
     */
    public void send(@NotNull String prompt, @NotNull String provider, @Nullable String model,
                     @NotNull CommitMessageCallback callback, @NotNull String emptyErrorMessage) {
        streamed.setLength(0);
        latestPreview = "";
        progressScheduled = false;
        CompletableFuture.runAsync(() -> {
            try {
                String raw = runScript(prompt, provider, model, callback);
                if (raw == null || raw.isEmpty()) {
                    callback.onError(emptyErrorMessage);
                    return;
                }
                callback.onSuccess(CommitMessageCleanup.clean(raw));
            } catch (Throwable t) {
                LOG.error("CommitAIClient: commit generation failed", t);
                callback.onError(t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName());
            }
        });
    }

    /** Cancel the in-flight generation by killing the child process. */
    public void cancel() {
        Process p = currentProcess;
        if (p != null && p.isAlive()) {
            try {
                PlatformUtils.terminateProcess(p);
            } catch (Throwable t) {
                LOG.debug("CommitAIClient: cancel terminate failed: " + t.getMessage());
            }
        }
    }

    @Nullable
    private String runScript(@NotNull String prompt, @NotNull String provider, @Nullable String model,
                             @NotNull CommitMessageCallback callback) throws Exception {
        ClaudeSDKBridge bridge = obtainBridge();
        String nodeExecutable = bridge.getNodeExecutable();
        if (nodeExecutable == null) {
            throw new IllegalStateException("Node.js is not configured");
        }
        File bridgeDir = bridge.getSdkTestDir();
        if (bridgeDir == null || !bridgeDir.exists()) {
            throw new IllegalStateException("AI Bridge directory is not ready");
        }
        File script = new File(bridgeDir, COMMIT_SCRIPT);
        ProcessManager processManager = bridge.getProcessManager();
        EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

        List<String> command = NodeDetector.buildNodeScriptCommand(nodeExecutable, script.getAbsolutePath());
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(bridgeDir);
        pb.redirectErrorStream(true);
        envConfigurator.updateProcessEnvironment(pb, nodeExecutable);

        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("prompt", prompt);
        stdinInput.addProperty("provider", provider != null ? provider : PROVIDER_CLAUDE);
        if (model != null && !model.isEmpty()) {
            stdinInput.addProperty("model", model);
        }
        String stdinJson = GSON.toJson(stdinInput);

        String channelId = ProcessManager.newChannelId("commit-message");
        currentChannelId = channelId;
        StringBuilder response = new StringBuilder();
        StringBuilder errorMessage = new StringBuilder();
        StringBuilder allOutput = new StringBuilder();
        Process process = null;
        CompletableFuture<Void> readerFuture = null;

        LOG.info("[CommitAIClient] Starting commit-message.js: provider=" + provider + ", model=" + model);

        try {
            process = pb.start();
            currentProcess = process;
            processManager.registerProcess(channelId, process);

            try (OutputStreamWriter writer = new OutputStreamWriter(
                    process.getOutputStream(), StandardCharsets.UTF_8)) {
                writer.write(stdinJson);
                writer.flush();
            }

            final Process finalProcess = process;
            readerFuture = CompletableFuture.runAsync(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        allOutput.append(line).append("\n");
                        LOG.info("[CommitAIClient] node: " + line);
                        if (line.startsWith("[COMMIT_ERROR]")) {
                            errorMessage.append(line.substring("[COMMIT_ERROR]".length()).trim());
                        } else if (line.startsWith("[CONTENT_DELTA]")) {
                            String payload = line.substring("[CONTENT_DELTA]".length()).trim();
                            String delta = parseJsonString(payload);
                            if (delta != null && !delta.isEmpty()) {
                                streamed.append(delta);
                                latestPreview = previewClean(streamed.toString());
                                scheduleProgress(callback);
                            }
                        } else if (line.startsWith("[COMMIT]")) {
                            String text = line.substring("[COMMIT]".length()).trim()
                                    .replace("{{NEWLINE}}", "\n");
                            response.append(text);
                        }
                    }
                } catch (IOException e) {
                    LOG.debug("[CommitAIClient] reader stream closed: " + e.getMessage());
                }
            });

            boolean finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                LOG.warn("[CommitAIClient] Timeout after " + TIMEOUT_SECONDS + "s, killing process");
                PlatformUtils.terminateProcess(process);
                throw new TimeoutException("Commit generation timed out after " + TIMEOUT_SECONDS + "s");
            }

            try {
                readerFuture.get(READER_DRAIN_SECONDS, TimeUnit.SECONDS);
            } catch (TimeoutException te) {
                LOG.warn("[CommitAIClient] Reader didn't drain within " + READER_DRAIN_SECONDS + "s");
            } catch (ExecutionException ee) {
                LOG.debug("[CommitAIClient] Reader failed: "
                        + (ee.getCause() != null ? ee.getCause().getMessage() : ee.getMessage()));
            } catch (CancellationException ce) {
                LOG.debug("[CommitAIClient] Reader cancelled unexpectedly");
            }

            if (errorMessage.length() > 0) {
                throw new RuntimeException(errorMessage.toString());
            }
            if (response.length() == 0 && allOutput.length() > 0) {
                LOG.warn("[CommitAIClient] No [COMMIT] marker found. Full output:\n" + allOutput);
            }
            return response.toString();

        } finally {
            if (process != null) {
                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }
                processManager.unregisterProcess(channelId, process);
            }
            if (readerFuture != null && !readerFuture.isDone()) {
                readerFuture.cancel(true);
            }
            currentProcess = null;
            currentChannelId = null;
        }
    }

    /** Parse a stdout delta payload that is a JSON-encoded string (e.g. {@code "Hello"}). */
    @Nullable
    private static String parseJsonString(@NotNull String payload) {
        if (payload.isEmpty()) {
            return null;
        }
        try {
            return GSON.fromJson(payload, String.class);
        } catch (Throwable t) {
            return payload;
        }
    }

    /** Strip the {@code <commit>} wrapper from a partial stream for a clean preview. */
    @NotNull
    private static String previewClean(@NotNull String raw) {
        String s = raw;
        int i = s.indexOf("<commit>");
        if (i >= 0) {
            s = s.substring(i + "<commit>".length());
        }
        int j = s.indexOf("</commit>");
        if (j >= 0) {
            s = s.substring(0, j);
        }
        return s;
    }

    /** Coalesce EDT preview updates so we never flood the event thread with deltas. */
    private void scheduleProgress(@NotNull CommitMessageCallback callback) {
        if (progressScheduled) {
            return;
        }
        progressScheduled = true;
        try {
            // ModalityState.any() so previews render even while a modal commit dialog is open.
            ApplicationManager.getApplication().invokeLater(() -> {
                progressScheduled = false;
                try {
                    callback.onProgress(latestPreview);
                } catch (Throwable ignored) {
                    // Preview rendering must never break generation.
                }
            }, ModalityState.any());
        } catch (Throwable t) {
            progressScheduled = false;
            LOG.debug("[CommitAIClient] invokeLater rejected: " + t.getMessage());
        }
    }

    /**
     * Reuse the chat window's Claude bridge for node/bridge-dir/process-manager
     * discovery; fall back to a fresh bridge instance if the chat window isn't
     * open. (No daemon is started — we only need filesystem/env helpers.)
     */
    @NotNull
    private ClaudeSDKBridge obtainBridge() {
        ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindow(project);
        if (chatWindow != null) {
            return chatWindow.getClaudeSDKBridge();
        }
        return new ClaudeSDKBridge();
    }
}
