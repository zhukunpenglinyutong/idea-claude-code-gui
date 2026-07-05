package com.github.claudecodegui.notifications;

import com.github.claudecodegui.interaction.FuturePermissionDecisionTarget;
import com.github.claudecodegui.interaction.UserInteractionService;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Unit test for {@link AskUserQuestionReminderToastListener}, with a fake {@link AskUserQuestionReminder}
 * (no real toast). The reminder must fire only for AskUserQuestion interactions.
 */
public class AskUserQuestionReminderToastListenerTest {

    private static final class CountingReminder implements AskUserQuestionReminder {
        private int count;

        @Override
        public void remind() {
            count++;
        }
    }

    @Test
    public void remindsOnlyForAskUserQuestion() {
        UserInteractionService service = new UserInteractionService();
        CountingReminder reminder = new CountingReminder();
        service.addListener(new AskUserQuestionReminderToastListener(reminder));

        service.requestPermission("ch", "Edit", new JsonObject(), null, null,
                new FuturePermissionDecisionTarget());
        assertEquals("permission requested -> no reminder", 0, reminder.count);

        service.requestAskUserQuestion("auq-1", new JsonObject());
        assertEquals("ask requested -> reminder once", 1, reminder.count);

        service.requestPlanApproval("plan-1", new JsonObject());
        assertEquals("plan requested -> no additional reminder", 1, reminder.count);
    }
}
