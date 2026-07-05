package com.github.claudecodegui.notifications;

/**
 * Shows the AskUserQuestion reminder toast. A tiny seam so
 * {@link AskUserQuestionReminderToastListener} can be unit-tested without a real toast / project; the
 * production wiring is {@code () -> SystemNotificationService.getInstance().showAskUserQuestionReminderToast(project)}.
 */
@FunctionalInterface
public interface AskUserQuestionReminder {
    void remind();
}
