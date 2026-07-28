package com.github.claudecodegui.bridge;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import org.jetbrains.annotations.NotNull;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Bridge directory resolver.
 * Responsible for locating and managing the ai-bridge directory (unified bridge for Claude and Codex SDKs).
 *
 * <p>This class is the public facade. Path discovery, archive extraction, and
 * signature verification are delegated to package-private helpers
 * ({@link BridgePathLocator}, {@link BridgeArchiveExtractor},
 * {@link BridgeSignatureVerifier}).
 */
public class BridgeDirectoryResolver {

    private static final Logger LOG = Logger.getInstance(BridgeDirectoryResolver.class);
    private static final String SDK_DIR_NAME = BridgePathLocator.SDK_DIR_NAME;
    private static final String BRIDGE_VERSION_FILE = ".bridge-version";

    private volatile File cachedSdkDir = null;
    /**
     * Directory path manually set via setSdkDir(), with the highest priority.
     * Difference from cachedSdkDir:
     * - manuallySdkDir: Explicitly set by the user via setSdkDir(), never overridden by auto-discovery
     * - cachedSdkDir: Cached directory found through any means (manual or automatic)
     */
    private volatile File manuallySdkDir = null;
    private final Object bridgeExtractionLock = new Object();

    // Extraction state management
    private enum ExtractionState {
        NOT_STARTED,    // Initial state
        IN_PROGRESS,    // Extraction is running
        COMPLETED,      // Extraction finished successfully
        FAILED          // Extraction failed
    }

    private final AtomicReference<ExtractionState> extractionState = new AtomicReference<>(ExtractionState.NOT_STARTED);
    private final AtomicReference<CompletableFuture<File>> extractionFutureRef = new AtomicReference<>();
    private volatile CompletableFuture<Boolean> extractionReadyFuture = new CompletableFuture<>();

    /**
     * Find the claude-bridge directory.
     * Priority: manually set path > configured path > embedded path > cached path > fallback
     */
    public File findSdkDir() {
        // Priority 0: Manually set path (via setSdkDir(), highest priority)
        if (this.manuallySdkDir != null && isValidBridgeDir(this.manuallySdkDir)) {
            LOG.debug("[BridgeResolver] Using manually set path: " + this.manuallySdkDir.getAbsolutePath());
            this.cachedSdkDir = this.manuallySdkDir;
            return this.cachedSdkDir;
        }

        // Priority 1: Configured path
        File configuredDir = BridgePathLocator.resolveConfiguredBridgeDir();
        if (configuredDir != null) {
            LOG.debug("[BridgeResolver] Using configured path: " + configuredDir.getAbsolutePath());
            this.cachedSdkDir = configuredDir;
            return this.cachedSdkDir;
        }

        // Check if extraction is already in progress (avoid triggering it again)
        if (this.extractionState.get() == ExtractionState.IN_PROGRESS) {
            LOG.debug("[BridgeResolver] Extraction in progress, returning null");
            return null;
        }

        // Priority 2: Embedded ai-bridge.zip (preferred in production)
        File embeddedDir = ensureEmbeddedBridgeExtracted();
        if (embeddedDir != null) {
            LOG.info("[BridgeResolver] Using embedded path: " + embeddedDir.getAbsolutePath());
            // Verify that node_modules exists
            File nodeModules = new File(embeddedDir, "node_modules");
            LOG.debug("[BridgeResolver] node_modules exists: " + nodeModules.exists());
            this.cachedSdkDir = embeddedDir;
            return this.cachedSdkDir;
        }

        // Re-check: if ensureEmbeddedBridgeExtracted() triggered background extraction (EDT thread scenario),
        // the state will be IN_PROGRESS, and we should return null instead of using a fallback path
        if (this.extractionState.get() == ExtractionState.IN_PROGRESS) {
            LOG.debug("[BridgeResolver] Background extraction started, returning null to avoid incorrect fallback path");
            return null;
        }

        // Priority 3: Use cached path (if it exists and is valid)
        if (this.cachedSdkDir != null && isValidBridgeDir(this.cachedSdkDir)) {
            LOG.debug("[BridgeResolver] Using cached path: " + this.cachedSdkDir.getAbsolutePath());
            return this.cachedSdkDir;
        }

        LOG.debug("[BridgeResolver] Embedded path not found, trying fallback search...");

        // Priority 4: Fallback (development environment)
        // List of possible locations
        List<File> possibleDirs = new ArrayList<>();

        // 1. Current working directory
        File currentDir = new File(System.getProperty("user.dir"));
        BridgePathLocator.addCandidate(possibleDirs, new File(currentDir, SDK_DIR_NAME));

        // 2. Project root directory (the current directory may be in a subdirectory)
        File parent = currentDir.getParentFile();
        while (parent != null && parent.exists()) {
            boolean hasIdeaDir = new File(parent, ".idea").exists();
            boolean hasBridgeDir = new File(parent, SDK_DIR_NAME).exists();
            if (hasIdeaDir || hasBridgeDir) {
                BridgePathLocator.addCandidate(possibleDirs, new File(parent, SDK_DIR_NAME));
                if (hasIdeaDir) {
                    break;
                }
            }
            if (BridgePathLocator.isRootDirectory(parent)) {
                break;
            }
            parent = parent.getParentFile();
        }

        // 3. Plugin directory and sandbox
        BridgePathLocator.addPluginCandidates(possibleDirs);

        // 4. Infer from classpath
        BridgePathLocator.addClasspathCandidates(possibleDirs);

        // Find the first valid directory
        for (File dir : possibleDirs) {
            if (isValidBridgeDir(dir)) {
                this.cachedSdkDir = dir;
                LOG.info("[BridgeResolver] Using fallback path: " + this.cachedSdkDir.getAbsolutePath());
                File nodeModules = new File(this.cachedSdkDir, "node_modules");
                LOG.debug("[BridgeResolver] node_modules exists: " + nodeModules.exists());
                return this.cachedSdkDir;
            }
        }

        // If none found, check if extraction is in progress before logging error
        if (this.extractionState.get() == ExtractionState.IN_PROGRESS) {
            // Extraction is in progress, this is expected - no need to log error
            LOG.debug("[BridgeResolver] Bridge not yet available - extraction in progress");
            return null;
        }

        // If extraction is not in progress, this is a real error
        LOG.warn("[BridgeResolver] Cannot find ai-bridge directory, tried locations:");
        for (File dir : possibleDirs) {
            LOG.warn("  - " + dir.getAbsolutePath() + " (exists: " + dir.exists() + ")");
        }

        // Do not return a non-existent default path, as it would cause ProcessBuilder to use an incorrect working directory.
        // For example, when user.dir is "/", it would produce the invalid path "/ai-bridge".
        LOG.error("[BridgeResolver] Failed to find valid ai-bridge directory. " +
                "Please ensure the plugin is properly installed or set CLAUDE_BRIDGE_PATH environment variable.");

        // Check if this is a development environment (source directory missing node_modules)
        for (File dir : possibleDirs) {
            if (dir.exists() && dir.isDirectory()) {
                File nodeModules = new File(dir, "node_modules");
                File packageJson = new File(dir, "package.json");
                if (packageJson.exists() && !nodeModules.exists()) {
                    LOG.warn("[BridgeResolver] Found ai-bridge directory at: " + dir.getAbsolutePath());
                    LOG.warn("[BridgeResolver] But node_modules is missing. This is a development environment issue.");
                    LOG.warn("[BridgeResolver] Please run: cd \"" + dir.getAbsolutePath() + "\" && npm install");
                    break;
                }
            }
        }

        return null;
    }

    /**
     * Validate whether a directory is a valid bridge directory.
     * Delegates to {@link BridgePathLocator#isValidBridgeDir(File)} but kept on
     * the facade because callers depend on this public method.
     */
    public boolean isValidBridgeDir(File dir) {
        return BridgePathLocator.isValidBridgeDir(dir);
    }

    private File ensureEmbeddedBridgeExtracted() {
        try {
            LOG.info("[BridgeResolver] === Starting embedded bridge extraction check ===");
            LOG.info("[BridgeResolver] Current thread: " + Thread.currentThread().getName());
            LOG.info("[BridgeResolver] Is EDT: " + ApplicationManager.getApplication().isDispatchThread());

            BridgeArchiveLocator.PluginLocation pluginLocation = BridgeArchiveLocator.resolvePluginLocation();
            if (pluginLocation == null) {
                return null;
            }

            File pluginDir = pluginLocation.pluginDir;
            LOG.info("[BridgeResolver] Plugin directory: " + pluginDir.getAbsolutePath());
            LOG.info("[BridgeResolver] Plugin directory exists: " + pluginDir.exists());

            File archiveFile = BridgeArchiveLocator.locateArchive(pluginDir);
            if (archiveFile == null) {
                return null;
            }

            File extractedDir = new File(pluginDir, SDK_DIR_NAME);
            LOG.info("[BridgeResolver] Extracted dir path: " + extractedDir.getAbsolutePath());
            LOG.info("[BridgeResolver] Extracted dir exists: " + extractedDir.exists());

            String signature = BridgeArchiveLocator.computeSignature(pluginLocation, archiveFile);
            LOG.info("[BridgeResolver] Expected signature: " + signature);
            File versionFile = new File(extractedDir, BRIDGE_VERSION_FILE);
            LOG.info("[BridgeResolver] Version file path: " + versionFile.getAbsolutePath());
            LOG.info("[BridgeResolver] Version file exists: " + versionFile.exists());

            boolean isValid = isValidBridgeDir(extractedDir);
            boolean signatureMatches = BridgeSignatureVerifier.bridgeSignatureMatches(versionFile, signature);
            LOG.info("[BridgeResolver] isValidBridgeDir: " + isValid);
            LOG.info("[BridgeResolver] signatureMatches: " + signatureMatches);

            if (isValid && signatureMatches) {
                this.cachedSdkDir = extractedDir;
                // Ensure waiters are notified even if the directory already exists
                this.extractionState.compareAndSet(ExtractionState.NOT_STARTED, ExtractionState.COMPLETED);
                if (!this.extractionReadyFuture.isDone()) {
                    this.extractionReadyFuture.complete(true);
                }
                return extractedDir;
            }

            synchronized (this.bridgeExtractionLock) {
                if (isValidBridgeDir(extractedDir) && BridgeSignatureVerifier.bridgeSignatureMatches(versionFile, signature)) {
                    this.cachedSdkDir = extractedDir;
                    // Ensure waiters are notified
                    this.extractionState.compareAndSet(ExtractionState.NOT_STARTED, ExtractionState.COMPLETED);
                    if (!this.extractionReadyFuture.isDone()) {
                        this.extractionReadyFuture.complete(true);
                    }
                    return extractedDir;
                }

                // Check current extraction state
                ExtractionState currentState = this.extractionState.get();

                if (currentState == ExtractionState.IN_PROGRESS) {
                    // Another thread is already extracting, wait for it
                    LOG.debug("[BridgeResolver] Extraction in progress, waiting for completion...");
                    return waitForExtraction();
                }

                if (currentState == ExtractionState.COMPLETED && isValidBridgeDir(extractedDir)) {
                    // Already extracted and valid
                    this.cachedSdkDir = extractedDir;
                    // Ensure waiters are notified
                    if (!this.extractionReadyFuture.isDone()) {
                        this.extractionReadyFuture.complete(true);
                    }
                    return extractedDir;
                }

                // Start extraction
                LOG.info("[BridgeResolver] No extracted ai-bridge found, starting extraction: " + archiveFile.getAbsolutePath());

                // Mark as in progress BEFORE checking EDT thread
                // Also initialize extractionFutureRef to ensure waitForExtraction() works
                // COMPLETED is allowed here because we only reach this point when the extracted
                // directory is no longer valid (e.g. the plugin was updated under a running IDE
                // and the old extracted dir was removed), so we must re-extract.
                if (!this.extractionState.compareAndSet(ExtractionState.NOT_STARTED, ExtractionState.IN_PROGRESS) &&
                    !this.extractionState.compareAndSet(ExtractionState.FAILED, ExtractionState.IN_PROGRESS) &&
                    !this.extractionState.compareAndSet(ExtractionState.COMPLETED, ExtractionState.IN_PROGRESS)) {
                    // Another thread just started extraction, wait for it
                    LOG.debug("[BridgeResolver] Another thread just started extraction, waiting...");
                    return waitForExtraction();
                }

                // Initialize extractionFutureRef for non-EDT threads to wait on
                CompletableFuture<File> currentFuture = this.extractionFutureRef.get();
                if (currentFuture == null || currentFuture.isDone()) {
                    CompletableFuture<File> newFuture = new CompletableFuture<>();
                    this.extractionFutureRef.compareAndSet(currentFuture, newFuture);
                }

                // Check if running on EDT thread
                if (ApplicationManager.getApplication().isDispatchThread()) {
                    // Extract on background thread with progress indicator to avoid EDT freeze
                    LOG.debug("[BridgeResolver] EDT thread detected, using background task to avoid UI freeze");
                    extractOnBackgroundThreadAsync(archiveFile, extractedDir, signature, versionFile);
                    // DO NOT wait here - return null and let caller handle async initialization
                    // The extractionReadyFuture will be completed when extraction finishes
                    LOG.debug("[BridgeResolver] EDT thread not blocking, returning null. Use getExtractionFuture() to wait asynchronously");
                    return null;
                } else {
                    // Direct extraction on non-EDT thread
                    LOG.info("[BridgeResolver] Starting synchronous extraction on non-EDT thread");
                    try {
                        // Skip deletion if the directory already passes validation with the
                        // expected signature. This prevents two IDEA instances from deleting
                        // each other's extracted files during concurrent startup.
                        if (isValidBridgeDir(extractedDir) && BridgeSignatureVerifier.bridgeSignatureMatches(versionFile, signature)) {
                            LOG.info("[BridgeResolver] Existing extraction is valid, skipping delete+extract");
                            this.extractionState.set(ExtractionState.COMPLETED);
                            this.cachedSdkDir = extractedDir;
                            CompletableFuture<File> future = this.extractionFutureRef.get();
                            if (future != null) {
                                future.complete(extractedDir);
                            }
                            this.extractionReadyFuture.complete(true);
                            return extractedDir;
                        }

                        LOG.info("[BridgeResolver] Step 1: Deleting old directory if exists");
                        BridgeArchiveExtractor.deleteDirectory(extractedDir);

                        LOG.info("[BridgeResolver] Step 2: Unzipping archive");
                        BridgeArchiveExtractor.unzipArchive(archiveFile, extractedDir);
                        LOG.info("[BridgeResolver] Unzip completed, extractedDir exists: " + extractedDir.exists());

                        LOG.info("[BridgeResolver] Step 3: Writing version file");
                        Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);
                        LOG.info("[BridgeResolver] Version file written");

                        // Wait for filesystem to sync and validate with retry
                        // This fixes race condition where unzip returns before files are fully synced
                        LOG.info("[BridgeResolver] Step 4: Validating extracted directory");
                        File validatedDir = waitForValidBridgeDir(extractedDir, 3, 100);
                        if (validatedDir != null) {
                            LOG.info("[BridgeResolver] Validation succeeded!");
                            this.extractionState.set(ExtractionState.COMPLETED);
                            this.cachedSdkDir = validatedDir;
                            CompletableFuture<File> future = this.extractionFutureRef.get();
                            if (future != null) {
                                future.complete(validatedDir);
                            }
                            this.extractionReadyFuture.complete(true);
                            LOG.info("[BridgeResolver] ai-bridge extraction completed: " + validatedDir.getAbsolutePath());
                            return validatedDir;
                        } else {
                            LOG.error("[BridgeResolver] Bridge validation failed after extraction and retries");
                            this.extractionState.set(ExtractionState.FAILED);
                            CompletableFuture<File> future = this.extractionFutureRef.get();
                            if (future != null) {
                                future.completeExceptionally(new IOException("Bridge validation failed after extraction"));
                            }
                            this.extractionReadyFuture.complete(false);
                            return null;
                        }
                    } catch (Exception e) {
                        this.extractionState.set(ExtractionState.FAILED);
                        CompletableFuture<File> future = this.extractionFutureRef.get();
                        if (future != null) {
                            future.completeExceptionally(e);
                        }
                        this.extractionReadyFuture.complete(false);
                        LOG.error("[BridgeResolver] Extraction failed: " + e.getMessage(), e);
                        throw e;
                    }
                }
            }
            // Note: All branches within synchronized block have explicit return statements,
            // so this code path is only reachable if an exception is caught below
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Auto-extraction of ai-bridge failed: " + e.getMessage());
        }
        return null;
    }

    /**
     * Wait for bridge directory to become valid with retry mechanism.
     * This fixes race condition where filesystem hasn't fully synced after extraction.
     *
     * @param dir The directory to validate
     * @param maxRetries Maximum number of retry attempts
     * @param initialDelayMs Initial delay in milliseconds (doubles with each retry)
     * @return The validated directory, or null if validation fails after all retries
     */
    private File waitForValidBridgeDir(File dir, int maxRetries, int initialDelayMs) {
        int delayMs = initialDelayMs;
        for (int i = 0; i <= maxRetries; i++) {
            if (isValidBridgeDir(dir)) {
                if (i > 0) {
                    LOG.info("[BridgeResolver] Bridge validation succeeded after " + i + " retries");
                }
                return dir;
            }
            if (i < maxRetries) {
                LOG.debug("[BridgeResolver] Bridge validation failed, retrying in " + delayMs + "ms (attempt " + (i + 1) + "/" + (maxRetries + 1) + ")");
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    LOG.warn("[BridgeResolver] Validation retry interrupted");
                    return null;
                }
                delayMs *= 2; // Exponential backoff
            }
        }
        LOG.warn("[BridgeResolver] Bridge validation failed after " + (maxRetries + 1) + " attempts");
        return null;
    }

    /**
     * Wait for ongoing extraction to complete.
     * Returns the extracted directory or null if failed.
     */
    private File waitForExtraction() {
        CompletableFuture<File> future = this.extractionFutureRef.get();
        if (future == null) {
            LOG.warn("[BridgeResolver] No extraction future available");
            return null;
        }

        try {
            LOG.info("[BridgeResolver] Waiting for extraction to complete...");
            File result = future.join(); // Block until completion
            LOG.info("[BridgeResolver] Extraction completed, result: " + (result != null ? result.getAbsolutePath() : "null"));
            if (result != null) {
                this.cachedSdkDir = result;
            }
            return result;
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Failed to wait for extraction: " + e.getMessage(), e);
            this.extractionState.set(ExtractionState.FAILED);
            return null;
        }
    }

    /**
     * Extract ai-bridge on background thread with progress indicator (async).
     * This method uses Task.Backgroundable to avoid EDT freeze.
     * Returns immediately, extraction runs in background.
     * NOTE: extractionFutureRef should already be initialized by the caller.
     */
    private void extractOnBackgroundThreadAsync(File archiveFile, File extractedDir, String signature, File versionFile) {
        // extractionFutureRef should already be initialized by caller
        // Do NOT recreate it here to avoid race conditions

        try {
            ProgressManager.getInstance().run(new Task.Backgroundable(null, "Extracting AI Bridge", true) {
                @Override
                public void run(@NotNull ProgressIndicator indicator) {
                    indicator.setIndeterminate(false);
                    indicator.setText("Extracting ai-bridge.zip...");

                    try {
                        // Skip deletion if the directory already passes validation with the
                        // expected signature. This prevents two IDEA instances from deleting
                        // each other's extracted files during concurrent startup.
                        if (isValidBridgeDir(extractedDir) && BridgeSignatureVerifier.bridgeSignatureMatches(versionFile, signature)) {
                            LOG.info("[BridgeResolver] Background: existing extraction is valid, skipping delete+extract");
                            indicator.setFraction(1.0);
                            indicator.setText("Using existing extraction");
                            BridgeDirectoryResolver.this.extractionState.set(ExtractionState.COMPLETED);
                            BridgeDirectoryResolver.this.cachedSdkDir = extractedDir;
                            CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                            if (future != null) {
                                future.complete(extractedDir);
                            }
                            BridgeDirectoryResolver.this.extractionReadyFuture.complete(true);
                            return;
                        }

                        // Delete old directory
                        indicator.setFraction(0.1);
                        indicator.setText("Cleaning old files...");
                        BridgeArchiveExtractor.deleteDirectory(extractedDir);

                        // Extract archive
                        indicator.setFraction(0.2);
                        indicator.setText("Extracting archive...");
                        BridgeArchiveExtractor.unzipArchiveWithProgress(archiveFile, extractedDir, indicator);

                        // Write version file
                        indicator.setFraction(0.9);
                        indicator.setText("Finalizing...");
                        Files.writeString(versionFile.toPath(), signature, StandardCharsets.UTF_8);

                        // Validate with retry to handle filesystem sync delay
                        indicator.setText("Validating extraction...");
                        File validatedDir = waitForValidBridgeDir(extractedDir, 3, 100);

                        indicator.setFraction(1.0);

                        if (validatedDir != null) {
                            LOG.info("[BridgeResolver] Background extraction completed successfully");
                            // Mark as completed and cache the directory
                            BridgeDirectoryResolver.this.extractionState.set(ExtractionState.COMPLETED);
                            BridgeDirectoryResolver.this.cachedSdkDir = validatedDir;
                            CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                            if (future != null) {
                                future.complete(validatedDir);
                            }
                            BridgeDirectoryResolver.this.extractionReadyFuture.complete(true);
                        } else {
                            LOG.error("[BridgeResolver] Background extraction completed but validation failed");
                            BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                            CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                            if (future != null) {
                                future.completeExceptionally(new IOException("Bridge validation failed after extraction"));
                            }
                            BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                        }
                    } catch (IOException e) {
                        LOG.error("[BridgeResolver] Background extraction failed: " + e.getMessage(), e);
                        BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                        CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                        if (future != null) {
                            future.completeExceptionally(e);
                        }
                        BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                    }
                }

                @Override
                public void onCancel() {
                    LOG.warn("[BridgeResolver] Extraction cancelled by user");
                    BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                    CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                    if (future != null) {
                        future.completeExceptionally(new InterruptedException("Extraction cancelled"));
                    }
                    BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                }

                @Override
                public void onThrowable(@NotNull Throwable error) {
                    LOG.error("[BridgeResolver] Extraction task threw error: " + error.getMessage(), error);
                    BridgeDirectoryResolver.this.extractionState.set(ExtractionState.FAILED);
                    CompletableFuture<File> future = BridgeDirectoryResolver.this.extractionFutureRef.get();
                    if (future != null) {
                        future.completeExceptionally(error);
                    }
                    BridgeDirectoryResolver.this.extractionReadyFuture.complete(false);
                }
            });
        } catch (Exception e) {
            LOG.error("[BridgeResolver] Failed to start background extraction task: " + e.getMessage(), e);
            this.extractionState.set(ExtractionState.FAILED);
            CompletableFuture<File> future = this.extractionFutureRef.get();
            if (future != null) {
                future.completeExceptionally(e);
            }
            this.extractionReadyFuture.complete(false);
        }
    }

    /**
     * Manually sets the claude-bridge directory path.
     * This path has the highest priority and overrides configured and embedded paths.
     * Once set, findSdkDir() will preferentially return this path.
     *
     * @param path the directory path
     */
    public void setSdkDir(String path) {
        this.manuallySdkDir = new File(path);
        this.cachedSdkDir = this.manuallySdkDir;
        LOG.debug("[BridgeResolver] Manually set SDK directory to: " + path);
    }

    /**
     * Gets the currently used claude-bridge directory.
     */
    public File getSdkDir() {
        if (this.cachedSdkDir == null) {
            return this.findSdkDir();
        }
        return this.cachedSdkDir;
    }

    /**
     * Clears all caches, including manually set paths and auto-discovered caches.
     * After calling this, the next findSdkDir() will re-execute the full path discovery logic.
     */
    public void clearCache() {
        this.cachedSdkDir = null;
        this.manuallySdkDir = null;
        this.extractionState.set(ExtractionState.NOT_STARTED);
        this.extractionFutureRef.set(null);
        this.extractionReadyFuture = new CompletableFuture<>();
    }

    /**
     * Check if extraction is complete (non-blocking).
     * Returns true if extraction finished successfully and bridge is valid.
     */
    public boolean isExtractionComplete() {
        ExtractionState state = extractionState.get();
        if (state == ExtractionState.COMPLETED && cachedSdkDir != null) {
            return isValidBridgeDir(cachedSdkDir);
        }
        // Also check if we have a valid configured or cached dir without extraction
        if (cachedSdkDir != null && isValidBridgeDir(cachedSdkDir)) {
            return true;
        }
        return false;
    }

    /**
     * Get a future that completes when extraction is ready.
     * This allows callers to wait asynchronously without blocking EDT.
     *
     * @return CompletableFuture that completes with true if bridge is ready, false otherwise
     */
    public CompletableFuture<Boolean> getExtractionFuture() {
        // If already completed, return a completed future
        if (isExtractionComplete()) {
            return CompletableFuture.completedFuture(true);
        }

        // If extraction hasn't started yet, trigger it on a background thread
        if (extractionState.get() == ExtractionState.NOT_STARTED) {
            // The next call to findSdkDir will trigger extraction
            // For now, return the ready future which will be completed when extraction finishes
        }

        return extractionReadyFuture;
    }

    /**
     * Check if extraction is currently in progress.
     */
    public boolean isExtractionInProgress() {
        return this.extractionState.get() == ExtractionState.IN_PROGRESS;
    }
}
