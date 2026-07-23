package com.github.claudecodegui.handler;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodexPetHandlerTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void loadsOnlyVerifiedImageFormatsWithinPetRoot() throws Exception {
        Path tempDir = temporaryFolder.getRoot().toPath();
        Path petDir = Files.createDirectories(tempDir.resolve("pixel-cat"));
        Files.write(petDir.resolve("idle.png"), pngImage(32, 48));
        Files.write(petDir.resolve("broken.png"), pngHeader(32, 48));
        Files.write(petDir.resolve("script.png"), "not an image".getBytes());
        Files.write(petDir.resolve("pet.svg"), "<svg/>".getBytes());

        JsonArray pets = CodexPetHandler.loadPetAssets(tempDir);

        assertEquals(1, pets.size());
        assertEquals("pixel-cat/idle.png", pets.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals("pixel-cat", pets.get(0).getAsJsonObject().get("name").getAsString());
        assertFalse(pets.get(0).getAsJsonObject().has("dataUrl"));
    }

    @Test
    public void returnsEmptyListWhenPetRootDoesNotExist() throws Exception {
        Path tempDir = temporaryFolder.getRoot().toPath();
        assertEquals(0, CodexPetHandler.loadPetAssets(tempDir.resolve("missing")).size());
    }

    @Test
    public void exposesMoreThanTwentyFourInstalledPetsForSearchableSelection() throws Exception {
        Path root = temporaryFolder.newFolder("many-pets").toPath();
        byte[] image = pngImage(8, 8);
        for (int i = 0; i < 30; i++) {
            Path pet = Files.createDirectories(root.resolve("pet-" + i));
            Files.write(pet.resolve("idle.png"), image);
        }

        assertEquals(30, CodexPetHandler.loadPetAssets(root).size());
    }

    @Test
    public void sendsCompactPngPreviewInsteadOfFullPetdexSpriteSheet() throws Exception {
        Path tempDir = temporaryFolder.getRoot().toPath();
        Path petDir = Files.createDirectories(tempDir.resolve("petdex-cat"));
        BufferedImage spriteSheet = new BufferedImage(1536, 1872, BufferedImage.TYPE_INT_ARGB);
        ByteArrayOutputStream source = new ByteArrayOutputStream();
        ImageIO.write(spriteSheet, "png", source);
        Files.write(petDir.resolve("spritesheet.png"), source.toByteArray());

        JsonArray pets = CodexPetHandler.loadPetAssets(tempDir);
        JsonObject previewPayload = CodexPetHandler.loadPetPreview(tempDir, "petdex-cat/spritesheet.png");

        assertEquals(1, pets.size());
        assertTrue(pets.get(0).getAsJsonObject().get("spriteSheet").getAsBoolean());
        String dataUrl = previewPayload.get("dataUrl").getAsString();
        assertTrue(dataUrl.startsWith("data:image/png;base64,"));
        byte[] previewBytes = Base64.getDecoder().decode(dataUrl.substring(dataUrl.indexOf(',') + 1));
        BufferedImage previewImage = ImageIO.read(new ByteArrayInputStream(previewBytes));
        assertEquals(704, previewImage.getWidth());
        assertEquals(96, previewImage.getHeight());
    }

    @Test
    public void ignoresNonImageFilesBeforeApplyingCandidateLimit() throws Exception {
        Path root = temporaryFolder.newFolder("pets-with-metadata").toPath();
        for (int i = 0; i < 350; i++) {
            Files.writeString(root.resolve(String.format("metadata-%03d.json", i)), "{}");
        }
        byte[] image = pngImage(8, 8);
        for (int i = 0; i < 30; i++) {
            Path pet = Files.createDirectories(root.resolve("pet-" + i));
            Files.write(pet.resolve("idle.png"), image);
        }

        assertEquals(30, CodexPetHandler.loadPetAssets(root).size());
    }

    @Test
    public void exposesManagedPetdexAliasWithoutChangingStablePetId() throws Exception {
        Path root = temporaryFolder.newFolder("aliased-pets").toPath();
        Path petDir = Files.createDirectories(root.resolve("same-name-pet"));
        Files.write(petDir.resolve("spritesheet.png"), pngImage(32, 48));
        Files.writeString(petDir.resolve("pet.json"),
                "{\"displayName\":\"Original Name\",\"alias\":\"My Pet\",\"source\":\"petdex\"}",
                StandardCharsets.UTF_8);
        Files.writeString(petDir.resolve(".petdex-installed"), "same-name-pet", StandardCharsets.UTF_8);

        JsonObject pet = CodexPetHandler.loadPetAssets(root).get(0).getAsJsonObject();

        assertEquals("same-name-pet/spritesheet.png", pet.get("id").getAsString());
        assertEquals("My Pet", pet.get("name").getAsString());
        assertEquals("Original Name", pet.get("originalName").getAsString());
        assertEquals("same-name-pet", pet.get("slug").getAsString());
        assertTrue(pet.get("managed").getAsBoolean());
    }

    @Test
    public void ignoresStaleImportDirectoriesFromOlderVersions() throws Exception {
        Path root = temporaryFolder.newFolder("stale-import-root").toPath();
        Path stale = Files.createDirectories(root.resolve(".local-pet-import-crashed"));
        Files.write(stale.resolve("pet.png"), pngImage(16, 16));

        assertEquals(0, CodexPetHandler.loadPetAssets(root).size());
    }

    @Test
    public void updatesImportedAliasWithValidJson() throws Exception {
        Path root = temporaryFolder.newFolder("imported-alias-root").toPath();
        String slug = createLegacyImportedPet(root, "alias-pet", "Alias Pet");

        CodexPetHandler.setImportedPetAlias(root, slug, "Desk Pet");

        Path metadata = root.resolve(slug).resolve("pet.json");
        JsonObject parsed = JsonParser.parseString(Files.readString(metadata, StandardCharsets.UTF_8))
                .getAsJsonObject();
        assertEquals("Desk Pet", parsed.get("alias").getAsString());
        try (java.util.stream.Stream<Path> files = Files.list(metadata.getParent())) {
            assertFalse(files.anyMatch(path -> path.getFileName().toString().startsWith(".pet-metadata-")));
        }
    }

    @Test
    public void serializesConcurrentImportedAliasUpdates() throws Exception {
        Path root = temporaryFolder.newFolder("concurrent-alias-root").toPath();
        String slug = createLegacyImportedPet(root, "concurrent-alias", "Concurrent Alias");
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> first = executor.submit(() -> updateAliasRepeatedly(root, slug, "Desk"));
            Future<?> second = executor.submit(() -> updateAliasRepeatedly(root, slug, "Work"));
            first.get();
            second.get();
        } finally {
            executor.shutdownNow();
        }

        Path metadata = root.resolve(slug).resolve("pet.json");
        JsonObject parsed = JsonParser.parseString(Files.readString(metadata, StandardCharsets.UTF_8))
                .getAsJsonObject();
        String alias = parsed.get("alias").getAsString();
        assertTrue(alias.startsWith("Desk-") || alias.startsWith("Work-"));
    }

    @Test
    public void detectsHatchPetSkillStatesAndBuildsReviewableCommands() throws Exception {
        Path codexRoot = temporaryFolder.newFolder("codex-home").toPath();
        assertEquals("missing", CodexPetHandler.inspectHatchPetSkill(codexRoot).getStatus());

        Path skill = Files.createDirectories(codexRoot.resolve("skills/hatch-pet"));
        Files.writeString(skill.resolve("SKILL.md"), "# Hatch Pet", StandardCharsets.UTF_8);
        assertEquals("broken", CodexPetHandler.inspectHatchPetSkill(codexRoot).getStatus());

        Path scripts = Files.createDirectories(skill.resolve("scripts"));
        Files.writeString(scripts.resolve("prepare_pet_run.py"), "", StandardCharsets.UTF_8);
        Files.writeString(scripts.resolve("validate_atlas.py"), "", StandardCharsets.UTF_8);
        CodexPetHandler.HatchPetStatus installed = CodexPetHandler.inspectHatchPetSkill(codexRoot);
        assertEquals("installed", installed.getStatus());

        JsonObject request = new JsonObject();
        request.addProperty("name", "IDE Cat");
        request.addProperty("description", "A quiet coding companion");
        request.addProperty("style", "pixel");
        request.addProperty("referencePath", "C:\\My Images\\cat.png");
        String command = CodexPetHandler.buildHatchPetCommand("create", request, installed);
        assertTrue(command.startsWith("$hatch-pet Create a Codex-compatible pet"));
        assertTrue(command.contains("Reference image path: \"C:\\My Images\\cat.png\""));
        assertEquals("$skill-installer hatch-pet",
                CodexPetHandler.buildHatchPetCommand("install", new JsonObject(), installed));
    }

    @Test
    public void normalizesCatalogOffsetsToConfiguredPages() {
        assertEquals(0, CodexPetHandler.normalizeCatalogOffset(-1, 25, 12));
        assertEquals(12, CodexPetHandler.normalizeCatalogOffset(12, 25, 12));
        assertEquals(24, CodexPetHandler.normalizeCatalogOffset(100, 25, 12));
        assertEquals(0, CodexPetHandler.normalizeCatalogOffset(12, 0, 12));
        assertEquals(24, CodexPetHandler.normalizeCatalogOffset(30, 70, 24));
        assertEquals(48, CodexPetHandler.normalizeCatalogOffset(200, 70, 24));
    }

    @Test
    public void reportsActionablePetdexNetworkErrors() {
        assertEquals("PETDEX_CONNECT_TIMEOUT",
                CodexPetHandler.errorCode(new HttpConnectTimeoutException("connect timed out")));
        assertEquals("PETDEX_REQUEST_TIMEOUT",
                CodexPetHandler.errorCode(new HttpTimeoutException("request timed out")));
        assertEquals("PET_NOT_FOUND",
                CodexPetHandler.errorCode(new java.io.IOException("PET_NOT_FOUND")));
        assertEquals("PET_ALIAS_UPDATE_FAILED",
                CodexPetHandler.aliasErrorCode(new java.io.IOException("Access is denied")));
    }

    @Test
    public void keepsFrontendSessionTitleForPetBubbles() {
        JsonObject payload = new JsonObject();
        payload.addProperty("tabTitle", "?????????");

        CodexPetHandler.applyFallbackTabTitle(payload, "AI1");

        assertEquals("?????????", payload.get("tabTitle").getAsString());
    }

    @Test
    public void fallsBackToIdeTabTitleWhenSessionTitleIsMissing() {
        JsonObject payload = new JsonObject();

        CodexPetHandler.applyFallbackTabTitle(payload, "AI1");

        assertEquals("AI1", payload.get("tabTitle").getAsString());
    }

    @Test
    public void keepsAuthoritativeDurationAcrossWebviewRestart() {
        JsonObject firstStart = new JsonObject();
        firstStart.addProperty("event", "task_started");
        Long startedAt = CodexPetHandler.applyAuthoritativeDuration(firstStart, null, 1_000L);

        JsonObject restartedWebview = new JsonObject();
        restartedWebview.addProperty("event", "task_started");
        restartedWebview.addProperty("durationMs", 0L);
        startedAt = CodexPetHandler.applyAuthoritativeDuration(restartedWebview, startedAt, 6_000L);

        JsonObject completed = new JsonObject();
        completed.addProperty("event", "task_success");
        completed.addProperty("durationMs", 2_000L);
        Long finished = CodexPetHandler.applyAuthoritativeDuration(completed, startedAt, 11_000L);

        assertEquals(5_000L, restartedWebview.get("durationMs").getAsLong());
        assertEquals(10_000L, completed.get("durationMs").getAsLong());
        assertNull(finished);
    }

    private static byte[] pngHeader(int width, int height) {
        byte[] bytes = new byte[24];
        bytes[0] = (byte) 0x89;
        bytes[1] = 0x50;
        bytes[2] = 0x4e;
        bytes[3] = 0x47;
        bytes[4] = 0x0d;
        bytes[5] = 0x0a;
        bytes[6] = 0x1a;
        bytes[7] = 0x0a;
        writeInt(bytes, 16, width);
        writeInt(bytes, 20, height);
        return bytes;
    }

    private static void updateAliasRepeatedly(Path root, String slug, String prefix) {
        try {
            for (int index = 0; index < 20; index++) {
                CodexPetHandler.setImportedPetAlias(root, slug, prefix + "-" + index);
            }
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String createLegacyImportedPet(Path root, String slug, String displayName) throws Exception {
        Path petDirectory = Files.createDirectories(root.resolve(slug));
        Files.write(petDirectory.resolve("pet.png"), pngImage(32, 32));
        Files.writeString(petDirectory.resolve("pet.json"),
                "{\"displayName\":\"" + displayName + "\",\"source\":\"local-import\"}",
                StandardCharsets.UTF_8);
        Files.writeString(petDirectory.resolve(".codemoss-imported"), slug, StandardCharsets.UTF_8);
        return slug;
    }

    private static byte[] pngImage(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }

    private static void writeInt(byte[] bytes, int offset, int value) {
        bytes[offset] = (byte) (value >>> 24);
        bytes[offset + 1] = (byte) (value >>> 16);
        bytes[offset + 2] = (byte) (value >>> 8);
        bytes[offset + 3] = (byte) value;
    }
}
