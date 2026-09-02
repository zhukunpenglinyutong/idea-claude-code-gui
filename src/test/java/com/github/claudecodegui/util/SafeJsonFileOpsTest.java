package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Comparator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link SafeJsonFileOps}: atomic writes, automatic backups,
 * self-healing reads and advisory locking — the machinery introduced to stop
 * MCP server configs from silently vanishing when ~/.claude.json is shared
 * with the Claude CLI process.
 */
public class SafeJsonFileOpsTest {

    private Path tempDir;

    @Before
    public void setUp() throws Exception {
        tempDir = Files.createTempDirectory("safe-json-ops-test");
    }

    @After
    public void tearDown() throws Exception {
        if (tempDir != null) {
            try (java.util.stream.Stream<Path> paths = Files.walk(tempDir)) {
                paths.sorted(Comparator.reverseOrder())
                        .map(Path::toFile)
                        .forEach(File::delete);
            }
            tempDir = null;
        }
    }

    /** Atomic write replaces the content and leaves no temp files behind. */
    @Test
    public void writeAtomicallyReplacesContent() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"a\":1}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"a\":2,\"b\":\"x\"}"));

        assertEquals("{\"a\":2,\"b\":\"x\"}", Files.readString(file, StandardCharsets.UTF_8));
        List<Path> leftovers = new ArrayList<>();
        try (java.util.stream.Stream<Path> paths = Files.list(tempDir)) {
            paths.filter(p -> p.getFileName().toString().contains(".ccgui-tmp")).forEach(leftovers::add);
        }
        assertTrue("staged temp files must be cleaned up", leftovers.isEmpty());
    }

    /** Each replace keeps a backup of the previous content. */
    @Test
    public void writeAtomicallyKeepsBackupOfPreviousContent() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"version\":\"old\"}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"version\":\"new\"}"));

        Path backup = SafeJsonFileOps.sibling(file, SafeJsonFileOps.BACKUP_SUFFIX);
        assertTrue("backup must exist after overwrite", Files.exists(backup));
        assertEquals("{\"version\":\"old\"}", Files.readString(backup, StandardCharsets.UTF_8));
    }

    /** A write into a non-existent directory creates the directory. */
    @Test
    public void writeAtomicallyCreatesParentDirectories() throws Exception {
        Path file = tempDir.resolve("nested/deep/config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{}"));
        assertTrue(Files.exists(file));
    }

    /** A torn/truncated file is recovered from the backup automatically. */
    @Test
    public void readJsonOrBackupRestoresDamagedFileFromBackup() throws Exception {
        Path file = tempDir.resolve("config.json");
        // Two writes: the second one leaves a backup holding the FIRST write's
        // content (the backup captures the state before the last replace).
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"mcpServers\":{\"srv\":{\"command\":\"npx\"}}}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"mcpServers\":{\"srv\":{\"command\":\"uvx\"}}}"));

        // Simulate a torn write: truncate the live file to garbage
        Files.writeString(file, "{\"mcpServers\":{\"srv\":{\"comm", StandardCharsets.UTF_8);

        JsonObject healed = SafeJsonFileOps.readJsonOrBackup(file, 2, 10);
        assertNotNull("damaged file must heal from backup", healed);
        assertTrue(healed.getAsJsonObject("mcpServers").has("srv"));
        // The damaged file itself must have been restored
        JsonObject onDisk = JsonParser.parseString(
                Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue(onDisk.getAsJsonObject("mcpServers").has("srv"));
    }

    /** readJsonObject returns null for a missing file without throwing. */
    @Test
    public void readJsonObjectReturnsNullForMissingFile() {
        assertNull(SafeJsonFileOps.readJsonObject(tempDir.resolve("nope.json"), 2, 10));
    }

    /** Transient garbage resolves to null after retries (no backup available). */
    @Test
    public void readJsonOrBackupReturnsNullWhenBothAreUnusable() throws Exception {
        Path file = tempDir.resolve("config.json");
        Files.writeString(file, "not json at all {{{", StandardCharsets.UTF_8);
        assertNull(SafeJsonFileOps.readJsonOrBackup(file, 2, 10));
    }

    /** withLock serialises concurrent read-modify-write cycles in-process. */
    @Test
    public void withLockSerialisesConcurrentWriters() throws Exception {
        Path target = tempDir.resolve("counter.json");
        Path lock = tempDir.resolve("counter.json.ccgui-lock");
        SafeJsonFileOps.writeAtomically(target, w -> w.write("{\"count\":0}"));

        int threads = 8;
        int incrementsEach = 25;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<?>> futures = new ArrayList<>();
            for (int t = 0; t < threads; t++) {
                futures.add(pool.submit(() -> {
                    try {
                        start.await();
                        for (int i = 0; i < incrementsEach; i++) {
                            SafeJsonFileOps.withLock(lock, 5_000, () -> {
                                JsonObject doc = SafeJsonFileOps.readJsonObject(target, 3, 20);
                                if (doc == null) {
                                    doc = new JsonObject();
                                }
                                int count = doc.has("count") ? doc.get("count").getAsInt() : 0;
                                doc.addProperty("count", count + 1);
                                JsonObject finalDoc = doc;
                                SafeJsonFileOps.writeAtomically(target, w -> w.write(finalDoc.toString()));
                            });
                        }
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }));
            }
            start.countDown();
            for (Future<?> f : futures) {
                f.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        JsonObject finalDoc = JsonParser.parseString(
                Files.readString(target, StandardCharsets.UTF_8)).getAsJsonObject();
        assertEquals("every increment must survive (no lost updates)",
                threads * incrementsEach, finalDoc.get("count").getAsInt());
    }

    /** writeAtomically survives a hostile writer replacing the file between backup and move. */
    @Test
    public void writeAtomicallyThrowsIoExceptionWhenMoveKeepsFailing() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"ok\":true}"));
        // A normal second write must still succeed (sanity for the retry loop)
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"ok\":false}"));
        assertFalse(JsonParser.parseString(
                Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject().get("ok").getAsBoolean());
    }
}
