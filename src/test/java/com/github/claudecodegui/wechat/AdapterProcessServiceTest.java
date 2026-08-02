package com.github.claudecodegui.wechat;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class AdapterProcessServiceTest {

    private static final class FakeProcess extends Process {
        final BlockingQueue<String> stdoutLines = new LinkedBlockingQueue<>();
        volatile boolean alive = true;
        final CompletableFuture<Integer> exitFuture = new CompletableFuture<>();

        @Override
        public OutputStream getOutputStream() {
            return OutputStream.nullOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return InputStream.nullInputStream();
        }

        @Override
        public InputStream getErrorStream() {
            return InputStream.nullInputStream();
        }

        @Override
        public int waitFor() throws InterruptedException {
            return 0;
        }

        @Override
        public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
            return exitFuture.isDone();
        }

        @Override
        public int exitValue() {
            return 0;
        }

        @Override
        public void destroy() {
            alive = false;
            exitFuture.complete(0);
        }

        @Override
        public Process destroyForcibly() {
            alive = false;
            exitFuture.complete(0);
            return this;
        }

        @Override
        public boolean isAlive() {
            return alive;
        }

        @Override
        public CompletableFuture<Process> onExit() {
            return exitFuture.thenApply(code -> this);
        }
    }

    private static final class RecordingLauncher implements AdapterProcessService.Launcher {
        final List<FakeProcess> processes = new ArrayList<>();
        final List<Map<String, String>> envs = new ArrayList<>();

        @Override
        public Process launch(List<String> command, Map<String, String> env, File dir,
                              Consumer<String> stdout, Consumer<String> stderr) {
            FakeProcess process = new FakeProcess();
            processes.add(process);
            envs.add(new HashMap<>(env));
            String line = env.get("__FAKE_READY_LINE");
            if (line != null) {
                process.stdoutLines.add(line);
            }
            Thread feeder = new Thread(() -> {
                try {
                    String l = process.stdoutLines.poll(5, TimeUnit.SECONDS);
                    if (l != null) {
                        stdout.accept(l);
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            });
            feeder.setDaemon(true);
            feeder.start();
            return process;
        }
    }

    private static File bundleDir() throws IOException {
        File dir = java.nio.file.Files.createTempDirectory("adapter-proc-test").toFile();
        dir.deleteOnExit();
        return dir;
    }

    private static String readyLine(int port) {
        return AdapterProcessService.READY_PREFIX + "{\"version\":1,\"port\":" + port + ",\"pid\":123}";
    }

    @Test
    public void parseHelpers() {
        assertEquals(22, AdapterProcessService.parseNodeMajor("v22.23.2"));
        assertEquals(18, AdapterProcessService.parseNodeMajor("18.20.5"));
        assertEquals(22, AdapterProcessService.parseEnginesMajor(">=22"));
        assertEquals(22, AdapterProcessService.parseEnginesMajor("^20.19.0 || >=22.12.0"));
        assertNotNull(AdapterProcessService.randomToken());
    }

    @Test
    public void readyHandshakeParsedWithoutTokenLeak() throws Exception {
        File dir = bundleDir();
        File bundle = new File(dir, "adapter-bundle.cjs");
        assertTrue(bundle.createNewFile());
        RecordingLauncher launcher = new RecordingLauncher();
        String ready = readyLine(4321);
        AdapterProcessService service = new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> {
                    env.put("__FAKE_READY_LINE", ready);
                    return launcher.launch(command, env, workDir, stdout, stderr);
                },
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                bundle, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.RUNNING, service.start().join());
        assertEquals("http://127.0.0.1:4321", service.controlBaseUrl());
        String token = service.controlToken();
        assertNotNull(token);
        assertFalse(ready.contains(token));
        Map<String, String> env = launcher.envs.get(0);
        assertEquals(token, env.get("CCGUI_ADAPTER_CONTROL_TOKEN"));
        assertNotNull(env.get("CCGUI_ADAPTER_PARENT_PID"));
        service.stop().join();
    }

    @Test
    public void startupTimeoutReportsOffline() throws Exception {
        File dir = bundleDir();
        File bundle = new File(dir, "adapter-bundle.cjs");
        assertTrue(bundle.createNewFile());
        AdapterProcessService service = new AdapterProcessService(
                launcher(), () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                bundle, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.OFFLINE, service.start().join());
        assertTrue(service.lastError().contains("READY"));
    }

    @Test
    public void nodeTooOldReportsReadableError() throws Exception {
        File dir = bundleDir();
        File bundle = new File(dir, "adapter-bundle.cjs");
        assertTrue(bundle.createNewFile());
        AdapterProcessService service = new AdapterProcessService(
                launcher(), () -> new AdapterProcessService.NodeRuntime("node", 18, "v18.20.5"),
                bundle, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.OFFLINE, service.start().join());
        assertTrue(service.lastError().contains("22"));
        assertTrue(service.lastError().contains("v18.20.5"));
    }

    @Test
    public void crashDoesNotAutoRestart() throws Exception {
        File dir = bundleDir();
        File bundle = new File(dir, "adapter-bundle.cjs");
        assertTrue(bundle.createNewFile());
        RecordingLauncher launcher = new RecordingLauncher();
        AdapterProcessService service = new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> {
                    env.put("__FAKE_READY_LINE", readyLine(5555));
                    return launcher.launch(command, env, workDir, stdout, stderr);
                },
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                bundle, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.RUNNING, service.start().join());
        launcher.processes.get(0).destroy();
        Thread.sleep(300);
        assertEquals(AdapterProcessService.State.OFFLINE, service.state());
        assertEquals(1, launcher.processes.size());
        // Manual retry launches a second process.
        service.retry().join();
        assertEquals(2, launcher.processes.size());
        service.stop().join();
    }

    @Test
    public void packagedBundleFirstInstallExtractsAndVerifies() throws Exception {
        File dir = bundleDir();
        byte[] bundleBytes = "console.log('first-install');\n".getBytes(StandardCharsets.UTF_8);
        File zip = zipWithBundle(dir, "adapter.zip", bundleBytes);
        String hash = sha256Hex(bundleBytes);
        File runtimeDir = new File(dir, "runtime");

        File result = AdapterProcessService.resolvePackagedBundle(
                runtimeDir, hash, Files.newInputStream(zip.toPath()));

        assertTrue(result.isFile());
        assertEquals("adapter-bundle.cjs", result.getName());
        assertArrayEquals(bundleBytes, Files.readAllBytes(result.toPath()));
        assertTrue(AdapterProcessService.bundleMatchesHash(result, hash));
    }

    @Test
    public void existingBundleMatchingHashIsReusedWithoutExtraction() throws Exception {
        File dir = bundleDir();
        byte[] bundleBytes = "console.log('reuse-me');\n".getBytes(StandardCharsets.UTF_8);
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        File bundle = new File(runtimeDir, "adapter-bundle.cjs");
        Files.write(bundle.toPath(), bundleBytes);

        File result = AdapterProcessService.resolvePackagedBundle(
                runtimeDir, sha256Hex(bundleBytes), new InputStream() {
                    @Override
                    public int read() {
                        throw new AssertionError("zip must not be read when the bundle hash matches");
                    }
                });

        assertEquals(bundle.getAbsolutePath(), result.getAbsolutePath());
        assertArrayEquals(bundleBytes, Files.readAllBytes(result.toPath()));
    }

    @Test
    public void staleBundleWithDifferentHashIsReplacedByNewPackage() throws Exception {
        File dir = bundleDir();
        byte[] oldBytes = "console.log('old-version');\n".getBytes(StandardCharsets.UTF_8);
        byte[] newBytes = "console.log('new-version');\n".getBytes(StandardCharsets.UTF_8);
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        File zip = zipWithBundle(dir, "adapter.zip", newBytes);
        String packagedHash = sha256Hex(newBytes);
        assertNotEquals(packagedHash, sha256Hex(oldBytes));

        File result = AdapterProcessService.resolvePackagedBundle(
                runtimeDir, packagedHash, Files.newInputStream(zip.toPath()));

        assertArrayEquals(newBytes, Files.readAllBytes(result.toPath()));
        assertTrue(AdapterProcessService.bundleMatchesHash(result, packagedHash));
        assertFalse(AdapterProcessService.bundleMatchesHash(result, sha256Hex(oldBytes)));
    }

    @Test
    public void wrongPackagedHashFailsDiagnosticallyAndDeletesBundle() throws Exception {
        File dir = bundleDir();
        byte[] bundleBytes = "console.log('bad-hash');\n".getBytes(StandardCharsets.UTF_8);
        File zip = zipWithBundle(dir, "adapter.zip", bundleBytes);
        File runtimeDir = new File(dir, "runtime");

        try {
            AdapterProcessService.resolvePackagedBundle(
                    runtimeDir,
                    sha256Hex("unrelated-content".getBytes(StandardCharsets.UTF_8)),
                    Files.newInputStream(zip.toPath()));
            fail("expected hash mismatch failure");
        } catch (IllegalStateException err) {
            assertTrue(err.getMessage().contains("mismatch"));
        }
        assertFalse(new File(runtimeDir, "adapter-bundle.cjs").exists());
    }

    @Test
    public void extractionWithoutBundleFailsDiagnostically() throws Exception {
        File dir = bundleDir();
        File zip = new File(dir, "empty.zip");
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(zip.toPath()))) {
            zos.putNextEntry(new ZipEntry("other.txt"));
            zos.write("x".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
        }
        File runtimeDir = new File(dir, "runtime");

        try {
            AdapterProcessService.resolvePackagedBundle(
                    runtimeDir,
                    sha256Hex("x".getBytes(StandardCharsets.UTF_8)),
                    Files.newInputStream(zip.toPath()));
            fail("expected missing bundle failure");
        } catch (IllegalStateException err) {
            assertTrue(err.getMessage().contains("did not produce"));
        }
    }

    @Test
    public void adapterHashObjectIsBundleNotZip() throws Exception {
        File dir = bundleDir();
        byte[] bundleBytes = "console.log('hash-contract');\n".getBytes(StandardCharsets.UTF_8);
        File zip = zipWithBundle(dir, "adapter.zip", bundleBytes);
        File bundleFile = new File(dir, "bundle.cjs");
        Files.write(bundleFile.toPath(), bundleBytes);
        String bundleHash = sha256Hex(bundleBytes);
        String zipHash = sha256Hex(Files.readAllBytes(zip.toPath()));

        assertNotEquals(bundleHash, zipHash);
        assertTrue(AdapterProcessService.bundleMatchesHash(bundleFile, bundleHash));
        assertFalse(AdapterProcessService.bundleMatchesHash(zip, bundleHash));
        assertFalse(AdapterProcessService.bundleMatchesHash(bundleFile, zipHash));
    }

    @Test
    public void pluginLayoutSourceFindsPackagedFiles() throws Exception {
        File dir = bundleDir();
        File pluginDir = new File(dir, "plugins/idea-claude-code-gui");
        assertTrue(pluginDir.mkdirs());
        Files.write(new File(pluginDir, AdapterArchiveLocator.ADAPTER_ARCHIVE_NAME).toPath(),
                "zip-bytes".getBytes(StandardCharsets.UTF_8));
        Files.write(new File(pluginDir, AdapterArchiveLocator.ADAPTER_HASH_NAME).toPath(),
                "a".repeat(64).getBytes(StandardCharsets.UTF_8));

        List<File> candidates = AdapterArchiveLocator.collectPluginDirCandidates(dir);
        File archive = null;
        for (File candidate : candidates) {
            archive = AdapterArchiveLocator.locateArchive(candidate);
            if (archive != null) {
                break;
            }
        }

        assertNotNull(archive);
        assertEquals(pluginDir.getAbsolutePath(), archive.getParentFile().getAbsolutePath());
        assertTrue(new File(archive.getParentFile(), AdapterArchiveLocator.ADAPTER_HASH_NAME).isFile());
    }

    @Test
    public void missingPackagedHashFailsClosed() throws Exception {
        File dir = bundleDir();
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        byte[] oldBytes = "console.log('old');\n".getBytes(StandardCharsets.UTF_8);
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        File zip = zipWithBundle(dir, "adapter.zip", oldBytes);

        try {
            AdapterProcessService.resolveBundleFromPackagedResources(runtimeDir, null, zip);
            fail("expected fail-closed on missing packaged hash");
        } catch (IllegalStateException err) {
            assertTrue(err.getMessage().contains("missing or malformed"));
        }
    }

    @Test
    public void malformedPackagedHashFailsClosed() throws Exception {
        File dir = bundleDir();
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        byte[] oldBytes = "console.log('old');\n".getBytes(StandardCharsets.UTF_8);
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        File zip = zipWithBundle(dir, "adapter.zip", oldBytes);

        try {
            AdapterProcessService.resolveBundleFromPackagedResources(runtimeDir, "not-a-hex-64", zip);
            fail("expected fail-closed on malformed packaged hash");
        } catch (IllegalStateException err) {
            assertTrue(err.getMessage().contains("missing or malformed"));
        }
    }

    @Test
    public void interruptedExtractionLeavesNoRunnablePartialBundle() throws Exception {
        File dir = bundleDir();
        byte[] bundleBytes = "console.log('partial');\n".getBytes(StandardCharsets.UTF_8);
        File zip = zipWithBundle(dir, "adapter.zip", bundleBytes);
        byte[] zipBytes = Files.readAllBytes(zip.toPath());
        File runtimeDir = new File(dir, "runtime");

        try {
            AdapterProcessService.resolvePackagedBundle(
                    runtimeDir,
                    sha256Hex(bundleBytes),
                    new FailingInputStream(zipBytes, 64));
            fail("expected interrupted extraction failure");
        } catch (IOException err) {
            assertTrue(err.getMessage().contains("simulated stream failure"));
        }
        assertFalse(new File(runtimeDir, "adapter-bundle.cjs").exists());
        assertNoTempFiles(runtimeDir);
    }

    @Test
    public void staleBundleAndFailedUpgradeDoNotRunStaleOrPartialContent() throws Exception {
        File dir = bundleDir();
        byte[] oldBytes = "console.log('old');\n".getBytes(StandardCharsets.UTF_8);
        byte[] newBytes = "console.log('new');\n".getBytes(StandardCharsets.UTF_8);
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        File zip = zipWithBundle(dir, "adapter.zip", newBytes);
        byte[] zipBytes = Files.readAllBytes(zip.toPath());

        try {
            AdapterProcessService.resolvePackagedBundle(
                    runtimeDir,
                    sha256Hex(newBytes),
                    new FailingInputStream(zipBytes, 64));
            fail("expected failed upgrade");
        } catch (IOException err) {
            assertTrue(err.getMessage().contains("simulated stream failure"));
        }
        // The stale bundle must not remain runnable and no partial bundle may exist.
        assertFalse(new File(runtimeDir, "adapter-bundle.cjs").exists());
        assertNoTempFiles(runtimeDir);
    }

    @Test
    public void successfulExtractionMovesVerifiedBundleIntoPlace() throws Exception {
        File dir = bundleDir();
        byte[] bundleBytes = "console.log('verified');\n".getBytes(StandardCharsets.UTF_8);
        File zip = zipWithBundle(dir, "adapter.zip", bundleBytes);
        File runtimeDir = new File(dir, "runtime");

        File result = AdapterProcessService.resolvePackagedBundle(
                runtimeDir, sha256Hex(bundleBytes), Files.newInputStream(zip.toPath()));

        assertTrue(result.isFile());
        assertArrayEquals(bundleBytes, Files.readAllBytes(result.toPath()));
        assertTrue(AdapterProcessService.bundleMatchesHash(result, sha256Hex(bundleBytes)));
        assertNoTempFiles(runtimeDir);
    }

    @Test
    public void zipTraversalIsRejected() throws Exception {
        File dir = bundleDir();
        byte[] bundleBytes = "console.log('safe');\n".getBytes(StandardCharsets.UTF_8);
        File zip = new File(dir, "traversal.zip");
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(zip.toPath()))) {
            zos.putNextEntry(new ZipEntry("../evil.txt"));
            zos.write("evil".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            zos.putNextEntry(new ZipEntry("/abs-evil.txt"));
            zos.write("evil".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            zos.putNextEntry(new ZipEntry("..\\win-evil.txt"));
            zos.write("evil".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            zos.putNextEntry(new ZipEntry("sub/../../nested-evil.txt"));
            zos.write("evil".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            zos.putNextEntry(new ZipEntry("adapter-bundle.cjs"));
            zos.write(bundleBytes);
            zos.closeEntry();
        }
        File runtimeDir = new File(dir, "runtime");

        try {
            AdapterProcessService.resolvePackagedBundle(
                    runtimeDir, sha256Hex(bundleBytes), Files.newInputStream(zip.toPath()));
            fail("expected traversal rejection");
        } catch (IOException err) {
            assertTrue(err.getMessage().contains("escapes"));
        }
        assertFalse(new File(runtimeDir, "adapter-bundle.cjs").exists());
        assertNoTempFiles(runtimeDir);
        assertNoEvilFiles(dir);
    }

    @Test
    public void missingHashWithExistingBundleDoesNotLaunch() throws Exception {
        File dir = bundleDir();
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        byte[] oldBytes = "console.log('old');\n".getBytes(StandardCharsets.UTF_8);
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        File zip = zipWithBundle(dir, "adapter.zip", oldBytes);
        AdapterArchiveLocator.AdapterResources resources =
                new AdapterArchiveLocator.AdapterResources(zip, new File(dir, "adapter.hash"));

        File resolved = AdapterProcessService.resolvePackagedBundleFile(runtimeDir, resources);
        assertNull("stale bundle path must not be returned when packaged hash is missing", resolved);
        RecordingLauncher launcher = new RecordingLauncher();
        AdapterProcessService service = new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> launcher.launch(command, env, workDir, stdout, stderr),
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                resolved, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.OFFLINE, service.start().join());
        assertEquals(0, launcher.processes.size());
    }

    @Test
    public void malformedHashWithExistingBundleDoesNotLaunch() throws Exception {
        File dir = bundleDir();
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        byte[] oldBytes = "console.log('old');\n".getBytes(StandardCharsets.UTF_8);
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        File zip = zipWithBundle(dir, "adapter.zip", oldBytes);
        File hashFile = new File(dir, "adapter.hash");
        Files.write(hashFile.toPath(), "not-a-64-hex".getBytes(StandardCharsets.UTF_8));
        AdapterArchiveLocator.AdapterResources resources =
                new AdapterArchiveLocator.AdapterResources(zip, hashFile);

        File resolved = AdapterProcessService.resolvePackagedBundleFile(runtimeDir, resources);
        assertNull("stale bundle path must not be returned when packaged hash is malformed", resolved);
        RecordingLauncher launcher = new RecordingLauncher();
        AdapterProcessService service = new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> launcher.launch(command, env, workDir, stdout, stderr),
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                resolved, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.OFFLINE, service.start().join());
        assertEquals(0, launcher.processes.size());
    }

    @Test
    public void missingArchiveWithExistingBundleDoesNotLaunch() throws Exception {
        File dir = bundleDir();
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        byte[] oldBytes = "console.log('old');\n".getBytes(StandardCharsets.UTF_8);
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        File hashFile = new File(dir, "adapter.hash");
        Files.write(hashFile.toPath(), sha256Hex(oldBytes).getBytes(StandardCharsets.UTF_8));
        AdapterArchiveLocator.AdapterResources resources =
                new AdapterArchiveLocator.AdapterResources(new File(dir, "adapter.zip"), hashFile);

        File resolved = AdapterProcessService.resolvePackagedBundleFile(runtimeDir, resources);
        assertNull("stale bundle path must not be returned when adapter.zip is missing", resolved);
        RecordingLauncher launcher = new RecordingLauncher();
        AdapterProcessService service = new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> launcher.launch(command, env, workDir, stdout, stderr),
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                resolved, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.OFFLINE, service.start().join());
        assertEquals(0, launcher.processes.size());
    }

    @Test
    public void corruptArchiveWithExistingBundleDoesNotLaunch() throws Exception {
        File dir = bundleDir();
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        byte[] oldBytes = "console.log('old');\n".getBytes(StandardCharsets.UTF_8);
        Files.write(new File(runtimeDir, "adapter-bundle.cjs").toPath(), oldBytes);
        byte[] newBytes = "console.log('new');\n".getBytes(StandardCharsets.UTF_8);
        File zip = new File(dir, "adapter.zip");
        Files.write(zip.toPath(), "this-is-not-a-zip".getBytes(StandardCharsets.UTF_8));
        File hashFile = new File(dir, "adapter.hash");
        Files.write(hashFile.toPath(), sha256Hex(newBytes).getBytes(StandardCharsets.UTF_8));
        AdapterArchiveLocator.AdapterResources resources =
                new AdapterArchiveLocator.AdapterResources(zip, hashFile);

        File resolved = AdapterProcessService.resolvePackagedBundleFile(runtimeDir, resources);
        assertNull("stale bundle path must not be returned when the archive is corrupt", resolved);
        RecordingLauncher launcher = new RecordingLauncher();
        AdapterProcessService service = new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> launcher.launch(command, env, workDir, stdout, stderr),
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                resolved, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.OFFLINE, service.start().join());
        assertEquals(0, launcher.processes.size());
    }

    @Test
    public void validVerifiedBundleStillLaunches() throws Exception {
        File dir = bundleDir();
        File runtimeDir = new File(dir, "runtime");
        assertTrue(runtimeDir.mkdirs());
        byte[] bundleBytes = "console.log('verified');\n".getBytes(StandardCharsets.UTF_8);
        File zip = zipWithBundle(dir, "adapter.zip", bundleBytes);
        File hashFile = new File(dir, "adapter.hash");
        Files.write(hashFile.toPath(), sha256Hex(bundleBytes).getBytes(StandardCharsets.UTF_8));
        AdapterArchiveLocator.AdapterResources resources =
                new AdapterArchiveLocator.AdapterResources(zip, hashFile);

        File resolved = AdapterProcessService.resolvePackagedBundleFile(runtimeDir, resources);
        assertNotNull(resolved);
        assertTrue(resolved.isFile());
        RecordingLauncher launcher = new RecordingLauncher();
        AdapterProcessService service = new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> {
                    env.put("__FAKE_READY_LINE", readyLine(7777));
                    return launcher.launch(command, env, workDir, stdout, stderr);
                },
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                resolved, dir.getAbsolutePath(), "/tmp/discovery.json");
        assertEquals(AdapterProcessService.State.RUNNING, service.start().join());
        assertEquals(1, launcher.processes.size());
        service.stop().join();
    }

    @Test
    public void developmentOverrideStillResolvesDistBundle() throws Exception {
        File dir = bundleDir();
        File dist = new File(dir, "dist/adapter-bundle.cjs");
        assertTrue(dist.getParentFile().mkdirs());
        assertTrue(dist.createNewFile());
        String property = "ccgui.adapter.dir";
        String old = System.getProperty(property);
        System.setProperty(property, dir.getAbsolutePath());
        try {
            assertEquals(dist.getAbsolutePath(),
                    AdapterProcessService.resolveBundleFile().getAbsolutePath());
        } finally {
            if (old == null) {
                System.clearProperty(property);
            } else {
                System.setProperty(property, old);
            }
        }
    }

    @Test
    public void developmentOverrideFallsBackToTopLevelBundle() throws Exception {
        File dir = bundleDir();
        File bundle = new File(dir, "adapter-bundle.cjs");
        assertTrue(bundle.createNewFile());
        String property = "ccgui.adapter.dir";
        String old = System.getProperty(property);
        System.setProperty(property, dir.getAbsolutePath());
        try {
            assertEquals(bundle.getAbsolutePath(),
                    AdapterProcessService.resolveBundleFile().getAbsolutePath());
        } finally {
            if (old == null) {
                System.clearProperty(property);
            } else {
                System.setProperty(property, old);
            }
        }
    }

    @Test
    public void developmentOverrideMissingFileStaysOfflineWithoutLaunch() throws Exception {
        File dir = bundleDir();
        String property = "ccgui.adapter.dir";
        String old = System.getProperty(property);
        System.setProperty(property, dir.getAbsolutePath());
        try {
            File resolved = AdapterProcessService.resolveBundleFile();
            assertNotNull(resolved);
            assertFalse(resolved.isFile());
            RecordingLauncher launcher = new RecordingLauncher();
            AdapterProcessService service = new AdapterProcessService(
                    (command, env, workDir, stdout, stderr) -> launcher.launch(command, env, workDir, stdout, stderr),
                    () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                    resolved, dir.getAbsolutePath(), "/tmp/discovery.json");
            assertEquals(AdapterProcessService.State.OFFLINE, service.start().join());
            assertEquals(0, launcher.processes.size());
        } finally {
            if (old == null) {
                System.clearProperty(property);
            } else {
                System.setProperty(property, old);
            }
        }
    }

    private static void assertNoTempFiles(File runtimeDir) {
        File[] files = runtimeDir.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            assertFalse("unexpected temp file: " + file.getName(), file.getName().contains(".tmp-"));
        }
    }

    private static void assertNoEvilFiles(File root) throws Exception {
        List<java.nio.file.Path> paths = new ArrayList<>();
        try (java.util.stream.Stream<java.nio.file.Path> stream = java.nio.file.Files.walk(root.toPath())) {
            stream.forEach(paths::add);
        }
        for (java.nio.file.Path path : paths) {
            assertFalse("evil file written outside runtime root: " + path,
                    path.getFileName().toString().contains("evil"));
        }
    }

    private static final class FailingInputStream extends InputStream {
        private final byte[] data;
        private int pos;
        private final int failAfter;

        FailingInputStream(byte[] data, int failAfter) {
            this.data = data;
            this.failAfter = failAfter;
        }

        @Override
        public int read() throws IOException {
            if (pos >= failAfter) {
                throw new IOException("simulated stream failure");
            }
            if (pos >= data.length) {
                return -1;
            }
            return data[pos++] & 0xff;
        }
    }

    private static File zipWithBundle(File dir, String name, byte[] bundleBytes) throws IOException {
        File zip = new File(dir, name);
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(zip.toPath()))) {
            zos.putNextEntry(new ZipEntry("adapter-bundle.cjs"));
            zos.write(bundleBytes);
            zos.closeEntry();
        }
        return zip;
    }

    private static String sha256Hex(byte[] data) throws Exception {
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(data);
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private static AdapterProcessService.Launcher launcher() {
        return (command, env, dir, stdout, stderr) -> {
            FakeProcess process = new FakeProcess();
            Thread feeder = new Thread(() -> {
                try {
                    String line = process.stdoutLines.poll(2, TimeUnit.SECONDS);
                    if (line != null) {
                        stdout.accept(line);
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            });
            feeder.setDaemon(true);
            feeder.start();
            return process;
        };
    }
}
