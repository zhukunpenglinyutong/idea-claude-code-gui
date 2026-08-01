package com.github.claudecodegui.permission;

import com.github.claudecodegui.handler.diff.DiffAction;
import com.github.claudecodegui.handler.diff.DiffResult;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Pure-logic coverage for Remote completion of a desktop diff review. */
public class DiffReviewControlTest {

    @Test
    public void remoteAllowCompletesUnderlyingDiffWithProposedContent() {
        CompletableFuture<DiffResult> diff = new CompletableFuture<>();
        DiffReviewService.ReviewHandle handle = handle(diff, "PROPOSED");

        assertTrue(handle.resolve(true, false));
        assertEquals(DiffAction.APPLY, diff.join().getAction());
        assertEquals("PROPOSED", diff.join().getFinalContent());
    }

    @Test
    public void remoteAllowAlwaysPreservesDecisionKind() {
        CompletableFuture<DiffResult> diff = new CompletableFuture<>();
        DiffReviewService.ReviewHandle handle = handle(diff, "PROPOSED");

        assertTrue(handle.resolve(true, true));
        assertEquals(DiffAction.APPLY_ALWAYS, diff.join().getAction());
    }

    @Test
    public void remoteDenyRejectsAndFirstCompletionWins() {
        CompletableFuture<DiffResult> diff = new CompletableFuture<>();
        DiffReviewService.ReviewHandle handle = handle(diff, "PROPOSED");

        assertTrue(handle.resolve(false, false));
        assertEquals(DiffAction.REJECT, diff.join().getAction());
        assertFalse(handle.resolve(true, false));
        assertEquals(DiffAction.REJECT, diff.join().getAction());
    }

    private static DiffReviewService.ReviewHandle handle(
            CompletableFuture<DiffResult> diff, String proposedContent) {
        CompletableFuture<DiffReviewResult> review = diff.thenApply(result ->
                result.isApplied()
                        ? DiffReviewResult.accepted(result.getFinalContent(), "test.txt")
                        : DiffReviewResult.rejected("test.txt"));
        return new DiffReviewService.ReviewHandle(diff, review, proposedContent);
    }
}
