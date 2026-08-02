package com.github.claudecodegui.remote;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Starts the {@link RemoteGatewayService} once per IDE process.
 *
 * <p>Registered as a {@code postStartupActivity} so it fires for every opened
 * project. The service itself is application-level and {@link
 * RemoteGatewayService#startIfNeeded()} is idempotent, so multiple projects
 * opening never start more than one HTTP server. The start runs on a pooled
 * thread to avoid blocking project startup.
 */
public class RemoteGatewayBootstrap implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(RemoteGatewayBootstrap.class);

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                RemoteGatewayService.getInstance().startIfNeeded();
            } catch (Throwable t) {
                LOG.warn("[RemoteGateway] Startup failed: " + t.getMessage(), t);
            }
        });
        return Unit.INSTANCE;
    }
}
