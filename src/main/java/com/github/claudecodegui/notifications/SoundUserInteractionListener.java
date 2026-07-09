package com.github.claudecodegui.notifications;

import com.github.claudecodegui.interaction.PendingUserInteraction;
import com.github.claudecodegui.interaction.UserInteractionListener;

/**
 * Plays the manual-action sound whenever a user interaction is requested.
 *
 * <p>This is the #1336 feature, implemented purely as an observer on the
 * {@code userInteractionRequested} seam — so it covers every requested interaction (file-watcher
 * permission, session-callback permission, AskUserQuestion, PlanApproval) without any sound logic
 * leaking into the service, handler, presenter or registry.
 *
 * <p>The listener reacts unconditionally; <em>all</em> activation logic (enabled /
 * only-when-unfocused / which sound) lives in {@code SoundNotificationService}.
 */
public final class SoundUserInteractionListener implements UserInteractionListener {

    private final ManualActionSoundPlayer player;

    public SoundUserInteractionListener(ManualActionSoundPlayer player) {
        this.player = player;
    }

    @Override
    public void userInteractionRequested(PendingUserInteraction interaction) {
        player.playManualActionRequiredSound();
    }
}
