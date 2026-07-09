package com.github.claudecodegui.permission;

import org.junit.Test;

import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link PermissionService#playSoundIfDiffReviewShown}: the diff-review (Apply/Reject)
 * prompt is an IDE-native approval path outside {@code UserInteractionService}, so it plays the
 * manual-action sound directly. Uses a {@link Runnable} seam (no real audio).
 */
public class PermissionServiceTest {

    private int soundCount;
    private final Runnable countingSound = () -> soundCount++;

    @Test
    public void diffReviewPromptPlaysManualActionSoundOnce() {
        boolean shown = PermissionService.playSoundIfDiffReviewShown(new CompletableFuture<>(), countingSound);

        assertTrue("a shown diff-review prompt counts as shown", shown);
        assertEquals("the manual-action sound fires exactly once", 1, soundCount);
    }

    @Test
    public void noReviewFuturePlaysNoSound() {
        boolean shown = PermissionService.playSoundIfDiffReviewShown(null, countingSound);

        assertFalse("no prompt shown -> falls back to the normal path", shown);
        assertEquals("no sound on the fallback path (the normal path plays its own)", 0, soundCount);
    }

    @Test
    public void soundFailureDoesNotBreakTheFlow() {
        boolean shown = PermissionService.playSoundIfDiffReviewShown(new CompletableFuture<>(),
                () -> {
                    throw new RuntimeException("boom");
                });

        assertTrue("a sound failure must never break the permission flow", shown);
    }
}
