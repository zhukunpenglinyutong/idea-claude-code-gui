package com.github.claudecodegui.notifications;

import com.github.claudecodegui.interaction.PendingUserInteraction;
import com.github.claudecodegui.interaction.UserInteractionListener;
import com.github.claudecodegui.interaction.UserInteractionType;

/**
 * Fires the opt-in AskUserQuestion reminder toast whenever an AskUserQuestion interaction is
 * requested — re-integrated from v0.4.7 as an observer on the {@code userInteractionRequested} seam
 * instead of an inline call in {@code showAskUserQuestionDialog}.
 *
 * <p>Reacts only to {@link UserInteractionType#ASK_USER_QUESTION}. The listener always calls the
 * reminder; the opt-in gating stays in {@code SystemNotificationService}.
 */
public final class AskUserQuestionReminderToastListener implements UserInteractionListener {

    private final AskUserQuestionReminder reminder;

    public AskUserQuestionReminderToastListener(AskUserQuestionReminder reminder) {
        this.reminder = reminder;
    }

    @Override
    public void userInteractionRequested(PendingUserInteraction interaction) {
        if (interaction.type() == UserInteractionType.ASK_USER_QUESTION) {
            reminder.remind();
        }
    }
}
