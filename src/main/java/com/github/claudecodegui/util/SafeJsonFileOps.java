package com.github.claudecodegui.util;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.io.Writer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Crash-safe, race-tolerant access to JSON config files that are shared with
 * other processes (e.g. {@code ~/.claude.json}, which the Claude CLI rewrites
 * on its own while the plugin also updates it).
 *
 * <p>Historically these files were written with a plain {@code FileWriter}
 * that truncates the target first. A crash, kill, or antivirus scan pause in
 * the middle of that window left a truncated file behind; every later reader
 * (CLI or plugin) then saw an empty/corrupt config — which is how configured
 * MCP servers "mysteriously vanished" (#<issue>). This utility prevents both
 * classes of damage:
 *
 * <ul>
 *   <li><b>Atomic writes</b>: content is staged in a temp file next to the
 *       target and moved into place with {@code ATOMIC_MOVE}. A crash can no
 *       longer leave a half-written config; readers see either the old or the
 *       new document, never a torn one.</li>
 *   <li><b>Automatic backup</b>: before each replace, the previous file is
 *       copied to {@code <name>.ccgui-backup} so a bad overwrite can be
 *       recovered.</li>
 *   <li><b>Retry reads</b>: parse failures (typically another process
 *       mid-write) are retried with backoff instead of being treated as
 *       permanent corruption.</li>
 *   <li><b>Self-healing reads</b>: {@link #readJsonOrBackup} falls back to the
 *       backup copy and restores it over the damaged target.</li>
 *   <li><b>Advisory locking</b>: {@link #withLock} serialises read-modify-write
 *       cycles across plugin windows (in-JVM via a reentrant lock, cross-process
 *       via an OS file lock on a dedicated {@code .lock} sidecar file).</li>
 * </ul>
 */
public final class SafeJsonFileOps {

    private static final Logger LOG = Logger.getInstance(SafeJsonFileOps.class);

    /** Suffix for the automatic pre-overwrite backup of a config file. */
    public static final String BACKUP_SUFFIX = ".ccgui-backup";

    /** How many times the replace-move is retried (Windows sharing violations while another process reads the target). */
    private static final int MOVE_ATTEMPTS = 5;
    private static final long MOVE_RETRY_DELAY_MS = 100;
    private static final long LOCK_RETRY_DELAY_MS = 50;
    /** Plain Gson used only to re-serialise a backup during self-healing restore. */
    private static final Gson RESTORE_GSON = new Gson();

    /** In-JVM (same IDE, multiple tool windows / threads) locks keyed by lock-file path. */
    private static final ConcurrentMap<String, ReentrantLock> IN_JVM_LOCKS = new ConcurrentHashMap<>();

    private SafeJsonFileOps() {
    }

    /** Callback that serialises JSON into the staged temp file's writer. */
    @FunctionalInterface
    public interface ThrowingWriter {
        void writeTo(Writer writer) throws IOException;
    }

    /** Callback executed while the advisory lock is held. */
    @FunctionalInterface
    public interface IORunnable {
        void run() throws IOException;
    }

    /**
     * Atomically replace {@code target} with the JSON produced by {@code writerFn}.
     *
     * <p>Stages the content in a temp file beside the target, backs up the
     * current file to {@code <name>}{@value BACKUP_SUFFIX}}, then moves the
     * temp file onto the target with {@code ATOMIC_MOVE} (falling back to a
     * plain replace on filesystems without atomic moves, retrying either way
     * a few times to ride out transient Windows sharing violations).
     *
     * @param target   the config file to replace
     * @param writerFn callback that writes the new content (e.g. {@code w -> gson.toJson(obj, w)})
     * @throws IOException if the content cannot be staged or the replace keeps failing
     */
    public static void writeAtomically(Path target, ThrowingWriter writerFn) throws IOException {
        Path parent = target.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Path tmp = Files.createTempFile(
                parent != null ? parent : target.toAbsolutePath().getParent(),
                target.getFileName().toString(),
                ".ccgui-tmp");
        try {
            try (Writer writer = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                writerFn.writeTo(writer);
                writer.flush();
            }
            backupExisting(target);
            moveWithRetry(tmp, target);
        } catch (IOException e) {
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException cleanupError) {
                LOG.debug("[SafeJsonFileOps] Could not delete staged temp file " + tmp + ": " + cleanupError.getMessage());
            }
            throw e;
        }
    }

    /**
     * Read and parse a JSON object, retrying on transient parse failures
     * (another process mid-write is the usual cause — with atomic writers on
     * the other side those windows are short).
     *
     * @param file         the JSON file to read
     * @param attempts     number of read attempts before giving up
     * @param retryDelayMs delay between attempts
     * @return the parsed object, or {@code null} if the file is missing or still unparsable
     */
    public static JsonObject readJsonObject(Path file, int attempts, long retryDelayMs) {
        Exception lastError = null;
        for (int attempt = 0; attempt < attempts; attempt++) {
            if (!Files.isRegularFile(file)) {
                return null;
            }
            try (java.io.Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
                return JsonParser.parseReader(reader).getAsJsonObject();
            } catch (IOException | RuntimeException e) {
                lastError = e;
                if (attempt + 1 < attempts) {
                    sleepQuietly(retryDelayMs);
                }
            }
        }
        LOG.warn("[SafeJsonFileOps] Could not read/parse " + file
                + " after " + attempts + " attempt(s): "
                + (lastError != null ? lastError.getMessage() : "unknown"));
        return null;
    }

    /**
     * Read a JSON object with retries; if the target stays unreadable but the
     * {@code <name>}{@value BACKUP_SUFFIX}} copy parses, restore that backup
     * over the target (self-healing) and return it.
     *
     * @param file         the JSON file to read
     * @param attempts     read attempts for the primary file
     * @param retryDelayMs delay between attempts
     * @return the parsed object (from the file, or from the restored backup), or {@code null} when both are unusable
     */
    public static JsonObject readJsonOrBackup(Path file, int attempts, long retryDelayMs) {
        JsonObject parsed = readJsonObject(file, attempts, retryDelayMs);
        if (parsed != null) {
            return parsed;
        }
        Path backup = sibling(file, BACKUP_SUFFIX);
        JsonObject fromBackup = readJsonObject(backup, 2, retryDelayMs);
        if (fromBackup == null) {
            return null;
        }
        LOG.warn("[SafeJsonFileOps] " + file.getFileName() + " is unreadable — restoring last known good copy from "
                + backup.getFileName());
        try {
            writeAtomically(file, writer -> RESTORE_GSON.toJson(fromBackup, writer));
        } catch (IOException e) {
            // Restore failed (e.g. read-only file) — still return the parsed
            // backup content so the caller keeps working with the recovered data.
            LOG.warn("[SafeJsonFileOps] Could not write restored copy back to " + file + ": " + e.getMessage());
        }
        return fromBackup;
    }

    /**
     * Run {@code action} while holding an advisory lock on {@code lockFile}.
     *
     * <p>Serialises read-modify-write cycles across (a) threads inside this
     * JVM (reentrant lock, handles multiple tool windows in one IDE) and
     * (b) separate plugin processes (OS file lock, handles multiple IDE
     * windows). Lock acquisition waits up to {@code timeoutMs}; on timeout the
     * action still runs without the lock (writes remain atomic, only the RMW
     * window widens) so a stuck peer never blocks the UI forever.
     *
     * @param lockFile  the sidecar lock file (created if missing, never deleted)
     * @param timeoutMs how long to wait for the lock
     * @param action    the critical section
     * @throws IOException if the lock file cannot be opened or the action throws
     */
    public static void withLock(Path lockFile, long timeoutMs, IORunnable action) throws IOException {
        Path parent = lockFile.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        ReentrantLock jvmLock = IN_JVM_LOCKS.computeIfAbsent(
                lockFile.toAbsolutePath().toString(), key -> new ReentrantLock());
        boolean jvmLocked = false;
        try {
            jvmLocked = jvmLock.tryLock(timeoutMs, TimeUnit.MILLISECONDS);
            if (!jvmLocked) {
                LOG.warn("[SafeJsonFileOps] Timed out waiting for in-JVM lock on " + lockFile
                        + " — proceeding without it");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            LOG.warn("[SafeJsonFileOps] Interrupted while waiting for in-JVM lock on " + lockFile);
        }
        try {
            try (FileChannel channel = FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
                 FileLock lock = acquireLock(channel, timeoutMs)) {
                action.run();
            } catch (OverlappingFileLockException e) {
                // The file lock is already held by this JVM through another
                // channel (e.g. a nested withLock call on the same thread, or
                // another thread that already passed the reentrant gate).
                // Serialisation is already in effect — run without re-locking.
                action.run();
            }
        } finally {
            if (jvmLocked) {
                jvmLock.unlock();
            }
        }
    }

    /**
     * Build a sibling path by appending {@code suffix} to the file name
     * (e.g. {@code .claude.json} + {@code .ccgui-backup}).
     *
     * @param file   the base file
     * @param suffix the suffix to append to its name
     * @return the sibling path
     */
    public static Path sibling(Path file, String suffix) {
        return file.resolveSibling(file.getFileName() + suffix);
    }

    // ==================== internals ====================

    /**
     * Copy the current target to the backup sibling (best effort — a backup
     * failure must not block the write; the staged temp file still replaces
     * the corrupt/old content atomically).
     */
    private static void backupExisting(Path target) {
        if (!Files.isRegularFile(target)) {
            return;
        }
        Path backup = sibling(target, BACKUP_SUFFIX);
        try (java.io.InputStream in = Files.newInputStream(target);
             java.io.OutputStream out = Files.newOutputStream(backup,
                     StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
            in.transferTo(out);
        } catch (IOException e) {
            LOG.warn("[SafeJsonFileOps] Could not back up " + target + " before replacing: " + e.getMessage());
        }
    }

    /**
     * Move the staged temp file onto the target, retrying transient failures
     * (Windows denies the replace while another process holds the target open
     * without share-delete) and degrading to a non-atomic replace only when
     * the filesystem has no atomic move.
     */
    private static void moveWithRetry(Path source, Path target) throws IOException {
        boolean atomicSupported = true;
        IOException lastError = null;
        for (int attempt = 0; attempt < MOVE_ATTEMPTS; attempt++) {
            try {
                if (atomicSupported) {
                    try {
                        Files.move(source, target,
                                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                        return;
                    } catch (AtomicMoveNotSupportedException notAtomic) {
                        atomicSupported = false;
                        continue;
                    }
                }
                Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
                return;
            } catch (IOException e) {
                lastError = e;
                sleepQuietly(MOVE_RETRY_DELAY_MS);
            }
        }
        throw new IOException("Could not replace " + target + " after " + MOVE_ATTEMPTS + " attempts"
                + (lastError != null ? ": " + lastError.getMessage() : ""), lastError);
    }

    /**
     * Try to acquire the OS-level exclusive lock, polling until the deadline.
     * Returns {@code null} (proceed-unlocked) when the deadline passes — the
     * caller's write is still atomic, so this only widens the RMW window.
     */
    private static FileLock acquireLock(FileChannel channel, long timeoutMs) throws IOException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        for (;;) {
            FileLock lock = channel.tryLock();
            if (lock != null) {
                return lock;
            }
            if (System.currentTimeMillis() >= deadline) {
                LOG.warn("[SafeJsonFileOps] Timed out waiting for file lock — proceeding without it");
                return null;
            }
            sleepQuietly(LOCK_RETRY_DELAY_MS);
        }
    }

    /** Sleep helper that swallows interrupts (keeps interrupt status set). */
    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
