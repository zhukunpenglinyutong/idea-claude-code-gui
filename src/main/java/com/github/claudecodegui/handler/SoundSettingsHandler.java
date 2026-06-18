package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.SoundNotificationService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Handles sound notification configuration and playback messages.
 */
public class SoundSettingsHandler {

    private static final Logger LOG = Logger.getInstance(SoundSettingsHandler.class);

    private final HandlerContext context;
    private final CodemossSettingsService settingsService;
    private final Gson gson = new Gson();

    public SoundSettingsHandler(HandlerContext context) {
        this.context = context;
        this.settingsService = context.getSettingsService();
    }

    /**
     * Gets sound notification configuration.
     */
    public void handleGetSoundNotificationConfig() {
        try {
            boolean enabled = settingsService.getSoundNotificationEnabled();
            boolean onlyWhenUnfocused = settingsService.getSoundOnlyWhenUnfocused();
            String selectedSound = settingsService.getSelectedSound();
            String customPath = settingsService.getCustomSoundPath();
            String manualActionSound = settingsService.getManualActionSoundId();
            String manualActionCustomPath = settingsService.getManualActionCustomSoundPath();

            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("enabled", enabled);
                response.addProperty("onlyWhenUnfocused", onlyWhenUnfocused);
                response.addProperty("selectedSound", selectedSound);
                response.addProperty("customSoundPath", customPath != null ? customPath : "");
                response.addProperty("manualActionSoundId", manualActionSound);
                response.addProperty("manualActionCustomSoundPath", manualActionCustomPath != null ? manualActionCustomPath : "");
                context.callJavaScript("window.updateSoundNotificationConfig", context.escapeJs(gson.toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to get sound notification config: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("enabled", false);
                response.addProperty("onlyWhenUnfocused", false);
                response.addProperty("selectedSound", "default");
                response.addProperty("customSoundPath", "");
                response.addProperty("manualActionSoundId", "bell");
                response.addProperty("manualActionCustomSoundPath", "");
                context.callJavaScript("window.updateSoundNotificationConfig", context.escapeJs(gson.toJson(response)));
            });
        }
    }

    /**
     * Set sound notification enabled state.
     */
    public void handleSetSoundNotificationEnabled(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json != null && json.has("enabled") && json.get("enabled").getAsBoolean();

            settingsService.setSoundNotificationEnabled(enabled);

            LOG.info("[SoundSettingsHandler] Set sound notification enabled: " + enabled);

            dispatchSoundConfigUpdate();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set sound notification enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs("Failed to save sound notification config: " + e.getMessage()));
            });
        }
    }

    /**
     * Set sound only-when-unfocused state.
     */
    public void handleSetSoundOnlyWhenUnfocused(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean onlyWhenUnfocused = json != null && json.has("onlyWhenUnfocused") && json.get("onlyWhenUnfocused").getAsBoolean();

            settingsService.setSoundOnlyWhenUnfocused(onlyWhenUnfocused);

            LOG.info("[SoundSettingsHandler] Set sound only when unfocused: " + onlyWhenUnfocused);

            dispatchSoundConfigUpdate();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set sound only when unfocused: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs("Failed to save sound notification config: " + e.getMessage()));
            });
        }
    }

    /**
     * Set selected sound ID.
     */
    public void handleSetSelectedSound(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String soundId = json != null && json.has("soundId") && !json.get("soundId").isJsonNull()
                ? json.get("soundId").getAsString() : "default";

            settingsService.setSelectedSound(soundId);

            dispatchSoundConfigUpdate();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set selected sound: " + e.getMessage(), e);
        }
    }

    /**
     * Set custom sound file path.
     */
    public void handleSetCustomSoundPath(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String path = json != null && json.has("path") && !json.get("path").isJsonNull()
                ? json.get("path").getAsString() : null;

            // Validate file
            if (path != null && !path.isEmpty()) {
                SoundNotificationService.ValidationResult validation =
                    SoundNotificationService.getInstance().validateSoundFile(path);

                if (!validation.valid()) {
                    final String errorMsg = validation.errorMessage();
                    ApplicationManager.getApplication().invokeLater(() -> {
                        context.callJavaScript("window.showError", context.escapeJs("Invalid audio file: " + errorMsg));
                    });
                    return;
                }
            }

            settingsService.setCustomSoundPath(path);

            LOG.debug("[SoundSettingsHandler] Set custom sound path: " + path);

            dispatchSoundConfigUpdate();
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showSuccessI18n", context.escapeJs("settings.basic.soundNotification.customSoundSaved"));
            });
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set custom sound path: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs("Failed to save custom sound: " + e.getMessage()));
            });
        }
    }

    /**
     * Set the selected sound ID for the "manual action required" notification.
     */
    public void handleSetManualActionSound(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String soundId = json != null && json.has("soundId") && !json.get("soundId").isJsonNull()
                ? json.get("soundId").getAsString() : "bell";

            settingsService.setManualActionSoundId(soundId);

            dispatchSoundConfigUpdate();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set manual action sound: " + e.getMessage(), e);
        }
    }

    /**
     * Set the custom sound file path for the "manual action required" notification.
     */
    public void handleSetManualActionCustomSoundPath(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String path = json != null && json.has("path") && !json.get("path").isJsonNull()
                ? json.get("path").getAsString() : null;

            if (path != null && !path.isEmpty()) {
                SoundNotificationService.ValidationResult validation =
                    SoundNotificationService.getInstance().validateSoundFile(path);

                if (!validation.valid()) {
                    final String errorMsg = validation.errorMessage();
                    ApplicationManager.getApplication().invokeLater(() -> {
                        context.callJavaScript("window.showError", context.escapeJs("Invalid audio file: " + errorMsg));
                    });
                    return;
                }
            }

            settingsService.setManualActionCustomSoundPath(path);

            LOG.debug("[SoundSettingsHandler] Set manual action custom sound path: " + path);

            dispatchSoundConfigUpdate();
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showSuccessI18n", context.escapeJs("settings.basic.soundNotification.customSoundSaved"));
            });
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set manual action custom sound path: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                context.callJavaScript("window.showError", context.escapeJs("Failed to save custom sound: " + e.getMessage()));
            });
        }
    }

    /**
     * Test play a sound by soundId + optional custom path.
     */
    public void handleTestSound(String content) {
        try {
            String soundId = "default";
            String path = null;
            if (content != null && !content.isEmpty()) {
                JsonObject json = gson.fromJson(content, JsonObject.class);
                if (json != null && json.has("soundId") && !json.get("soundId").isJsonNull()) {
                    soundId = json.get("soundId").getAsString();
                }
                if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
                    path = json.get("path").getAsString();
                }
            }

            LOG.debug("[SoundSettingsHandler] Testing sound: " + soundId);
            SoundNotificationService.getInstance().testPlaySound(soundId, path);
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to test sound: " + e.getMessage(), e);
        }
    }

    /**
     * Open file chooser for selecting a sound file.
     */
    public void handleBrowseSoundFile() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                com.intellij.openapi.fileChooser.FileChooserDescriptor descriptor =
                    new com.intellij.openapi.fileChooser.FileChooserDescriptor(
                        true, false, false, false, false, false
                    )
                    .withFileFilter(file -> {
                        String ext = file.getExtension();
                        return ext != null && (
                            ext.equalsIgnoreCase("wav") ||
                            ext.equalsIgnoreCase("mp3") ||
                            ext.equalsIgnoreCase("aiff")
                        );
                    })
                    .withTitle("Select Sound File")
                    .withDescription("Select a WAV, MP3, or AIFF audio file");

                com.intellij.openapi.fileChooser.FileChooser.chooseFile(
                    descriptor,
                    context.getProject(),
                    null,
                    file -> {
                        if (file != null) {
                            String path = file.getPath();

                            // Auto-save the selected path and set selectedSound to "custom"
                            boolean enabled = false;
                            try {
                                enabled = settingsService.getSoundNotificationEnabled();
                                settingsService.setCustomSoundPath(path);
                                settingsService.setSelectedSound("custom");
                            } catch (Exception e) {
                                LOG.warn("[SoundSettingsHandler] Failed to auto-save selected sound path: " + e.getMessage());
                            }

                            JsonObject response = new JsonObject();
                            response.addProperty("enabled", enabled);
                            response.addProperty("selectedSound", "custom");
                            response.addProperty("customSoundPath", path);
                            context.callJavaScript("window.updateSoundNotificationConfig",
                                context.escapeJs(gson.toJson(response)));
                            context.callJavaScript("window.showSuccessI18n",
                                context.escapeJs("settings.basic.soundNotification.customSoundSaved"));
                        }
                    }
                );
            } catch (Exception e) {
                LOG.error("[SoundSettingsHandler] Failed to open file chooser: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Reads all sound config fields from settingsService, builds a JsonObject,
     * and dispatches it to the frontend via window.updateSoundNotificationConfig.
     * Must be called on a non-EDT thread; scheduling onto EDT is handled internally.
     */
    private void dispatchSoundConfigUpdate() {
        boolean enabled;
        boolean onlyWhenUnfocused;
        String selectedSound;
        String customPath;
        String manualActionSound;
        String manualActionCustomPath;

        try {
            enabled = settingsService.getSoundNotificationEnabled();
            onlyWhenUnfocused = settingsService.getSoundOnlyWhenUnfocused();
            selectedSound = settingsService.getSelectedSound();
            customPath = settingsService.getCustomSoundPath();
            manualActionSound = settingsService.getManualActionSoundId();
            manualActionCustomPath = settingsService.getManualActionCustomSoundPath();
        } catch (Exception e) {
            enabled = false;
            onlyWhenUnfocused = false;
            selectedSound = "default";
            customPath = null;
            manualActionSound = "bell";
            manualActionCustomPath = null;
        }

        final boolean finalEnabled = enabled;
        final boolean finalOnlyWhenUnfocused = onlyWhenUnfocused;
        final String finalSelectedSound = selectedSound;
        final String finalCustomPath = customPath != null ? customPath : "";
        final String finalManualActionSound = manualActionSound;
        final String finalManualActionCustomPath = manualActionCustomPath != null ? manualActionCustomPath : "";

        ApplicationManager.getApplication().invokeLater(() -> {
            JsonObject response = new JsonObject();
            response.addProperty("enabled", finalEnabled);
            response.addProperty("onlyWhenUnfocused", finalOnlyWhenUnfocused);
            response.addProperty("selectedSound", finalSelectedSound);
            response.addProperty("customSoundPath", finalCustomPath);
            response.addProperty("manualActionSoundId", finalManualActionSound);
            response.addProperty("manualActionCustomSoundPath", finalManualActionCustomPath);
            context.callJavaScript("window.updateSoundNotificationConfig", context.escapeJs(gson.toJson(response)));
        });
    }

    /**
     * Open a file chooser for selecting the "manual action required" custom sound file.
     */
    public void handleBrowseManualActionSoundFile() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                com.intellij.openapi.fileChooser.FileChooserDescriptor descriptor =
                    new com.intellij.openapi.fileChooser.FileChooserDescriptor(
                        true, false, false, false, false, false
                    )
                    .withFileFilter(file -> {
                        String ext = file.getExtension();
                        return ext != null && (
                            ext.equalsIgnoreCase("wav") ||
                            ext.equalsIgnoreCase("mp3") ||
                            ext.equalsIgnoreCase("aiff")
                        );
                    })
                    .withTitle("Select Sound File")
                    .withDescription("Select a WAV, MP3, or AIFF audio file");

                com.intellij.openapi.fileChooser.FileChooser.chooseFile(
                    descriptor,
                    context.getProject(),
                    null,
                    file -> {
                        if (file != null) {
                            String path = file.getPath();
                            try {
                                settingsService.setManualActionCustomSoundPath(path);
                                settingsService.setManualActionSoundId("custom");
                            } catch (Exception e) {
                                LOG.warn("[SoundSettingsHandler] Failed to auto-save manual action sound path: " + e.getMessage());
                            }
                            dispatchSoundConfigUpdate();
                            context.callJavaScript("window.showSuccessI18n",
                                context.escapeJs("settings.basic.soundNotification.customSoundSaved"));
                        }
                    }
                );
            } catch (Exception e) {
                LOG.error("[SoundSettingsHandler] Failed to open file chooser: " + e.getMessage(), e);
            }
        });
    }
}
