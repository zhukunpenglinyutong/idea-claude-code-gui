package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for the session_updated reload coalescing + staleness guard.
 *
 * <p>When background-task completions arrive (via the daemon's session_updated
 * event) they trigger a server reload of the current session. Reloads are
 * coalesced so overlapping completions never run {@code loadFromServer()}
 * concurrently, and — crucially — a reload that was started for session A must
 * never run against (or be re-driven against) session B after the user has
 * navigated away on the EDT.
 *
 * <p>The decision logic is extracted into the pure static
 * {@link ClaudeChatWindow#decideReloadCompletion} so it can be tested without
 * constructing a full ClaudeChatWindow (which needs a Project, JBCefBrowser,
 * etc.).
 */
public class ClaudeChatWindowReloadCoalescingTest {

    // =========================================================================
    // Happy path: pending follow-up collapses into another reload
    // =========================================================================

    @Test
    public void pendingFollowUpOnSameLiveSessionRunsAgain() {
        assertTrue(
                "a pending reload for the same live session should trigger a follow-up reload",
                ClaudeChatWindow.decideReloadCompletion(
                        /* pending */ true,
                        /* disposed */ false,
                        /* sessionMatches */ true));
    }

    // =========================================================================
    // Stale-session guard: the core fix for the reload race
    // =========================================================================

    @Test
    public void pendingFollowUpForReplacedSessionDoesNotRunAgain() {
        // The session was switched on the EDT (new-session / restart) while the
        // reload was in flight. The pending flag belongs to the OLD session and
        // must NOT trigger a reload against the new one — that would load the
        // wrong session's history through the new session's callback adapter.
        assertFalse(
                "a pending reload bound to a session the user navigated away from must not re-run",
                ClaudeChatWindow.decideReloadCompletion(
                        /* pending */ true,
                        /* disposed */ false,
                        /* sessionMatches */ false));
    }

    @Test
    public void noPendingFollowUpFinishesEvenOnSameSession() {
        // Nothing queued → finish. The in-flight flag is cleared by the caller.
        assertFalse(
                "no pending reload should finish the coalescing cycle",
                ClaudeChatWindow.decideReloadCompletion(
                        /* pending */ false,
                        /* disposed */ false,
                        /* sessionMatches */ true));
    }

    @Test
    public void disposedWindowNeverRunsAgainEvenWithPendingAndMatchingSession() {
        // After dispose we must not schedule any more reloads, regardless of
        // pending state or session identity — the browser and callback adapter
        // are torn down.
        assertFalse(
                "a disposed window must not re-run a reload even if a follow-up is pending",
                ClaudeChatWindow.decideReloadCompletion(
                        /* pending */ true,
                        /* disposed */ true,
                        /* sessionMatches */ true));
    }

    // =========================================================================
    // Remaining input combinations — full 8-of-8 decision-table coverage.
    //
    // The four true-returning-blocked cases below each have at least one of
    // the three conditions false, so the result is always false. Named for the
    // condition that would otherwise enable a re-run, to make the intent
    // readable. (true,true,true) is already covered by
    // disposedWindowNeverRunsAgainEvenWithPendingAndMatchingSession above and
    // is not re-asserted here to avoid a duplicate.
    // =========================================================================

    @Test
    public void allConditionsFalseFinishes() {
        // (false, false, false): nothing pending, live, no match → finish.
        assertFalse(ClaudeChatWindow.decideReloadCompletion(false, false, false));
    }

    @Test
    public void pendingAloneInsufficientWhenDisposed() {
        // (true, true, false): pending is set, but disposed + no match → finish.
        assertFalse(ClaudeChatWindow.decideReloadCompletion(true, true, false));
    }

    @Test
    public void disposedWithoutPendingFinishes() {
        // (false, true, false): disposed, nothing pending → finish.
        assertFalse(ClaudeChatWindow.decideReloadCompletion(false, true, false));
    }

    @Test
    public void disposedAndMatchButNoPendingFinishes() {
        // (false, true, true): session matches and window was live at start,
        // but no pending follow-up → finish.
        assertFalse(ClaudeChatWindow.decideReloadCompletion(false, true, true));
    }
}
