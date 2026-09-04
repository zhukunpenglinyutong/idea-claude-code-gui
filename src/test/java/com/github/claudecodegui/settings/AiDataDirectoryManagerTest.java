package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.DosFileAttributeView;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeNoException;
import static org.junit.Assume.assumeNotNull;

public class AiDataDirectoryManagerTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void migratesAllHomesThroughCanonicalLinksAndCleansBackups() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("home"));
        Path state = root.resolve("state");
        Path targetRoot = Files.createDirectory(root.resolve("target"));
        createSource(home, "claude", "settings.json", "claude-data");
        createSource(home, "codemoss", "config.json", "codemoss-data");
        createSource(home, "codex", "config.toml", "codex-data");
        AiDataDirectoryManager manager = manager(home, state, null);

        JsonObject result = manager.migrate(targetRoot.toString());

        assertTrue(result.get("success").getAsBoolean());
        for (String id : new String[]{"claude", "codemoss", "codex"}) {
            Path canonical = home.resolve("." + id);
            assertTrue(AiDataDirectoryManager.isDirectDirectoryLink(canonical));
            assertTrue(Files.isSameFile(canonical, targetRoot.resolve("." + id)));
        }
        assertEquals("codex-data", Files.readString(
                home.resolve(".codex/config.toml"), StandardCharsets.UTF_8));
        JsonObject snapshot = manager.snapshot();
        assertEquals(3, snapshot.getAsJsonArray("backups").size());
        assertEquals(3, linkedEntryCount(snapshot.getAsJsonArray("directories")));

        manager.cleanupBackups();

        assertEquals(0, manager.snapshot().getAsJsonArray("backups").size());
        assertEquals("claude-data", Files.readString(
                home.resolve(".claude/settings.json"), StandardCharsets.UTF_8));
    }

    @Test
    public void deletesWindowsReadOnlyFilesFromBackups() throws Exception {
        Path root = temporaryFolder.newFolder("readonly-backup").toPath();
        Path readOnlyFile = Files.writeString(root.resolve("git-pack.idx"), "pack", StandardCharsets.UTF_8);
        DosFileAttributeView attributes = Files.getFileAttributeView(
                readOnlyFile, DosFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        assumeNotNull(attributes);
        attributes.setReadOnly(true);
        assertTrue(attributes.readAttributes().isReadOnly());

        AiDataDirectoryManager.deleteTree(root);

        assertFalse(Files.exists(root, LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    public void retainsOnlyFailedBackupMetadataAndAllowsRetry() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("partial-cleanup-home"));
        Path state = root.resolve("partial-cleanup-state");
        Path targetRoot = Files.createDirectory(root.resolve("partial-cleanup-target"));
        createSource(home, "claude", "settings.json", "claude-data");
        createSource(home, "codemoss", "config.json", "codemoss-data");
        createSource(home, "codex", "config.toml", "codex-data");
        AtomicReference<Path> failingRoot = new AtomicReference<>();
        AiDataDirectoryManager manager = manager(
                home, state, null, new AiDataProcessGate(), path -> {
                    Path blocked = failingRoot.get();
                    if (blocked != null && path.startsWith(blocked)) {
                        throw new IOException("SIMULATED_DELETE_FAILURE");
                    }
                    AiDataDirectoryManager.deleteWritablePath(path);
                });
        manager.migrate(targetRoot.toString());
        JsonObject beforeCleanup = manager.snapshot();
        Path claudeBackup = backupPath(beforeCleanup, "claude");
        Path codemossBackup = backupPath(beforeCleanup, "codemoss");
        Path codexBackup = backupPath(beforeCleanup, "codex");
        failingRoot.set(codemossBackup);

        IOException error = assertThrows(IOException.class, manager::cleanupBackups);

        assertEquals("BACKUP_CLEANUP_PARTIAL", error.getMessage());
        JsonObject partialStatus = manager.snapshot();
        assertEquals(1, partialStatus.get("backupCount").getAsInt());
        assertEquals(codemossBackup, backupPath(partialStatus, "codemoss"));
        assertFalse(Files.exists(claudeBackup, LinkOption.NOFOLLOW_LINKS));
        assertTrue(Files.exists(codemossBackup, LinkOption.NOFOLLOW_LINKS));
        assertFalse(Files.exists(codexBackup, LinkOption.NOFOLLOW_LINKS));

        failingRoot.set(null);
        manager.cleanupBackups();

        assertEquals(0, manager.snapshot().get("backupCount").getAsInt());
        assertFalse(Files.exists(state.resolve("migration-backups.json"), LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    public void validatesAllBackupRecordsBeforeDeletingAnyBackup() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("prevalidate-home"));
        Path state = Files.createDirectory(root.resolve("prevalidate-state"));
        String operationId = UUID.randomUUID().toString();
        Path validBackup = Files.createDirectory(home.resolve(
                ".claude.cc-gui-backup-1-" + operationId));
        Path sentinel = Files.writeString(validBackup.resolve("keep.txt"), "keep", StandardCharsets.UTF_8);
        JsonArray metadata = new JsonArray();
        metadata.add(backupRecord("claude", validBackup, operationId));
        metadata.add(backupRecord("invalid", home.resolve("invalid-backup"), operationId));
        Files.writeString(state.resolve("migration-backups.json"), metadata.toString(), StandardCharsets.UTF_8);

        IOException error = assertThrows(IOException.class,
                () -> manager(home, state, null).cleanupBackups());

        assertEquals("BACKUP_METADATA_INVALID", error.getMessage());
        assertEquals("keep", Files.readString(sentinel, StandardCharsets.UTF_8));
    }

    @Test
    public void removesMetadataForAlreadyMissingBackups() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("missing-backup-home"));
        Path state = Files.createDirectory(root.resolve("missing-backup-state"));
        String operationId = UUID.randomUUID().toString();
        Path missingBackup = home.resolve(".codex.cc-gui-backup-1-" + operationId);
        JsonArray metadata = new JsonArray();
        metadata.add(backupRecord("codex", missingBackup, operationId));
        Files.writeString(state.resolve("migration-backups.json"), metadata.toString(), StandardCharsets.UTF_8);
        AtomicReference<Path> deletionAttempt = new AtomicReference<>();
        AiDataDirectoryManager manager = manager(
                home, state, null, new AiDataProcessGate(), path -> {
                    deletionAttempt.set(path);
                    throw new IOException("MISSING_BACKUP_MUST_NOT_BE_DELETED");
                });

        JsonObject result = manager.cleanupBackups();

        assertTrue(result.get("success").getAsBoolean());
        assertEquals(0, result.getAsJsonObject("status").get("backupCount").getAsInt());
        assertNull(deletionAttempt.get());
        assertFalse(Files.exists(state.resolve("migration-backups.json"), LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    public void restoresOriginalDirectoriesWhenLinkCreationFails() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("rollback-home"));
        Path state = root.resolve("rollback-state");
        Path targetRoot = Files.createDirectory(root.resolve("rollback-target"));
        createSource(home, "claude", "settings.json", "keep-claude");
        createSource(home, "codemoss", "config.json", "keep-codemoss");
        createSource(home, "codex", "config.toml", "keep-codex");
        AiDataDirectoryManager manager = manager(home, state,
                (canonical, target) -> {
                    throw new IOException("LINK_CREATION_FAILED");
                });

        IOException error = assertThrows(IOException.class, () -> manager.migrate(targetRoot.toString()));

        assertEquals("LINK_CREATION_FAILED", error.getMessage());
        assertEquals("keep-claude", Files.readString(
                home.resolve(".claude/settings.json"), StandardCharsets.UTF_8));
        assertFalse(AiDataDirectoryManager.isDirectDirectoryLink(home.resolve(".claude")));
        assertFalse(Files.exists(targetRoot.resolve(".claude"), LinkOption.NOFOLLOW_LINKS));
        assertFalse(Files.exists(state.resolve("migration-journal.json"), LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    public void rejectsMigrationWhileAiProcessIsActive() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("active-home"));
        Path state = root.resolve("active-state");
        Path targetRoot = Files.createDirectory(root.resolve("active-target"));
        createSource(home, "codex", "config.toml", "keep");
        AiDataProcessGate gate = new AiDataProcessGate();
        AiDataDirectoryManager manager = manager(home, state, null, gate);

        try (AiDataProcessGate.ProcessPermit ignored = gate.acquireProcessPermit()) {
            IOException error = assertThrows(IOException.class, () -> manager.migrate(targetRoot.toString()));

            assertEquals("AI_PROCESSES_ACTIVE", error.getMessage());
            assertEquals("keep", Files.readString(home.resolve(".codex/config.toml"), StandardCharsets.UTF_8));
            assertFalse(Files.exists(state.resolve("migration-journal.json"), LinkOption.NOFOLLOW_LINKS));
        }
    }

    @Test
    public void rollsBackBeforeAllowingAiProcessToStart() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("cancel-home"));
        Path state = root.resolve("cancel-state");
        Path targetRoot = Files.createDirectory(root.resolve("cancel-target"));
        createSource(home, "claude", "settings.json", "claude-data");
        createSource(home, "codemoss", "config.json", "codemoss-data");
        createSource(home, "codex", "config.toml", "codex-data");
        AiDataProcessGate gate = new AiDataProcessGate();
        CountDownLatch linkStarted = new CountDownLatch(1);
        CountDownLatch continueLink = new CountDownLatch(1);
        AiDataDirectoryManager manager = manager(home, state, (canonical, target) -> {
            linkStarted.countDown();
            try {
                if (!continueLink.await(2, TimeUnit.SECONDS)) {
                    throw new IOException("TEST_LINK_TIMEOUT");
                }
                createDirectoryLink(canonical, target);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IOException(error);
            } catch (IOException error) {
                throw error;
            } catch (Exception error) {
                throw new IOException(error);
            }
        }, gate);
        ExecutorService migrationExecutor = Executors.newSingleThreadExecutor();
        AtomicReference<String> observedAfterGate = new AtomicReference<>();
        AtomicReference<Throwable> processFailure = new AtomicReference<>();

        try {
            Future<JsonObject> migration = migrationExecutor.submit(() -> manager.migrate(targetRoot.toString()));
            assertTrue(linkStarted.await(2, TimeUnit.SECONDS));
            Thread processStarter = new Thread(() -> {
                try (AiDataProcessGate.ProcessPermit ignored = gate.acquireProcessPermit()) {
                    observedAfterGate.set(Files.readString(
                            home.resolve(".codex/config.toml"), StandardCharsets.UTF_8));
                } catch (Throwable error) {
                    processFailure.set(error);
                }
            });
            processStarter.start();
            waitUntilBlocked(processStarter);
            assertNull(observedAfterGate.get());

            continueLink.countDown();
            ExecutionException error = assertThrows(ExecutionException.class,
                    () -> migration.get(5, TimeUnit.SECONDS));
            processStarter.join(TimeUnit.SECONDS.toMillis(2));

            assertEquals("MIGRATION_CANCELLED_FOR_AI_START", error.getCause().getMessage());
            assertNull(processFailure.get());
            assertEquals("codex-data", observedAfterGate.get());
            assertFalse(Files.exists(state.resolve("migration-journal.json"), LinkOption.NOFOLLOW_LINKS));
            assertFalse(Files.exists(targetRoot.resolve(".codex"), LinkOption.NOFOLLOW_LINKS));
        } finally {
            continueLink.countDown();
            migrationExecutor.shutdownNow();
        }
    }

    @Test
    public void rejectsNonEmptyTargetsBeforeChangingSources() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("conflict-home"));
        Path state = root.resolve("conflict-state");
        Path targetRoot = Files.createDirectory(root.resolve("conflict-target"));
        createSource(home, "codex", "config.toml", "source");
        Path occupied = Files.createDirectory(targetRoot.resolve(".codex"));
        Files.writeString(occupied.resolve("existing.txt"), "existing", StandardCharsets.UTF_8);

        IOException error = assertThrows(IOException.class,
                () -> manager(home, state, null).migrate(targetRoot.toString()));

        assertEquals("TARGET_NOT_EMPTY", error.getMessage());
        assertEquals("source", Files.readString(home.resolve(".codex/config.toml"), StandardCharsets.UTF_8));
    }

    @Test
    public void rejectsRelativeTargetRoots() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("relative-home"));

        IOException error = assertThrows(IOException.class,
                () -> manager(home, root.resolve("relative-state"), null).migrate("relative-target"));

        assertEquals("TARGET_PATH_INVALID", error.getMessage());
    }

    @Test
    public void recoversAProcessInterruptionFromThePersistedJournal() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("recovery-home"));
        Path state = root.resolve("recovery-state");
        Path targetRoot = Files.createDirectory(root.resolve("recovery-target"));
        createSource(home, "claude", "settings.json", "keep-claude");
        createSource(home, "codemoss", "config.json", "keep-codemoss");
        createSource(home, "codex", "config.toml", "keep-codex");
        AiDataDirectoryManager interrupted = manager(home, state,
                (canonical, target) -> {
                    throw new AssertionError("simulated process stop");
                });

        assertThrows(AssertionError.class, () -> interrupted.migrate(targetRoot.toString()));
        assertTrue(Files.isRegularFile(state.resolve("migration-journal.json")));

        JsonObject recovered = manager(home, state, null).snapshot();

        assertTrue(recovered.get("recovered").getAsBoolean());
        assertEquals("keep-codex", Files.readString(
                home.resolve(".codex/config.toml"), StandardCharsets.UTF_8));
        assertFalse(Files.exists(state.resolve("migration-journal.json"), LinkOption.NOFOLLOW_LINKS));
        assertFalse(Files.exists(targetRoot.resolve(".codex"), LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    public void refusesToDeleteAnUnmarkedTargetFromRecoveryMetadata() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("guard-home"));
        Path state = Files.createDirectory(root.resolve("guard-state"));
        Path targetRoot = Files.createDirectory(root.resolve("guard-target"));
        Path target = Files.createDirectory(targetRoot.resolve(".codex"));
        Path sentinel = target.resolve("keep.txt");
        Files.writeString(sentinel, "keep", StandardCharsets.UTF_8);
        String operationId = UUID.randomUUID().toString();
        String journal = "{\"operationId\":\"" + operationId + "\",\"entries\":[{"
                + "\"id\":\"codex\","
                + "\"canonical\":\"" + jsonPath(home.resolve(".codex")) + "\","
                + "\"target\":\"" + jsonPath(target) + "\","
                + "\"staging\":\"" + jsonPath(targetRoot.resolve(
                        ".cc-gui-migration-" + operationId + "-codex")) + "\","
                + "\"backup\":\"" + jsonPath(home.resolve(
                        ".codex.cc-gui-backup-1-" + operationId)) + "\","
                + "\"sourceKind\":\"MISSING\",\"phase\":\"TARGET_READY\","
                + "\"targetExisted\":false}]}";
        Files.writeString(state.resolve("migration-journal.json"), journal, StandardCharsets.UTF_8);

        IOException error = assertThrows(IOException.class, () -> manager(home, state, null).snapshot());

        assertEquals("RECOVERY_TARGET_CONFLICT", error.getMessage());
        assertEquals("keep", Files.readString(sentinel, StandardCharsets.UTF_8));
    }

    @Test
    public void preservesStorageMarkerWhenDeletingOwnedTargetFails() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path target = Files.createDirectory(root.resolve("partial-delete-target"));
        Path marker = target.resolve(".cc-gui-storage");
        Path locked = target.resolve("locked.dat");
        Files.writeString(marker, "codex", StandardCharsets.UTF_8);
        Files.writeString(locked, "locked", StandardCharsets.UTF_8);
        List<Path> deletionAttempts = new ArrayList<>();

        IOException error = assertThrows(IOException.class,
                () -> AiDataDirectoryManager.deleteTree(target, path -> {
                    deletionAttempts.add(path);
                    if (path.equals(locked)) {
                        throw new IOException("FILE_LOCKED");
                    }
                    Files.delete(path);
                }));

        assertEquals("FILE_LOCKED", error.getMessage());
        assertFalse(deletionAttempts.contains(marker));
        assertTrue(Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS));
        AiDataDirectoryManager.deleteTree(target, Files::delete);
    }

    @Test
    public void restoresStorageMarkerWhenFinalDirectoryDeleteFails() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path target = Files.createDirectory(root.resolve("final-delete-target"));
        Path marker = target.resolve(".cc-gui-storage");
        Files.writeString(marker, "codex", StandardCharsets.UTF_8);

        IOException error = assertThrows(IOException.class,
                () -> AiDataDirectoryManager.deleteTree(target, path -> {
                    if (path.equals(target)) {
                        throw new IOException("DIRECTORY_LOCKED");
                    }
                    Files.delete(path);
                }));

        assertEquals("DIRECTORY_LOCKED", error.getMessage());
        assertEquals("codex", Files.readString(marker, StandardCharsets.UTF_8));
        AiDataDirectoryManager.deleteTree(target, Files::delete);
    }

    @Test
    public void refusesToDeleteARecreatedCanonicalLinkThatTargetsElsewhere() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("recreated-link-home"));
        Path state = Files.createDirectory(root.resolve("recreated-link-state"));
        Path targetRoot = Files.createDirectory(root.resolve("recreated-link-target"));
        Path unrelated = Files.createDirectory(root.resolve("unrelated-target"));
        Path canonical = Files.createDirectory(home.resolve(".codex"));
        Files.writeString(canonical.resolve("config.toml"), "keep", StandardCharsets.UTF_8);
        String operationId = UUID.randomUUID().toString();
        Path backup = home.resolve(".codex.cc-gui-backup-1-" + operationId);
        Files.move(canonical, backup);
        Path target = Files.createDirectory(targetRoot.resolve(".codex"));
        Files.writeString(target.resolve(".cc-gui-storage"), "codex", StandardCharsets.UTF_8);
        createDirectoryLink(home.resolve(".codex"), unrelated);

        String journal = "{\"operationId\":\"" + operationId + "\",\"entries\":[{"
                + "\"id\":\"codex\","
                + "\"canonical\":\"" + jsonPath(home.resolve(".codex")) + "\","
                + "\"target\":\"" + jsonPath(target) + "\","
                + "\"staging\":\"" + jsonPath(targetRoot.resolve(
                        ".cc-gui-migration-" + operationId + "-codex")) + "\","
                + "\"backup\":\"" + jsonPath(backup) + "\","
                + "\"sourcePhysical\":\"" + jsonPath(home.resolve(".codex")) + "\","
                + "\"sourceKind\":\"LOCAL\",\"phase\":\"SOURCE_DETACHED\","
                + "\"targetExisted\":false}]}";
        Files.writeString(state.resolve("migration-journal.json"), journal, StandardCharsets.UTF_8);

        IOException error = assertThrows(IOException.class,
                () -> manager(home, state, null).snapshot());

        assertEquals("RECOVERY_PATH_CONFLICT", error.getMessage());
        assertTrue(Files.isSameFile(home.resolve(".codex"), unrelated));
        assertTrue(Files.exists(target.resolve(".cc-gui-storage")));
        assertTrue(Files.exists(backup.resolve("config.toml")));
    }

    @Test
    public void rejectsRecoveryPathsThatDoNotBelongToTheJournalOperation() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("journal-guard-home"));
        Path state = Files.createDirectory(root.resolve("journal-guard-state"));
        Path targetRoot = Files.createDirectory(root.resolve("journal-guard-target"));
        String operationId = UUID.randomUUID().toString();
        Path unrelatedStaging = Files.createDirectory(targetRoot.resolve(
                ".cc-gui-migration-" + UUID.randomUUID() + "-codex"));
        Path sentinel = unrelatedStaging.resolve("keep.txt");
        Files.writeString(sentinel, "keep", StandardCharsets.UTF_8);
        String journal = "{\"operationId\":\"" + operationId + "\",\"entries\":[{"
                + "\"id\":\"codex\","
                + "\"canonical\":\"" + jsonPath(home.resolve(".codex")) + "\","
                + "\"target\":\"" + jsonPath(targetRoot.resolve(".codex")) + "\","
                + "\"staging\":\"" + jsonPath(unrelatedStaging) + "\","
                + "\"backup\":\"" + jsonPath(home.resolve(
                        ".codex.cc-gui-backup-1-" + operationId)) + "\","
                + "\"sourceKind\":\"MISSING\",\"phase\":\"INITIAL\","
                + "\"targetExisted\":false}]}";
        Files.writeString(state.resolve("migration-journal.json"), journal, StandardCharsets.UTF_8);

        IOException error = assertThrows(IOException.class, () -> manager(home, state, null).snapshot());

        assertEquals("MIGRATION_JOURNAL_INVALID", error.getMessage());
        assertEquals("keep", Files.readString(sentinel, StandardCharsets.UTF_8));
    }

    @Test
    public void preservesNestedDirectoryLinksWithoutCopyingTheirTargets() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("linked-content-home"));
        Path state = root.resolve("linked-content-state");
        Path targetRoot = Files.createDirectory(root.resolve("linked-content-target"));
        Path externalSkills = Files.createDirectory(root.resolve("external-skills"));
        Files.writeString(externalSkills.resolve("SKILL.md"), "shared", StandardCharsets.UTF_8);
        Path codex = Files.createDirectory(home.resolve(".codex"));
        Path skillsLink = codex.resolve("skills");
        createDirectoryLink(skillsLink, externalSkills);

        AiDataDirectoryManager manager = manager(home, state, null);
        manager.migrate(targetRoot.toString());

        Path migratedSkills = home.resolve(".codex/skills");
        assertTrue(AiDataDirectoryManager.isDirectDirectoryLink(migratedSkills));
        assertTrue(Files.isSameFile(migratedSkills, externalSkills));
        assertEquals("shared", Files.readString(migratedSkills.resolve("SKILL.md"), StandardCharsets.UTF_8));

        manager.cleanupBackups();

        assertEquals("shared", Files.readString(externalSkills.resolve("SKILL.md"), StandardCharsets.UTF_8));
    }

    @Test
    public void rebasesInternalDirectoryLinksAfterMovingTheStagingTree() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("internal-link-home"));
        Path targetRoot = Files.createDirectory(root.resolve("internal-link-target"));
        Path codex = Files.createDirectory(home.resolve(".codex"));
        Path realDirectory = Files.createDirectory(codex.resolve("real"));
        Files.writeString(realDirectory.resolve("data.txt"), "internal", StandardCharsets.UTF_8);
        createDirectoryLink(codex.resolve("alias"), realDirectory);
        AiDataDirectoryManager manager = manager(home, root.resolve("internal-link-state"), null);

        manager.migrate(targetRoot.toString());

        assertTrue(Files.isSameFile(home.resolve(".codex/alias"), targetRoot.resolve(".codex/real")));
        assertEquals("internal", Files.readString(
                home.resolve(".codex/alias/data.txt"), StandardCharsets.UTF_8));
    }

    @Test
    public void supportsMovingAnAlreadyRelocatedHomeToAnotherStorageRoot() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("repeat-home"));
        Path state = root.resolve("repeat-state");
        Path firstTargetRoot = Files.createDirectory(root.resolve("repeat-first-target"));
        Path secondTargetRoot = Files.createDirectory(root.resolve("repeat-second-target"));
        createSource(home, "codex", "auth.json", "credentials");
        AiDataDirectoryManager manager = manager(home, state, null);

        manager.migrate(firstTargetRoot.toString());
        Files.writeString(home.resolve(".codex/session.json"), "session", StandardCharsets.UTF_8);

        manager.migrate(secondTargetRoot.toString());

        assertTrue(Files.isSameFile(home.resolve(".codex"), secondTargetRoot.resolve(".codex")));
        assertEquals("credentials", Files.readString(
                secondTargetRoot.resolve(".codex/auth.json"), StandardCharsets.UTF_8));
        assertEquals("session", Files.readString(
                secondTargetRoot.resolve(".codex/session.json"), StandardCharsets.UTF_8));
        assertEquals(4, manager.snapshot().get("backupCount").getAsInt());

        manager.cleanupBackups();

        assertFalse(Files.exists(firstTargetRoot.resolve(".codex"), LinkOption.NOFOLLOW_LINKS));
        assertEquals("session", Files.readString(
                home.resolve(".codex/session.json"), StandardCharsets.UTF_8));
    }

    @Test
    public void createsWindowsJunctionsForPathsContainingCommandCharacters() throws Exception {
        if (PlatformUtils.getPlatformType() != PlatformUtils.PlatformType.WINDOWS) {
            return;
        }
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("junction & home"));
        Path state = root.resolve("junction-state");
        Path targetRoot = Files.createDirectory(root.resolve("junction & target"));
        createSource(home, "codex", "config.toml", "safe");
        AiDataDirectoryManager manager = new AiDataDirectoryManager(
                home, state, PlatformUtils.PlatformType.WINDOWS, false, null);

        manager.migrate(targetRoot.toString());

        assertTrue(Files.isSameFile(home.resolve(".codex"), targetRoot.resolve(".codex")));
        assertEquals("safe", Files.readString(home.resolve(".codex/config.toml"), StandardCharsets.UTF_8));
    }

    @Test
    public void rejectsExistingStorageMarkerWithoutOverwritingIt() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("marker-home"));
        Path source = Files.createDirectory(home.resolve(".codex"));
        Path marker = source.resolve(".cc-gui-storage");
        Files.writeString(marker, "user-data", StandardCharsets.UTF_8);
        Path targetRoot = Files.createDirectory(root.resolve("marker-target"));

        IOException error = assertThrows(IOException.class,
                () -> manager(home, root.resolve("marker-state"), null).migrate(targetRoot.toString()));

        assertEquals("STORAGE_MARKER_CONFLICT", error.getMessage());
        assertEquals("user-data", Files.readString(marker, StandardCharsets.UTF_8));
        assertFalse(Files.exists(targetRoot.resolve(".codex"), LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    public void rejectsLinkedStorageMarkerWithoutTouchingItsTarget() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("linked-marker-home"));
        Path externalRoot = Files.createDirectory(root.resolve("linked-marker-source"));
        Path source = Files.createDirectory(externalRoot.resolve(".codex"));
        Path sentinel = root.resolve("sentinel.txt");
        Files.writeString(sentinel, "keep", StandardCharsets.UTF_8);
        try {
            Files.createSymbolicLink(source.resolve(".cc-gui-storage"), sentinel);
        } catch (IOException | UnsupportedOperationException error) {
            assumeNoException(error);
        }
        createDirectoryLink(home.resolve(".codex"), source);
        Path targetRoot = Files.createDirectory(root.resolve("linked-marker-target"));

        IOException error = assertThrows(IOException.class,
                () -> manager(home, root.resolve("linked-marker-state"), null).migrate(targetRoot.toString()));

        assertEquals("STORAGE_MARKER_CONFLICT", error.getMessage());
        assertEquals("keep", Files.readString(sentinel, StandardCharsets.UTF_8));
    }

    @Test
    public void preservesExternalRelativeSymbolicLinkAfterBackupCleanup() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("relative-link-home"));
        Path source = Files.createDirectory(home.resolve(".codex"));
        Path external = root.resolve("shared.txt");
        Files.writeString(external, "shared", StandardCharsets.UTF_8);
        Path link = source.resolve("shared.txt");
        try {
            Files.createSymbolicLink(link, link.getParent().relativize(external));
        } catch (IOException | UnsupportedOperationException error) {
            assumeNoException(error);
        }
        Path targetRoot = Files.createDirectory(root.resolve("relative-link-target"));
        AiDataDirectoryManager manager = manager(home, root.resolve("relative-link-state"), null);

        manager.migrate(targetRoot.toString());
        manager.cleanupBackups();

        Path migratedLink = home.resolve(".codex/shared.txt");
        assertTrue(Files.isSymbolicLink(migratedLink));
        assertEquals("shared", Files.readString(migratedLink, StandardCharsets.UTF_8));
        assertTrue(Files.isSameFile(migratedLink, external));
    }

    @Test
    public void rollsBackWhenSourceChangesAfterInitialVerification() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("late-write-home"));
        Path state = root.resolve("late-write-state");
        Path targetRoot = Files.createDirectory(root.resolve("late-write-target"));
        createSource(home, "codex", "config.toml", "original");
        AiDataDirectoryManager manager = manager(home, state, (canonical, target) -> {
            try {
                createDirectoryLink(canonical, target);
            } catch (Exception error) {
                throw new IOException(error);
            }
            if (".codex".equals(canonical.getFileName().toString())) {
                try (java.util.stream.Stream<Path> children = Files.list(home)) {
                    Path backup = children.filter(path -> path.getFileName().toString()
                                    .startsWith(".codex.cc-gui-backup-"))
                            .findFirst()
                            .orElseThrow();
                    Files.writeString(backup.resolve("late.txt"), "late", StandardCharsets.UTF_8);
                }
            }
        });

        IOException error = assertThrows(IOException.class, () -> manager.migrate(targetRoot.toString()));

        assertEquals("SOURCE_CHANGED_DURING_MIGRATION", error.getMessage());
        assertEquals("original", Files.readString(home.resolve(".codex/config.toml"), StandardCharsets.UTF_8));
        assertEquals("late", Files.readString(home.resolve(".codex/late.txt"), StandardCharsets.UTF_8));
        assertFalse(AiDataDirectoryManager.isDirectDirectoryLink(home.resolve(".codex")));
        assertFalse(Files.exists(targetRoot.resolve(".codex"), LinkOption.NOFOLLOW_LINKS));
    }

    private static AiDataDirectoryManager manager(
            Path home, Path state, AiDataDirectoryManager.DirectoryLinkCreator creator) {
        return manager(home, state, creator, new AiDataProcessGate());
    }

    private static AiDataDirectoryManager manager(
            Path home, Path state, AiDataDirectoryManager.DirectoryLinkCreator creator,
            AiDataProcessGate processGate) {
        return manager(home, state, creator, processGate, AiDataDirectoryManager::deleteWritablePath);
    }

    private static AiDataDirectoryManager manager(
            Path home, Path state, AiDataDirectoryManager.DirectoryLinkCreator creator,
            AiDataProcessGate processGate, AiDataDirectoryManager.PathDeleter backupPathDeleter) {
        return new AiDataDirectoryManager(
                home, state, PlatformUtils.getPlatformType(), false, creator, processGate, backupPathDeleter);
    }

    private static void createSource(Path home, String id, String fileName, String content) throws IOException {
        Path directory = Files.createDirectory(home.resolve("." + id));
        Files.writeString(directory.resolve(fileName), content, StandardCharsets.UTF_8);
    }

    private static void createDirectoryLink(Path link, Path target) throws Exception {
        if (PlatformUtils.getPlatformType() == PlatformUtils.PlatformType.WINDOWS) {
            Process process = new ProcessBuilder("cmd.exe", "/d", "/c", "mklink", "/J",
                    link.toString(), target.toString()).redirectErrorStream(true).start();
            process.getInputStream().readAllBytes();
            assertEquals(0, process.waitFor());
        } else {
            Files.createSymbolicLink(link, target);
        }
    }

    private static int linkedEntryCount(JsonArray entries) {
        int count = 0;
        for (int index = 0; index < entries.size(); index++) {
            if ("linked".equals(entries.get(index).getAsJsonObject().get("state").getAsString())) {
                count++;
            }
        }
        return count;
    }

    private static Path backupPath(JsonObject status, String id) {
        JsonArray backups = status.getAsJsonArray("backups");
        for (JsonElement element : backups) {
            JsonObject backup = element.getAsJsonObject();
            if (id.equals(backup.get("id").getAsString())) {
                return Path.of(backup.get("path").getAsString());
            }
        }
        throw new AssertionError("Missing backup metadata for " + id);
    }

    private static JsonObject backupRecord(String id, Path path, String operationId) {
        JsonObject record = new JsonObject();
        record.addProperty("id", id);
        record.addProperty("path", path.toString());
        record.addProperty("operationId", operationId);
        return record;
    }

    private static void waitUntilBlocked(Thread thread) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (thread.getState() != Thread.State.WAITING && System.nanoTime() < deadline) {
            Thread.sleep(5L);
        }
        assertEquals(Thread.State.WAITING, thread.getState());
    }

    private static String jsonPath(Path path) {
        return path.toAbsolutePath().normalize().toString().replace("\\", "\\\\");
    }
}
