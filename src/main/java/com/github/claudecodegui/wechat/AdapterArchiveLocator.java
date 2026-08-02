package com.github.claudecodegui.wechat;

import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.PluginMetadata;
import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Locates the packaged {@code adapter.zip}/{@code adapter.hash} files in the
 * plugin installation directory.
 *
 * <p>The plugin ZIP places both files at the plugin root (same layout as
 * ai-bridge.zip/ai-bridge.hash). Plugin root plain files are not guaranteed to
 * be on the plugin classpath, so this locator resolves the plugin directory
 * from the plugin descriptor and standard IDE paths instead of
 * {@code ClassLoader.getResourceAsStream}. The candidate search mirrors the
 * verified {@code BridgeArchiveLocator} pattern.
 */
final class AdapterArchiveLocator {

    private static final Logger LOG = Logger.getInstance(AdapterArchiveLocator.class);

    static final String ADAPTER_ARCHIVE_NAME = "adapter.zip";
    static final String ADAPTER_HASH_NAME = "adapter.hash";
    static final String PLUGIN_DIR_NAME = "idea-claude-code-gui";

    /** Packaged adapter resources found in one plugin directory. */
    static final class AdapterResources {
        final File zipFile;
        final File hashFile;

        AdapterResources(File zipFile, File hashFile) {
            this.zipFile = zipFile;
            this.hashFile = hashFile;
        }
    }

    private AdapterArchiveLocator() {
    }

    /**
     * Resolves the plugin directory that contains {@code adapter.zip} and
     * returns both packaged resources. Returns {@code null} when no plugin
     * directory with an archive can be found.
     */
    static AdapterResources locate() {
        File classpathPluginDir = null;
        try {
            classpathPluginDir = PluginMetadata.getPluginDirectory(AdapterArchiveLocator.class);
        } catch (Throwable t) {
            LOG.debug("[adapter] Cannot infer plugin directory from descriptor: " + t.getMessage());
        }
        for (File candidate : collectPluginDirCandidates(classpathPluginDir)) {
            File archive = locateArchive(candidate);
            if (archive != null) {
                return new AdapterResources(archive, new File(archive.getParentFile(), ADAPTER_HASH_NAME));
            }
        }
        return null;
    }

    /** Testable core: finds adapter.zip inside a single candidate plugin dir. */
    static File locateArchive(File pluginDir) {
        if (pluginDir == null) {
            return null;
        }
        File archive = new File(pluginDir, ADAPTER_ARCHIVE_NAME);
        return archive.isFile() ? archive : null;
    }

    static List<File> collectPluginDirCandidates(File classpathPluginDir) {
        List<File> candidates = new ArrayList<>();
        addCandidate(candidates, classpathPluginDir);

        try {
            String pluginsRoot = PathManager.getPluginsPath();
            if (pluginsRoot != null && !pluginsRoot.isEmpty()) {
                addPluginRootCandidates(candidates, new File(pluginsRoot));
            }

            String systemPath = PathManager.getSystemPath();
            if (systemPath != null && !systemPath.isEmpty()) {
                addPluginRootCandidates(candidates, new File(systemPath, "plugins"));
            }
        } catch (Throwable t) {
            LOG.debug("[adapter] Cannot infer plugin roots from PathManager: " + t.getMessage());
        }

        if (classpathPluginDir != null) {
            File ancestor = classpathPluginDir;
            int climbs = 0;
            while (ancestor != null && climbs < 8) {
                addPluginRootCandidates(candidates, ancestor);
                addPluginRootCandidates(candidates, new File(ancestor, "plugins"));
                addPluginRootCandidates(candidates, new File(ancestor, "system/plugins"));
                addPluginRootCandidates(candidates, new File(ancestor, "config/plugins"));
                addIdeaSandboxCandidates(candidates, new File(ancestor, "build/idea-sandbox"));
                ancestor = ancestor.getParentFile();
                climbs++;
            }
        }

        return candidates;
    }

    private static void addIdeaSandboxCandidates(List<File> candidates, File sandboxRoot) {
        if (sandboxRoot == null || !sandboxRoot.isDirectory()) {
            return;
        }
        File[] ideSandboxes = sandboxRoot.listFiles(File::isDirectory);
        if (ideSandboxes == null) {
            return;
        }
        for (File ideSandbox : ideSandboxes) {
            addPluginRootCandidates(candidates, new File(ideSandbox, "plugins"));
        }
    }

    private static void addPluginRootCandidates(List<File> candidates, File pluginsRoot) {
        if (pluginsRoot == null) {
            return;
        }
        addCandidate(candidates, new File(pluginsRoot, PLUGIN_DIR_NAME));
        addCandidate(candidates, new File(pluginsRoot, PlatformUtils.getPluginId()));
    }

    private static void addCandidate(List<File> candidates, File candidate) {
        if (candidate == null) {
            return;
        }
        String path = candidate.getAbsolutePath();
        for (File existing : candidates) {
            if (existing.getAbsolutePath().equals(path)) {
                return;
            }
        }
        candidates.add(candidate);
    }
}
