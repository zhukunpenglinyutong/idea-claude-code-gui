package com.github.claudecodegui.remote;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;

import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;

/**
 * Assigns an opaque, stable runtime {@code tabId} to each live
 * {@link ClaudeChatWindow}.
 *
 * <p>Why a separate id instead of reusing an existing one:
 * <ul>
 *   <li>tab index drifts as tabs are opened/closed/reordered.</li>
 *   <li>{@code sessionId} is null until the first message is sent on a new tab.</li>
 *   <li>{@code Content.hashCode()} / {@code ClaudeChatWindow.hashCode()} are not
 *       stable across restarts and leak implementation detail.</li>
 * </ul>
 * A remote tab handle is a different concept from a provider session identity.
 *
 * <p>Stability rules:
 * <ul>
 *   <li>The same {@code ClaudeChatWindow} instance always resolves to the same
 *       tabId for as long as it is live.</li>
 *   <li>Different windows get different ids.</li>
 *   <li>When a window becomes weakly reachable (its tab is closed and the
 *       ToolWindow releases its strong references), the entry is cleared by GC
 *       — no manual unregister is required, and there is no leak.</li>
 *   <li>tabIds are NOT persisted; they change across IDE restarts.</li>
 * </ul>
 *
 * <p>The backing map is a synchronized {@link WeakHashMap}. {@code ClaudeChatWindow}
 * does not override {@code equals/hashCode}, so lookup is identity-based, which
 * is exactly the semantics we want. The generated tabId is a random UUID stored
 * as the value; the key's hashCode is used only for bucketing, never as the id.
 *
 * <p>The core {@link #idFor(Object)} / {@link #forget(Object)} / {@link #size()}
 * methods accept {@code Object} (package-private) so the registry can be unit
 * tested with plain objects instead of a fully constructed {@code ClaudeChatWindow}.
 */
public final class RemoteTabRegistry {

    private static final RemoteTabRegistry INSTANCE = new RemoteTabRegistry();

    private final Map<Object, String> ids = Collections.synchronizedMap(new WeakHashMap<>());

    public static RemoteTabRegistry getInstance() {
        return INSTANCE;
    }

    /** Public production entry point. */
    public String tabIdFor(ClaudeChatWindow window) {
        if (window == null) {
            return null;
        }
        return idFor(window);
    }

    /**
     * Resolve (or assign) a tabId for an arbitrary identity key. Package-private
     * so tests can exercise the logic without a real {@code ClaudeChatWindow}.
     */
    String idFor(Object key) {
        if (key == null) {
            return null;
        }
        synchronized (ids) {
            String existing = ids.get(key);
            if (existing != null) {
                return existing;
            }
            String id = UUID.randomUUID().toString();
            ids.put(key, id);
            return id;
        }
    }

    /** Explicitly drop a mapping. Normally unnecessary (GC handles it). */
    public void forget(ClaudeChatWindow window) {
        if (window != null) {
            forget((Object) window);
        }
    }

    void forget(Object key) {
        if (key == null) {
            return;
        }
        synchronized (ids) {
            ids.remove(key);
        }
    }

    /** Test/diagnostic: number of currently-tracked ids. */
    public int size() {
        synchronized (ids) {
            return ids.size();
        }
    }
}
