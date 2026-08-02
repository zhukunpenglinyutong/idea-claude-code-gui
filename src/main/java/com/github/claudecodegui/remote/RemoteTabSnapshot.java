package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;

/**
 * Immutable snapshot of one CC GUI tab, copied from the live
 * {@code ClaudeChatWindow}/{@code ClaudeSession}/{@code SessionState} on the EDT.
 *
 * <p>The snapshot is a plain data object so that JSON serialization on the HTTP
 * worker thread never holds references to UI/session objects. This makes the
 * upcoming SSE/chat phases easier to reason about: the HTTP layer only ever
 * touches immutable copies.
 *
 * <p>Fields are limited to what {@code SessionState} can safely expose:
 * {@code tabId} and {@code selected} are always present; {@code sessionId} is
 * null for a new tab that has not yet sent its first message. No apiKey,
 * baseUrl, token, env, or full provider config is ever included.
 */
public final class RemoteTabSnapshot {

    private final String tabId;
    private final int index;
    private final boolean selected;
    private final String sessionId;
    private final String provider;
    private final String model;
    private final String cwd;
    private final boolean busy;

    public RemoteTabSnapshot(String tabId, int index, boolean selected,
                             String sessionId, String provider, String model,
                             String cwd, boolean busy) {
        this.tabId = tabId;
        this.index = index;
        this.selected = selected;
        this.sessionId = sessionId;
        this.provider = provider;
        this.model = model;
        this.cwd = cwd;
        this.busy = busy;
    }

    public String getTabId() {
        return tabId;
    }

    public int getIndex() {
        return index;
    }

    public boolean isSelected() {
        return selected;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getProvider() {
        return provider;
    }

    public String getModel() {
        return model;
    }

    public String getCwd() {
        return cwd;
    }

    public boolean isBusy() {
        return busy;
    }

    public JsonObject toJson() {
        JsonObject obj = new JsonObject();
        obj.addProperty("tabId", tabId);
        obj.addProperty("index", index);
        obj.addProperty("selected", selected);
        addIfPresent(obj, "sessionId", sessionId);
        addIfPresent(obj, "provider", provider);
        addIfPresent(obj, "model", model);
        addIfPresent(obj, "cwd", cwd);
        obj.addProperty("busy", busy);
        return obj;
    }

    private static void addIfPresent(JsonObject obj, String name, String value) {
        if (value != null && !value.isEmpty()) {
            obj.addProperty(name, value);
        }
    }
}
