package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.pet.CodexPetFloatingService;
import com.github.claudecodegui.pet.CodexPetImageSupport;
import com.github.claudecodegui.pet.PetdexRepository;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.intellij.ide.BrowserUtil;
import com.intellij.ide.actions.RevealFileAction;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Base64;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Stream;

/** Handles local pets, IDE-wide floating configuration and the official Petdex catalog. */
public class CodexPetHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CodexPetHandler.class);
    private static final String[] SUPPORTED_TYPES = {
        "get_codex_pets",
        "get_codex_pet_config",
        "set_codex_pet_config",
        "set_codex_pet_state",
        "show_codex_pet_bubble",
        "reset_codex_pet_position",
        "get_codex_pet_preview",
        "refresh_codex_pet_assets",
        "get_petdex_catalog",
        "get_petdex_preview",
        "install_petdex_pet",
        "uninstall_petdex_pet",
        "set_petdex_pet_alias",
        "open_petdex_website",
        "open_codex_pet_directory",
        "get_hatch_pet_status",
        "open_hatch_pet_website",
        "choose_hatch_pet_reference",
        "prepare_hatch_pet_command"
    };
    static final long MAX_IMAGE_BYTES = 4L * 1024L * 1024L;
    static final int MAX_PETS = 100;
    private static final int MAX_CANDIDATE_FILES = 1000;
    private static final int MAX_IMAGE_HEADER_BYTES = 256 * 1024;
    private static final int MAX_IMPORTED_MARKER_BYTES = 128;
    private static final String IMPORTED_MARKER = ".codemoss-imported";
    private static final String IMPORTED_SOURCE = "local-import";
    private static final PetdexRepository PETDEX_REPOSITORY = new PetdexRepository();
    private static final ReentrantLock IMPORTED_PET_OPERATION_LOCK = new ReentrantLock();
    private static final List<WeakReference<CodexPetHandler>> INSTANCES = new ArrayList<>();
    private final Gson gson = new Gson();
    private Long bubbleTurnStartedAtMillis;

    public CodexPetHandler(HandlerContext context) {
        super(context);
        synchronized (INSTANCES) {
            INSTANCES.removeIf(reference -> {
                CodexPetHandler handler = reference.get();
                return handler == null || handler.context.isDisposed();
            });
            INSTANCES.add(new WeakReference<>(this));
        }
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_codex_pets":
                runAsync(this::pushPets);
                return true;
            case "get_codex_pet_config":
                handleGetConfig();
                return true;
            case "set_codex_pet_config":
                handleSetConfig(content);
                return true;
            case "set_codex_pet_state":
                handleSetState(content);
                return true;
            case "show_codex_pet_bubble":
                handleShowBubble(content);
                return true;
            case "reset_codex_pet_position":
                handleResetPosition();
                return true;
            case "get_codex_pet_preview":
                runAsync(() -> pushLocalPreview(readString(content, "petId")));
                return true;
            case "refresh_codex_pet_assets":
                handleRefreshPetAssets();
                return true;
            case "get_petdex_catalog":
                runAsync(() -> pushCatalog(
                        readBoolean(content, "forceRefresh", false),
                        readString(content, "query"),
                        readInt(content, "offset", 0),
                        readInt(content, "limit", CodexPetFloatingService.DEFAULT_CATALOG_PAGE_SIZE),
                        readString(content, "sort"),
                        readInt(content, "requestId", 0)));
                return true;
            case "get_petdex_preview":
                runAsync(() -> pushPreview(readString(content, "slug")));
                return true;
            case "install_petdex_pet":
                runAsync(() -> installPet(readString(content, "slug")));
                return true;
            case "uninstall_petdex_pet":
                runAsync(() -> uninstallPet(readString(content, "slug")));
                return true;
            case "set_petdex_pet_alias":
                runAsync(() -> setPetAlias(
                        readString(content, "slug"),
                        readString(content, "alias")));
                return true;
            case "open_petdex_website":
                BrowserUtil.browse(PetdexRepository.WEBSITE_URI);
                return true;
            case "open_codex_pet_directory":
                handleOpenPetDirectory();
                return true;
            case "get_hatch_pet_status":
                runAsync(this::pushHatchPetStatus);
                return true;
            case "open_hatch_pet_website":
                BrowserUtil.browse("https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet");
                return true;
            case "choose_hatch_pet_reference":
                handleChooseHatchReference();
                return true;
            case "prepare_hatch_pet_command":
                handlePrepareHatchPetCommand(content);
                return true;
            default:
                return false;
        }
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    private void handleGetConfig() {
        CodexPetFloatingService service = floatingService();
        service.refresh();
        pushJson("updateCodexPetConfig", service.snapshot());
    }

    private void handleSetConfig(String content) {
        try {
            JsonObject config = parseObject(content);
            CodexPetFloatingService service = floatingService();
            service.applyConfig(config);
            pushJson("updateCodexPetConfig", service.snapshot());
        } catch (IllegalArgumentException | JsonParseException e) {
            LOG.warn("[CodexPet] Invalid pet configuration: " + e.getMessage(), e);
            pushOperation("configure", false, null, null, "INVALID_PET_CONFIG");
        } catch (RuntimeException e) {
            LOG.error("[CodexPet] Failed to update pet configuration", e);
            pushOperation("configure", false, null, null, "PET_CONFIG_UPDATE_FAILED");
        }
    }

    private void handleSetState(String content) {
        try {
            JsonObject payload = parseObject(content);
            floatingService().updateActivity(
                    readString(payload, "sourceId"),
                    readString(payload, "state"),
                    context.isActiveContent());
        } catch (RuntimeException e) {
            LOG.debug("[CodexPet] Ignored invalid state update: " + e.getMessage());
        }
    }

    private void handleShowBubble(String content) {
        try {
            JsonObject payload = parseObject(content);
            payload.addProperty("background", !context.isActiveContent());
            applyFallbackTabTitle(payload, context.getContentTitle());
            synchronized (this) {
                ClaudeSession session = context.getSession();
                long sessionStartedAt = session == null ? 0L : session.getLastTurnStartedAtMillis();
                Long authoritativeStart = bubbleTurnStartedAtMillis;
                String event = readString(payload, "event");
                if (sessionStartedAt > 0L
                        && ("task_started".equals(event) || authoritativeStart == null)) {
                    authoritativeStart = sessionStartedAt;
                }
                bubbleTurnStartedAtMillis = applyAuthoritativeDuration(
                        payload, authoritativeStart, System.currentTimeMillis());
            }
            floatingService().showBubble(payload, context::activateContent);
        } catch (RuntimeException e) {
            LOG.debug("[CodexPet] Ignored invalid bubble event: " + e.getMessage());
        }
    }

    static void applyFallbackTabTitle(JsonObject payload, String fallbackTitle) {
        JsonElement title = payload.get("tabTitle");
        boolean hasSessionTitle = title != null
                && title.isJsonPrimitive()
                && title.getAsJsonPrimitive().isString()
                && !title.getAsString().isBlank();
        if (!hasSessionTitle && fallbackTitle != null && !fallbackTitle.isBlank()) {
            payload.addProperty("tabTitle", fallbackTitle);
        }
    }

    static Long applyAuthoritativeDuration(JsonObject payload, Long startedAtMillis, long nowMillis) {
        String event = readString(payload, "event");
        Long effectiveStart = startedAtMillis;
        if ("task_started".equals(event) && effectiveStart == null) {
            effectiveStart = nowMillis;
        }
        if (effectiveStart != null) {
            long durationMillis = nowMillis >= effectiveStart ? nowMillis - effectiveStart : 0L;
            payload.addProperty("durationMs", durationMillis);
        }
        if ("task_success".equals(event) || "task_error".equals(event)) {
            return null;
        }
        return effectiveStart;
    }

    private void handleResetPosition() {
        CodexPetFloatingService service = floatingService();
        service.resetPosition();
        pushJson("updateCodexPetConfig", service.snapshot());
    }

    private void handleRefreshPetAssets() {
        floatingService().reloadSelectedPet();
        publishPetAssetsChanged(true);
    }

    private void installPet(String slug) {
        try {
            configurePetdexNetwork();
            PetdexRepository.InstallResult result = PETDEX_REPOSITORY.install(slug);
            JsonObject config = new JsonObject();
            config.addProperty("enabled", true);
            config.addProperty("selectedPetId", result.getPetId());
            floatingService().applyConfig(config);
            pushOperation("install", true, result.getSlug(), result.getPetId(), null);
            pushJson("updateCodexPetConfig", floatingService().snapshot());
            publishPetAssetsChanged(true);
        } catch (Exception e) {
            LOG.warn("[Petdex] Installation failed for " + slug + ": " + e.getMessage(), e);
            pushOperation("install", false, slug, null, errorCode(e));
        }
    }

    private void uninstallPet(String slug) {
        try {
            String selectedPetId = floatingService().snapshot().get("selectedPetId").getAsString();
            PETDEX_REPOSITORY.uninstall(slug);
            if (selectedPetId.startsWith(slug + "/")) {
                JsonObject config = new JsonObject();
                config.addProperty("selectedPetId", "builtin");
                floatingService().applyConfig(config);
            }
            pushOperation("uninstall", true, slug, null, null);
            pushJson("updateCodexPetConfig", floatingService().snapshot());
            publishPetAssetsChanged(true);
        } catch (Exception e) {
            LOG.warn("[Petdex] Uninstall failed for " + slug + ": " + e.getMessage(), e);
            pushOperation("uninstall", false, slug, null, errorCode(e));
        }
    }

    private void setPetAlias(String slug, String alias) {
        try {
            Path root = petRoot();
            if (isImportedPet(root, slug)) {
                setImportedPetAlias(root, slug, alias);
            } else {
                PETDEX_REPOSITORY.setAlias(slug, alias);
            }
            pushOperation("alias", true, slug, null, null);
            publishPetAssetsChanged(false);
        } catch (Exception e) {
            LOG.warn("[Petdex] Failed to update alias for " + slug + ": " + e.getMessage(), e);
            pushOperation("alias", false, slug, null, aliasErrorCode(e));
        }
    }

    private void handleOpenPetDirectory() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                Path root = resolvePetRoot(petRoot(), true);
                RevealFileAction.openDirectory(root);
            } catch (Exception e) {
                LOG.warn("[CodexPet] Failed to open pet directory: " + e.getMessage(), e);
                pushOperation("open-directory", false, null, null, "PET_DIRECTORY_UNAVAILABLE");
            }
        });
    }

    private void pushHatchPetStatus() {
        HatchPetStatus status = inspectHatchPetSkill(codexRoot());
        JsonObject payload = new JsonObject();
        payload.addProperty("status", status.status);
        payload.addProperty("skillPath", status.skillPath.toString());
        payload.addProperty("officialUrl", "https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet");
        pushJson("updateHatchPetStatus", payload);
    }

    private void handleChooseHatchReference() {
        ApplicationManager.getApplication().invokeLater(() -> {
            FileChooserDescriptor descriptor = new FileChooserDescriptor(
                    true, false, false, false, false, false)
                    .withTitle("Choose Pet Reference Image");
            descriptor.withFileFilter(file -> hasSupportedImageExtension(Path.of(file.getName())));
            FileChooser.chooseFile(descriptor, context.getProject(), null, file -> {
                JsonObject payload = new JsonObject();
                payload.addProperty("path", file.getPath());
                pushJson("updateHatchPetReference", payload);
            });
        });
    }

    private void handlePrepareHatchPetCommand(String content) {
        try {
            if (!"codex".equalsIgnoreCase(context.getCurrentProvider())) {
                throw new IOException("HATCH_PET_REQUIRES_CODEX");
            }
            JsonObject request = parseObject(content);
            String action = limitText(readString(request, "action"), 16);
            HatchPetStatus status = inspectHatchPetSkill(codexRoot());
            String command = buildHatchPetCommand(action, request, status);
            JsonObject payload = new JsonObject();
            payload.addProperty("command", command);
            pushJson("onHatchPetCommandPrepared", payload);
        } catch (Exception e) {
            LOG.warn("[CodexPet] Failed to prepare hatch-pet command: " + e.getMessage(), e);
            pushOperation("skill-command", false, null, null, localPetErrorCode(e));
        }
    }

    private void publishPetAssetsChanged(boolean reloadSelectedPet) {
        List<CodexPetHandler> handlers = new ArrayList<>();
        synchronized (INSTANCES) {
            Iterator<WeakReference<CodexPetHandler>> iterator = INSTANCES.iterator();
            while (iterator.hasNext()) {
                CodexPetHandler handler = iterator.next().get();
                if (handler == null || handler.context.isDisposed()) {
                    iterator.remove();
                } else {
                    handlers.add(handler);
                }
            }
        }
        if (reloadSelectedPet) {
            CodexPetFloatingService.notifyPetAssetsChanged(floatingService());
        }
        for (CodexPetHandler handler : handlers) {
            try {
                if (handler == this) {
                    runAsync(handler::pushPets);
                } else {
                    handler.pushJson("onCodexPetAssetsChanged", new JsonObject());
                }
            } catch (RuntimeException e) {
                LOG.debug("[CodexPet] Skipped disposed pet asset listener: " + e.getMessage());
            }
        }
    }

    private void pushPets() {
        JsonObject response = new JsonObject();
        try {
            Path root = Path.of(PlatformUtils.getHomeDirectory(), ".codex", "pets");
            response.add("pets", loadPetAssets(root));
        } catch (Exception e) {
            LOG.warn("[CodexPet] Failed to load local pets: " + e.getMessage());
            response.add("pets", new JsonArray());
            response.addProperty("error", "LOCAL_PETS_UNAVAILABLE");
        }
        pushJson("updateCodexPets", response);
    }

    private void pushLocalPreview(String petId) {
        JsonObject response = new JsonObject();
        if (petId != null) {
            response.addProperty("petId", petId);
        }
        try {
            Path root = Path.of(PlatformUtils.getHomeDirectory(), ".codex", "pets");
            JsonObject preview = loadPetPreview(root, petId);
            response.addProperty("dataUrl", preview.get("dataUrl").getAsString());
            response.addProperty("spriteSheet", preview.get("spriteSheet").getAsBoolean());
        } catch (Exception e) {
            LOG.debug("[CodexPet] Failed to load local preview for " + petId + ": " + e.getMessage());
            response.addProperty("error", "LOCAL_PET_PREVIEW_UNAVAILABLE");
        }
        pushJson("updateCodexPetPreview", response);
    }

    private void pushCatalog(boolean forceRefresh, String rawQuery, int requestedOffset,
                             int requestedLimit, String requestedSort, int requestId) {
        JsonObject response = new JsonObject();
        String normalizedQuery = rawQuery == null ? "" : rawQuery.trim().toLowerCase(Locale.ROOT);
        final String query = normalizedQuery.length() > 100
                ? normalizedQuery.substring(0, 100) : normalizedQuery;
        final int limit = CodexPetFloatingService.normalizeCatalogPageSize(requestedLimit);
        final String sort = CodexPetFloatingService.normalizeCatalogSort(requestedSort);
        response.addProperty("query", query);
        response.addProperty("limit", limit);
        response.addProperty("sort", sort);
        if (requestId > 0) {
            response.addProperty("requestId", requestId);
        }
        try {
            configurePetdexNetwork();
            List<PetdexRepository.PetdexPet> matches = PETDEX_REPOSITORY.getCatalog(forceRefresh)
                    .stream()
                    .filter(pet -> matchesCatalogQuery(pet, query))
                    .sorted(catalogComparator(sort))
                    .toList();
            int offset = normalizeCatalogOffset(requestedOffset, matches.size(), limit);
            int end = Math.min(matches.size(), offset + limit);
            response.add("pets", PETDEX_REPOSITORY.toCatalogJson(matches.subList(offset, end)));
            response.addProperty("total", matches.size());
            response.addProperty("offset", offset);
        } catch (Exception e) {
            LOG.warn("[Petdex] Failed to load catalog: " + e.getMessage(), e);
            response.add("pets", new JsonArray());
            response.addProperty("total", 0);
            response.addProperty("offset", Math.max(0, requestedOffset));
            response.addProperty("error", errorCode(e));
        }
        pushJson("updatePetdexCatalog", response);
    }

    private void pushPreview(String slug) {
        JsonObject response = new JsonObject();
        if (slug != null) {
            response.addProperty("slug", slug);
        }
        try {
            configurePetdexNetwork();
            response.addProperty("dataUrl", PETDEX_REPOSITORY.getPreviewDataUrl(slug));
        } catch (Exception e) {
            LOG.warn("[Petdex] Failed to load preview for " + slug + ": " + e.getMessage(), e);
            response.addProperty("error", errorCode(e));
        }
        pushJson("updatePetdexPreview", response);
    }

    private static boolean matchesCatalogQuery(PetdexRepository.PetdexPet pet, String query) {
        if (query.isEmpty()) {
            return true;
        }
        String searchable = pet.getDisplayName() + " " + pet.getSlug() + " "
                + pet.getKind() + " " + pet.getSubmittedBy();
        return searchable.toLowerCase(Locale.ROOT).contains(query);
    }

    static int normalizeCatalogOffset(int requestedOffset, int total, int pageSize) {
        int limit = CodexPetFloatingService.normalizeCatalogPageSize(pageSize);
        int maxOffset = total <= 0 ? 0 : ((total - 1) / limit) * limit;
        int clampedOffset = Math.max(0, Math.min(requestedOffset, maxOffset));
        return (clampedOffset / limit) * limit;
    }

    private static Comparator<PetdexRepository.PetdexPet> catalogComparator(String sort) {
        Comparator<PetdexRepository.PetdexPet> fallback =
                Comparator.comparing(PetdexRepository.PetdexPet::getSlug, String.CASE_INSENSITIVE_ORDER);
        if ("name_asc".equals(sort)) {
            return Comparator.comparing(PetdexRepository.PetdexPet::getDisplayName,
                    String.CASE_INSENSITIVE_ORDER).thenComparing(fallback);
        }
        if ("name_desc".equals(sort)) {
            return Comparator.comparing(PetdexRepository.PetdexPet::getDisplayName,
                    String.CASE_INSENSITIVE_ORDER).reversed().thenComparing(fallback);
        }
        if ("author_asc".equals(sort)) {
            return Comparator.comparing(PetdexRepository.PetdexPet::getSubmittedBy,
                    String.CASE_INSENSITIVE_ORDER).thenComparing(fallback);
        }
        if ("kind_asc".equals(sort)) {
            return Comparator.comparing(PetdexRepository.PetdexPet::getKind,
                    String.CASE_INSENSITIVE_ORDER).thenComparing(fallback);
        }
        if ("slug_asc".equals(sort)) {
            return fallback;
        }
        return (left, right) -> 0;
    }

    private void pushOperation(String operation, boolean success, String slug, String petId, String error) {
        JsonObject response = new JsonObject();
        response.addProperty("operation", operation);
        response.addProperty("success", success);
        if (slug != null) {
            response.addProperty("slug", slug);
        }
        if (petId != null) {
            response.addProperty("petId", petId);
        }
        if (error != null) {
            response.addProperty("error", error);
        }
        pushJson("onCodexPetOperation", response);
    }

    private void pushJson(String callback, JsonElement payload) {
        callJavaScript(callback, escapeJs(gson.toJson(payload)));
    }

    private CodexPetFloatingService floatingService() {
        return CodexPetFloatingService.getInstance(context.getProject());
    }

    private void configurePetdexNetwork() {
        JsonObject config = floatingService().snapshot();
        PETDEX_REPOSITORY.configureNetwork(
                config.get("petdexConnectTimeoutSeconds").getAsInt(),
                config.get("petdexRequestTimeoutSeconds").getAsInt(),
                config.get("petdexRetryAttempts").getAsInt());
    }

    private static Path codexRoot() {
        return Path.of(PlatformUtils.getHomeDirectory(), ".codex");
    }

    private static Path petRoot() {
        return codexRoot().resolve("pets");
    }

    static HatchPetStatus inspectHatchPetSkill(Path configuredCodexRoot) {
        Path skillPath = configuredCodexRoot.resolve("skills").resolve("hatch-pet").toAbsolutePath().normalize();
        boolean skillFile = Files.isRegularFile(skillPath.resolve("SKILL.md"), LinkOption.NOFOLLOW_LINKS)
                && !Files.isSymbolicLink(skillPath.resolve("SKILL.md"));
        boolean scripts = Files.isRegularFile(skillPath.resolve("scripts").resolve("prepare_pet_run.py"),
                LinkOption.NOFOLLOW_LINKS)
                && Files.isRegularFile(skillPath.resolve("scripts").resolve("validate_atlas.py"),
                LinkOption.NOFOLLOW_LINKS);
        String status = skillFile && scripts ? "installed"
                : Files.exists(skillPath, LinkOption.NOFOLLOW_LINKS) ? "broken" : "missing";
        return new HatchPetStatus(status, skillPath);
    }

    static String buildHatchPetCommand(String action, JsonObject request, HatchPetStatus status) throws IOException {
        if ("install".equals(action)) {
            return "$skill-installer hatch-pet";
        }
        if (!("create".equals(action) || "repair".equals(action))) {
            throw new IOException("INVALID_HATCH_PET_ACTION");
        }
        if (!"installed".equals(status.status)) {
            throw new IOException("HATCH_PET_SKILL_NOT_READY");
        }
        String name = commandText(readString(request, "name"), 80);
        String description = commandText(readString(request, "description"), 500);
        String style = commandText(readString(request, "style"), 40);
        String referencePath = commandText(readString(request, "referencePath"), 500);
        if (name.isBlank() && description.isBlank() && referencePath.isBlank()) {
            throw new IOException("HATCH_PET_INPUT_REQUIRED");
        }
        StringBuilder command = new StringBuilder("$hatch-pet ");
        command.append("repair".equals(action) ? "Repair" : "Create")
                .append(" a Codex-compatible pet");
        if (!name.isBlank()) {
            command.append(" named \"").append(escapeCommandText(name)).append("\"");
        }
        command.append('.');
        if (!description.isBlank()) {
            command.append(" Description: ").append(description).append('.');
        }
        if (!style.isBlank()) {
            command.append(" Style preset: ").append(style).append('.');
        }
        if (!referencePath.isBlank()) {
            command.append(" Reference image path: \"")
                    .append(escapeCommandText(referencePath)).append("\".");
        }
        command.append(" Validate and package it under ~/.codex/pets, then report the package and QA paths.");
        return command.toString();
    }

    static void setImportedPetAlias(Path root, String slug, String alias) throws IOException {
        IMPORTED_PET_OPERATION_LOCK.lock();
        try {
            Path target = resolveImportedPetDirectory(root, slug);
            if (!isImportedPet(root, slug)) {
                throw new IOException("PET_NOT_MANAGED_BY_PLUGIN");
            }
            Path metadataPath = target.resolve("pet.json");
            JsonObject metadata = JsonParser.parseString(readBoundedUtf8(
                    metadataPath, PetdexRepository.MAX_PET_JSON_BYTES, "INVALID_PET_JSON"))
                    .getAsJsonObject();
            String normalized = normalizeImportedAlias(alias);
            if (normalized.isBlank()) {
                metadata.remove("alias");
            } else {
                metadata.addProperty("alias", normalized);
            }
            writeJsonAtomically(target, metadataPath, metadata);
        } finally {
            IMPORTED_PET_OPERATION_LOCK.unlock();
        }
    }

    private static boolean isImportedPet(Path root, String slug) {
        try {
            Path target = resolveImportedPetDirectory(root, slug);
            Path marker = target.resolve(IMPORTED_MARKER);
            Path metadataPath = target.resolve("pet.json");
            if (!Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(marker)
                    || !Files.isRegularFile(metadataPath, LinkOption.NOFOLLOW_LINKS)
                    || Files.isSymbolicLink(metadataPath)) {
                return false;
            }
            if (!slug.equals(readBoundedUtf8(
                    marker, MAX_IMPORTED_MARKER_BYTES, "INVALID_IMPORTED_MARKER").trim())) {
                return false;
            }
            JsonObject metadata = JsonParser.parseString(readBoundedUtf8(
                    metadataPath, PetdexRepository.MAX_PET_JSON_BYTES, "INVALID_PET_JSON"))
                    .getAsJsonObject();
            return IMPORTED_SOURCE.equals(readString(metadata, "source"));
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    private static Path resolveImportedPetDirectory(Path configuredRoot, String slug) throws IOException {
        if (slug == null || !slug.matches("^[a-z0-9][a-z0-9-]{0,62}$")) {
            throw new IOException("INVALID_PET_SLUG");
        }
        Path root = resolvePetRoot(configuredRoot, false);
        Path target = root.resolve(slug).normalize();
        if (!target.startsWith(root) || !Objects.equals(target.getParent(), root)
                || !Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(target)) {
            throw new IOException("PET_NOT_FOUND");
        }
        Path realTarget = target.toRealPath();
        if (!Objects.equals(realTarget.getParent(), root) || !realTarget.startsWith(root)) {
            throw new IOException("PET_PATH_OUTSIDE_ROOT");
        }
        return realTarget;
    }

    private static Path resolvePetRoot(Path configuredRoot, boolean create) throws IOException {
        if (configuredRoot == null) {
            throw new IOException("PET_DIRECTORY_UNAVAILABLE");
        }
        Path root = configuredRoot.toAbsolutePath().normalize();
        if (create) {
            Files.createDirectories(root);
        }
        if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(root)) {
            throw new IOException("PET_DIRECTORY_UNAVAILABLE");
        }
        Path realRoot = root.toRealPath();
        if (!Files.isDirectory(realRoot, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(realRoot)) {
            throw new IOException("PET_DIRECTORY_UNAVAILABLE");
        }
        return realRoot;
    }

    private static void writeJsonAtomically(Path directory, Path target, JsonObject metadata) throws IOException {
        Path temporary = Files.createTempFile(directory, ".pet-metadata-", ".json");
        try {
            Files.writeString(temporary, new GsonBuilder().setPrettyPrinting().create().toJson(metadata),
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

    private static String readBoundedUtf8(Path path, long maxBytes, String errorCode) throws IOException {
        int limit = Math.toIntExact(maxBytes);
        byte[] bytes;
        try (InputStream input = Files.newInputStream(path)) {
            bytes = input.readNBytes(limit + 1);
        }
        if (bytes.length > limit) {
            throw new IOException(errorCode);
        }
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private static String normalizeImportedAlias(String alias) throws IOException {
        if (alias == null) {
            return "";
        }
        String normalized = alias.trim().replaceAll("\\s+", " ");
        if (normalized.codePointCount(0, normalized.length()) > PetdexRepository.MAX_ALIAS_CODE_POINTS) {
            throw new IOException("PET_ALIAS_TOO_LONG");
        }
        if (normalized.codePoints().anyMatch(Character::isISOControl)) {
            throw new IOException("INVALID_PET_ALIAS");
        }
        return normalized;
    }

    private static String commandText(String value, int maxCodePoints) {
        return limitText(value == null ? "" : value.replaceAll("[\\p{Cntrl}&&[^\\r\\n\\t]]", " "), maxCodePoints)
                .replace('\r', ' ').replace('\n', ' ').replace('\t', ' ');
    }

    private static String escapeCommandText(String value) {
        return value.replace("\"", "\\\"");
    }

    static String localPetErrorCode(Exception error) {
        String message = error.getMessage();
        if (message != null && message.matches("^[A-Z0-9_]+$")) {
            return message;
        }
        return error instanceof IOException ? "LOCAL_PET_OPERATION_FAILED" : "PETDEX_OPERATION_FAILED";
    }

    private static void runAsync(Runnable task) {
        AppExecutorUtil.getAppExecutorService().execute(task);
    }

    static JsonArray loadPetAssets(Path configuredRoot) throws IOException {
        JsonArray pets = new JsonArray();
        if (configuredRoot == null || !Files.isDirectory(configuredRoot, LinkOption.NOFOLLOW_LINKS)) {
            return pets;
        }

        Path root = configuredRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
        try (Stream<Path> files = Files.walk(root, 4)) {
            Path[] candidates = files.filter(path -> !isStaleImportPath(root, path))
                    .filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                    .filter(path -> !Files.isSymbolicLink(path))
                    .filter(CodexPetHandler::hasSupportedImageExtension)
                    .sorted(Comparator.comparing(Path::toString))
                    .limit(MAX_CANDIDATE_FILES)
                    .toArray(Path[]::new);
            for (Path candidate : candidates) {
                if (pets.size() >= MAX_PETS) {
                    break;
                }
                appendPetMetadata(root, candidate, pets);
            }
        }
        return pets;
    }

    private static void appendPetMetadata(Path root, Path path, JsonArray pets) {
        try {
            Path realPath = path.toRealPath(LinkOption.NOFOLLOW_LINKS);
            long fileSize = Files.size(realPath);
            if (!realPath.startsWith(root) || fileSize <= 0L || fileSize > MAX_IMAGE_BYTES) {
                return;
            }

            byte[] header = readImageHeader(realPath, fileSize);
            String mimeType = CodexPetImageSupport.detectMimeType(realPath, header);
            CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mimeType, header);
            if (mimeType == null || !CodexPetImageSupport.hasSafeDimensions(dimensions)
                    || !hasReadableImageMetadata(realPath, dimensions)) {
                return;
            }
            boolean spriteSheet = CodexPetImageSupport.isCanonicalPetdexSheet(dimensions);

            Path relative = root.relativize(realPath);
            Path relativeParent = relative.getParent();
            PetMetadata metadata = readPetMetadata(root, realPath, relativeParent, relative);
            JsonObject pet = new JsonObject();
            pet.addProperty("id", relative.toString().replace('\\', '/'));
            pet.addProperty("name", metadata.alias.isEmpty() ? metadata.originalName : metadata.alias);
            pet.addProperty("originalName", metadata.originalName);
            pet.addProperty("alias", metadata.alias);
            pet.addProperty("source", metadata.source);
            pet.addProperty("managed", metadata.managed);
            if (metadata.slug != null) {
                pet.addProperty("slug", metadata.slug);
            }
            pet.addProperty("spriteSheet", spriteSheet);
            pets.add(pet);
        } catch (IOException | SecurityException e) {
            LOG.debug("[CodexPet] Skipped unreadable pet asset: " + path);
        }
    }

    static JsonObject loadPetPreview(Path configuredRoot, String petId) throws IOException {
        if (configuredRoot == null || petId == null || petId.isBlank()
                || !Files.isDirectory(configuredRoot, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("LOCAL_PET_NOT_FOUND");
        }
        Path root = configuredRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
        Path candidate = root.resolve(petId.replace('/', java.io.File.separatorChar)).normalize();
        if (!candidate.startsWith(root)
                || !Files.isRegularFile(candidate, LinkOption.NOFOLLOW_LINKS)
                || Files.isSymbolicLink(candidate)
                || Files.size(candidate) > MAX_IMAGE_BYTES) {
            throw new IOException("LOCAL_PET_NOT_FOUND");
        }
        Path realPath = candidate.toRealPath(LinkOption.NOFOLLOW_LINKS);
        if (!realPath.startsWith(root)) {
            throw new IOException("PET_PATH_OUTSIDE_ROOT");
        }
        byte[] bytes = Files.readAllBytes(realPath);
        String mimeType = CodexPetImageSupport.detectMimeType(realPath, bytes);
        CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mimeType, bytes);
        if (mimeType == null || !CodexPetImageSupport.hasSafeDimensions(dimensions)
                || !CodexPetImageSupport.hasSafeFrameBudget(mimeType, bytes)) {
            throw new IOException("INVALID_LOCAL_PET_IMAGE");
        }
        BufferedImage decodedImage = ImageIO.read(new ByteArrayInputStream(bytes));
        if (decodedImage == null) {
            throw new IOException("INVALID_LOCAL_PET_IMAGE");
        }
        boolean spriteSheet = CodexPetImageSupport.isCanonicalPetdexSheet(dimensions);
        byte[] previewBytes = spriteSheet ? PetdexRepository.createPreviewPng(decodedImage) : bytes;
        String previewMimeType = spriteSheet ? "image/png" : mimeType;
        JsonObject result = new JsonObject();
        result.addProperty("dataUrl", "data:" + previewMimeType + ";base64,"
                + Base64.getEncoder().encodeToString(previewBytes));
        result.addProperty("spriteSheet", spriteSheet);
        return result;
    }

    private static byte[] readImageHeader(Path path, long fileSize) throws IOException {
        int headerSize = (int) Math.min(fileSize, MAX_IMAGE_HEADER_BYTES);
        try (InputStream input = Files.newInputStream(path)) {
            return input.readNBytes(headerSize);
        }
    }

    private static boolean hasReadableImageMetadata(
            Path path,
            CodexPetImageSupport.ImageDimensions expectedDimensions
    ) {
        try (ImageInputStream input = ImageIO.createImageInputStream(path.toFile())) {
            if (input == null) {
                return false;
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) {
                return false;
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                return reader.getWidth(0) == expectedDimensions.getWidth()
                        && reader.getHeight(0) == expectedDimensions.getHeight();
            } finally {
                reader.dispose();
            }
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    private static boolean hasSupportedImageExtension(Path path) {
        if (path == null || path.getFileName() == null) {
            return false;
        }
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")
                || name.endsWith(".gif") || name.endsWith(".webp");
    }

    private static boolean isStaleImportPath(Path root, Path path) {
        Path relative = root.relativize(path);
        return relative.getNameCount() > 0
                && relative.getName(0).toString().startsWith(".local-pet-import-");
    }

    private static PetMetadata readPetMetadata(Path root, Path image,
                                               Path relativeParent, Path relativeImage) {
        String fallbackName = relativeParent != null && relativeParent.getFileName() != null
                ? relativeParent.getFileName().toString()
                : stripExtension(relativeImage.getFileName().toString());
        String originalName = fallbackName;
        String alias = "";
        String source = "local";
        Path parent = image.getParent();
        Path petJson = parent == null ? null : parent.resolve("pet.json");
        if (petJson != null && Files.isRegularFile(petJson, LinkOption.NOFOLLOW_LINKS)
                && !Files.isSymbolicLink(petJson)) {
            try {
                if (Files.size(petJson) <= PetdexRepository.MAX_PET_JSON_BYTES) {
                    JsonObject metadata = JsonParser.parseString(Files.readString(petJson, StandardCharsets.UTF_8))
                            .getAsJsonObject();
                    String displayName = readString(metadata, "displayName");
                    if (displayName != null && !displayName.isBlank()) {
                        originalName = limitText(displayName, 100);
                    }
                    String configuredAlias = readString(metadata, "alias");
                    if (configuredAlias != null && !configuredAlias.isBlank()) {
                        alias = limitText(configuredAlias, PetdexRepository.MAX_ALIAS_CODE_POINTS);
                    }
                    String configuredSource = readString(metadata, "source");
                    if (configuredSource != null && !configuredSource.isBlank()) {
                        source = limitText(configuredSource, 32);
                    }
                }
            } catch (Exception e) {
                LOG.debug("[CodexPet] Ignored invalid pet metadata: " + petJson);
            }
        }
        String slug = relativeParent != null && relativeParent.getNameCount() == 1
                ? relativeParent.getFileName().toString() : null;
        boolean managedPetdex = "petdex".equals(source)
                && slug != null && PetdexRepository.isManagedInstall(root, slug);
        boolean managedImport = IMPORTED_SOURCE.equals(source)
                && slug != null && isImportedPet(root, slug);
        boolean managed = managedPetdex || managedImport;
        return new PetMetadata(originalName, alias, source, managed, managed ? slug : null);
    }

    private static String limitText(String value, int maxCodePoints) {
        String trimmed = value == null ? "" : value.trim().replaceAll("\\s+", " ");
        int codePoints = trimmed.codePointCount(0, trimmed.length());
        if (codePoints <= maxCodePoints) {
            return trimmed;
        }
        return trimmed.substring(0, trimmed.offsetByCodePoints(0, maxCodePoints));
    }

    private static JsonObject parseObject(String content) {
        JsonElement value = JsonParser.parseString(content == null || content.isBlank() ? "{}" : content);
        if (!value.isJsonObject()) {
            throw new IllegalArgumentException("Expected JSON object");
        }
        return value.getAsJsonObject();
    }

    private static boolean readBoolean(String content, String property, boolean fallback) {
        try {
            JsonObject object = parseObject(content);
            JsonElement value = object.get(property);
            return value != null && value.isJsonPrimitive() ? value.getAsBoolean() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static int readInt(String content, String property, int fallback) {
        try {
            JsonObject object = parseObject(content);
            JsonElement value = object.get(property);
            return value != null && value.isJsonPrimitive() ? value.getAsInt() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static String readString(String content, String property) {
        try {
            return readString(parseObject(content), property);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String readString(JsonObject object, String property) {
        JsonElement value = object.get(property);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
                ? value.getAsString() : null;
    }

    static String errorCode(Exception error) {
        String message = error.getMessage();
        if (message != null && message.matches("^[A-Z0-9_]+$")) {
            return message;
        }
        if (error instanceof HttpConnectTimeoutException) {
            return "PETDEX_CONNECT_TIMEOUT";
        }
        if (error instanceof HttpTimeoutException) {
            return "PETDEX_REQUEST_TIMEOUT";
        }
        if (error instanceof IOException) {
            return "PETDEX_NETWORK_ERROR";
        }
        return "PETDEX_OPERATION_FAILED";
    }

    static String aliasErrorCode(Exception error) {
        String message = error.getMessage();
        if (List.of(
                "INVALID_PET_SLUG",
                "PET_NOT_INSTALLED",
                "PET_NOT_MANAGED_BY_PLUGIN",
                "INVALID_PET_JSON",
                "PET_ALIAS_TOO_LONG",
                "INVALID_PET_ALIAS",
                "PET_PATH_OUTSIDE_ROOT"
        ).contains(message)) {
            return message;
        }
        return error instanceof IOException ? "PET_ALIAS_UPDATE_FAILED" : "PETDEX_OPERATION_FAILED";
    }

    private static String stripExtension(String fileName) {
        int dotIndex = fileName.lastIndexOf('.');
        return dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
    }

    private static final class PetMetadata {
        private final String originalName;
        private final String alias;
        private final String source;
        private final boolean managed;
        private final String slug;

        private PetMetadata(String originalName, String alias, String source,
                            boolean managed, String slug) {
            this.originalName = originalName;
            this.alias = alias;
            this.source = source;
            this.managed = managed;
            this.slug = slug;
        }
    }

    static final class HatchPetStatus {
        private final String status;
        private final Path skillPath;

        private HatchPetStatus(String status, Path skillPath) {
            this.status = status;
            this.skillPath = skillPath;
        }

        String getStatus() {
            return status;
        }
    }
}
