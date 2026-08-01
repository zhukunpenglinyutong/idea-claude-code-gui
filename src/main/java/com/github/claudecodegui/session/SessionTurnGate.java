package com.github.claudecodegui.session;

import java.util.concurrent.atomic.AtomicReference;

/**
 * Atomic single-turn gate for a {@link ClaudeSession}.
 *
 * <p>Guarantees at most one in-flight turn per session across both the desktop
 * send path ({@code SessionHandler}) and the Remote send path
 * ({@code RemoteChatDispatcher}). Acquire is a single CAS — there is no
 * check-then-act window (TOCTOU) like a {@code busy} flag read would have.
 *
 * <p>A gate is per {@link ClaudeSession} instance and is obtained from
 * {@link SessionTurnGateRegistry}, which keys gates on session identity via a
 * {@link java.util.WeakHashMap} so a closed tab's session can be GC'd without an
 * explicit unregister.
 *
 * <p>A successful {@link #acquire()} returns a {@link Lease} that owns the gate
 * until {@link Lease#release()} is called. Release is also CAS-based: a stale
 * lease (from an earlier turn) cannot release a newer lease that now owns the
 * gate.
 */
public final class SessionTurnGate {

    /** Ownership token held by the active lease. */
    private final AtomicReference<Object> owner = new AtomicReference<>();

    /**
     * Try to acquire the gate.
     *
     * @return a new {@link Lease} if the gate was free, or {@code null} if a turn
     *         is already in flight (caller must reject/queue)
     */
    public Lease acquire() {
        Object token = new Object();
        return owner.compareAndSet(null, token) ? new Lease(this, token) : null;
    }

    /**
     * Release the gate, but only if {@code lease} is still the current owner.
     * A stale lease from a previous turn is a no-op and returns {@code false}.
     */
    boolean release(Lease lease) {
        if (lease == null || lease.gate != this) {
            return false;
        }
        return owner.compareAndSet(lease.token, null);
    }

    /** @return true if a turn currently holds this gate */
    public boolean isHeld() {
        return owner.get() != null;
    }

    /** Ownership handle returned by {@link #acquire()}. */
    public static final class Lease {
        private final SessionTurnGate gate;
        private final Object token;

        Lease(SessionTurnGate gate, Object token) {
            this.gate = gate;
            this.token = token;
        }

        /**
         * Release the gate. Idempotent-ish: a second call is a no-op because the
         * CAS only succeeds while this lease still owns the gate.
         *
         * @return true if this call actually released the gate
         */
        public boolean release() {
            return gate.release(this);
        }
    }
}
