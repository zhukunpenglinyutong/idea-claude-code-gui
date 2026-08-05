package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.PathManager;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.FileVisitOption;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.DosFileAttributeView;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Safely relocates AI CLI data while preserving the canonical home-directory paths. */
public final class AiDataDirectoryManager {

    private static final Object OPERATION_LOCK = new Object();
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final String[] DATA_HOME_IDS = {"claude", "codemoss", "codex"};
    private static final String JOURNAL_FILE = "migration-journal.json";
    private static final String BACKUPS_FILE = "migration-backups.json";
    private static final String BACKUP_MARKER = ".cc-gui-backup-";
    private static final String STORAGE_MARKER = ".cc-gui-storage";
    private static final int LINK_COMMAND_TIMEOUT_SECONDS = 30;

    private final Path userHome;
    private final Path stateDirectory;
    private final PlatformUtils.PlatformType platform;
    private final boolean wsl;
    private final DirectoryLinkCreator linkCreator;
    private final AiDataProcessGate processGate;
    private final PathDeleter backupPathDeleter;

    public AiDataDirectoryManager() {
        this(Path.of(PlatformUtils.getHomeDirectory()),
                Path.of(PathManager.getSystemPath(), "cc-gui", "ai-data-storage"),
                PlatformUtils.getPlatformType(),
                PlatformUtils.isLinux() && notBlank(PlatformUtils.getEnvIgnoreCase("WSL_DISTRO_NAME")),
                null);
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator) {
        this(userHome, stateDirectory, platform, wsl, linkCreator, AiDataProcessGate.getInstance());
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator, AiDataProcessGate processGate) {
        this(userHome, stateDirectory, platform, wsl, linkCreator, processGate,
                AiDataDirectoryManager::deleteWritablePath);
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator, AiDataProcessGate processGate,
                           PathDeleter backupPathDeleter) {
        this.userHome = userHome.toAbsolutePath().normalize();
        this.stateDirectory = stateDirectory.toAbsolutePath().normalize();
        this.platform = Objects.requireNonNull(platform, "platform");
        this.wsl = wsl;
        this.linkCreator = linkCreator == null ? this::createPlatformLink : linkCreator;
        this.processGate = Objects.requireNonNull(processGate, "processGate");
        this.backupPathDeleter = Objects.requireNonNull(backupPathDeleter, "backupPathDeleter");
    }

    public JsonObject snapshot() throws IOException {
        synchronized (OPERATION_LOCK) {
            try (AiDataProcessGate.MigrationPermit ignored = acquireRecoveryPermitIfNeeded()) {
                boolean recovered = recoverInterruptedMigration();
                JsonObject result = new JsonObject();
                result.addProperty("supported", isSupported());
                result.addProperty("platform", platform.name().toLowerCase());
                result.addProperty("wsl", wsl);
                result.addProperty("homeDirectory", userHome.toString());
                result.addProperty("recovered", recovered);
                if (wsl) {
                    result.addProperty("error", "WSL_NOT_SUPPORTED");
                } else if (platform == PlatformUtils.PlatformType.UNKNOWN) {
                    result.addProperty("error", "PLATFORM_NOT_SUPPORTED");
                }

                JsonArray entries = new JsonArray();
                Path commonRoot = null;
                boolean commonRootAvailable = true;
                for (String id : DATA_HOME_IDS) {
                    JsonObject entry = inspectEntry(id);
                    entries.add(entry);
                    if (!"linked".equals(entry.get("state").getAsString())) {
                        commonRootAvailable = false;
                        continue;
                    }
                    Path physical = Path.of(entry.get("physicalPath").getAsString());
                    Path parent = physical.getParent();
                    if (parent == null || (commonRoot != null && !commonRoot.equals(parent))) {
                        commonRootAvailable = false;
                    } else if (commonRoot == null) {
                        commonRoot = parent;
                    }
                }
                result.add("directories", entries);
                if (commonRootAvailable && commonRoot != null) {
                    result.addProperty("storageRoot", commonRoot.toString());
                }
                JsonArray backups = readBackupRecords();
                result.add("backups", backups);
                result.addProperty("backupCount", backups.size());
                return result;
            }
        }
    }

    public JsonObject migrate(String requestedRoot) throws IOException {
        synchronized (OPERATION_LOCK) {
            AiDataProcessGate.MigrationPermit migrationPermit = processGate.tryAcquireMigrationPermit();
            if (migrationPermit == null) {
                throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
            }
            try (migrationPermit) {
                requireSupported();
                recoverInterruptedMigration();
                checkMigrationCancellation(migrationPermit);
                Path targetRoot = validateTargetRoot(requestedRoot);
                String operationId = UUID.randomUUID().toString();
                List<MigrationEntry> entries = prepareEntries(targetRoot, operationId);
                checkMigrationCancellation(migrationPermit);
                if (entries.isEmpty()) {
                    beginMigrationCommit(migrationPermit);
                    return operationResult("migrate", true, null, snapshot());
                }

                Journal journal = new Journal(operationId, entries);
                writeJournal(journal);
                try {
                    for (MigrationEntry entry : entries) {
                        checkMigrationCancellation(migrationPermit);
                        prepareTarget(entry);
                        checkMigrationCancellation(migrationPermit);
                        entry.phase = Phase.TARGET_READY.name();
                        writeJournal(journal);
                    }
                    for (MigrationEntry entry : entries) {
                        checkMigrationCancellation(migrationPermit);
                        detachCanonicalPath(entry);
                        checkMigrationCancellation(migrationPermit);
                        entry.phase = Phase.SOURCE_DETACHED.name();
                        writeJournal(journal);
                        linkCreator.create(entry.canonicalPath(), entry.targetPath());
                        validateLink(entry.canonicalPath(), entry.targetPath());
                        validateDetachedSource(entry);
                        checkMigrationCancellation(migrationPermit);
                        entry.phase = Phase.LINKED.name();
                        writeJournal(journal);
                    }
                    checkMigrationCancellation(migrationPermit);
                    rememberBackups(entries, journal.operationId);
                    checkMigrationCancellation(migrationPermit);
                    beginMigrationCommit(migrationPermit);
                    Files.deleteIfExists(journalPath());
                    return operationResult("migrate", true, null, snapshot());
                } catch (IOException | RuntimeException error) {
                    try {
                        rollback(journal);
                    } catch (IOException rollbackError) {
                        error.addSuppressed(rollbackError);
                        throw new AiDataDirectoryException("MIGRATION_ROLLBACK_FAILED", error);
                    }
                    throw error;
                }
            }
        }
    }

    private static void checkMigrationCancellation(AiDataProcessGate.MigrationPermit migrationPermit)
            throws AiDataDirectoryException {
        if (migrationPermit.isCancellationRequested()) {
            throw new AiDataDirectoryException("MIGRATION_CANCELLED_FOR_AI_START");
        }
    }

    private static void beginMigrationCommit(AiDataProcessGate.MigrationPermit migrationPermit)
            throws AiDataDirectoryException {
        if (!migrationPermit.beginCommit()) {
            throw new AiDataDirectoryException("MIGRATION_CANCELLED_FOR_AI_START");
        }
    }

    public JsonObject cleanupBackups() throws IOException {
        synchronized (OPERATION_LOCK) {
            try (AiDataProcessGate.MigrationPermit ignored = acquireRecoveryPermitIfNeeded()) {
                recoverInterruptedMigration();
            }
            List<BackupRecord> records = validateBackupRecords(readBackupRecords());
            List<BackupRecord> retained = new ArrayList<>(records);
            IOException cleanupFailure = null;
            for (BackupRecord record : records) {
                if (record.existedAtValidation) {
                    try {
                        deleteTree(record.path, backupPathDeleter);
                    } catch (IOException error) {
                        cleanupFailure = appendFailure(cleanupFailure, error);
                        continue;
                    }
                }

                retained.remove(record);
                try {
                    persistBackupRecords(retained);
                } catch (IOException error) {
                    cleanupFailure = appendFailure(cleanupFailure, error);
                    break;
                }
            }
            if (cleanupFailure != null) {
                throw new AiDataDirectoryException("BACKUP_CLEANUP_PARTIAL", cleanupFailure);
            }
            return operationResult("cleanup", true, null, snapshot());
        }
    }

    private List<BackupRecord> validateBackupRecords(JsonArray metadata) throws IOException {
        List<BackupRecord> records = new ArrayList<>();
        for (JsonElement element : metadata) {
            if (!element.isJsonObject()) {
                throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
            }
            JsonObject record = element.getAsJsonObject();
            String id = requiredString(record, "id");
            String operationId = requiredString(record, "operationId");
            Path path;
            try {
                path = Path.of(requiredString(record, "path")).toAbsolutePath().normalize();
            } catch (RuntimeException error) {
                throw new AiDataDirectoryException("BACKUP_METADATA_INVALID", error);
            }
            validateBackupPath(id, path, operationId);
            Path canonical = canonicalPath(id);
            boolean backupExists = Files.exists(path, LinkOption.NOFOLLOW_LINKS);
            if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)
                    && backupExists
                    && Files.isSameFile(canonical, path)) {
                throw new AiDataDirectoryException("BACKUP_STILL_ACTIVE");
            }
            records.add(new BackupRecord(record, path, backupExists));
        }
        return records;
    }

    private void persistBackupRecords(List<BackupRecord> records) throws IOException {
        if (records.isEmpty()) {
            Files.deleteIfExists(backupsPath());
            return;
        }
        JsonArray metadata = new JsonArray();
        for (BackupRecord record : records) {
            metadata.add(record.metadata);
        }
        writeJson(backupsPath(), metadata);
    }

    private static IOException appendFailure(IOException current, IOException next) {
        if (current == null) {
            return next;
        }
        current.addSuppressed(next);
        return current;
    }

    private List<MigrationEntry> prepareEntries(Path targetRoot, String operationId) throws IOException {
        List<MigrationEntry> entries = new ArrayList<>();
        for (String id : DATA_HOME_IDS) {
            Path canonical = canonicalPath(id);
            Path target = targetRoot.resolve("." + id).normalize();
            if (!Objects.equals(target.getParent(), targetRoot)) {
                throw new AiDataDirectoryException("TARGET_PATH_INVALID");
            }

            SourceKind sourceKind = SourceKind.MISSING;
            Path sourcePhysical = null;
            if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
                if (!Files.isDirectory(canonical)) {
                    throw new AiDataDirectoryException("SOURCE_NOT_DIRECTORY");
                }
                sourcePhysical = canonical.toRealPath();
                sourceKind = isDirectDirectoryLink(canonical) ? SourceKind.LINKED : SourceKind.LOCAL;
            }
            if (sourcePhysical != null && Files.exists(target, LinkOption.NOFOLLOW_LINKS)
                    && Files.isSameFile(sourcePhysical, target)) {
                continue;
            }
            if (sourcePhysical != null && targetRoot.startsWith(sourcePhysical)) {
                throw new AiDataDirectoryException("TARGET_INSIDE_SOURCE");
            }
            boolean targetExisted = Files.exists(target, LinkOption.NOFOLLOW_LINKS);
            if (targetExisted) {
                if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)
                        || isDirectDirectoryLink(target) || !isDirectoryEmpty(target)) {
                    throw new AiDataDirectoryException("TARGET_NOT_EMPTY");
                }
            }
            Path staging = targetRoot.resolve(".cc-gui-migration-" + operationId + "-" + id);
            Path backup = userHome.resolve("." + id + BACKUP_MARKER
                    + Instant.now().toEpochMilli() + "-" + operationId);
            entries.add(new MigrationEntry(id, canonical, target, staging, backup,
                    sourcePhysical, sourceKind, targetExisted));
        }
        return entries;
    }

    private Path validateTargetRoot(String value) throws IOException {
        if (!notBlank(value)) {
            throw new AiDataDirectoryException("TARGET_ROOT_REQUIRED");
        }
        Path requested;
        try {
            requested = Path.of(value);
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("TARGET_PATH_INVALID", error);
        }
        if (!requested.isAbsolute()) {
            throw new AiDataDirectoryException("TARGET_PATH_INVALID");
        }
        requested = requested.normalize();
        for (String id : DATA_HOME_IDS) {
            Path canonical = canonicalPath(id);
            if (requested.startsWith(canonical) || canonical.startsWith(requested)) {
                throw new AiDataDirectoryException("TARGET_OVERLAPS_HOME");
            }
        }
        Files.createDirectories(requested);
        if (!Files.isDirectory(requested, LinkOption.NOFOLLOW_LINKS)
                || isDirectDirectoryLink(requested) || !Files.isWritable(requested)) {
            throw new AiDataDirectoryException("TARGET_ROOT_UNAVAILABLE");
        }
        return requested.toRealPath();
    }

    private void prepareTarget(MigrationEntry entry) throws IOException {
        Path staging = entry.stagingPath();
        if (Files.exists(staging, LinkOption.NOFOLLOW_LINKS)) {
            throw new AiDataDirectoryException("STAGING_PATH_EXISTS");
        }
        validateStorageMarker(entry);
        Files.createDirectory(staging);
        Path source = entry.sourcePhysicalPath();
        Map<Path, Path> internalDirectoryLinks = Map.of();
        if (source != null) {
            Map<String, ManifestEntry> before = buildDataManifest(source);
            internalDirectoryLinks = copyDirectory(source, staging);
            Map<String, ManifestEntry> copied = buildDataManifest(staging);
            Map<String, ManifestEntry> after = buildDataManifest(source);
            if (!before.equals(copied) || !before.equals(after)) {
                throw new AiDataDirectoryException("SOURCE_CHANGED_DURING_MIGRATION");
            }
        }
        Path target = entry.targetPath();
        if (entry.targetExisted) {
            Files.delete(target);
        }
        Path marker = staging.resolve(STORAGE_MARKER);
        if (Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
            if (!hasStorageMarker(staging, entry.id)) {
                throw new AiDataDirectoryException("STORAGE_MARKER_CONFLICT");
            }
        } else {
            Files.writeString(marker, entry.id, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
        }
        for (Path relativeLink : internalDirectoryLinks.keySet()) {
            deleteDirectoryLink(staging.resolve(relativeLink));
        }
        move(staging, target);
        for (Map.Entry<Path, Path> link : internalDirectoryLinks.entrySet()) {
            createPlatformLink(target.resolve(link.getKey()), target.resolve(link.getValue()));
        }
    }

    private static void validateStorageMarker(MigrationEntry entry) throws IOException {
        Path source = entry.sourcePhysicalPath();
        if (source == null) {
            return;
        }
        Path marker = source.resolve(STORAGE_MARKER);
        if (!Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (entry.sourceKind() != SourceKind.LINKED || !hasStorageMarker(source, entry.id)) {
            throw new AiDataDirectoryException("STORAGE_MARKER_CONFLICT");
        }
    }

    private void detachCanonicalPath(MigrationEntry entry) throws IOException {
        Path canonical = entry.canonicalPath();
        if (entry.sourceKind() == SourceKind.LOCAL) {
            move(canonical, entry.backupPath());
        } else if (entry.sourceKind() == SourceKind.LINKED) {
            deleteDirectoryLink(canonical);
        }
    }

    private static void validateDetachedSource(MigrationEntry entry) throws IOException {
        Path detachedSource = entry.sourceKind() == SourceKind.LOCAL
                ? entry.backupPath() : entry.sourcePhysicalPath();
        if (detachedSource != null
                && !buildDataManifest(detachedSource, entry.sourcePhysicalPath(), entry.targetPath())
                        .equals(buildDataManifest(entry.targetPath()))) {
            throw new AiDataDirectoryException("SOURCE_CHANGED_DURING_MIGRATION");
        }
    }

    private boolean recoverInterruptedMigration() throws IOException {
        if (!Files.isRegularFile(journalPath(), LinkOption.NOFOLLOW_LINKS)) {
            return false;
        }
        rollback(readJournal());
        return true;
    }

    private AiDataProcessGate.MigrationPermit acquireRecoveryPermitIfNeeded() throws IOException {
        if (!Files.isRegularFile(journalPath(), LinkOption.NOFOLLOW_LINKS)) {
            return null;
        }
        AiDataProcessGate.MigrationPermit migrationPermit = processGate.tryAcquireMigrationPermit();
        if (migrationPermit == null) {
            throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
        }
        return migrationPermit;
    }

    private void rollback(Journal journal) throws IOException {
        validateJournal(journal);
        IOException failure = null;
        List<MigrationEntry> reverse = new ArrayList<>(journal.entries);
        reverse.sort(Comparator.comparingInt((MigrationEntry entry) -> phaseOrder(entry.phase)).reversed());
        for (MigrationEntry entry : reverse) {
            try {
                rollbackEntry(entry);
            } catch (IOException error) {
                if (failure == null) {
                    failure = error;
                } else {
                    failure.addSuppressed(error);
                }
            }
        }
        if (failure != null) {
            throw failure;
        }
        removeBackupRecords(journal.operationId);
        Files.deleteIfExists(journalPath());
    }

    private void rollbackEntry(MigrationEntry entry) throws IOException {
        Path canonical = entry.canonicalPath();
        Path target = entry.targetPath();
        if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
            if (isDirectDirectoryLink(canonical)) {
                boolean pointsToTarget = hasStorageMarker(target, entry.id) && isLinkTo(canonical, target);
                Path previous = entry.sourcePhysicalPath();
                boolean pointsToPrevious = entry.sourceKind() == SourceKind.LINKED
                        && previous != null && isLinkTo(canonical, previous);
                if (!pointsToTarget && !pointsToPrevious) {
                    throw new AiDataDirectoryException("RECOVERY_PATH_CONFLICT");
                }
                deleteDirectoryLink(canonical);
            } else if (entry.sourceKind() != SourceKind.LOCAL) {
                throw new AiDataDirectoryException("RECOVERY_PATH_CONFLICT");
            }
        }
        if (entry.sourceKind() == SourceKind.LOCAL && Files.exists(entry.backupPath(), LinkOption.NOFOLLOW_LINKS)) {
            if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
                throw new AiDataDirectoryException("RECOVERY_PATH_CONFLICT");
            }
            move(entry.backupPath(), canonical);
        } else if (entry.sourceKind() == SourceKind.LINKED
                && !Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
            Path previous = entry.sourcePhysicalPath();
            if (previous == null || !Files.isDirectory(previous, LinkOption.NOFOLLOW_LINKS)) {
                throw new AiDataDirectoryException("RECOVERY_SOURCE_MISSING");
            }
            linkCreator.create(canonical, previous);
            validateLink(canonical, previous);
        }
        if (Files.exists(entry.stagingPath(), LinkOption.NOFOLLOW_LINKS)) {
            deleteTree(entry.stagingPath());
        }
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            if (hasStorageMarker(target, entry.id)) {
                deleteTree(target);
            } else if (!entry.targetExisted || !isDirectoryEmpty(target)) {
                throw new AiDataDirectoryException("RECOVERY_TARGET_CONFLICT");
            }
        }
        if (entry.targetExisted && !Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            Files.createDirectory(target);
        }
    }

    private JsonObject inspectEntry(String id) {
        JsonObject entry = new JsonObject();
        Path canonical = canonicalPath(id);
        entry.addProperty("id", id);
        entry.addProperty("canonicalPath", canonical.toString());
        try {
            if (!Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
                entry.addProperty("state", "missing");
                return entry;
            }
            if (!Files.isDirectory(canonical)) {
                entry.addProperty("state", "unavailable");
                return entry;
            }
            entry.addProperty("state", isDirectDirectoryLink(canonical) ? "linked" : "local");
            entry.addProperty("physicalPath", canonical.toRealPath().toString());
        } catch (IOException error) {
            entry.addProperty("state", "unavailable");
        }
        return entry;
    }

    private boolean isSupported() {
        return !wsl && platform != PlatformUtils.PlatformType.UNKNOWN;
    }

    private void requireSupported() throws AiDataDirectoryException {
        if (wsl) {
            throw new AiDataDirectoryException("WSL_NOT_SUPPORTED");
        }
        if (platform == PlatformUtils.PlatformType.UNKNOWN) {
            throw new AiDataDirectoryException("PLATFORM_NOT_SUPPORTED");
        }
    }

    private Path canonicalPath(String id) {
        return userHome.resolve("." + id).normalize();
    }

    private void createPlatformLink(Path canonical, Path target) throws IOException {
        if (platform == PlatformUtils.PlatformType.WINDOWS) {
            createWindowsJunction(canonical, target);
        } else {
            Files.createSymbolicLink(canonical, target);
        }
    }

    private static void createWindowsJunction(Path canonical, Path target) throws IOException {
        Path script = Files.createTempFile("cc-gui-junction-", ".ps1");
        try {
            Files.writeString(script, "param([string]$LinkPath, [string]$TargetPath)\n"
                    + "$ErrorActionPreference = 'Stop'\n"
                    + "New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null\n",
                    StandardCharsets.UTF_8);
            Process process = new ProcessBuilder("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                    "-ExecutionPolicy", "Bypass", "-File", script.toString(),
                    "-LinkPath", canonical.toString(), "-TargetPath", target.toString())
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();
            try {
                if (!process.waitFor(LINK_COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    terminateProcess(process);
                    throw new AiDataDirectoryException("LINK_CREATION_TIMEOUT");
                }
            } catch (InterruptedException error) {
                terminateProcess(process);
                Thread.currentThread().interrupt();
                throw new AiDataDirectoryException("LINK_CREATION_INTERRUPTED", error);
            }
            if (process.exitValue() != 0) {
                throw new AiDataDirectoryException("LINK_CREATION_FAILED");
            }
        } finally {
            Files.deleteIfExists(script);
        }
    }

    private static void terminateProcess(Process process) {
        process.destroyForcibly();
        try {
            process.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    static boolean isDirectDirectoryLink(Path path) throws IOException {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return false;
        }
        if (Files.isSymbolicLink(path)) {
            return true;
        }
        Path parent = path.getParent();
        if (parent == null || !Files.isDirectory(parent)) {
            return false;
        }
        Path expected = parent.toRealPath().resolve(path.getFileName()).normalize();
        return !expected.equals(path.toRealPath());
    }

    private static void validateLink(Path canonical, Path target) throws IOException {
        if (!isDirectDirectoryLink(canonical) || !Files.isSameFile(canonical, target)) {
            throw new AiDataDirectoryException("LINK_VALIDATION_FAILED");
        }
    }

    private static boolean isLinkTo(Path link, Path target) {
        try {
            return isDirectDirectoryLink(link) && Files.isSameFile(link, target);
        } catch (IOException error) {
            return false;
        }
    }

    private static void deleteDirectoryLink(Path path) throws IOException {
        if (!isDirectDirectoryLink(path)) {
            throw new AiDataDirectoryException("PATH_IS_NOT_LINK");
        }
        Files.deleteIfExists(path);
    }

    private Map<Path, Path> copyDirectory(Path source, Path target) throws IOException {
        Map<Path, Path> directoryLinks = new LinkedHashMap<>();
        Map<Path, Path> internalDirectoryLinks = new LinkedHashMap<>();
        Files.walkFileTree(source, EnumSet.noneOf(FileVisitOption.class), Integer.MAX_VALUE,
                new SimpleFileVisitor<>() {
                    @Override
                    public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes)
                            throws IOException {
                        if (!directory.equals(source)) {
                            Path destination = target.resolve(source.relativize(directory));
                            if (isDirectDirectoryLink(directory)) {
                                Path resolved = directory.toRealPath();
                                directoryLinks.put(destination, relocatedLinkTarget(source, target, resolved));
                                rememberInternalDirectoryLink(
                                        source, target, destination, resolved, internalDirectoryLinks);
                                return FileVisitResult.SKIP_SUBTREE;
                            }
                            if (attributes.isOther()) {
                                throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                            }
                            Files.createDirectory(destination);
                        }
                        return FileVisitResult.CONTINUE;
                    }

                    @Override
                    public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                        Path destination = target.resolve(source.relativize(file));
                        if (attributes.isSymbolicLink()) {
                            Files.createSymbolicLink(destination,
                                    relocatedSymbolicLinkTarget(source, target, file, destination));
                        } else if (isDirectDirectoryLink(file)) {
                            Path resolved = file.toRealPath();
                            directoryLinks.put(destination, relocatedLinkTarget(source, target, resolved));
                            rememberInternalDirectoryLink(
                                    source, target, destination, resolved, internalDirectoryLinks);
                        } else if (attributes.isRegularFile()) {
                            Files.copy(file, destination, StandardCopyOption.COPY_ATTRIBUTES);
                        } else {
                            throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                        }
                        return FileVisitResult.CONTINUE;
                    }
                });
        for (Map.Entry<Path, Path> link : directoryLinks.entrySet()) {
            createPlatformLink(link.getKey(), link.getValue());
        }
        return internalDirectoryLinks;
    }

    private static void rememberInternalDirectoryLink(
            Path source, Path target, Path destination, Path resolved,
            Map<Path, Path> internalDirectoryLinks) {
        if (resolved.startsWith(source)) {
            internalDirectoryLinks.put(target.relativize(destination), source.relativize(resolved));
        }
    }

    private static Path relocatedSymbolicLinkTarget(Path source, Path target, Path link, Path destination)
            throws IOException {
        Path resolved = resolveSymbolicLink(link);
        if (!resolved.startsWith(source)) {
            return resolved;
        }
        Path relocated = target.resolve(source.relativize(resolved)).normalize();
        return destination.getParent().relativize(relocated);
    }

    private static Path resolveSymbolicLink(Path link) throws IOException {
        Path configured = Files.readSymbolicLink(link);
        if (configured.isAbsolute()) {
            return configured.normalize();
        }
        return link.getParent().resolve(configured).toAbsolutePath().normalize();
    }

    private static Path relocatedLinkTarget(Path source, Path target, Path resolved) {
        return resolved.startsWith(source)
                ? target.resolve(source.relativize(resolved)).normalize()
                : resolved;
    }

    static Map<String, ManifestEntry> buildManifest(Path root) throws IOException {
        return buildManifest(root, null, null);
    }

    private static Map<String, ManifestEntry> buildManifest(
            Path root, Path originalRoot, Path relocatedRoot) throws IOException {
        Map<String, ManifestEntry> result = new LinkedHashMap<>();
        Files.walkFileTree(root, EnumSet.noneOf(FileVisitOption.class), Integer.MAX_VALUE,
                new SimpleFileVisitor<>() {
                    @Override
                    public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes)
                            throws IOException {
                        if (directory.equals(root)) {
                            return FileVisitResult.CONTINUE;
                        }
                        String relative = manifestPath(root, directory);
                        if (isDirectDirectoryLink(directory)) {
                            Path resolved = relocatedManifestTarget(
                                    directory.toRealPath(), root, originalRoot, relocatedRoot);
                            result.put(relative, new ManifestEntry(
                                    "directory-link", 0L,
                                    linkFingerprint(root, resolved)));
                            return FileVisitResult.SKIP_SUBTREE;
                        }
                        if (attributes.isOther()) {
                            throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                        }
                        result.put(relative, new ManifestEntry("directory", 0L, ""));
                        return FileVisitResult.CONTINUE;
                    }

                    @Override
                    public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                        String relative = manifestPath(root, file);
                        if (attributes.isSymbolicLink()) {
                            Path resolved = relocatedManifestTarget(
                                    resolveSymbolicLink(file), root, originalRoot, relocatedRoot);
                            result.put(relative, new ManifestEntry(
                                    "link", 0L, linkFingerprint(root, resolved)));
                        } else if (isDirectDirectoryLink(file)) {
                            Path resolved = relocatedManifestTarget(
                                    file.toRealPath(), root, originalRoot, relocatedRoot);
                            result.put(relative, new ManifestEntry(
                                    "directory-link", 0L,
                                    linkFingerprint(root, resolved)));
                        } else if (attributes.isRegularFile()) {
                            result.put(relative, new ManifestEntry("file", attributes.size(), sha256(file)));
                        } else {
                            throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                        }
                        return FileVisitResult.CONTINUE;
                    }
                });
        return result;
    }

    private static Map<String, ManifestEntry> buildDataManifest(Path root) throws IOException {
        Map<String, ManifestEntry> result = buildManifest(root);
        result.remove(STORAGE_MARKER);
        return result;
    }

    private static Map<String, ManifestEntry> buildDataManifest(
            Path root, Path originalRoot, Path relocatedRoot) throws IOException {
        Map<String, ManifestEntry> result = buildManifest(root, originalRoot, relocatedRoot);
        result.remove(STORAGE_MARKER);
        return result;
    }

    private static Path relocatedManifestTarget(
            Path resolved, Path root, Path originalRoot, Path relocatedRoot) {
        Path normalized = resolved.toAbsolutePath().normalize();
        if (relocatedRoot != null && normalized.startsWith(relocatedRoot)) {
            return root.resolve(relocatedRoot.relativize(normalized)).normalize();
        }
        if (originalRoot != null && normalized.startsWith(originalRoot)) {
            return root.resolve(originalRoot.relativize(normalized)).normalize();
        }
        return normalized;
    }

    private static String linkFingerprint(Path root, Path resolvedTarget) {
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path normalizedTarget = resolvedTarget.toAbsolutePath().normalize();
        if (normalizedTarget.startsWith(normalizedRoot)) {
            return "internal:" + manifestPath(normalizedRoot, normalizedTarget);
        }
        return "external:" + normalizedTarget;
    }

    private static String manifestPath(Path root, Path path) {
        return root.relativize(path).toString().replace('\\', '/');
    }

    private static String sha256(Path path) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = new DigestInputStream(Files.newInputStream(path), digest)) {
                input.transferTo(java.io.OutputStream.nullOutputStream());
            }
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    static void deleteTree(Path root) throws IOException {
        deleteTree(root, AiDataDirectoryManager::deleteWritablePath);
    }

    static void deleteTree(Path root, PathDeleter pathDeleter) throws IOException {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (isDirectDirectoryLink(root)) {
            deleteDirectoryLink(root);
            return;
        }
        Path storageMarker = root.resolve(STORAGE_MARKER);
        byte[] storageMarkerContent = Files.isRegularFile(storageMarker, LinkOption.NOFOLLOW_LINKS)
                && !Files.isSymbolicLink(storageMarker) ? Files.readAllBytes(storageMarker) : null;
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes)
                    throws IOException {
                if (!directory.equals(root) && isDirectDirectoryLink(directory)) {
                    deleteDirectoryLink(directory);
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                if (!file.equals(storageMarker)) {
                    if (attributes.isSymbolicLink()) {
                        Files.deleteIfExists(file);
                    } else {
                        pathDeleter.delete(file);
                    }
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error) throws IOException {
                if (error != null) {
                    throw error;
                }
                if (directory.equals(root) && Files.exists(storageMarker, LinkOption.NOFOLLOW_LINKS)) {
                    pathDeleter.delete(storageMarker);
                }
                try {
                    pathDeleter.delete(directory);
                } catch (IOException deleteError) {
                    if (directory.equals(root) && storageMarkerContent != null
                            && Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)
                            && !Files.exists(storageMarker, LinkOption.NOFOLLOW_LINKS)) {
                        try {
                            Files.write(storageMarker, storageMarkerContent, StandardOpenOption.CREATE_NEW);
                        } catch (IOException restoreError) {
                            deleteError.addSuppressed(restoreError);
                        }
                    }
                    throw deleteError;
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    static void deleteWritablePath(Path path) throws IOException {
        DosFileAttributeView attributes = Files.getFileAttributeView(
                path, DosFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes != null && attributes.readAttributes().isReadOnly()) {
            attributes.setReadOnly(false);
        }
        Files.delete(path);
    }

    private void rememberBackups(List<MigrationEntry> entries, String operationId) throws IOException {
        JsonArray records = readBackupRecords();
        for (MigrationEntry entry : entries) {
            Path backup = entry.sourceKind() == SourceKind.LOCAL
                    ? entry.backupPath() : entry.sourcePhysicalPath();
            if (backup == null || backup.equals(entry.targetPath())) {
                continue;
            }
            if (entry.sourceKind() == SourceKind.LINKED && !hasStorageMarker(backup, entry.id)) {
                continue;
            }
            JsonObject record = new JsonObject();
            record.addProperty("id", entry.id);
            record.addProperty("path", backup.toString());
            record.addProperty("createdAt", Instant.now().toString());
            record.addProperty("operationId", operationId);
            records.add(record);
        }
        writeJson(backupsPath(), records);
    }

    private void removeBackupRecords(String operationId) throws IOException {
        if (!Files.isRegularFile(backupsPath(), LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        JsonArray retained = new JsonArray();
        for (JsonElement element : readBackupRecords()) {
            JsonObject record = element.getAsJsonObject();
            if (!record.has("operationId")
                    || !operationId.equals(record.get("operationId").getAsString())) {
                retained.add(record);
            }
        }
        if (retained.isEmpty()) {
            Files.deleteIfExists(backupsPath());
        } else {
            writeJson(backupsPath(), retained);
        }
    }

    private void validateBackupPath(String id, Path path, String operationId) throws IOException {
        if (!List.of(DATA_HOME_IDS).contains(id) || !isUuid(operationId)) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
        }
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        String name = path.getFileName() == null ? "" : path.getFileName().toString();
        boolean localBackup = Objects.equals(path.getParent(), userHome)
                && isGeneratedBackupName(name, id, operationId);
        boolean relocatedHome = name.equals("." + id) && !path.equals(canonicalPath(id))
                && hasStorageMarker(path, id);
        if ((!localBackup && !relocatedHome) || isDirectDirectoryLink(path)) {
            throw new AiDataDirectoryException("BACKUP_PATH_INVALID");
        }
    }

    private JsonArray readBackupRecords() throws IOException {
        if (!Files.isRegularFile(backupsPath(), LinkOption.NOFOLLOW_LINKS)) {
            return new JsonArray();
        }
        JsonElement value = JsonParser.parseString(Files.readString(backupsPath(), StandardCharsets.UTF_8));
        if (!value.isJsonArray()) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
        }
        return value.getAsJsonArray();
    }

    private Journal readJournal() throws IOException {
        try {
            Journal journal = GSON.fromJson(
                    Files.readString(journalPath(), StandardCharsets.UTF_8), Journal.class);
            validateJournal(journal);
            return journal;
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID", error);
        }
    }

    private void validateJournal(Journal journal) throws IOException {
        if (journal == null || !isUuid(journal.operationId)
                || journal.entries == null || journal.entries.isEmpty()
                || journal.entries.size() > DATA_HOME_IDS.length) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
        }
        Set<String> ids = new HashSet<>();
        for (MigrationEntry entry : journal.entries) {
            if (entry == null || !List.of(DATA_HOME_IDS).contains(entry.id) || !ids.add(entry.id)) {
                throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
            }
            Path canonical = requireAbsolutePath(entry.canonical);
            Path target = requireAbsolutePath(entry.target);
            Path staging = requireAbsolutePath(entry.staging);
            Path backup = requireAbsolutePath(entry.backup);
            Path targetRoot = target.getParent();
            String targetName = target.getFileName() == null ? "" : target.getFileName().toString();
            String stagingName = staging.getFileName() == null ? "" : staging.getFileName().toString();
            String backupName = backup.getFileName() == null ? "" : backup.getFileName().toString();
            if (!canonical.equals(canonicalPath(entry.id))
                    || targetRoot == null || !targetName.equals("." + entry.id)
                    || !Objects.equals(staging.getParent(), targetRoot)
                    || !stagingName.equals(".cc-gui-migration-" + journal.operationId + "-" + entry.id)
                    || !Objects.equals(backup.getParent(), userHome)
                    || !isGeneratedBackupName(backupName, entry.id, journal.operationId)
                    || overlapsCanonicalHome(targetRoot)
                    || !isValidEnum(entry.sourceKind, SourceKind.class)
                    || !isValidEnum(entry.phase, Phase.class)) {
                throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
            }
            SourceKind kind = entry.sourceKind();
            if (kind == SourceKind.MISSING && entry.sourcePhysical != null) {
                throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
            }
            if (kind != SourceKind.MISSING) {
                Path source = requireAbsolutePath(entry.sourcePhysical);
                if (source.getFileName() == null
                        || !source.getFileName().toString().equals("." + entry.id)) {
                    throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
                }
            }
        }
    }

    private boolean overlapsCanonicalHome(Path targetRoot) {
        for (String id : DATA_HOME_IDS) {
            Path canonical = canonicalPath(id);
            if (targetRoot.startsWith(canonical) || canonical.startsWith(targetRoot)) {
                return true;
            }
        }
        return false;
    }

    private static Path requireAbsolutePath(String value) throws IOException {
        if (!notBlank(value)) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
        }
        Path path;
        try {
            path = Path.of(value);
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID", error);
        }
        if (!path.isAbsolute() || !path.equals(path.normalize())) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
        }
        return path;
    }

    private static boolean isUuid(String value) {
        try {
            return value != null && UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static boolean isGeneratedBackupName(String name, String id, String operationId) {
        String prefix = "." + id + BACKUP_MARKER;
        String suffix = "-" + operationId;
        if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
            return false;
        }
        String timestamp = name.substring(prefix.length(), name.length() - suffix.length());
        return !timestamp.isEmpty() && timestamp.chars().allMatch(Character::isDigit);
    }

    private static <T extends Enum<T>> boolean isValidEnum(String value, Class<T> type) {
        try {
            Enum.valueOf(type, value);
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private void writeJournal(Journal journal) throws IOException {
        writeJson(journalPath(), GSON.toJsonTree(journal));
    }

    private static void writeJson(Path path, JsonElement value) throws IOException {
        Files.createDirectories(path.getParent());
        Path temporary = Files.createTempFile(path.getParent(), ".ai-data-", ".json");
        try {
            Files.writeString(temporary, GSON.toJson(value), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static void move(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(source, target);
        }
    }

    private static boolean isDirectoryEmpty(Path directory) throws IOException {
        try (java.util.stream.Stream<Path> children = Files.list(directory)) {
            return children.findAny().isEmpty();
        }
    }

    private Path journalPath() {
        return stateDirectory.resolve(JOURNAL_FILE);
    }

    private Path backupsPath() {
        return stateDirectory.resolve(BACKUPS_FILE);
    }

    private static JsonObject operationResult(String operation, boolean success, String error, JsonObject status) {
        JsonObject result = new JsonObject();
        result.addProperty("operation", operation);
        result.addProperty("success", success);
        if (error != null) {
            result.addProperty("error", error);
        }
        result.add("status", status);
        return result;
    }

    private static String requiredString(JsonObject object, String key) throws IOException {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()
                || !object.getAsJsonPrimitive(key).isString()) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
        }
        return object.get(key).getAsString();
    }

    private static int phaseOrder(String phase) {
        try {
            return Phase.valueOf(phase).ordinal();
        } catch (RuntimeException error) {
            return 0;
        }
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }

    private static boolean hasStorageMarker(Path directory, String id) {
        Path marker = directory.resolve(STORAGE_MARKER);
        try {
            return Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS)
                    && !Files.isSymbolicLink(marker)
                    && Files.size(marker) <= 32L
                    && id.equals(Files.readString(marker, StandardCharsets.UTF_8).trim());
        } catch (IOException error) {
            return false;
        }
    }

    interface DirectoryLinkCreator {
        void create(Path canonical, Path target) throws IOException;
    }

    interface PathDeleter {
        void delete(Path path) throws IOException;
    }

    static final class ManifestEntry {
        private final String type;
        private final long size;
        private final String fingerprint;

        ManifestEntry(String type, long size, String fingerprint) {
            this.type = type;
            this.size = size;
            this.fingerprint = fingerprint;
        }

        @Override
        public boolean equals(Object value) {
            if (this == value) {
                return true;
            }
            if (!(value instanceof ManifestEntry other)) {
                return false;
            }
            return size == other.size && Objects.equals(type, other.type)
                    && Objects.equals(fingerprint, other.fingerprint);
        }

        @Override
        public int hashCode() {
            return Objects.hash(type, size, fingerprint);
        }
    }

    private enum SourceKind {
        LOCAL,
        LINKED,
        MISSING
    }

    private enum Phase {
        INITIAL,
        TARGET_READY,
        SOURCE_DETACHED,
        LINKED
    }

    private static final class Journal {
        private String operationId;
        private List<MigrationEntry> entries;

        private Journal(String operationId, List<MigrationEntry> entries) {
            this.operationId = operationId;
            this.entries = entries;
        }
    }

    private static final class MigrationEntry {
        private String id;
        private String canonical;
        private String target;
        private String staging;
        private String backup;
        private String sourcePhysical;
        private String sourceKind;
        private String phase;
        private boolean targetExisted;

        private MigrationEntry(String id, Path canonical, Path target, Path staging, Path backup,
                               Path sourcePhysical, SourceKind sourceKind, boolean targetExisted) {
            this.id = id;
            this.canonical = canonical.toString();
            this.target = target.toString();
            this.staging = staging.toString();
            this.backup = backup.toString();
            this.sourcePhysical = sourcePhysical == null ? null : sourcePhysical.toString();
            this.sourceKind = sourceKind.name();
            this.phase = Phase.INITIAL.name();
            this.targetExisted = targetExisted;
        }

        private Path canonicalPath() {
            return Path.of(canonical);
        }

        private Path targetPath() {
            return Path.of(target);
        }

        private Path stagingPath() {
            return Path.of(staging);
        }

        private Path backupPath() {
            return Path.of(backup);
        }

        private Path sourcePhysicalPath() {
            return sourcePhysical == null ? null : Path.of(sourcePhysical);
        }

        private SourceKind sourceKind() {
            return SourceKind.valueOf(sourceKind);
        }
    }

    private static final class BackupRecord {
        private final JsonObject metadata;
        private final Path path;
        private final boolean existedAtValidation;

        private BackupRecord(JsonObject metadata, Path path, boolean existedAtValidation) {
            this.metadata = metadata;
            this.path = path;
            this.existedAtValidation = existedAtValidation;
        }
    }

    public static final class AiDataDirectoryException extends IOException {
        public AiDataDirectoryException(String message) {
            super(message);
        }

        public AiDataDirectoryException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
