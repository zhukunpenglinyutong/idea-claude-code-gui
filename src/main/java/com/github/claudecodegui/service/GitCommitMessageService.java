package com.github.claudecodegui.service;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.service.commit.CommitAIClient;
import com.github.claudecodegui.service.commit.CommitDiffProvider;
import com.github.claudecodegui.service.commit.CommitMessageCallback;
import com.github.claudecodegui.service.commit.CommitPromptBuilder;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.util.Collection;

/**
 * Slim orchestrator for AI commit-message generation.
 *
 * <p>Collaborates with three focused units:
 * <ul>
 *     <li>{@link CommitDiffProvider} — real {@code git diff} via git4idea.</li>
 *     <li>{@link CommitPromptBuilder} — lean prompt assembly.</li>
 *     <li>{@link CommitAIClient} — reuses the shared SDK daemon + streams.</li>
 * </ul>
 *
 * <p>The {@code protected} seams ({@link #generateGitDiff}, {@link #callClaudeAPI},
 * {@link #callCodexAPI}, {@link #getCommitAiConfig}) are preserved so routing
 * and diff unit tests can override them.
 */
public class GitCommitMessageService {

    private static final Logger LOG = Logger.getInstance(GitCommitMessageService.class);

    private final Project project;
    private final CodemossSettingsService settingsService;
    private final CommitAIClient client;
    private final CommitDiffProvider diffProvider;
    private final CommitPromptBuilder promptBuilder;

    public GitCommitMessageService(@Nullable Project project) {
        this.project = project;
        this.settingsService = new CodemossSettingsService();
        this.client = new CommitAIClient(project);
        this.diffProvider = new CommitDiffProvider(project, LOG);
        this.promptBuilder = new CommitPromptBuilder(settingsService, project);
    }

    /**
     * Generate a commit message for the selected changes.
     *
     * <p>Heavy work (git4idea {@code git diff}, repository lookup, AI call setup)
     * must not run on the EDT. IntelliJ asserts against synchronous process waits
     * and repository updates on the UI thread. When invoked from the EDT this
     * method re-dispatches to a pooled thread; otherwise it runs inline (unit
     * tests and already-background callers stay synchronous).
     *
     * @param changes  the selected file changes
     * @param callback the callback (onSuccess / onError / onProgress)
     */
    public void generateCommitMessage(
            @NotNull Collection<Change> changes,
            @NotNull CommitMessageCallback callback
    ) {
        if (shouldOffloadToBackground()) {
            ApplicationManager.getApplication().executeOnPooledThread(
                    () -> generateCommitMessageOnCallerThread(changes, callback));
            return;
        }
        generateCommitMessageOnCallerThread(changes, callback);
    }

    /**
     * Same as {@link #generateCommitMessage} but always runs on the calling thread.
     * Prefer the public entry point unless you already own a background thread.
     */
    private void generateCommitMessageOnCallerThread(
            @NotNull Collection<Change> changes,
            @NotNull CommitMessageCallback callback
    ) {
        try {
            // 1. Real git diff (git4idea process + repo lookup — not EDT-safe).
            String diff = generateGitDiff(changes);
            if (diff.isEmpty()) {
                callback.onError(ClaudeCodeGuiBundle.message("commit.noChangesFound"));
                return;
            }

            // 2. Lean prompt.
            String prompt = promptBuilder.build(diff);

            // 3. Route to the resolved provider's shared bridge (streams).
            callAIService(prompt, callback);
        } catch (IOException e) {
            LOG.warn("AI service call failed", e);
            String message = e.getMessage();
            callback.onError("AI service call failed: " + (message != null ? message : e.getClass().getSimpleName()));
        } catch (Exception e) {
            LOG.error("Failed to generate commit message", e);
            String message = e.getMessage();
            callback.onError(message != null ? message : e.getClass().getSimpleName());
        }
    }

    /**
     * True when the current thread is the EDT and a real Application is available
     * so we can re-dispatch. Headless/unit-test environments without an
     * Application keep the synchronous path for deterministic assertions.
     */
    private static boolean shouldOffloadToBackground() {
        try {
            Application app = ApplicationManager.getApplication();
            return app != null && app.isDispatchThread();
        } catch (Throwable t) {
            return false;
        }
    }

    /** Cancel the in-flight generation (channel-scoped; safe for shared bridges). */
    public void cancel() {
        client.cancel();
    }

    // -------------------------------------------------------------------------
    // Protected seams (overridable by tests)
    // -------------------------------------------------------------------------

    /**
     * Generate the unified git diff for the changes. Delegates to
     * {@link CommitDiffProvider} (real git4idea diff, with a content fallback).
     */
    protected String generateGitDiff(@NotNull Collection<Change> changes) {
        return diffProvider.generate(changes);
    }

    /**
     * Resolve provider + model and dispatch to Claude / Codex / headless CLI
     * (Grok, Kimi, OpenCode, PI) via {@link CommitAIClient}.
     */
    private void callAIService(String prompt, CommitMessageCallback callback) throws IOException {
        JsonObject commitAiConfig = getCommitAiConfig();
        String effectiveProvider = getResolvedCommitAiProvider(commitAiConfig);

        if (effectiveProvider == null) {
            callback.onError(ClaudeCodeGuiBundle.message("commit.noAvailableProvider"));
            return;
        }

        String model = getResolvedCommitAiModel(commitAiConfig, effectiveProvider);

        if (CommitAIClient.PROVIDER_CODEX.equals(effectiveProvider)) {
            callCodexAPI(prompt, model, callback);
            return;
        }

        if (CommitAIClient.PROVIDER_CLAUDE.equals(effectiveProvider)) {
            callClaudeAPI(prompt, model, callback);
            return;
        }

        // Headless CLI providers (grok / kimi / opencode / pi / mimo) share the same
        // one-shot commit-message.js path as Claude/Codex.
        callCliProviderAPI(prompt, effectiveProvider, model, callback);
    }

    /** Call the Claude bridge (shared daemon). Overridable by tests. */
    protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
        client.send(prompt, CommitAIClient.PROVIDER_CLAUDE, model, callback,
                ClaudeCodeGuiBundle.message("commit.emptyMessage"));
    }

    /** Call the Codex bridge (shared daemon). Overridable by tests. */
    protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
        client.send(prompt, CommitAIClient.PROVIDER_CODEX, model, callback,
                ClaudeCodeGuiBundle.message("commit.emptyMessage"));
    }

    /**
     * Call a headless CLI provider via commit-message.js. Overridable by tests.
     */
    protected void callCliProviderAPI(
            String prompt,
            String provider,
            String model,
            CommitMessageCallback callback
    ) {
        client.send(prompt, provider, model, callback,
                ClaudeCodeGuiBundle.message("commit.emptyMessage"));
    }

    protected JsonObject getCommitAiConfig() throws IOException {
        // Auto mode prefers the active chat tab CLI when available.
        return settingsService.getCommitAiConfig(resolvePreferredChatProvider());
    }

    /**
     * Best-effort current chat CLI for auto-mode resolution. Returns null when
     * no chat window is open so resolution falls back to Codex → Claude → others.
     */
    @Nullable
    protected String resolvePreferredChatProvider() {
        if (project == null) {
            return null;
        }
        try {
            ClaudeChatWindow window = ClaudeSDKToolWindow.getChatWindow(project);
            if (window == null) {
                return null;
            }
            String provider = window.getCurrentProvider();
            return (provider != null && !provider.isEmpty()) ? provider : null;
        } catch (Exception e) {
            LOG.debug("Could not resolve chat provider for commit AI auto mode: " + e.getMessage());
            return null;
        }
    }

    @Nullable
    private String getResolvedCommitAiProvider(JsonObject commitAiConfig) {
        if (commitAiConfig == null
                || !commitAiConfig.has("effectiveProvider")
                || commitAiConfig.get("effectiveProvider").isJsonNull()) {
            return null;
        }
        String provider = commitAiConfig.get("effectiveProvider").getAsString().trim();
        return provider.isEmpty() ? null : provider;
    }

    @Nullable
    private String getResolvedCommitAiModel(JsonObject commitAiConfig, String provider) {
        if (commitAiConfig == null
                || !commitAiConfig.has("models")
                || !commitAiConfig.get("models").isJsonObject()) {
            return null;
        }
        JsonObject models = commitAiConfig.getAsJsonObject("models");
        if (!models.has(provider) || models.get(provider).isJsonNull()) {
            return null;
        }
        String model = models.get(provider).getAsString().trim();
        return model.isEmpty() ? null : model;
    }
}
