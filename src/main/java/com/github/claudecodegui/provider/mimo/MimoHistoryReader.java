package com.github.claudecodegui.provider.mimo;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.opencode.OpenCodeHistoryReader;
import com.google.gson.Gson;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Reads MiMo Code (Xiaomi's OpenCode fork) session history.
 *
 * <p>MiMo Code inherits the OpenCode 1.x storage model: a SQLite database at
 * {@code ~/.local/share/mimocode/mimocode.db} (or
 * {@code $XDG_DATA_HOME/mimocode/mimocode.db}) plus the legacy
 * {@code storage/} JSON tree fallback. Session/message/part schemas are
 * expected to match upstream OpenCode, so all parsing is inherited from
 * {@link OpenCodeHistoryReader}; only the data home, database file name, and
 * provider labels differ.
 */
public class MimoHistoryReader extends OpenCodeHistoryReader {

    public MimoHistoryReader() {
        super(defaultStorageRoot(), defaultDatabasePath(defaultStorageRoot()), new Gson());
    }

    /**
     * Test/fork constructor pointing storage and database at explicit fixtures.
     */
    MimoHistoryReader(Path storageRoot, Path databasePath, Gson gson) {
        super(storageRoot, databasePath, gson);
    }

    @Override
    protected String providerId() {
        return "mimo";
    }

    @Override
    protected String providerDisplayName() {
        return "MiMo";
    }

    private static Path defaultStorageRoot() {
        return defaultMimoDataHome().resolve("storage");
    }

    /**
     * The fork keeps upstream naming for its database file candidates: prefer
     * {@code mimocode.db}, then {@code opencode.db} / {@code mimo.db} in case
     * an install still carries the upstream file name.
     */
    private static Path defaultDatabasePath(Path storageRoot) {
        Path parent = storageRoot != null ? storageRoot.getParent() : null;
        if (parent == null) {
            parent = defaultMimoDataHome();
        }
        for (String candidate : new String[]{"mimocode.db", "opencode.db", "mimo.db"}) {
            Path db = parent.resolve(candidate);
            if (Files.isRegularFile(db)) {
                return db;
            }
        }
        return parent.resolve("mimocode.db");
    }

    private static Path defaultMimoDataHome() {
        String home = NodeDetector.resolveHomeForFileOps();
        String override = System.getenv("MIMOCODE_DATA_HOME");
        if (override != null && !override.trim().isEmpty()) {
            return Paths.get(override.trim());
        }
        String xdg = System.getenv("XDG_DATA_HOME");
        if (xdg != null && !xdg.trim().isEmpty()) {
            return Paths.get(xdg.trim(), "mimocode");
        }
        // MiMo Code docs: macOS/Linux ~/.local/share/mimocode ; Windows %USERPROFILE%\.local\share\mimocode
        return Paths.get(home, ".local", "share", "mimocode");
    }
}
