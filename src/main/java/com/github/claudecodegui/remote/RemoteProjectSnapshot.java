package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.Nullable;

/**
 * Serializable view of an open IntelliJ {@link Project} for the
 * {@code GET /api/v1/projects} endpoint.
 *
 * <p>{@code basePath} is included because the Remote Client runs on the same
 * machine and already holds the bearer token; it is never written to ordinary
 * info logs.
 */
public final class RemoteProjectSnapshot {

    private final String projectId;
    private final String name;
    private final String basePath;

    private RemoteProjectSnapshot(String projectId, String name, String basePath) {
        this.projectId = projectId;
        this.name = name;
        this.basePath = basePath;
    }

    /**
     * Build a snapshot from a project, or null when the project has no basePath
     * (e.g. the default project) and therefore no stable id.
     */
    @Nullable
    public static RemoteProjectSnapshot from(Project project) {
        if (project == null || project.isDisposed()) {
            return null;
        }
        String basePath = project.getBasePath();
        String id = RemoteProjectId.of(basePath);
        if (id == null) {
            return null;
        }
        String name = project.getName();
        if (name == null || name.isEmpty()) {
            name = basePath;
        }
        return new RemoteProjectSnapshot(id, name, basePath);
    }

    public String getProjectId() {
        return projectId;
    }

    public String getName() {
        return name;
    }

    public String getBasePath() {
        return basePath;
    }

    public JsonObject toJson() {
        JsonObject obj = new JsonObject();
        obj.addProperty("projectId", projectId);
        obj.addProperty("name", name);
        obj.addProperty("basePath", basePath);
        return obj;
    }
}
