package com.github.claudecodegui.pet;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import javax.imageio.ImageIO;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.awt.image.BufferedImage;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Secure HTTP client and installer for the official Petdex community repository. */
public final class PetdexRepository {

    public static final URI MANIFEST_URI = URI.create("https://petdex.dev/api/manifest");
    public static final URI WEBSITE_URI = URI.create("https://petdex.dev");
    static final long MAX_MANIFEST_BYTES = 2L * 1024L * 1024L;
    public static final long MAX_PET_JSON_BYTES = 64L * 1024L;
    static final long MAX_SPRITE_BYTES = 4L * 1024L * 1024L;
    static final int MAX_CATALOG_PETS = 5000;
    private static final Logger LOG = Logger.getInstance(PetdexRepository.class);
    private static final Pattern SAFE_SLUG = Pattern.compile("^[a-z0-9][a-z0-9-]{0,62}$");
    private static final Set<String> ALLOWED_HOSTS = Set.of("petdex.dev", "assets.petdex.dev");
    private static final String MANAGED_MARKER = ".petdex-installed";
    private static final long CACHE_MILLIS = Duration.ofMinutes(5).toMillis();
    private static final int MAX_REDIRECTS = 3;
    private static final int DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;
    private static final int DEFAULT_REQUEST_TIMEOUT_SECONDS = 60;
    private static final int DEFAULT_RETRY_ATTEMPTS = 3;
    private static final int PREVIEW_FRAME_WIDTH = 88;
    private static final int PREVIEW_FRAME_HEIGHT = 96;
    private static final int MAX_CACHED_PREVIEWS = 48;
    private static final int OPERATION_LOCK_COUNT = 64;
    private static final ReentrantLock[] OPERATION_LOCKS = createOperationLocks();
    public static final int MAX_ALIAS_CODE_POINTS = 60;

    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();
    private volatile HttpClient httpClient;
    private volatile int connectTimeoutSeconds = DEFAULT_CONNECT_TIMEOUT_SECONDS;
    private volatile int requestTimeoutSeconds = DEFAULT_REQUEST_TIMEOUT_SECONDS;
    private volatile int retryAttempts = DEFAULT_RETRY_ATTEMPTS;
    private volatile List<PetdexPet> cachedPets = List.of();
    private volatile long cacheTimestamp;
    private final Map<String, String> previewCache = new LinkedHashMap<>(16, 0.75f, true);
    private final Semaphore previewFetchSlots = new Semaphore(4);

    public PetdexRepository() {
        this(HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(DEFAULT_CONNECT_TIMEOUT_SECONDS))
                .build());
    }

    PetdexRepository(HttpClient httpClient) {
        this.httpClient = httpClient;
    }

    public synchronized void configureNetwork(int connectTimeout, int requestTimeout, int attempts) {
        int safeConnectTimeout = clamp(connectTimeout, 5, 300);
        int safeRequestTimeout = Math.max(safeConnectTimeout, clamp(requestTimeout, 10, 300));
        int safeAttempts = clamp(attempts, 0, 10);
        if (safeConnectTimeout != connectTimeoutSeconds) {
            httpClient = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(safeConnectTimeout))
                    .build();
            connectTimeoutSeconds = safeConnectTimeout;
        }
        requestTimeoutSeconds = safeRequestTimeout;
        retryAttempts = safeAttempts;
    }

    public List<PetdexPet> getCatalog(boolean forceRefresh) throws IOException, InterruptedException {
        long now = System.currentTimeMillis();
        List<PetdexPet> current = cachedPets;
        if (!forceRefresh && !current.isEmpty() && now - cacheTimestamp < CACHE_MILLIS) {
            return current;
        }
        synchronized (this) {
            now = System.currentTimeMillis();
            if (!forceRefresh && !cachedPets.isEmpty() && now - cacheTimestamp < CACHE_MILLIS) {
                return cachedPets;
            }
            byte[] manifest = fetchBytes(MANIFEST_URI, MAX_MANIFEST_BYTES);
            List<PetdexPet> parsed = parseManifest(new String(manifest, StandardCharsets.UTF_8));
            cachedPets = List.copyOf(parsed);
            cacheTimestamp = now;
            return cachedPets;
        }
    }

    public InstallResult install(String slug) throws IOException, InterruptedException {
        validateSlug(slug);
        ReentrantLock lock = operationLock(slug);
        lock.lockInterruptibly();
        try {
            return installLocked(slug);
        } finally {
            lock.unlock();
        }
    }

    private InstallResult installLocked(String slug) throws IOException, InterruptedException {
        PetdexPet pet = getCatalog(false).stream()
                .filter(candidate -> candidate.slug.equals(slug))
                .findFirst()
                .orElseThrow(() -> new IOException("PET_NOT_FOUND"));

        Path root = resolvePetRoot();
        Path target = resolveDirectChild(root, slug);
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("PET_ALREADY_INSTALLED");
        }

        byte[] petJsonBytes = fetchBytes(pet.petJsonUri, MAX_PET_JSON_BYTES);
        JsonObject petJson = parsePetJson(petJsonBytes);
        byte[] spriteBytes = fetchBytes(pet.spritesheetUri, MAX_SPRITE_BYTES);
        String extension = detectSpriteExtension(spriteBytes);
        Path spriteName = Path.of("spritesheet." + extension);
        CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(
                "image/" + ("jpg".equals(extension) ? "jpeg" : extension), spriteBytes);
        if (!CodexPetImageSupport.isCanonicalPetdexSheet(dimensions)) {
            throw new IOException("INVALID_PETDEX_SPRITESHEET");
        }
        BufferedImage decodedImage = ImageIO.read(new ByteArrayInputStream(spriteBytes));
        if (decodedImage == null
                || decodedImage.getWidth() != dimensions.getWidth()
                || decodedImage.getHeight() != dimensions.getHeight()) {
            throw new IOException("UNDECODABLE_PETDEX_SPRITESHEET");
        }

        JsonObject canonicalPetJson = new JsonObject();
        canonicalPetJson.addProperty("id", slug);
        canonicalPetJson.addProperty("displayName", readDisplayName(petJson, pet.displayName));
        if (petJson.has("description") && petJson.get("description").isJsonPrimitive()) {
            canonicalPetJson.addProperty("description", limitText(petJson.get("description").getAsString(), 1000));
        }
        canonicalPetJson.addProperty("spritesheetPath", spriteName.toString().replace('\\', '/'));
        canonicalPetJson.addProperty("source", "petdex");

        Path tempDirectory = Files.createTempDirectory(root, ".petdex-install-");
        boolean moved = false;
        try {
            Files.writeString(tempDirectory.resolve("pet.json"), gson.toJson(canonicalPetJson), StandardCharsets.UTF_8);
            Files.write(tempDirectory.resolve(spriteName), spriteBytes);
            Files.writeString(tempDirectory.resolve(MANAGED_MARKER), slug, StandardCharsets.UTF_8);
            moveDirectory(tempDirectory, target);
            moved = true;
        } finally {
            if (!moved) {
                deleteTree(tempDirectory);
            }
        }
        return new InstallResult(slug, slug + "/" + spriteName.toString().replace('\\', '/'));
    }

    public String getPreviewDataUrl(String slug) throws IOException, InterruptedException {
        validateSlug(slug);
        String cached = getCachedPreview(slug);
        if (cached != null) {
            return cached;
        }

        previewFetchSlots.acquire();
        try {
            cached = getCachedPreview(slug);
            if (cached != null) {
                return cached;
            }
            PetdexPet pet = getCatalog(false).stream()
                    .filter(candidate -> candidate.slug.equals(slug))
                    .findFirst()
                    .orElseThrow(() -> new IOException("PET_NOT_FOUND"));
            byte[] spriteBytes = fetchBytes(pet.spritesheetUri, MAX_SPRITE_BYTES);
            String extension = detectSpriteExtension(spriteBytes);
            CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(
                    "image/" + extension, spriteBytes);
            if (!CodexPetImageSupport.isCanonicalPetdexSheet(dimensions)) {
                throw new IOException("INVALID_PETDEX_SPRITESHEET");
            }
            BufferedImage decodedImage = ImageIO.read(new ByteArrayInputStream(spriteBytes));
            if (decodedImage == null) {
                throw new IOException("UNDECODABLE_PETDEX_SPRITESHEET");
            }
            String preview = createPreviewDataUrl(decodedImage);
            cachePreview(slug, preview);
            return preview;
        } finally {
            previewFetchSlots.release();
        }
    }

    private String getCachedPreview(String slug) {
        synchronized (previewCache) {
            return previewCache.get(slug);
        }
    }

    private void cachePreview(String slug, String preview) {
        synchronized (previewCache) {
            previewCache.put(slug, preview);
            while (previewCache.size() > MAX_CACHED_PREVIEWS) {
                previewCache.remove(previewCache.keySet().iterator().next());
            }
        }
    }

    public void uninstall(String slug) throws IOException {
        uninstall(resolvePetRoot(), slug);
    }

    static void uninstall(Path configuredRoot, String slug) throws IOException {
        validateSlug(slug);
        ReentrantLock lock = operationLock(slug);
        lock.lock();
        try {
            Path root = configuredRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
            Path target = resolveDirectChild(root, slug);
            validateManagedTarget(target, slug);
            deleteTree(target);
        } finally {
            lock.unlock();
        }
    }

    public void setAlias(String slug, String alias) throws IOException {
        updateAlias(resolvePetRoot(), slug, alias);
    }

    static void updateAlias(Path configuredRoot, String slug, String alias) throws IOException {
        validateSlug(slug);
        ReentrantLock lock = operationLock(slug);
        lock.lock();
        try {
            Path root = configuredRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
            Path target = resolveDirectChild(root, slug);
            validateManagedTarget(target, slug);

            Path petJson = target.resolve("pet.json");
            if (!Files.isRegularFile(petJson, LinkOption.NOFOLLOW_LINKS)
                    || Files.isSymbolicLink(petJson)
                    || Files.size(petJson) > MAX_PET_JSON_BYTES) {
                throw new IOException("INVALID_PET_JSON");
            }

            JsonObject metadata = parsePetJson(Files.readAllBytes(petJson));
            String normalizedAlias = normalizeAlias(alias);
            if (normalizedAlias.isEmpty()) {
                metadata.remove("alias");
            } else {
                metadata.addProperty("alias", normalizedAlias);
            }
            writeJsonAtomically(target, petJson, metadata);
        } finally {
            lock.unlock();
        }
    }

    public JsonArray toCatalogJson(List<PetdexPet> pets) throws IOException {
        Path root = resolvePetRoot();
        JsonArray result = new JsonArray();
        for (PetdexPet pet : pets) {
            Path target = resolveDirectChild(root, pet.slug);
            boolean installed = Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)
                    && !Files.isSymbolicLink(target);
            boolean managed = installed && isManaged(target, pet.slug);
            JsonObject item = new JsonObject();
            item.addProperty("slug", pet.slug);
            item.addProperty("displayName", pet.displayName);
            item.addProperty("kind", pet.kind);
            item.addProperty("submittedBy", pet.submittedBy);
            item.addProperty("installed", installed);
            item.addProperty("managed", managed);
            if (managed) {
                String alias = readInstalledAlias(target);
                if (alias != null && !alias.isEmpty()) {
                    item.addProperty("alias", alias);
                }
            }
            result.add(item);
        }
        return result;
    }

    static List<PetdexPet> parseManifest(String json) throws IOException {
        JsonElement root;
        try {
            root = JsonParser.parseString(json);
        } catch (RuntimeException e) {
            throw new IOException("INVALID_PETDEX_MANIFEST", e);
        }
        if (!root.isJsonObject()) {
            throw new IOException("INVALID_PETDEX_MANIFEST");
        }
        JsonElement petsElement = root.getAsJsonObject().get("pets");
        if (petsElement == null || !petsElement.isJsonArray()) {
            throw new IOException("INVALID_PETDEX_MANIFEST");
        }
        List<PetdexPet> pets = new ArrayList<>();
        for (JsonElement element : petsElement.getAsJsonArray()) {
            if (pets.size() >= MAX_CATALOG_PETS) {
                break;
            }
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject item = element.getAsJsonObject();
            String slug = readString(item, "slug");
            String displayName = readString(item, "displayName");
            URI spritesheetUri = parseAllowedUri(readString(item, "spritesheetUrl"));
            URI petJsonUri = parseAllowedUri(readString(item, "petJsonUrl"));
            if (!isSafeSlug(slug) || displayName == null || displayName.isBlank()
                    || spritesheetUri == null || petJsonUri == null) {
                continue;
            }
            pets.add(new PetdexPet(
                    slug,
                    limitText(displayName, 100),
                    limitText(readString(item, "kind"), 40),
                    limitText(readString(item, "submittedBy"), 100),
                    spritesheetUri,
                    petJsonUri));
        }
        if (pets.isEmpty()) {
            throw new IOException("EMPTY_PETDEX_MANIFEST");
        }
        return pets;
    }

    static boolean isAllowedRemoteUri(URI uri) {
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && uri.getUserInfo() == null
                && uri.getPort() == -1
                && uri.getHost() != null
                && ALLOWED_HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT));
    }

    static boolean isSafeSlug(String slug) {
        return slug != null && SAFE_SLUG.matcher(slug).matches();
    }

    private byte[] fetchBytes(URI initialUri, long maxBytes) throws IOException, InterruptedException {
        URI currentUri = initialUri;
        for (int redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            if (!isAllowedRemoteUri(currentUri)) {
                throw new IOException("PETDEX_URL_NOT_ALLOWED");
            }
            HttpRequest request = HttpRequest.newBuilder(currentUri)
                    .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                    .header("Accept", "application/json,image/webp,image/png;q=0.9,*/*;q=0.1")
                    .GET()
                    .build();
            HttpResponse<byte[]> response = sendWithRetry(request, maxBytes);
            int status = response.statusCode();
            if (status >= 300 && status < 400) {
                String location = response.headers().firstValue("location")
                        .orElseThrow(() -> new IOException("PETDEX_REDIRECT_WITHOUT_LOCATION"));
                currentUri = currentUri.resolve(location);
                continue;
            }
            if (status != 200) {
                throw new IOException("PETDEX_HTTP_" + status);
            }
            return response.body();
        }
        throw new IOException("PETDEX_TOO_MANY_REDIRECTS");
    }

    private HttpResponse<byte[]> sendWithRetry(HttpRequest request, long maxBytes)
            throws IOException, InterruptedException {
        IOException lastError = null;
        int maxAttempts = retryAttempts + 1;
        HttpClient client = httpClient;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return sendWithFullResponseTimeout(client, request, maxBytes);
            } catch (IOException e) {
                lastError = e;
                if ("PETDEX_RESPONSE_TOO_LARGE".equals(e.getMessage())) {
                    throw e;
                }
                if (attempt == maxAttempts) {
                    throw e;
                }
                String failure = e instanceof HttpConnectTimeoutException
                        ? "connection timeout" : e.getClass().getSimpleName();
                LOG.info("[Petdex] Retrying request after " + failure
                        + " (attempt " + attempt + "/" + maxAttempts + ")");
                Thread.sleep(500L * attempt);
            }
        }
        throw lastError == null ? new IOException("PETDEX_NETWORK_ERROR") : lastError;
    }

    private HttpResponse<byte[]> sendWithFullResponseTimeout(
            HttpClient client, HttpRequest request, long maxBytes) throws IOException, InterruptedException {
        CompletableFuture<HttpResponse<byte[]>> future = client.sendAsync(
                request, responseInfo -> new BoundedBodySubscriber(responseInfo, maxBytes));
        try {
            return future.get(requestTimeoutSeconds, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            throw new HttpTimeoutException("PETDEX_REQUEST_TIMEOUT");
        } catch (ExecutionException e) {
            Throwable cause = unwrapCompletionCause(e.getCause());
            if (cause instanceof IOException) {
                throw (IOException) cause;
            }
            throw new IOException("PETDEX_NETWORK_ERROR", cause);
        } catch (InterruptedException e) {
            future.cancel(true);
            throw e;
        }
    }

    public static byte[] createPreviewPng(BufferedImage spriteSheet) throws IOException {
        if (spriteSheet == null
                || spriteSheet.getWidth() < CodexPetImageSupport.PETDEX_FRAME_WIDTH
                        * CodexPetImageSupport.PETDEX_COLUMNS
                || spriteSheet.getHeight() < CodexPetImageSupport.PETDEX_FRAME_HEIGHT) {
            throw new IOException("INVALID_PETDEX_SPRITESHEET");
        }
        BufferedImage preview = new BufferedImage(
                PREVIEW_FRAME_WIDTH * CodexPetImageSupport.PETDEX_COLUMNS,
                PREVIEW_FRAME_HEIGHT,
                BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = preview.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                    RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
            for (int frame = 0; frame < CodexPetImageSupport.PETDEX_COLUMNS; frame++) {
                int sourceX = frame * CodexPetImageSupport.PETDEX_FRAME_WIDTH;
                int targetX = frame * PREVIEW_FRAME_WIDTH;
                graphics.drawImage(spriteSheet,
                        targetX, 0, targetX + PREVIEW_FRAME_WIDTH, PREVIEW_FRAME_HEIGHT,
                        sourceX, 0, sourceX + CodexPetImageSupport.PETDEX_FRAME_WIDTH,
                        CodexPetImageSupport.PETDEX_FRAME_HEIGHT,
                        null);
            }
        } finally {
            graphics.dispose();
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        if (!ImageIO.write(preview, "png", output)) {
            throw new IOException("PETDEX_PREVIEW_ENCODING_FAILED");
        }
        return output.toByteArray();
    }

    private static String createPreviewDataUrl(BufferedImage spriteSheet) throws IOException {
        return "data:image/png;base64," + Base64.getEncoder().encodeToString(createPreviewPng(spriteSheet));
    }

    private static Throwable unwrapCompletionCause(Throwable error) {
        Throwable current = error;
        while ((current instanceof java.util.concurrent.CompletionException
                || current instanceof ExecutionException) && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private static JsonObject parsePetJson(byte[] bytes) throws IOException {
        try {
            JsonElement value = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8));
            if (!value.isJsonObject()) {
                throw new IOException("INVALID_PET_JSON");
            }
            return value.getAsJsonObject();
        } catch (RuntimeException e) {
            throw new IOException("INVALID_PET_JSON", e);
        }
    }

    private static String detectSpriteExtension(byte[] bytes) throws IOException {
        String mimeType = CodexPetImageSupport.detectMimeType(Path.of("sprite.webp"), bytes);
        if (mimeType == null) {
            mimeType = CodexPetImageSupport.detectMimeType(Path.of("sprite.png"), bytes);
        }
        if ("image/png".equals(mimeType)) {
            return "png";
        }
        if ("image/webp".equals(mimeType)) {
            return "webp";
        }
        throw new IOException("UNSUPPORTED_PETDEX_IMAGE");
    }

    private static String readDisplayName(JsonObject petJson, String fallback) {
        String displayName = readString(petJson, "displayName");
        return limitText(displayName == null || displayName.isBlank() ? fallback : displayName, 100);
    }

    private static String readString(JsonObject object, String property) {
        JsonElement value = object.get(property);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
                ? value.getAsString() : null;
    }

    private static String limitText(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        return trimmed.length() <= maxLength ? trimmed : trimmed.substring(0, maxLength);
    }

    private static URI parseAllowedUri(String value) {
        try {
            URI uri = value == null ? null : URI.create(value);
            return isAllowedRemoteUri(uri) ? uri : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static void validateSlug(String slug) throws IOException {
        if (!isSafeSlug(slug)) {
            throw new IOException("INVALID_PET_SLUG");
        }
    }

    private static ReentrantLock[] createOperationLocks() {
        ReentrantLock[] locks = new ReentrantLock[OPERATION_LOCK_COUNT];
        for (int i = 0; i < locks.length; i++) {
            locks[i] = new ReentrantLock();
        }
        return locks;
    }

    private static ReentrantLock operationLock(String slug) {
        return OPERATION_LOCKS[Math.floorMod(slug.hashCode(), OPERATION_LOCKS.length)];
    }

    static String normalizeAlias(String value) throws IOException {
        if (value == null) {
            return "";
        }
        String normalized = value.trim().replaceAll("\\s+", " ");
        if (normalized.codePointCount(0, normalized.length()) > MAX_ALIAS_CODE_POINTS) {
            throw new IOException("PET_ALIAS_TOO_LONG");
        }
        if (normalized.codePoints().anyMatch(Character::isISOControl)) {
            throw new IOException("INVALID_PET_ALIAS");
        }
        return normalized;
    }

    private static Path resolvePetRoot() throws IOException {
        Path configuredRoot = Path.of(PlatformUtils.getHomeDirectory(), ".codex", "pets");
        Files.createDirectories(configuredRoot);
        return configuredRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
    }

    private static Path resolveDirectChild(Path root, String slug) throws IOException {
        Path target = root.resolve(slug).normalize();
        if (!target.getParent().equals(root) || !target.startsWith(root)) {
            throw new IOException("PET_PATH_OUTSIDE_ROOT");
        }
        return target;
    }

    private static boolean isManaged(Path directory, String slug) {
        try {
            Path marker = directory.resolve(MANAGED_MARKER);
            return Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS)
                    && !Files.isSymbolicLink(marker)
                    && Files.size(marker) <= 128L
                    && slug.equals(Files.readString(marker, StandardCharsets.UTF_8).trim());
        } catch (IOException e) {
            return false;
        }
    }

    public static boolean isManagedInstall(Path configuredRoot, String slug) {
        if (configuredRoot == null || !isSafeSlug(slug)) {
            return false;
        }
        try {
            Path root = configuredRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
            Path target = resolveDirectChild(root, slug);
            return Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)
                    && !Files.isSymbolicLink(target)
                    && isManaged(target, slug);
        } catch (IOException | SecurityException e) {
            return false;
        }
    }

    private static void validateManagedTarget(Path target, String slug) throws IOException {
        if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(target)) {
            throw new IOException("PET_NOT_INSTALLED");
        }
        if (!isManaged(target, slug)) {
            throw new IOException("PET_NOT_MANAGED_BY_PLUGIN");
        }
    }

    private static String readInstalledAlias(Path target) {
        Path petJson = target.resolve("pet.json");
        try {
            if (!Files.isRegularFile(petJson, LinkOption.NOFOLLOW_LINKS)
                    || Files.isSymbolicLink(petJson)
                    || Files.size(petJson) > MAX_PET_JSON_BYTES) {
                return null;
            }
            return normalizeAlias(readString(parsePetJson(Files.readAllBytes(petJson)), "alias"));
        } catch (IOException | SecurityException e) {
            return null;
        }
    }

    private static void writeJsonAtomically(Path directory, Path target, JsonObject value) throws IOException {
        Path temporary = Files.createTempFile(directory, ".pet-metadata-", ".json");
        try {
            Files.writeString(temporary, new GsonBuilder().setPrettyPrinting().create().toJson(value),
                    StandardCharsets.UTF_8);
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static void moveDirectory(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(source, target);
        }
    }

    private static void deleteTree(Path root) throws IOException {
        if (root == null || !Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (Files.isSymbolicLink(root)) {
            Files.deleteIfExists(root);
            return;
        }
        try (Stream<Path> paths = Files.walk(root)) {
            List<Path> ordered = paths.sorted(Comparator.reverseOrder()).toList();
            for (Path path : ordered) {
                Files.deleteIfExists(path);
            }
        }
    }

    static final class BoundedBodySubscriber implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private final ByteArrayOutputStream output = new ByteArrayOutputStream();
        private final long maxBytes;
        private Flow.Subscription subscription;
        private long receivedBytes;

        BoundedBodySubscriber(HttpResponse.ResponseInfo responseInfo, long maxBytes) {
            this.maxBytes = maxBytes;
            long declaredLength = responseInfo.headers().firstValueAsLong("content-length").orElse(-1L);
            if (declaredLength > maxBytes) {
                body.completeExceptionally(new IOException("PETDEX_RESPONSE_TOO_LARGE"));
            }
        }

        @Override
        public CompletableFuture<byte[]> getBody() {
            return body;
        }

        @Override
        public void onSubscribe(Flow.Subscription value) {
            subscription = value;
            if (body.isDone()) {
                value.cancel();
            } else {
                value.request(Long.MAX_VALUE);
            }
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            if (body.isDone()) {
                return;
            }
            for (ByteBuffer buffer : buffers) {
                int remaining = buffer.remaining();
                if (receivedBytes + remaining > maxBytes) {
                    subscription.cancel();
                    body.completeExceptionally(new IOException("PETDEX_RESPONSE_TOO_LARGE"));
                    return;
                }
                byte[] chunk = new byte[remaining];
                buffer.get(chunk);
                output.write(chunk, 0, chunk.length);
                receivedBytes += remaining;
            }
        }

        @Override
        public void onError(Throwable error) {
            body.completeExceptionally(error);
        }

        @Override
        public void onComplete() {
            body.complete(output.toByteArray());
        }
    }

    public static final class PetdexPet {
        private final String slug;
        private final String displayName;
        private final String kind;
        private final String submittedBy;
        private final URI spritesheetUri;
        private final URI petJsonUri;

        private PetdexPet(String slug, String displayName, String kind, String submittedBy,
                          URI spritesheetUri, URI petJsonUri) {
            this.slug = slug;
            this.displayName = displayName;
            this.kind = kind;
            this.submittedBy = submittedBy;
            this.spritesheetUri = spritesheetUri;
            this.petJsonUri = petJsonUri;
        }

        public String getSlug() {
            return slug;
        }

        public String getDisplayName() {
            return displayName;
        }

        public String getKind() {
            return kind;
        }

        public String getSubmittedBy() {
            return submittedBy;
        }
    }

    public static final class InstallResult {
        private final String slug;
        private final String petId;

        private InstallResult(String slug, String petId) {
            this.slug = slug;
            this.petId = petId;
        }

        public String getSlug() {
            return slug;
        }

        public String getPetId() {
            return petId;
        }
    }
}
