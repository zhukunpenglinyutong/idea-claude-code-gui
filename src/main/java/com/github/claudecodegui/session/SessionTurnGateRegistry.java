package com.github.claudecodegui.session;

import java.util.Collections;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Process-wide registry of {@link SessionTurnGate}s keyed by session identity.
 *
 * <p>Keys are {@link ClaudeSession} instances (which do not override
 * {@code equals/hashCode}, so lookup is identity-based — exactly what we want).
 * The backing map is a synchronized {@link WeakHashMap}, so when a tab closes
 * and its {@link ClaudeSession} becomes weakly reachable, the gate entry is
 * cleared by GC with no explicit unregister and no leak.
 *
 * <p>Single application-wide instance.
 */
public final class SessionTurnGateRegistry {

    private static final SessionTurnGateRegistry INSTANCE = new SessionTurnGateRegistry();

    private final Map<Object, SessionTurnGate> gates =
            Collections.synchronizedMap(new WeakHashMap<>());

    private SessionTurnGateRegistry() {
    }

    public static SessionTurnGateRegistry getInstance() {
        return INSTANCE;
    }

    /**
     * Atomically acquire the gate for {@code sessionKey}. The first caller for a
     * free session wins; concurrent callers for the same session lose and get
     * {@code null}.
     *
     * @param sessionKey the {@link ClaudeSession} instance (or any identity key)
     * @return a {@link SessionTurnGate.Lease}, or {@code null} if the gate is held
     */
    public SessionTurnGate.Lease acquire(Object sessionKey) {
        if (sessionKey == null) {
            return null;
        }
        return gateFor(sessionKey).acquire();
    }

    /** @return true if a turn is currently in flight for {@code sessionKey} */
    public boolean isHeld(Object sessionKey) {
        if (sessionKey == null) {
            return false;
        }
        SessionTurnGate gate;
        synchronized (gates) {
            gate = gates.get(sessionKey);
        }
        return gate != null && gate.isHeld();
    }

    private SessionTurnGate gateFor(Object sessionKey) {
        synchronized (gates) {
            SessionTurnGate gate = gates.get(sessionKey);
            if (gate == null) {
                gate = new SessionTurnGate();
                gates.put(sessionKey, gate);
            }
            return gate;
        }
    }

    /** Test/diagnostic: number of known gates. */
    public int size() {
        synchronized (gates) {
            return gates.size();
        }
    }

    /** Test only: drop all gates. Not used in production. */
    public void clearForTest() {
        synchronized (gates) {
            gates.clear();
        }
    }
}
