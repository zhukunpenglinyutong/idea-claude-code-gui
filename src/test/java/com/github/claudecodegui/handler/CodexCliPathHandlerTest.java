package com.github.claudecodegui.handler;

import org.junit.Assume;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit-tests the pure path-validation branches of
 * {@link CodexCliPathHandler#validateCliPath(File, String)}.
 */
public class CodexCliPathHandlerTest {

    @Test
    public void validateCliPath_rejectsNonExistentFile() {
        File missing = new File(System.getProperty("java.io.tmpdir"), "cc-gui-codex-cli-missing-zzz");
        String reason = CodexCliPathHandler.validateCliPath(missing, missing.getPath());
        assertNotNull("A non-existent path must be rejected", reason);
        assertTrue("Reason should explain the file is missing: " + reason,
                reason.startsWith("File does not exist"));
    }

    @Test
    public void validateCliPath_rejectsDirectory() throws IOException {
        File dir = Files.createTempDirectory("cc-gui-codex-cli-dir").toFile();
        dir.deleteOnExit();
        String reason = CodexCliPathHandler.validateCliPath(dir, dir.getPath());
        assertNotNull("A directory must be rejected", reason);
        assertTrue("Reason should explain the path is a directory: " + reason,
                reason.startsWith("Path is a directory"));
    }

    @Test
    public void validateCliPath_rejectsNonExecutableFile() throws IOException {
        File file = Files.createTempFile("cc-gui-codex-cli-noexec", ".bin").toFile();
        file.deleteOnExit();
        file.setExecutable(false, false);
        // Some filesystems / privileged users cannot represent a non-executable regular
        // file (canExecute stays true); skip rather than fail spuriously in that case.
        Assume.assumeFalse("Filesystem cannot strip the execute bit", file.canExecute());

        String reason = CodexCliPathHandler.validateCliPath(file, file.getPath());
        assertNotNull("A non-executable file must be rejected", reason);
        assertTrue("Reason should explain the file is not executable: " + reason,
                reason.startsWith("File is not executable"));
    }

    @Test
    public void validateCliPath_acceptsExecutableFile() throws IOException {
        File file = Files.createTempFile("cc-gui-codex-cli-ok", ".sh").toFile();
        file.deleteOnExit();
        assertTrue("Test precondition: set the execute bit", file.setExecutable(true, false));

        String reason = CodexCliPathHandler.validateCliPath(file, file.getPath());
        assertNull("A usable executable file must pass validation, got: " + reason, reason);
    }
}
