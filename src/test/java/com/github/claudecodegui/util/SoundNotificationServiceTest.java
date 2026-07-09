package com.github.claudecodegui.util;

import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Test;

import java.io.IOException;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link SoundNotificationService#shouldPlay}, the gate that decides whether a sound
 * plays for a given kind. The two sound events are independently switchable: MANUAL_ACTION has its
 * own enable toggle, while TASK_COMPLETE is unaffected by it; both share the global enable gate.
 *
 * <p>{@code onlyWhenUnfocused} is false in the fake so the focus check (which touches
 * ApplicationManager) is short-circuited and no IDE application is required.
 */
public class SoundNotificationServiceTest {

    private final SoundNotificationService service = SoundNotificationService.getInstance();

    private static final class FakeSettings extends CodemossSettingsService {
        private final boolean globalEnabled;
        private final boolean manualEnabled;

        private FakeSettings(boolean globalEnabled, boolean manualEnabled) {
            this.globalEnabled = globalEnabled;
            this.manualEnabled = manualEnabled;
        }

        @Override
        public boolean getSoundNotificationEnabled() {
            return globalEnabled;
        }

        @Override
        public boolean getSoundOnlyWhenUnfocused() {
            return false;
        }

        @Override
        public boolean getManualActionSoundEnabled() {
            return manualEnabled;
        }
    }

    @Test
    public void manualActionDisabledSuppressesOnlyTheManualSound() throws IOException {
        FakeSettings settings = new FakeSettings(true, false);

        assertFalse("manual-action disabled -> no manual sound",
                service.shouldPlay(settings, SoundNotificationService.Kind.MANUAL_ACTION));
        assertTrue("task-complete is independent of the manual-action toggle",
                service.shouldPlay(settings, SoundNotificationService.Kind.TASK_COMPLETE));
    }

    @Test
    public void manualActionEnabledAllowsTheManualSound() throws IOException {
        FakeSettings settings = new FakeSettings(true, true);

        assertTrue(service.shouldPlay(settings, SoundNotificationService.Kind.MANUAL_ACTION));
        assertTrue(service.shouldPlay(settings, SoundNotificationService.Kind.TASK_COMPLETE));
    }

    @Test
    public void globalDisableSuppressesBoth() throws IOException {
        FakeSettings settings = new FakeSettings(false, true);

        assertFalse(service.shouldPlay(settings, SoundNotificationService.Kind.MANUAL_ACTION));
        assertFalse(service.shouldPlay(settings, SoundNotificationService.Kind.TASK_COMPLETE));
    }
}
