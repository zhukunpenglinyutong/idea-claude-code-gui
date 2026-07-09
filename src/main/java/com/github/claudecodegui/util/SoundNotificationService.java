package com.github.claudecodegui.util;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import javazoom.jl.decoder.JavaLayerException;
import javazoom.jl.player.Player;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.Clip;
import javax.sound.sampled.LineEvent;
import javax.sound.sampled.UnsupportedAudioFileException;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.URI;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Sound notification service
 * Responsible for playing notification sounds when a task completes
 */
public class SoundNotificationService {

    private static final Logger LOG = Logger.getInstance(SoundNotificationService.class);

    /**
     * Built-in sound resources: soundId -> resource path.
     * Insertion order preserved for UI display.
     */
    public static final Map<String, String> SOUND_RESOURCES;

    static {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("default", "/sounds/success.wav");
        map.put("chime", "/sounds/chime.wav");
        map.put("bell", "/sounds/bell.wav");
        map.put("ding", "/sounds/ding.wav");
        map.put("success", "/sounds/task-complete.wav");
        SOUND_RESOURCES = Collections.unmodifiableMap(map);
    }

    // Singleton pattern
    private static volatile SoundNotificationService instance;

    private SoundNotificationService() {
    }

    public static SoundNotificationService getInstance() {
        if (instance == null) {
            synchronized (SoundNotificationService.class) {
                if (instance == null) {
                    instance = new SoundNotificationService();
                }
            }
        }
        return instance;
    }

    /**
     * Notification kinds. Each has its own selected sound; both share the global enable / focus
     * gates, and MANUAL_ACTION additionally has its own enable toggle.
     * Package-private so the gate decision can be unit-tested.
     */
    enum Kind { TASK_COMPLETE, MANUAL_ACTION }

    /**
     * Play task completion notification sound based on user settings.
     */
    public void playTaskCompleteSound() {
        playConfigured(Kind.TASK_COMPLETE);
    }

    /**
     * Play the "manual action required" notification sound (permission / question / plan approval)
     * based on user settings. Shares the enable / only-when-unfocused gates with the task-complete
     * sound, but uses its own selected sound.
     */
    public void playManualActionRequiredSound() {
        playConfigured(Kind.MANUAL_ACTION);
    }

    /**
     * Read settings and, if enabled and not gated by focus, play the sound configured for {@code kind}.
     */
    private void playConfigured(Kind kind) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                CodemossSettingsService settings = new CodemossSettingsService();

                if (!shouldPlay(settings, kind)) {
                    return;
                }

                String soundId = kind == Kind.TASK_COMPLETE
                        ? settings.getSelectedSound()
                        : settings.getManualActionSoundId();
                String customPath = kind == Kind.TASK_COMPLETE
                        ? settings.getCustomSoundPath()
                        : settings.getManualActionCustomSoundPath();

                // "custom" with no saved path: fall back to this kind's own default rather than the
                // shared built-in default playBySelection would otherwise use (the task-complete sound).
                if ("custom".equals(soundId) && (customPath == null || customPath.trim().isEmpty())) {
                    soundId = kind == Kind.TASK_COMPLETE ? "default" : "bell";
                }

                playBySelection(soundId, customPath);
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to play notification sound: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Decide whether the sound for {@code kind} should play, given the current settings.
     *
     * <p>Both kinds share the global enable and only-when-unfocused gates; MANUAL_ACTION is
     * additionally gated by its own {@code manualActionSoundEnabled} toggle, so the two sound events
     * can be switched independently. Package-private for unit testing.
     */
    boolean shouldPlay(CodemossSettingsService settings, Kind kind) throws java.io.IOException {
        if (!settings.getSoundNotificationEnabled()) {
            LOG.debug("[SoundNotification] Sound notification is disabled");
            return false;
        }
        if (settings.getSoundOnlyWhenUnfocused() && ApplicationManager.getApplication().isActive()) {
            LOG.debug("[SoundNotification] IDE window is focused, skipping notification sound");
            return false;
        }
        if (kind == Kind.MANUAL_ACTION && !settings.getManualActionSoundEnabled()) {
            LOG.debug("[SoundNotification] Manual action sound is disabled");
            return false;
        }
        return true;
    }

    /**
     * Play sound by selection: built-in soundId or custom file path.
     */
    private void playBySelection(String soundId, String customPath) throws Exception {
        if ("custom".equals(soundId)) {
            String normalizedCustomPath = normalizeSoundPath(customPath);
            if (normalizedCustomPath != null && !normalizedCustomPath.isEmpty()) {
                LOG.debug("[SoundNotification] Playing custom sound: " + normalizedCustomPath);
                playFromFile(normalizedCustomPath);
            } else {
                LOG.debug("[SoundNotification] Custom selected but no path, falling back to default");
                playFromResource(SOUND_RESOURCES.get("default"));
            }
        } else {
            String resourcePath = SOUND_RESOURCES.getOrDefault(soundId, SOUND_RESOURCES.get("default"));
            LOG.debug("[SoundNotification] Playing built-in sound: " + soundId);
            playFromResource(resourcePath);
        }
    }

    /**
     * Test play a sound (for settings preview).
     *
     * @param soundId    sound ID ("default", "chime", "bell", "ding", "success", "custom")
     * @param customPath custom file path (only used when soundId is "custom")
     */
    public void testPlaySound(String soundId, String customPath) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                playBySelection(
                        soundId != null ? soundId : "default",
                        customPath
                );
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to play test sound: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Play audio from a bundled resource.
     */
    private void playFromResource(String resourcePath) throws Exception {
        try (InputStream rawStream = getClass().getResourceAsStream(resourcePath)) {
            if (rawStream == null) {
                LOG.warn("[SoundNotification] Sound resource not found: " + resourcePath);
                return;
            }

            // Wrap with BufferedInputStream because AudioSystem requires mark/reset support
            try (BufferedInputStream bufferedStream = new BufferedInputStream(rawStream);
                    AudioInputStream audioIn = AudioSystem.getAudioInputStream(bufferedStream)) {
                playAudioStream(audioIn);
            }
        }
    }

    /**
     * Normalize user provided sound path (supports file:// URI).
     */
    private String normalizeSoundPath(String filePath) {
        if (filePath == null) {
            return null;
        }

        String normalized = filePath.trim();
        if (normalized.isEmpty()) {
            return normalized;
        }

        // Remove wrapping quotes to avoid lookup failures on Windows.
        if (normalized.length() >= 2 && normalized.startsWith("\"") && normalized.endsWith("\"")) {
            normalized = normalized.substring(1, normalized.length() - 1);
        }

        if (normalized.startsWith("file://")) {
            try {
                normalized = new File(new URI(normalized)).getPath();
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to parse file URI: " + normalized + " - " + e.getMessage());
            }
        }

        return normalized;
    }

    /**
     * Play audio from a file.
     */
    private void playFromFile(String rawPath) throws Exception {
        String normalizedPath = normalizeSoundPath(rawPath);
        if (normalizedPath == null || normalizedPath.isEmpty()) {
            LOG.warn("[SoundNotification] Custom sound path is empty");
            return;
        }

        File file = new File(normalizedPath);
        if (!file.exists() || !file.canRead()) {
            LOG.warn("[SoundNotification] Sound file not found or not readable: " + file.getAbsolutePath());
            return;
        }

        String fileName = file.getName().toLowerCase(Locale.ROOT);

        // Decode and play MP3 files with JLayer on a background thread
        if (fileName.endsWith(".mp3")) {
            playMp3(file);
            return;
        }

        // Play WAV and AIFF files with the Java standard library
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            playAudioStream(audioIn);
        }
    }

    /**
     * Max playback time for MP3 files (seconds).
     * Prevents a corrupted/oversized file from blocking the pooled thread indefinitely.
     */
    private static final int MP3_PLAYBACK_TIMEOUT_SECONDS = 30;

    /**
     * Play MP3 with JLayer (called from a background thread and blocks until playback completes or times out).
     */
    private void playMp3(File file) throws Exception {
        try (BufferedInputStream bufferedStream = new BufferedInputStream(new FileInputStream(file))) {
            Player player = new Player(bufferedStream);
            CountDownLatch latch = new CountDownLatch(1);

            Thread playThread = new Thread(() -> {
                try {
                    player.play();
                } catch (JavaLayerException e) {
                    LOG.warn("[SoundNotification] MP3 playback error: " + e.getMessage());
                } finally {
                    latch.countDown();
                }
            }, "SoundNotification-MP3");
            playThread.setDaemon(true);
            playThread.start();

            if (!latch.await(MP3_PLAYBACK_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                LOG.warn("[SoundNotification] MP3 playback timed out after " + MP3_PLAYBACK_TIMEOUT_SECONDS + "s");
                player.close();
                playThread.interrupt();
            }
        } catch (JavaLayerException e) {
            throw new Exception("Failed to decode MP3: " + e.getMessage(), e);
        }
    }

    /**
     * Play an audio stream and block until playback completes.
     */
    private void playAudioStream(AudioInputStream audioIn) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        Clip clip = AudioSystem.getClip();
        clip.addLineListener(event -> {
            if (event.getType() == LineEvent.Type.STOP) {
                latch.countDown();
            }
        });
        clip.open(audioIn);
        clip.start();

        // Wait for playback to complete (max 10 seconds)
        latch.await(10, TimeUnit.SECONDS);

        if (clip.isOpen()) {
            clip.close();
        }
    }

    /**
     * Validate whether an audio file is usable.
     *
     * @param filePath file path
     * @return validation result, including success state and error information
     */
    public ValidationResult validateSoundFile(String filePath) {
        String normalizedPath = normalizeSoundPath(filePath);
        if (normalizedPath == null || normalizedPath.isEmpty()) {
            return new ValidationResult(true, null); // An empty path means the default sound should be used
        }

        File file = new File(normalizedPath);

        if (!file.exists()) {
            return new ValidationResult(false, "File not found");
        }

        if (!file.canRead()) {
            return new ValidationResult(false, "File is not readable");
        }

        String lowerPath = normalizedPath.toLowerCase(Locale.ROOT);
        if (!lowerPath.endsWith(".wav") && !lowerPath.endsWith(".mp3") && !lowerPath.endsWith(".aiff")) {
            return new ValidationResult(false, "Only WAV, MP3, AIFF formats are supported");
        }

        // MP3 playback uses JLayer, so skip AudioSystem format validation
        if (lowerPath.endsWith(".mp3")) {
            return new ValidationResult(true, null);
        }

        // For WAV and AIFF, try loading to validate format
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            return new ValidationResult(true, null);
        } catch (UnsupportedAudioFileException e) {
            return new ValidationResult(false, "Unsupported audio format");
        } catch (Exception e) {
            return new ValidationResult(false, "Cannot read audio file: " + e.getMessage());
        }
    }

    /**
     * Validation result
     */
    public record ValidationResult(boolean valid, String errorMessage) {
    }
}
