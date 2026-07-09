package com.github.claudecodegui.notifications;

/**
 * Plays the "manual action required" notification sound. A tiny seam so
 * {@link SoundUserInteractionListener} can be unit-tested without real audio; the production wiring
 * is {@code SoundNotificationService.getInstance()::playManualActionRequiredSound}.
 */
@FunctionalInterface
public interface ManualActionSoundPlayer {
    void playManualActionRequiredSound();
}
