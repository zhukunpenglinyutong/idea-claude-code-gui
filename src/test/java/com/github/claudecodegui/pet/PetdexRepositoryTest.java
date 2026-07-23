package com.github.claudecodegui.pet;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.lang.reflect.Field;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class PetdexRepositoryTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void manifestKeepsOnlySafeOfficialEntries() throws Exception {
        String manifest = "{\"pets\":[null,"
                + "{\"slug\":\"safe-pet\",\"displayName\":\"Safe\","
                + "\"spritesheetUrl\":\"https://assets.petdex.dev/pets/safe/sprite.webp\","
                + "\"petJsonUrl\":\"https://assets.petdex.dev/pets/safe/petjson.json\"},"
                + "{\"slug\":\"../escape\",\"displayName\":\"Escape\","
                + "\"spritesheetUrl\":\"https://assets.petdex.dev/x.webp\","
                + "\"petJsonUrl\":\"https://assets.petdex.dev/x.json\"},"
                + "{\"slug\":\"evil-host\",\"displayName\":\"Evil\","
                + "\"spritesheetUrl\":\"https://example.com/x.webp\","
                + "\"petJsonUrl\":\"https://assets.petdex.dev/x.json\"}]}";

        List<PetdexRepository.PetdexPet> pets = PetdexRepository.parseManifest(manifest);

        assertEquals(1, pets.size());
    }

    @Test(expected = IOException.class)
    public void rejectsManifestWithoutAnyValidPets() throws Exception {
        PetdexRepository.parseManifest("{\"pets\":[]}");
    }

    @Test
    public void allowsOnlyHttpsOfficialHostsWithoutCredentialsOrPorts() {
        assertTrue(PetdexRepository.isAllowedRemoteUri(
                URI.create("https://assets.petdex.dev/pets/a/sprite.webp")));
        assertTrue(PetdexRepository.isAllowedRemoteUri(
                URI.create("https://petdex.dev/api/manifest")));
        assertFalse(PetdexRepository.isAllowedRemoteUri(
                URI.create("http://assets.petdex.dev/pets/a/sprite.webp")));
        assertFalse(PetdexRepository.isAllowedRemoteUri(
                URI.create("https://user@assets.petdex.dev/pets/a/sprite.webp")));
        assertFalse(PetdexRepository.isAllowedRemoteUri(
                URI.create("https://assets.petdex.dev:8443/pets/a/sprite.webp")));
        assertFalse(PetdexRepository.isAllowedRemoteUri(
                URI.create("https://assets.petdex.dev.example.com/pets/a/sprite.webp")));
    }

    @Test
    public void validatesInstallSlug() {
        assertTrue(PetdexRepository.isSafeSlug("paper-ledger-spacer"));
        assertFalse(PetdexRepository.isSafeSlug("../paper-ledger-spacer"));
        assertFalse(PetdexRepository.isSafeSlug("UPPERCASE"));
        assertFalse(PetdexRepository.isSafeSlug("a/b"));
    }

    @Test
    public void acceptsFrontendPetdexNetworkBounds() throws Exception {
        PetdexRepository repository = new PetdexRepository(HttpClient.newHttpClient());

        repository.configureNetwork(300, 300, 10);

        assertEquals(300, readIntField(repository, "connectTimeoutSeconds"));
        assertEquals(300, readIntField(repository, "requestTimeoutSeconds"));
        assertEquals(10, readIntField(repository, "retryAttempts"));
    }

    @Test
    public void updatesAndClearsAliasOnlyForManagedInstall() throws Exception {
        Path root = temporaryFolder.newFolder("pets").toPath();
        Path pet = Files.createDirectories(root.resolve("same-name-pet"));
        Path metadata = pet.resolve("pet.json");
        Files.writeString(metadata,
                "{\"displayName\":\"Original\",\"source\":\"petdex\"}",
                StandardCharsets.UTF_8);
        Files.writeString(pet.resolve(".petdex-installed"), "same-name-pet", StandardCharsets.UTF_8);

        PetdexRepository.updateAlias(root, "same-name-pet", "  My   Pet  ");
        JsonObject updated = JsonParser.parseString(Files.readString(metadata)).getAsJsonObject();
        assertEquals("My Pet", updated.get("alias").getAsString());
        assertEquals("Original", updated.get("displayName").getAsString());

        PetdexRepository.updateAlias(root, "same-name-pet", " ");
        JsonObject cleared = JsonParser.parseString(Files.readString(metadata)).getAsJsonObject();
        assertFalse(cleared.has("alias"));
    }

    @Test
    public void rejectsAliasUpdateForUnmanagedPet() throws Exception {
        Path root = temporaryFolder.newFolder("unmanaged-pets").toPath();
        Path pet = Files.createDirectories(root.resolve("local-pet"));
        Files.writeString(pet.resolve("pet.json"), "{}", StandardCharsets.UTF_8);

        try {
            PetdexRepository.updateAlias(root, "local-pet", "Alias");
            fail("Expected unmanaged pet rejection");
        } catch (IOException e) {
            assertEquals("PET_NOT_MANAGED_BY_PLUGIN", e.getMessage());
        }
    }

    @Test
    public void serializesAliasUpdateAndUninstallForTheSamePet() throws Exception {
        Path root = temporaryFolder.newFolder("concurrent-pets").toPath();
        for (int i = 0; i < 20; i++) {
            Path pet = Files.createDirectories(root.resolve("same-name-pet"));
            Files.writeString(pet.resolve("pet.json"),
                    "{\"displayName\":\"Original\",\"source\":\"petdex\"}",
                    StandardCharsets.UTF_8);
            Files.writeString(pet.resolve(".petdex-installed"), "same-name-pet", StandardCharsets.UTF_8);
            CountDownLatch start = new CountDownLatch(1);

            CompletableFuture<Void> aliasUpdate = CompletableFuture.runAsync(() -> {
                await(start);
                try {
                    PetdexRepository.updateAlias(root, "same-name-pet", "Alias");
                } catch (IOException e) {
                    if (!"PET_NOT_INSTALLED".equals(e.getMessage())) {
                        throw new CompletionException(e);
                    }
                }
            });
            CompletableFuture<Void> uninstall = CompletableFuture.runAsync(() -> {
                await(start);
                try {
                    PetdexRepository.uninstall(root, "same-name-pet");
                } catch (IOException e) {
                    throw new CompletionException(e);
                }
            });

            start.countDown();
            CompletableFuture.allOf(aliasUpdate, uninstall).join();
            assertFalse(Files.exists(pet));
        }
    }

    @Test
    public void createsEightFramePngPreviewStrip() throws Exception {
        BufferedImage source = new BufferedImage(
                CodexPetImageSupport.PETDEX_FRAME_WIDTH * CodexPetImageSupport.PETDEX_COLUMNS,
                CodexPetImageSupport.PETDEX_FRAME_HEIGHT,
                BufferedImage.TYPE_INT_ARGB);
        for (int frame = 0; frame < CodexPetImageSupport.PETDEX_COLUMNS; frame++) {
            int color = new Color(frame * 30, 20, 30, 255).getRGB();
            for (int y = 0; y < source.getHeight(); y++) {
                for (int x = frame * CodexPetImageSupport.PETDEX_FRAME_WIDTH;
                     x < (frame + 1) * CodexPetImageSupport.PETDEX_FRAME_WIDTH; x++) {
                    source.setRGB(x, y, color);
                }
            }
        }

        BufferedImage preview = ImageIO.read(new ByteArrayInputStream(
                PetdexRepository.createPreviewPng(source)));

        assertNotNull(preview);
        assertEquals(88 * CodexPetImageSupport.PETDEX_COLUMNS, preview.getWidth());
        assertEquals(96, preview.getHeight());
        assertEquals(source.getRGB(0, 0), preview.getRGB(0, 0));
        assertEquals(source.getRGB(source.getWidth() - 1, 0), preview.getRGB(preview.getWidth() - 1, 0));
    }

    @Test
    public void boundedSubscriberRejectsChunkedBodyPastLimit() {
        PetdexRepository.BoundedBodySubscriber subscriber =
                new PetdexRepository.BoundedBodySubscriber(responseInfo(Map.of()), 3L);
        subscriber.onSubscribe(new NoOpSubscription());
        subscriber.onNext(List.of(ByteBuffer.wrap(new byte[]{1, 2, 3, 4})));

        try {
            subscriber.getBody().toCompletableFuture().join();
            fail("Expected an oversized response failure");
        } catch (CompletionException e) {
            assertTrue(e.getCause() instanceof IOException);
            assertEquals("PETDEX_RESPONSE_TOO_LARGE", e.getCause().getMessage());
        }
    }

    @Test
    public void boundedSubscriberRejectsOversizedContentLengthBeforeReading() {
        PetdexRepository.BoundedBodySubscriber subscriber = new PetdexRepository.BoundedBodySubscriber(
                responseInfo(Map.of("content-length", List.of("4"))), 3L);
        NoOpSubscription subscription = new NoOpSubscription();
        subscriber.onSubscribe(subscription);

        assertTrue(subscription.cancelled);
        try {
            subscriber.getBody().toCompletableFuture().join();
            fail("Expected an oversized response failure");
        } catch (CompletionException e) {
            assertEquals("PETDEX_RESPONSE_TOO_LARGE", e.getCause().getMessage());
        }
    }

    private static HttpResponse.ResponseInfo responseInfo(Map<String, List<String>> headers) {
        return new HttpResponse.ResponseInfo() {
            @Override
            public int statusCode() {
                return 200;
            }

            @Override
            public HttpHeaders headers() {
                return HttpHeaders.of(headers, (name, value) -> true);
            }

            @Override
            public HttpClient.Version version() {
                return HttpClient.Version.HTTP_1_1;
            }
        };
    }

    private static int readIntField(PetdexRepository repository, String fieldName) throws Exception {
        Field field = PetdexRepository.class.getDeclaredField(fieldName);
        field.setAccessible(true);
        return field.getInt(repository);
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CompletionException(e);
        }
    }

    private static final class NoOpSubscription implements Flow.Subscription {
        private boolean cancelled;

        @Override
        public void request(long count) {
        }

        @Override
        public void cancel() {
            cancelled = true;
        }
    }
}
