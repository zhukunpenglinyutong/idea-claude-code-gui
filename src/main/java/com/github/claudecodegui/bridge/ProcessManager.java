package com.github.claudecodegui.bridge;

import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Process manager.
 * Manages child processes related to the Claude SDK.
 */
public class ProcessManager {

    private static final Logger LOG = Logger.getInstance(ProcessManager.class);
    private static final String CLAUDE_TEMP_DIR_NAME = "claude-agent-tmp";

    private final Map<String, Process> activeChannelProcesses = new ConcurrentHashMap<>();
    private final Set<String> interruptedChannels = ConcurrentHashMap.newKeySet();
    /**
     * Per-channel spawn-vs-interrupt boundary locks (provider-abort final closure,
     * PART B). Serialize {@link #beginSpawn} / {@link #registerProcessChecked} /
     * {@link #interruptChannel} / {@link #clearInterrupt} for a given channelId so the
     * spawn commit and the interrupt are mutually exclusive — no check-then-spawn gap.
     */
    private final Map<String, Object> channelLocks = new ConcurrentHashMap<>();

    /**
     * Generates a unique channel ID by appending a random UUID to {@code prefix}.
     *
     * <p>Use this when registering a short-lived child process whose channel
     * has no natural identifier (one-shot RPC calls, helper scripts, etc.).
     * A unique suffix is mandatory: see {@code CodexSDKBridge#getMcpServerTools}
     * (L10 fix) for why constant channel IDs corrupt the registry under
     * concurrent calls.
     */
    public static String newChannelId(String prefix) {
        return prefix + "-" + UUID.randomUUID();
    }

    /**
     * Registers an active process.
     */
    public void registerProcess(String channelId, Process process) {
        if (channelId != null && process != null) {
            activeChannelProcesses.put(channelId, process);
            interruptedChannels.remove(channelId);
        }
    }

    /**
     * Unregisters an active process.
     */
    public void unregisterProcess(String channelId, Process process) {
        if (channelId != null) {
            activeChannelProcesses.remove(channelId, process);
        }
    }

    /**
     * Gets an active process by channel ID.
     */
    public Process getProcess(String channelId) {
        return activeChannelProcesses.get(channelId);
    }

    /**
     * Checks whether a channel was interrupted.
     */
    public boolean wasInterrupted(String channelId) {
        return channelId != null && interruptedChannels.remove(channelId);
    }

    /**
     * Interrupts a channel.
     * Uses platform-aware process termination to ensure the entire process tree
     * is properly terminated on Windows.
     *
     * <p>Records the interrupt UNDER the per-channel lock EVEN IF no process is
     * registered yet (provider-abort final closure, PART B). Previously a pre-spawn
     * interrupt returned early and was lost, so a later spawn ran un-aborted. Now a
     * pending interrupt is visible to {@link #beginSpawn} / {@link #registerProcessChecked},
     * which reject the spawn (or destroy the just-spawned process) before Agent work.
     */
    public void interruptChannel(String channelId) {
        if (channelId == null) {
            LOG.info("[Interrupt] ChannelId is null, nothing to interrupt");
            return;
        }

        synchronized (lockFor(channelId)) {
            // Record the interrupt even if no process is registered yet.
            interruptedChannels.add(channelId);
            Process process = activeChannelProcesses.get(channelId);
            if (process == null) {
                LOG.info("[Interrupt] No active process yet; pending interrupt recorded for channel: " + channelId);
                return;
            }

            LOG.info("[Interrupt] Attempting to interrupt channel: " + channelId);
            // Use platform-aware process termination
            // Windows: uses taskkill /F /T to kill the process tree
            // Unix: uses standard destroy/destroyForcibly
            PlatformUtils.terminateProcess(process);

            // Wait for the process to fully terminate
            try {
                if (process.isAlive()) {
                    boolean terminated = process.waitFor(3, TimeUnit.SECONDS);
                    if (!terminated) {
                        LOG.info("[Interrupt] Process still alive, force killing channel: " + channelId);
                        process.destroyForcibly();
                        process.waitFor(2, TimeUnit.SECONDS);
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                activeChannelProcesses.remove(channelId, process);
                // Verify the process has actually terminated
                if (process.isAlive()) {
                    LOG.warn("[Interrupt] Warning: Process may still be alive for channel: " + channelId);
                } else {
                    LOG.info("[Interrupt] Successfully terminated channel: " + channelId);
                }
            }
        }
    }

    /**
     * Pre-spawn boundary (PART B). Atomically check whether an interrupt has already
     * been recorded for {@code channelId}. Returns false if interrupted (the caller
     * MUST NOT spawn — abort won). Returns true if clear (spawn may proceed). This is
     * an optimization; the authoritative gate is {@link #registerProcessChecked},
     * which re-checks atomically with the registration.
     */
    public boolean beginSpawn(String channelId) {
        if (channelId == null) {
            return true;
        }
        synchronized (lockFor(channelId)) {
            return !interruptedChannels.contains(channelId);
        }
    }

    /**
     * Atomically register a spawned process UNLESS an interrupt has already won
     * (PART B). Returns false if interrupted (the caller MUST destroy the process
     * before it begins Agent work — stdin not yet written). Returns true and registers
     * the process otherwise. Does NOT blindly clear a pending interrupt (unlike
     * {@link #registerProcess}, which is for non-Agent helpers).
     */
    public boolean registerProcessChecked(String channelId, Process process) {
        if (channelId == null || process == null) {
            return true;
        }
        synchronized (lockFor(channelId)) {
            if (interruptedChannels.contains(channelId)) {
                return false; // interrupt won during spawn — reject
            }
            activeChannelProcesses.put(channelId, process);
            return true;
        }
    }

    /**
     * Clear a recorded interrupt for {@code channelId}. Called on turn completion (via
     * {@code ClaudeSession.send}'s completion handler) so the next turn on the same
     * channel is not falsely rejected (PART B).
     */
    public void clearInterrupt(String channelId) {
        if (channelId == null) {
            return;
        }
        synchronized (lockFor(channelId)) {
            interruptedChannels.remove(channelId);
        }
    }

    private Object lockFor(String channelId) {
        return channelLocks.computeIfAbsent(channelId, k -> new Object());
    }

    /**
     * Cleans up all active child processes.
     * Should be called when the plugin is unloaded or IDEA is shutting down.
     */
    public void cleanupAllProcesses() {
        LOG.info("[ProcessManager] Cleaning up all active processes...");
        int count = 0;

        for (Map.Entry<String, Process> entry : activeChannelProcesses.entrySet()) {
            String channelId = entry.getKey();
            Process process = entry.getValue();

            if (process != null && process.isAlive()) {
                LOG.info("[ProcessManager] Terminating process for channel: " + channelId);
                PlatformUtils.terminateProcess(process);
                count++;
            }
        }

        activeChannelProcesses.clear();
        interruptedChannels.clear();

        // Clean up stale temp files on shutdown (safe for concurrent sessions)
        cleanupStaleTempFiles();

        LOG.info("[ProcessManager] Cleanup complete. Terminated " + count + " processes.");
    }

    /**
     * Gets the number of currently active processes.
     */
    public int getActiveProcessCount() {
        int count = 0;
        for (Process process : activeChannelProcesses.values()) {
            if (process != null && process.isAlive()) {
                count++;
            }
        }
        return count;
    }

    /**
     * Returns an immutable snapshot of the currently registered channel→process map.
     * Used by NodeProcessRegistry to enumerate live processes for the management panel.
     * Filters out dead processes inline so callers don't need to re-check isAlive().
     */
    public Map<String, Process> getActiveChannelSnapshot() {
        Map<String, Process> snapshot = new java.util.HashMap<>();
        for (Map.Entry<String, Process> entry : activeChannelProcesses.entrySet()) {
            Process process = entry.getValue();
            if (process != null && process.isAlive()) {
                snapshot.put(entry.getKey(), process);
            }
        }
        return snapshot;
    }

    /**
     * Waits for a process to terminate.
     */
    public void waitForProcessTermination(Process process) {
        if (process == null) {
            return;
        }
        if (process.isAlive()) {
            try {
                process.waitFor(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Prepares the Claude temporary directory.
     */
    public File prepareClaudeTempDir() {
        String baseTemp = System.getProperty("java.io.tmpdir");
        if (baseTemp == null || baseTemp.isEmpty()) {
            return null;
        }

        Path tempPath = Paths.get(baseTemp, CLAUDE_TEMP_DIR_NAME);
        try {
            Files.createDirectories(tempPath);
            return tempPath.toFile();
        } catch (IOException e) {
            LOG.error("[ProcessManager] Failed to prepare temp dir: " + tempPath + ", reason: " + e.getMessage());
            return null;
        }
    }

    /**
     * Cleans up stale Claude cwd temp files older than the given threshold.
     * Called during IDE shutdown to prevent temp file accumulation
     * without interfering with concurrent sessions.
     */
    public void cleanupStaleTempFiles() {
        File tempDir = prepareClaudeTempDir();
        if (tempDir == null || !tempDir.exists()) {
            return;
        }
        File[] cwdFiles = tempDir.listFiles((dir, name) ->
            name.startsWith("claude-") && name.endsWith("-cwd"));
        if (cwdFiles == null || cwdFiles.length == 0) {
            return;
        }
        long staleThresholdMs = TimeUnit.HOURS.toMillis(24);
        long now = System.currentTimeMillis();
        int cleaned = 0;
        for (File file : cwdFiles) {
            if (now - file.lastModified() > staleThresholdMs) {
                if (!PlatformUtils.deleteWithRetry(file, 3)) {
                    try {
                        Files.deleteIfExists(file.toPath());
                    } catch (IOException e) {
                        LOG.error("[ProcessManager] Failed to delete stale temp cwd file: " + file.getAbsolutePath());
                    }
                }
                cleaned++;
            }
        }
        if (cleaned > 0) {
            LOG.info("[ProcessManager] Cleaned up " + cleaned + " stale temp cwd files.");
        }
    }
}
