package com.github.claudecodegui.notifications;

import com.github.claudecodegui.interaction.FuturePermissionDecisionTarget;
import com.github.claudecodegui.interaction.SessionPermissionDecisionTarget;
import com.github.claudecodegui.interaction.UserInteractionService;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Unit test for {@link SoundUserInteractionListener}, with a fake {@link ManualActionSoundPlayer}
 * (no real audio).
 *
 * <p>Proves #1336 is satisfied for <em>every</em> requested interaction type — crucially including
 * both permission paths (file-watcher and session-callback), which is exactly what PR-1b made
 * possible.
 */
public class SoundUserInteractionListenerTest {

    private static final class CountingPlayer implements ManualActionSoundPlayer {
        private int count;

        @Override
        public void playManualActionRequiredSound() {
            count++;
        }
    }

    @Test
    public void playsSoundForEveryRequestedInteractionType() {
        UserInteractionService service = new UserInteractionService();
        CountingPlayer player = new CountingPlayer();
        service.addListener(new SoundUserInteractionListener(player));

        // File-watcher permission path.
        service.requestPermission("ch-file", "Edit", new JsonObject(), null, null,
                new FuturePermissionDecisionTarget());
        assertEquals("file-watcher permission requested -> sound", 1, player.count);

        // Session-callback permission path (the path that used to be missed).
        service.requestPermission("ch-session", "Edit", new JsonObject(), null, null,
                new SessionPermissionDecisionTarget(() -> null, "ch-session", () -> { }));
        assertEquals("session-callback permission requested -> sound", 2, player.count);

        // AskUserQuestion.
        service.requestAskUserQuestion("auq-1", new JsonObject());
        assertEquals("ask requested -> sound", 3, player.count);

        // PlanApproval.
        service.requestPlanApproval("plan-1", new JsonObject());
        assertEquals("plan requested -> sound", 4, player.count);
    }
}
