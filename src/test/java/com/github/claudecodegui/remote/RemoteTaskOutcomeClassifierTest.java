package com.github.claudecodegui.remote;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Pure-logic tests for {@link RemoteTaskOutcomeClassifier}.
 *
 * <p>Guards against the Phase 2C-A.1 finding that {@code ClaudeSession.send}'s
 * {@code .exceptionally} swallows errors, so future completion alone must not be
 * read as success.
 */
public class RemoteTaskOutcomeClassifierTest {

    @Test
    public void cleanTerminalIsCompleted() {
        assertEquals(RemoteTaskState.COMPLETED,
                RemoteTaskOutcomeClassifier.classify(false, false, false));
    }

    @Test
    public void failureObservedIsFailed() {
        assertEquals(RemoteTaskState.FAILED,
                RemoteTaskOutcomeClassifier.classify(false, true, false));
    }

    @Test
    public void abortRequestedIsAborted() {
        assertEquals(RemoteTaskState.ABORTED,
                RemoteTaskOutcomeClassifier.classify(true, false, false));
    }

    @Test
    public void abortTakesPrecedenceOverFailure() {
        // An abort may surface as a provider error; abort wins.
        assertEquals(RemoteTaskState.ABORTED,
                RemoteTaskOutcomeClassifier.classify(true, true, false));
    }

    @Test
    public void syncExceptionIsFailed() {
        assertEquals(RemoteTaskState.FAILED,
                RemoteTaskOutcomeClassifier.classify(false, false, true));
    }

    @Test
    public void syncExceptionTakesPrecedence() {
        assertEquals(RemoteTaskState.FAILED,
                RemoteTaskOutcomeClassifier.classify(true, false, true));
    }

    @Test
    public void futureCompletesNormallyButFailureObservedStillFailed() {
        // The key regression guard: future completion (ex == null) with
        // failureObserved must NOT be mislabeled COMPLETED.
        assertEquals(RemoteTaskState.FAILED,
                RemoteTaskOutcomeClassifier.classify(false, true, false));
    }
}
